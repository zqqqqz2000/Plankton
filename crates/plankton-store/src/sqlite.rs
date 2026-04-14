use std::path::PathBuf;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use plankton_core::{
    build_provider_input_snapshot, escalate_for_secret_exposure_risk,
    evaluate_automatic_disposition, evaluate_local_hard_rules, generate_llm_suggestion,
    render_request_template, request_llm_suggestion, sanitize_prompt_context,
    sanitize_request_context_for_storage, secret_exposure_risk, AccessRequest, AuditRecord,
    AutomaticDecisionTrace, DashboardData, Decision, DomainError, LlmSuggestion, PlanktonSettings,
    PolicyMode, ProviderError, ProviderInputSnapshot, RequestContext, TemplateError,
    DEFAULT_USER_PROVIDER_KIND,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row, SqlitePool,
};
use tracing::instrument;

#[derive(Debug, Clone)]
pub struct SqliteStore {
    pool: SqlitePool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestQueryResult {
    pub request: AccessRequest,
    pub audit_records: Vec<AuditRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AccessibleResourceRecord {
    pub resource: String,
    pub granted_by_request_id: String,
    pub policy_mode: PolicyMode,
    pub provider_kind: Option<String>,
    pub granted_at: DateTime<Utc>,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("migration error: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("template error: {0}")]
    Template(#[from] TemplateError),
    #[error("domain error: {0}")]
    Domain(#[from] DomainError),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("provider error: {0}")]
    Provider(#[from] ProviderError),
    #[error("invalid datetime in storage: {0}")]
    InvalidDateTime(String),
    #[error("request {0} was not found")]
    NotFound(String),
    #[error("policy mode {0:?} is not implemented in the store yet")]
    UnsupportedPolicyMode(PolicyMode),
}

impl SqliteStore {
    #[instrument(skip(settings))]
    pub async fn new(settings: &PlanktonSettings) -> Result<Self, StoreError> {
        ensure_sqlite_parent_dir(&settings.database_url)?;
        let options =
            SqliteConnectOptions::from_str(&settings.database_url)?.create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;

        sqlx::migrate!("./migrations").run(&pool).await?;

        Ok(Self { pool })
    }

    #[instrument(skip(self, settings, context))]
    pub async fn submit_request(
        &self,
        settings: &PlanktonSettings,
        context: RequestContext,
        policy_mode: PolicyMode,
    ) -> Result<AccessRequest, StoreError> {
        let sanitized_context = sanitize_prompt_context(&context);
        let stored_context = sanitize_request_context_for_storage(&context);
        let rendered_prompt =
            render_request_template(&settings.request_template, &sanitized_context, policy_mode)?;
        let normalized_provider_kind = normalized_provider_kind(settings);
        let (provider_kind, provider_input, llm_suggestion, automatic_decision) = match policy_mode
        {
            PolicyMode::ManualOnly => (None, None, None, None),
            PolicyMode::Assisted => {
                let (provider_input, llm_suggestion) =
                    generate_llm_suggestion(settings, policy_mode, &context, &sanitized_context)
                        .await?;
                (
                    Some(normalized_provider_kind),
                    Some(provider_input),
                    Some(llm_suggestion),
                    None,
                )
            }
            PolicyMode::LlmAutomatic => {
                let provider_kind = Some(normalized_provider_kind);

                if let Some(local_decision) =
                    evaluate_local_hard_rules(&context, &sanitized_context)
                {
                    (provider_kind, None, None, Some(local_decision))
                } else {
                    let provider_input = build_provider_input_snapshot(
                        settings,
                        policy_mode,
                        &context,
                        &sanitized_context,
                    )?;

                    if secret_exposure_risk(&sanitized_context) {
                        let automatic_decision = escalate_for_secret_exposure_risk(
                            &sanitized_context,
                            Some(&provider_input),
                        );
                        (
                            provider_kind,
                            Some(provider_input),
                            None,
                            Some(automatic_decision),
                        )
                    } else {
                        let llm_suggestion =
                            request_llm_suggestion(settings, policy_mode, &provider_input).await;
                        let automatic_decision = evaluate_automatic_disposition(
                            provider_kind.as_deref(),
                            Some(&provider_input),
                            Some(&llm_suggestion),
                            &sanitized_context,
                        );
                        (
                            provider_kind,
                            Some(provider_input),
                            Some(llm_suggestion),
                            Some(automatic_decision),
                        )
                    }
                }
            }
        };
        let mut request = AccessRequest::new_pending(
            stored_context,
            policy_mode,
            provider_kind,
            rendered_prompt,
            provider_input,
            llm_suggestion,
        );
        let mut audits = vec![request.record_submission_audit()];
        if let Some(audit) = request.record_llm_suggestion_audit() {
            audits.push(audit);
        }
        if let Some(automatic_decision) = automatic_decision {
            audits.extend(request.apply_automatic_decision(automatic_decision)?);
        }
        let mut tx = self.pool.begin().await?;

        sqlx::query(
            r#"
            INSERT INTO access_requests (
                id, resource, requested_by, reason, policy_mode, approval_status, final_decision,
                provider_kind, rendered_prompt, provider_input_json, llm_suggestion_json,
                automatic_decision_json, context_json, created_at, updated_at, resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&request.id)
        .bind(&request.context.resource)
        .bind(&request.context.requested_by)
        .bind(&request.context.reason)
        .bind(enum_to_string(&request.policy_mode)?)
        .bind(enum_to_string(&request.approval_status)?)
        .bind(option_enum_to_string(&request.final_decision)?)
        .bind(&request.provider_kind)
        .bind(&request.rendered_prompt)
        .bind(option_json_string(&request.provider_input)?)
        .bind(option_json_string(&request.llm_suggestion)?)
        .bind(option_json_string(&request.automatic_decision)?)
        .bind(serde_json::to_string(&request.context)?)
        .bind(request.created_at.to_rfc3339())
        .bind(request.updated_at.to_rfc3339())
        .bind(option_datetime(&request.resolved_at))
        .execute(&mut *tx)
        .await?;

        insert_audits(&mut tx, &audits).await?;
        tx.commit().await?;

        Ok(request)
    }

    #[instrument(skip(self))]
    pub async fn get_request(&self, request_id: &str) -> Result<RequestQueryResult, StoreError> {
        let request_row = sqlx::query(
            r#"
            SELECT
                id, resource, policy_mode, approval_status, final_decision, provider_kind,
                rendered_prompt, provider_input_json, llm_suggestion_json,
                automatic_decision_json, context_json, created_at, updated_at, resolved_at
            FROM access_requests
            WHERE id = ?
            "#,
        )
        .bind(request_id)
        .fetch_optional(&self.pool)
        .await?;

        let request_row =
            request_row.ok_or_else(|| StoreError::NotFound(request_id.to_string()))?;
        let request = decode_request(&request_row)?;

        let audit_rows = sqlx::query(
            r#"
            SELECT id, request_id, action, actor, note, payload_json, created_at
            FROM audit_records
            WHERE request_id = ?
            ORDER BY created_at ASC
            "#,
        )
        .bind(request_id)
        .fetch_all(&self.pool)
        .await?;

        let audit_records = audit_rows
            .iter()
            .map(decode_audit)
            .collect::<Result<Vec<_>, _>>()?;

        Ok(RequestQueryResult {
            request,
            audit_records,
        })
    }

    #[instrument(skip(self))]
    pub async fn list_pending_requests(&self) -> Result<Vec<AccessRequest>, StoreError> {
        let rows = sqlx::query(
            r#"
            SELECT
                id, resource, policy_mode, approval_status, final_decision, provider_kind,
                rendered_prompt, provider_input_json, llm_suggestion_json,
                automatic_decision_json, context_json, created_at, updated_at, resolved_at
            FROM access_requests
            WHERE approval_status = ?
            ORDER BY created_at ASC
            "#,
        )
        .bind("pending")
        .fetch_all(&self.pool)
        .await?;

        rows.iter().map(decode_request).collect()
    }

    #[instrument(skip(self))]
    pub async fn list_accessible_resources(
        &self,
    ) -> Result<Vec<AccessibleResourceRecord>, StoreError> {
        let rows = sqlx::query(
            r#"
            SELECT id, resource, policy_mode, provider_kind, granted_at
            FROM (
                SELECT
                    id,
                    resource,
                    policy_mode,
                    provider_kind,
                    COALESCE(resolved_at, updated_at, created_at) AS granted_at,
                    ROW_NUMBER() OVER (
                        PARTITION BY resource
                        ORDER BY COALESCE(resolved_at, updated_at, created_at) DESC, updated_at DESC, id DESC
                    ) AS row_number
                FROM access_requests
                WHERE final_decision = 'allow'
            )
            WHERE row_number = 1
            ORDER BY resource ASC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        rows.iter().map(decode_accessible_resource).collect()
    }

    #[instrument(skip(self))]
    pub async fn list_audit_records(&self, limit: u32) -> Result<Vec<AuditRecord>, StoreError> {
        let rows = sqlx::query(
            r#"
            SELECT id, request_id, action, actor, note, payload_json, created_at
            FROM audit_records
            ORDER BY created_at DESC
            LIMIT ?
            "#,
        )
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await?;

        rows.iter().map(decode_audit).collect()
    }

    #[instrument(skip(self))]
    pub async fn dashboard(&self, limit: u32) -> Result<DashboardData, StoreError> {
        Ok(DashboardData {
            pending_requests: self.list_pending_requests().await?,
            recent_audit_records: self.list_audit_records(limit).await?,
        })
    }

    #[instrument(skip(self, actor, note))]
    pub async fn record_decision(
        &self,
        request_id: &str,
        decision: Decision,
        actor: &str,
        note: Option<String>,
    ) -> Result<AccessRequest, StoreError> {
        let mut tx = self.pool.begin().await?;

        let row = sqlx::query(
            r#"
            SELECT
                id, resource, policy_mode, approval_status, final_decision, provider_kind,
                rendered_prompt, provider_input_json, llm_suggestion_json,
                automatic_decision_json, context_json, created_at, updated_at, resolved_at
            FROM access_requests
            WHERE id = ?
            "#,
        )
        .bind(request_id)
        .fetch_optional(&mut *tx)
        .await?;

        let row = row.ok_or_else(|| StoreError::NotFound(request_id.to_string()))?;
        let mut request = decode_request(&row)?;
        let audits = request.apply_manual_decision(decision, actor.to_string(), note)?;

        sqlx::query(
            r#"
            UPDATE access_requests
            SET approval_status = ?, final_decision = ?, updated_at = ?, resolved_at = ?
            WHERE id = ?
            "#,
        )
        .bind(enum_to_string(&request.approval_status)?)
        .bind(option_enum_to_string(&request.final_decision)?)
        .bind(request.updated_at.to_rfc3339())
        .bind(option_datetime(&request.resolved_at))
        .bind(&request.id)
        .execute(&mut *tx)
        .await?;

        insert_audits(&mut tx, &audits).await?;
        tx.commit().await?;

        Ok(request)
    }
}

fn ensure_sqlite_parent_dir(database_url: &str) -> Result<(), StoreError> {
    if let Some(path) = database_url.strip_prefix("sqlite://") {
        let path = PathBuf::from(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(sqlx::Error::Io)?;
        }
    }

    Ok(())
}

fn option_datetime(value: &Option<DateTime<Utc>>) -> Option<String> {
    value.as_ref().map(DateTime::<Utc>::to_rfc3339)
}

fn enum_to_string<T: serde::Serialize>(value: &T) -> Result<String, StoreError> {
    let value = serde_json::to_value(value)?;
    Ok(value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string()))
}

fn option_enum_to_string<T: serde::Serialize>(
    value: &Option<T>,
) -> Result<Option<String>, StoreError> {
    match value {
        Some(value) => Ok(Some(enum_to_string(value)?)),
        None => Ok(None),
    }
}

fn option_json_string<T: serde::Serialize>(
    value: &Option<T>,
) -> Result<Option<String>, StoreError> {
    match value {
        Some(value) => Ok(Some(serde_json::to_string(value)?)),
        None => Ok(None),
    }
}

fn normalized_provider_kind(settings: &PlanktonSettings) -> String {
    let provider_kind = settings.provider_kind.trim().to_ascii_lowercase();
    if provider_kind.is_empty() {
        DEFAULT_USER_PROVIDER_KIND.to_string()
    } else {
        provider_kind
    }
}

async fn insert_audits<'a>(
    tx: &mut sqlx::Transaction<'a, sqlx::Sqlite>,
    audits: &[AuditRecord],
) -> Result<(), StoreError> {
    for audit in audits {
        sqlx::query(
            r#"
            INSERT INTO audit_records (id, request_id, action, actor, note, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&audit.id)
        .bind(&audit.request_id)
        .bind(enum_to_string(&audit.action)?)
        .bind(&audit.actor)
        .bind(&audit.note)
        .bind(audit.payload.to_string())
        .bind(audit.created_at.to_rfc3339())
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

fn decode_request(row: &sqlx::sqlite::SqliteRow) -> Result<AccessRequest, StoreError> {
    let mut context: RequestContext =
        serde_json::from_str(row.try_get::<String, _>("context_json")?.as_str())?;
    context.resource = row.try_get("resource")?;
    let policy_mode = parse_enum(row.try_get::<String, _>("policy_mode")?.as_str())?;
    let approval_status = parse_enum(row.try_get::<String, _>("approval_status")?.as_str())?;
    let final_decision = match row.try_get::<Option<String>, _>("final_decision")? {
        Some(value) => Some(parse_enum(value.as_str())?),
        None => None,
    };
    let provider_input = parse_optional_json::<ProviderInputSnapshot>(
        row.try_get::<Option<String>, _>("provider_input_json")?,
    )?;
    let llm_suggestion = parse_optional_json::<LlmSuggestion>(
        row.try_get::<Option<String>, _>("llm_suggestion_json")?,
    )?;
    let automatic_decision = parse_optional_json::<AutomaticDecisionTrace>(
        row.try_get::<Option<String>, _>("automatic_decision_json")?,
    )?;

    Ok(AccessRequest {
        id: row.try_get("id")?,
        context,
        policy_mode,
        approval_status,
        final_decision,
        provider_kind: row.try_get("provider_kind")?,
        rendered_prompt: row.try_get("rendered_prompt")?,
        provider_input,
        llm_suggestion,
        automatic_decision,
        created_at: parse_datetime(row.try_get::<String, _>("created_at")?.as_str())?,
        updated_at: parse_datetime(row.try_get::<String, _>("updated_at")?.as_str())?,
        resolved_at: row
            .try_get::<Option<String>, _>("resolved_at")?
            .map(|value| parse_datetime(value.as_str()))
            .transpose()?,
    })
}

fn decode_accessible_resource(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<AccessibleResourceRecord, StoreError> {
    Ok(AccessibleResourceRecord {
        resource: row.try_get("resource")?,
        granted_by_request_id: row.try_get("id")?,
        policy_mode: parse_enum(row.try_get::<String, _>("policy_mode")?.as_str())?,
        provider_kind: row.try_get("provider_kind")?,
        granted_at: parse_datetime(row.try_get::<String, _>("granted_at")?.as_str())?,
    })
}

fn decode_audit(row: &sqlx::sqlite::SqliteRow) -> Result<AuditRecord, StoreError> {
    let payload: Value = serde_json::from_str(row.try_get::<String, _>("payload_json")?.as_str())?;
    let action = parse_enum(row.try_get::<String, _>("action")?.as_str())?;

    Ok(AuditRecord {
        id: row.try_get("id")?,
        request_id: row.try_get("request_id")?,
        action,
        actor: row.try_get("actor")?,
        note: row.try_get("note")?,
        payload,
        created_at: parse_datetime(row.try_get::<String, _>("created_at")?.as_str())?,
    })
}

fn parse_datetime(value: &str) -> Result<DateTime<Utc>, StoreError> {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|_| StoreError::InvalidDateTime(value.to_string()))
}

fn parse_enum<T>(value: &str) -> Result<T, StoreError>
where
    T: for<'de> serde::Deserialize<'de>,
{
    let quoted = format!("\"{value}\"");
    Ok(serde_json::from_str(&quoted)?)
}

fn parse_optional_json<T>(value: Option<String>) -> Result<Option<T>, StoreError>
where
    T: for<'de> serde::Deserialize<'de>,
{
    match value {
        Some(value) => Ok(Some(serde_json::from_str(value.as_str())?)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use tempfile::tempdir;

    use plankton_core::{
        load_settings, ApprovalStatus, AuditAction, AutomaticDisposition, CallChainNode, Decision,
        PolicyMode, RequestContext, LLM_ADVICE_TEMPLATE_ID, LLM_ADVICE_TEMPLATE_VERSION,
        PROMPT_CONTRACT_VERSION,
    };

    use super::SqliteStore;

    fn test_settings() -> plankton_core::PlanktonSettings {
        let temp = tempdir().expect("temp directory should be created");
        let mut settings = load_settings().expect("default settings should load");
        settings.database_url = format!("sqlite://{}", temp.path().join("plankton.db").display());
        settings.provider_kind = "mock".to_string();
        settings
    }

    #[tokio::test]
    async fn persists_request_and_decision_round_trip() {
        let temp = tempdir().expect("temp directory should be created");
        let mut settings = load_settings().expect("default settings should load");
        settings.database_url = format!("sqlite://{}", temp.path().join("plankton.db").display());

        let store = SqliteStore::new(&settings)
            .await
            .expect("store should initialize");

        let request = store
            .submit_request(
                &settings,
                RequestContext::new(
                    "secret/api-token".to_string(),
                    "Need smoke test access".to_string(),
                    "alice".to_string(),
                ),
                PolicyMode::ManualOnly,
            )
            .await
            .expect("request should be inserted");

        let updated = store
            .record_decision(
                &request.id,
                Decision::Allow,
                "reviewer",
                Some("approved".to_string()),
            )
            .await
            .expect("decision should be persisted");

        assert_eq!(
            updated.approval_status,
            plankton_core::ApprovalStatus::Approved
        );

        let fetched = store
            .get_request(&request.id)
            .await
            .expect("request should load");
        assert_eq!(fetched.audit_records.len(), 2);
    }

    #[tokio::test]
    async fn persists_assisted_request_with_llm_suggestion() {
        let temp = tempdir().expect("temp directory should be created");
        let mut settings = load_settings().expect("default settings should load");
        settings.database_url = format!("sqlite://{}", temp.path().join("plankton.db").display());
        settings.provider_kind = "mock".to_string();

        let store = SqliteStore::new(&settings)
            .await
            .expect("store should initialize");

        let mut context = RequestContext::new(
            "secret/dev-token".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        );
        context
            .metadata
            .insert("environment".to_string(), "dev".to_string());

        let request = store
            .submit_request(&settings, context, PolicyMode::Assisted)
            .await
            .expect("request should be inserted");

        assert_eq!(request.policy_mode, PolicyMode::Assisted);
        assert_eq!(request.provider_kind.as_deref(), Some("mock"));
        assert!(request.provider_input.is_some());
        assert!(request.llm_suggestion.is_some());

        let fetched = store
            .get_request(&request.id)
            .await
            .expect("request should load");
        assert_eq!(fetched.audit_records.len(), 2);
        assert!(fetched
            .audit_records
            .iter()
            .any(|record| record.action == plankton_core::AuditAction::LlmSuggestionGenerated));
    }

    #[tokio::test]
    async fn persists_human_override_audit_for_assisted_requests() {
        let temp = tempdir().expect("temp directory should be created");
        let mut settings = load_settings().expect("default settings should load");
        settings.database_url = format!("sqlite://{}", temp.path().join("plankton.db").display());
        settings.provider_kind = "mock".to_string();

        let store = SqliteStore::new(&settings)
            .await
            .expect("store should initialize");

        let request = store
            .submit_request(
                &settings,
                RequestContext::new(
                    "secret/dev-token".to_string(),
                    "Need smoke test access".to_string(),
                    "alice".to_string(),
                ),
                PolicyMode::Assisted,
            )
            .await
            .expect("request should be inserted");

        let updated = store
            .record_decision(
                &request.id,
                Decision::Deny,
                "reviewer",
                Some("override mock allow".to_string()),
            )
            .await
            .expect("decision should be persisted");

        assert_eq!(
            updated.approval_status,
            plankton_core::ApprovalStatus::Rejected
        );

        let fetched = store
            .get_request(&request.id)
            .await
            .expect("request should load");
        assert!(fetched
            .audit_records
            .iter()
            .any(|record| record.action == plankton_core::AuditAction::HumanDecisionOverrodeLlm));
    }

    #[tokio::test]
    async fn persists_llm_automatic_allow_with_system_auto_audits() {
        let settings = test_settings();

        let store = SqliteStore::new(&settings)
            .await
            .expect("store should initialize");

        let mut context = RequestContext::new(
            "secret/dev-token".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        );
        context
            .metadata
            .insert("environment".to_string(), "dev".to_string());

        let request = store
            .submit_request(&settings, context, PolicyMode::LlmAutomatic)
            .await
            .expect("automatic request should be inserted");

        assert_eq!(request.approval_status, ApprovalStatus::Approved);
        assert_eq!(request.final_decision, Some(Decision::Allow));
        assert_eq!(
            request
                .automatic_decision
                .as_ref()
                .map(|decision| decision.auto_disposition),
            Some(AutomaticDisposition::Allow)
        );
        assert!(request.provider_input.is_some());
        assert!(request.llm_suggestion.is_some());

        let fetched = store
            .get_request(&request.id)
            .await
            .expect("request should load");
        assert_eq!(fetched.audit_records.len(), 4);
        assert_eq!(
            fetched
                .audit_records
                .iter()
                .filter(|record| record.action == AuditAction::ApprovalRecorded)
                .count(),
            1
        );
        assert!(fetched
            .audit_records
            .iter()
            .any(|record| record.action == AuditAction::AutomaticDecisionRecorded));
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT actor_type FROM audit_records WHERE request_id = ? AND action = 'approval_recorded'"
            )
            .bind(&request.id)
            .fetch_one(&store.pool)
            .await
            .expect("approval actor_type should be queryable"),
            "system_auto"
        );
    }

    #[tokio::test]
    async fn escalates_llm_automatic_before_provider_when_secret_exposure_risk_is_true() {
        let settings = test_settings();

        let store = SqliteStore::new(&settings)
            .await
            .expect("store should initialize");

        let mut context = RequestContext::new(
            "secret/dev-token".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        );
        context.env_vars.insert(
            "OPENAI_API_KEY".to_string(),
            "sk-test-super-secret-value".to_string(),
        );

        let request = store
            .submit_request(&settings, context, PolicyMode::LlmAutomatic)
            .await
            .expect("automatic request should be inserted");

        assert_eq!(request.approval_status, ApprovalStatus::Pending);
        assert_eq!(request.final_decision, None);
        assert!(request.provider_input.is_some());
        assert!(request.llm_suggestion.is_none());
        assert_eq!(
            request
                .automatic_decision
                .as_ref()
                .map(|decision| decision.auto_disposition),
            Some(AutomaticDisposition::Escalate)
        );
        assert_eq!(
            request
                .automatic_decision
                .as_ref()
                .map(|decision| decision.provider_called),
            Some(false)
        );

        let fetched = store
            .get_request(&request.id)
            .await
            .expect("request should load");
        assert_eq!(fetched.audit_records.len(), 3);
        assert!(fetched
            .audit_records
            .iter()
            .any(|record| record.action == AuditAction::AutomaticEscalatedToHuman));
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT actor_type FROM audit_records WHERE request_id = ? AND action = 'automatic_escalated_to_human'"
            )
            .bind(&request.id)
            .fetch_one(&store.pool)
            .await
            .expect("automatic escalation actor_type should be queryable"),
            "system_auto"
        );
    }

    #[tokio::test]
    async fn persists_sanitized_context_without_raw_secrets_or_absolute_paths() {
        let temp = tempdir().expect("temp directory should be created");
        let mut settings = load_settings().expect("default settings should load");
        settings.database_url = format!("sqlite://{}", temp.path().join("plankton.db").display());
        settings.provider_kind = "mock".to_string();

        let store = SqliteStore::new(&settings)
            .await
            .expect("store should initialize");

        let mut context = RequestContext::new(
            "secret/demo".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        );
        context.script_path = Some("/Users/jpx/private/run-secret.sh".to_string());
        context.call_chain = vec![
            CallChainNode::legacy_path("/Users/jpx/private/run-secret.sh"),
            CallChainNode::legacy_path("bash"),
        ];
        context.env_vars.insert(
            "OPENAI_API_KEY".to_string(),
            "sk-test-super-secret-value".to_string(),
        );
        context.env_vars.insert(
            "SESSION_TOKEN".to_string(),
            "super-secret-session-token".to_string(),
        );
        context.metadata.insert(
            "api_token".to_string(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        );

        let request = store
            .submit_request(&settings, context, PolicyMode::Assisted)
            .await
            .expect("request should be inserted");

        let (context_json, provider_input_json): (String, String) = sqlx::query_as(
            r#"
            SELECT context_json, provider_input_json
            FROM access_requests
            WHERE id = ?
            "#,
        )
        .bind(&request.id)
        .fetch_one(&store.pool)
        .await
        .expect("request payloads should be queryable");

        assert!(context_json.contains("/Users/jpx/private/run-secret.sh"));
        assert!(provider_input_json.contains("/Users/jpx/private/run-secret.sh"));
        assert!(!context_json.contains("sk-test-super-secret-value"));
        assert!(!context_json.contains("super-secret-session-token"));
        assert!(!context_json.contains("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(context_json.contains("[redacted]"));
        assert!(!context_json.contains("\"preview_text\":\"echo secret\""));
    }

    #[tokio::test]
    async fn reads_legacy_request_payloads_without_template_metadata() {
        let temp = tempdir().expect("temp directory should be created");
        let mut settings = load_settings().expect("default settings should load");
        settings.database_url = format!("sqlite://{}", temp.path().join("plankton.db").display());
        settings.provider_kind = "mock".to_string();

        let store = SqliteStore::new(&settings)
            .await
            .expect("store should initialize");

        let request = store
            .submit_request(
                &settings,
                RequestContext::new(
                    "secret/demo".to_string(),
                    "Need legacy payload compatibility".to_string(),
                    "alice".to_string(),
                ),
                PolicyMode::Assisted,
            )
            .await
            .expect("request should be inserted");

        let (provider_input_json, llm_suggestion_json): (String, String) = sqlx::query_as(
            r#"
            SELECT provider_input_json, llm_suggestion_json
            FROM access_requests
            WHERE id = ?
            "#,
        )
        .bind(&request.id)
        .fetch_one(&store.pool)
        .await
        .expect("request payloads should be queryable");

        let legacy_provider_input_json = strip_template_metadata(provider_input_json);
        let legacy_llm_suggestion_json = strip_template_metadata(llm_suggestion_json);

        sqlx::query(
            r#"
            UPDATE access_requests
            SET provider_input_json = ?, llm_suggestion_json = ?
            WHERE id = ?
            "#,
        )
        .bind(legacy_provider_input_json)
        .bind(legacy_llm_suggestion_json)
        .bind(&request.id)
        .execute(&store.pool)
        .await
        .expect("legacy payload should be written");

        let fetched = store
            .get_request(&request.id)
            .await
            .expect("legacy payload should still deserialize");

        let provider_input = fetched
            .request
            .provider_input
            .expect("provider input should still exist");
        assert_eq!(provider_input.template_id, LLM_ADVICE_TEMPLATE_ID);
        assert_eq!(provider_input.template_version, LLM_ADVICE_TEMPLATE_VERSION);
        assert_eq!(
            provider_input.prompt_contract_version,
            PROMPT_CONTRACT_VERSION
        );
        assert!(provider_input.prompt_sha256.is_empty());

        let suggestion = fetched
            .request
            .llm_suggestion
            .expect("llm suggestion should still exist");
        assert_eq!(suggestion.template_id, LLM_ADVICE_TEMPLATE_ID);
        assert_eq!(suggestion.template_version, LLM_ADVICE_TEMPLATE_VERSION);
        assert_eq!(suggestion.prompt_contract_version, PROMPT_CONTRACT_VERSION);
        assert!(suggestion.prompt_sha256.is_empty());

        let updated = store
            .record_decision(
                &request.id,
                Decision::Allow,
                "reviewer",
                Some("legacy payload still readable".to_string()),
            )
            .await
            .expect("decision path should also tolerate legacy payloads");

        assert_eq!(updated.approval_status, ApprovalStatus::Approved);
    }

    #[tokio::test]
    async fn lists_only_accessible_resources_without_duplicates_or_denied_entries() {
        let temp = tempdir().expect("temp directory should be created");
        let mut settings = load_settings().expect("default settings should load");
        settings.database_url = format!("sqlite://{}", temp.path().join("plankton.db").display());

        let store = SqliteStore::new(&settings)
            .await
            .expect("store should initialize");

        let allow_request = store
            .submit_request(
                &settings,
                RequestContext::new(
                    "secret/shared-token".to_string(),
                    "Need shared access".to_string(),
                    "alice".to_string(),
                ),
                PolicyMode::ManualOnly,
            )
            .await
            .expect("allow request should be inserted");
        store
            .record_decision(
                &allow_request.id,
                Decision::Allow,
                "reviewer",
                Some("approved".to_string()),
            )
            .await
            .expect("allow decision should persist");

        tokio::time::sleep(std::time::Duration::from_millis(5)).await;

        let superseding_allow = store
            .submit_request(
                &settings,
                RequestContext::new(
                    "secret/shared-token".to_string(),
                    "Need newer shared access".to_string(),
                    "alice".to_string(),
                ),
                PolicyMode::Assisted,
            )
            .await
            .expect("superseding allow request should be inserted");
        store
            .record_decision(
                &superseding_allow.id,
                Decision::Allow,
                "reviewer",
                Some("approved again".to_string()),
            )
            .await
            .expect("superseding allow decision should persist");

        let denied_request = store
            .submit_request(
                &settings,
                RequestContext::new(
                    "secret/denied-token".to_string(),
                    "Need denied access".to_string(),
                    "alice".to_string(),
                ),
                PolicyMode::ManualOnly,
            )
            .await
            .expect("denied request should be inserted");
        store
            .record_decision(
                &denied_request.id,
                Decision::Deny,
                "reviewer",
                Some("denied".to_string()),
            )
            .await
            .expect("deny decision should persist");

        let pending_request = store
            .submit_request(
                &settings,
                RequestContext::new(
                    "secret/pending-token".to_string(),
                    "Need pending access".to_string(),
                    "alice".to_string(),
                ),
                PolicyMode::ManualOnly,
            )
            .await
            .expect("pending request should be inserted");
        assert_eq!(pending_request.approval_status, ApprovalStatus::Pending);

        let resources = store
            .list_accessible_resources()
            .await
            .expect("accessible resources should load");

        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0].resource, "secret/shared-token");
        assert_eq!(resources[0].granted_by_request_id, superseding_allow.id);
        assert_eq!(resources[0].policy_mode, PolicyMode::Assisted);
    }

    fn strip_template_metadata(value: String) -> String {
        let mut json: Value =
            serde_json::from_str(value.as_str()).expect("payload should parse as json");
        let object = json
            .as_object_mut()
            .expect("payload should deserialize to a json object");
        object.remove("template_id");
        object.remove("template_version");
        object.remove("prompt_contract_version");
        object.remove("prompt_sha256");
        serde_json::to_string(&json).expect("payload should serialize back to json")
    }
}
