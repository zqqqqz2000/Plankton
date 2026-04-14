use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    deserialize_call_chain_nodes, AutomaticDecisionTrace, AutomaticDisposition, CallChainNode,
    LLM_ADVICE_TEMPLATE_ID, LLM_ADVICE_TEMPLATE_VERSION, PROMPT_CONTRACT_VERSION,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PolicyMode {
    ManualOnly,
    LlmAutomatic,
    Assisted,
}

impl Default for PolicyMode {
    fn default() -> Self {
        Self::ManualOnly
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SuggestedDecision {
    Allow,
    Deny,
    Escalate,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuditAction {
    RequestSubmitted,
    LlmSuggestionGenerated,
    LlmSuggestionFailed,
    AutomaticDecisionRecorded,
    AutomaticEscalatedToHuman,
    ApprovalRecorded,
    HumanDecisionOverrodeLlm,
    StatusViewed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RequestContext {
    pub resource: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resource_tags: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub resource_metadata: BTreeMap<String, String>,
    pub reason: String,
    pub requested_by: String,
    pub script_path: Option<String>,
    #[serde(default, deserialize_with = "deserialize_call_chain_nodes")]
    pub call_chain: Vec<CallChainNode>,
    pub env_vars: BTreeMap<String, String>,
    pub metadata: BTreeMap<String, String>,
    pub created_at: DateTime<Utc>,
}

impl RequestContext {
    pub fn new(resource: String, reason: String, requested_by: String) -> Self {
        Self {
            resource,
            resource_tags: Vec::new(),
            resource_metadata: BTreeMap::new(),
            reason,
            requested_by,
            script_path: None,
            call_chain: Vec::new(),
            env_vars: BTreeMap::new(),
            metadata: BTreeMap::new(),
            created_at: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SanitizedPromptContext {
    pub resource: String,
    #[serde(default)]
    pub resource_tags: Vec<String>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub requested_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub call_chain: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env_vars: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env_var_names: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub redaction_summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub redacted_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderInputSnapshot {
    #[serde(default = "default_llm_advice_template_id")]
    pub template_id: String,
    #[serde(default = "default_llm_advice_template_version")]
    pub template_version: String,
    #[serde(default = "default_prompt_contract_version")]
    pub prompt_contract_version: String,
    #[serde(default)]
    pub prompt_sha256: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_read_files: Vec<String>,
    pub sanitized_context: SanitizedPromptContext,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProviderTrace {
    pub transport: Option<String>,
    pub protocol: Option<String>,
    pub api_version: Option<String>,
    pub output_format: Option<String>,
    pub stop_reason: Option<String>,
    pub package_name: Option<String>,
    pub package_version: Option<String>,
    pub session_id: Option<String>,
    pub client_request_id: Option<String>,
    pub agent_name: Option<String>,
    pub agent_version: Option<String>,
    #[serde(default)]
    pub beta_headers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LlmSuggestionUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LlmSuggestion {
    #[serde(default = "default_llm_advice_template_id")]
    pub template_id: String,
    #[serde(default = "default_llm_advice_template_version")]
    pub template_version: String,
    #[serde(default = "default_prompt_contract_version")]
    pub prompt_contract_version: String,
    #[serde(default)]
    pub prompt_sha256: String,
    pub suggested_decision: SuggestedDecision,
    pub rationale_summary: String,
    pub risk_score: u8,
    pub provider_kind: String,
    pub provider_model: Option<String>,
    pub provider_response_id: Option<String>,
    pub x_request_id: Option<String>,
    pub provider_trace: Option<ProviderTrace>,
    pub usage: Option<LlmSuggestionUsage>,
    pub error: Option<String>,
    pub generated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AccessRequest {
    pub id: String,
    pub context: RequestContext,
    pub policy_mode: PolicyMode,
    pub approval_status: ApprovalStatus,
    pub final_decision: Option<Decision>,
    pub provider_kind: Option<String>,
    pub rendered_prompt: String,
    pub provider_input: Option<ProviderInputSnapshot>,
    pub llm_suggestion: Option<LlmSuggestion>,
    pub automatic_decision: Option<AutomaticDecisionTrace>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

fn default_llm_advice_template_id() -> String {
    LLM_ADVICE_TEMPLATE_ID.to_string()
}

fn default_llm_advice_template_version() -> String {
    LLM_ADVICE_TEMPLATE_VERSION.to_string()
}

fn default_prompt_contract_version() -> String {
    PROMPT_CONTRACT_VERSION.to_string()
}

impl AccessRequest {
    pub fn new_pending(
        context: RequestContext,
        policy_mode: PolicyMode,
        provider_kind: Option<String>,
        rendered_prompt: String,
        provider_input: Option<ProviderInputSnapshot>,
        llm_suggestion: Option<LlmSuggestion>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            context,
            policy_mode,
            approval_status: ApprovalStatus::Pending,
            final_decision: None,
            provider_kind,
            rendered_prompt,
            provider_input,
            llm_suggestion,
            automatic_decision: None,
            created_at: now,
            updated_at: now,
            resolved_at: None,
        }
    }

    pub fn record_submission_audit(&self) -> AuditRecord {
        AuditRecord::new(
            self.id.clone(),
            AuditAction::RequestSubmitted,
            self.context.requested_by.clone(),
            Some(self.context.reason.clone()),
            json!({
                "policy_mode": self.policy_mode,
                "resource": self.context.resource,
                "resource_tags": self.context.resource_tags,
                "resource_metadata": self.context.resource_metadata,
            }),
        )
    }

    pub fn record_llm_suggestion_audit(&self) -> Option<AuditRecord> {
        let suggestion = self.llm_suggestion.as_ref()?;
        let action = if suggestion.error.is_some() {
            AuditAction::LlmSuggestionFailed
        } else {
            AuditAction::LlmSuggestionGenerated
        };
        let note = suggestion
            .error
            .clone()
            .or_else(|| Some(suggestion.rationale_summary.clone()));

        Some(AuditRecord::new(
            self.id.clone(),
            action,
            suggestion.provider_kind.clone(),
            note,
            json!({
                "template_id": suggestion.template_id,
                "template_version": suggestion.template_version,
                "prompt_contract_version": suggestion.prompt_contract_version,
                "prompt_sha256": suggestion.prompt_sha256,
                "suggested_decision": suggestion.suggested_decision,
                "risk_score": suggestion.risk_score,
                "provider_response_id": suggestion.provider_response_id,
                "x_request_id": suggestion.x_request_id,
                "provider_model": suggestion.provider_model,
                "provider_trace": suggestion.provider_trace,
                "approval_status": self.approval_status,
            }),
        ))
    }

    pub fn apply_manual_decision(
        &mut self,
        decision: Decision,
        actor: impl Into<String>,
        note: Option<String>,
    ) -> Result<Vec<AuditRecord>, DomainError> {
        if self.approval_status != ApprovalStatus::Pending {
            return Err(DomainError::AlreadyResolved {
                request_id: self.id.clone(),
                status: self.approval_status,
            });
        }

        self.final_decision = Some(decision);
        self.approval_status = match decision {
            Decision::Allow => ApprovalStatus::Approved,
            Decision::Deny => ApprovalStatus::Rejected,
        };
        let now = Utc::now();
        self.updated_at = now;
        self.resolved_at = Some(now);

        let actor = actor.into();
        let mut audits = vec![AuditRecord::new(
            self.id.clone(),
            AuditAction::ApprovalRecorded,
            actor.clone(),
            note.clone(),
            json!({
                "approval_status": self.approval_status,
                "decision": decision,
            }),
        )];

        if self.should_record_human_override(decision) {
            audits.push(AuditRecord::new(
                self.id.clone(),
                AuditAction::HumanDecisionOverrodeLlm,
                actor,
                note,
                json!({
                    "approval_status": self.approval_status,
                    "decision": decision,
                    "suggested_decision": self.llm_suggestion.as_ref().map(|suggestion| suggestion.suggested_decision),
                    "risk_score": self.llm_suggestion.as_ref().map(|suggestion| suggestion.risk_score),
                }),
            ));
        }

        Ok(audits)
    }

    pub fn apply_automatic_decision(
        &mut self,
        automatic_decision: AutomaticDecisionTrace,
    ) -> Result<Vec<AuditRecord>, DomainError> {
        if self.approval_status != ApprovalStatus::Pending {
            return Err(DomainError::AlreadyResolved {
                request_id: self.id.clone(),
                status: self.approval_status,
            });
        }

        let evaluated_at = automatic_decision.evaluated_at;
        let auto_disposition = automatic_decision.auto_disposition;
        self.updated_at = evaluated_at;
        self.automatic_decision = Some(automatic_decision.clone());

        match auto_disposition {
            AutomaticDisposition::Allow => {
                self.final_decision = Some(Decision::Allow);
                self.approval_status = ApprovalStatus::Approved;
                self.resolved_at = Some(evaluated_at);
            }
            AutomaticDisposition::Deny => {
                self.final_decision = Some(Decision::Deny);
                self.approval_status = ApprovalStatus::Rejected;
                self.resolved_at = Some(evaluated_at);
            }
            AutomaticDisposition::Escalate => {
                self.final_decision = None;
                self.approval_status = ApprovalStatus::Pending;
                self.resolved_at = None;
            }
        }

        let mut audits = vec![AuditRecord::new(
            self.id.clone(),
            AuditAction::AutomaticDecisionRecorded,
            "system_auto".to_string(),
            Some(automatic_decision.auto_rationale_summary.clone()),
            json!({
                "auto_disposition": auto_disposition,
                "decision": auto_disposition,
                "decision_source": automatic_decision.decision_source,
                "approval_status": self.approval_status,
                "final_decision": self.final_decision,
                "matched_rule_ids": automatic_decision.matched_rule_ids,
                "secret_exposure_risk": automatic_decision.secret_exposure_risk,
                "provider_called": automatic_decision.provider_called,
                "suggested_decision": automatic_decision.suggested_decision,
                "risk_score": automatic_decision.risk_score,
                "template_id": automatic_decision.template_id,
                "template_version": automatic_decision.template_version,
                "prompt_contract_version": automatic_decision.prompt_contract_version,
                "provider_kind": automatic_decision.provider_kind,
                "provider_model": automatic_decision.provider_model,
                "x_request_id": automatic_decision.x_request_id,
                "provider_response_id": automatic_decision.provider_response_id,
                "redacted_fields": automatic_decision.redacted_fields,
                "redaction_summary": automatic_decision.redaction_summary,
                "auto_rationale_summary": automatic_decision.auto_rationale_summary,
                "fail_closed": automatic_decision.fail_closed,
                "evaluated_at": automatic_decision.evaluated_at,
            }),
        )];

        match auto_disposition {
            AutomaticDisposition::Allow | AutomaticDisposition::Deny => {
                audits.push(AuditRecord::new(
                    self.id.clone(),
                    AuditAction::ApprovalRecorded,
                    "system_auto".to_string(),
                    Some(automatic_decision.auto_rationale_summary.clone()),
                    json!({
                        "approval_status": self.approval_status,
                        "decision": self.final_decision,
                        "auto_disposition": auto_disposition,
                        "decision_source": automatic_decision.decision_source,
                    }),
                ))
            }
            AutomaticDisposition::Escalate => audits.push(AuditRecord::new(
                self.id.clone(),
                AuditAction::AutomaticEscalatedToHuman,
                "system_auto".to_string(),
                Some(automatic_decision.auto_rationale_summary.clone()),
                json!({
                    "auto_disposition": auto_disposition,
                    "decision": auto_disposition,
                    "decision_source": automatic_decision.decision_source,
                    "matched_rule_ids": automatic_decision.matched_rule_ids,
                    "secret_exposure_risk": automatic_decision.secret_exposure_risk,
                    "provider_called": automatic_decision.provider_called,
                    "suggested_decision": automatic_decision.suggested_decision,
                    "risk_score": automatic_decision.risk_score,
                    "template_id": automatic_decision.template_id,
                    "template_version": automatic_decision.template_version,
                    "prompt_contract_version": automatic_decision.prompt_contract_version,
                    "provider_kind": automatic_decision.provider_kind,
                    "provider_model": automatic_decision.provider_model,
                    "x_request_id": automatic_decision.x_request_id,
                    "provider_response_id": automatic_decision.provider_response_id,
                    "redacted_fields": automatic_decision.redacted_fields,
                    "redaction_summary": automatic_decision.redaction_summary,
                    "auto_rationale_summary": automatic_decision.auto_rationale_summary,
                    "fail_closed": automatic_decision.fail_closed,
                }),
            )),
        }

        Ok(audits)
    }

    fn should_record_human_override(&self, decision: Decision) -> bool {
        let Some(suggestion) = self.llm_suggestion.as_ref() else {
            return false;
        };
        if suggestion.error.is_some() {
            return false;
        }

        match suggestion.suggested_decision {
            SuggestedDecision::Allow => decision != Decision::Allow,
            SuggestedDecision::Deny => decision != Decision::Deny,
            SuggestedDecision::Escalate => true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuditRecord {
    pub id: String,
    pub request_id: String,
    pub action: AuditAction,
    pub actor: String,
    pub note: Option<String>,
    pub payload: Value,
    pub created_at: DateTime<Utc>,
}

impl AuditRecord {
    pub fn new(
        request_id: String,
        action: AuditAction,
        actor: String,
        note: Option<String>,
        payload: Value,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            request_id,
            action,
            actor,
            note,
            payload,
            created_at: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DashboardData {
    pub pending_requests: Vec<AccessRequest>,
    pub recent_audit_records: Vec<AuditRecord>,
}

#[derive(Debug, thiserror::Error)]
pub enum DomainError {
    #[error("request {request_id} has already been resolved with status {status:?}")]
    AlreadyResolved {
        request_id: String,
        status: ApprovalStatus,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_decision_updates_request_state() {
        let context = RequestContext::new(
            "secret/api-token".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        );
        let mut request = AccessRequest::new_pending(
            context,
            PolicyMode::ManualOnly,
            None,
            "rendered prompt".to_string(),
            None,
            None,
        );

        let audits = request
            .apply_manual_decision(Decision::Allow, "reviewer", Some("looks safe".to_string()))
            .expect("manual decision should succeed");

        assert_eq!(request.approval_status, ApprovalStatus::Approved);
        assert_eq!(request.final_decision, Some(Decision::Allow));
        assert_eq!(audits.len(), 1);
        assert_eq!(audits[0].action, AuditAction::ApprovalRecorded);
    }

    #[test]
    fn automatic_decision_updates_request_state() {
        let context = RequestContext::new(
            "secret/api-token".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        );
        let mut request = AccessRequest::new_pending(
            context,
            PolicyMode::LlmAutomatic,
            Some("mock".to_string()),
            "rendered prompt".to_string(),
            None,
            None,
        );
        let trace = AutomaticDecisionTrace {
            auto_disposition: AutomaticDisposition::Allow,
            decision_source: crate::AutomaticDecisionSource::CombinedGuardrail,
            matched_rule_ids: vec!["llm_allow_low_risk".to_string()],
            secret_exposure_risk: false,
            provider_called: true,
            suggested_decision: Some(SuggestedDecision::Allow),
            risk_score: Some(20),
            template_id: Some("llm_advice_request".to_string()),
            template_version: Some("2".to_string()),
            prompt_contract_version: Some("sanitized_prompt_context.v2".to_string()),
            provider_kind: Some("mock".to_string()),
            provider_model: Some("mock-suggestion-v1".to_string()),
            x_request_id: None,
            provider_response_id: None,
            redacted_fields: Vec::new(),
            redaction_summary: String::new(),
            auto_rationale_summary:
                "Automatic mode allowed the request because the suggestion was low-risk".to_string(),
            fail_closed: false,
            evaluated_at: Utc::now(),
        };

        let audits = request
            .apply_automatic_decision(trace)
            .expect("automatic decision should succeed");

        assert_eq!(request.approval_status, ApprovalStatus::Approved);
        assert_eq!(request.final_decision, Some(Decision::Allow));
        assert_eq!(audits.len(), 2);
        assert_eq!(audits[0].action, AuditAction::AutomaticDecisionRecorded);
        assert_eq!(audits[1].action, AuditAction::ApprovalRecorded);
    }
}
