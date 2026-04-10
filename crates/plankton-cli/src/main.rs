mod desktop_handoff;

use std::{collections::BTreeMap, env, process::ExitCode, time::Duration};

use anyhow::{bail, Context, Result};
use clap::{ArgGroup, Args, Parser, Subcommand, ValueEnum};
use desktop_handoff::maybe_trigger_desktop_handoff;
use plankton_core::{
    collect_runtime_call_chain, derive_script_path, load_settings, prompt_call_chain_paths,
    AccessRequest, ApprovalStatus, AuditAction, AuditRecord, AutomaticDecisionSource,
    AutomaticDecisionTrace, AutomaticDisposition, Decision, LlmSuggestion, LlmSuggestionUsage,
    PolicyMode, ProviderTrace, RequestContext, SuggestedDecision,
};
use plankton_store::{AccessibleResourceRecord, RequestQueryResult, SqliteStore};
use serde::Serialize;
use serde_json::Value;
use tokio::time::sleep;
use tracing_subscriber::{fmt, EnvFilter};

const GET_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Parser)]
#[command(
    author,
    version,
    about = "Plankton command-line companion for listing, searching, and requesting access",
    arg_required_else_help = true,
    after_help = "Examples:\n  plankton list\n  plankton search api-token\n  plankton get secret/api-token --reason \"Smoke test\" --requested-by alice\n  plankton get secret/api-token --reason \"Auto smoke\" --policy-mode auto\n\nHuman approvals and request history live in the desktop UI. The public CLI surface is intentionally limited to `get`, `list`, and `search`."
)]
struct Cli {
    #[arg(
        long,
        global = true,
        value_enum,
        default_value_t = OutputFormat::Text,
        help = "Choose human-readable text or JSON output"
    )]
    output: OutputFormat,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum OutputFormat {
    Text,
    Json,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum CliPolicyMode {
    #[value(name = "human-review", alias = "manual-only")]
    ManualOnly,
    Auto,
    Assisted,
}

impl From<CliPolicyMode> for PolicyMode {
    fn from(value: CliPolicyMode) -> Self {
        match value {
            CliPolicyMode::ManualOnly => PolicyMode::ManualOnly,
            CliPolicyMode::Auto => PolicyMode::LlmAutomatic,
            CliPolicyMode::Assisted => PolicyMode::Assisted,
        }
    }
}

#[derive(Debug, Subcommand)]
enum Commands {
    #[command(
        visible_alias = "request",
        about = "Request access to one resource and continue the decision flow through Plankton"
    )]
    Get(GetArgs),
    #[command(
        about = "List resource identifiers currently available to the local LLM surface without revealing secret values"
    )]
    List(ListArgs),
    #[command(about = "Fuzzy-search the same accessible resource identifier view used by `list`")]
    Search(SearchArgs),
}

#[derive(Debug, Args)]
#[command(group(
    ArgGroup::new("resource_input")
        .required(true)
        .args(["resource", "resource_flag"]),
))]
struct GetArgs {
    #[arg(
        value_name = "RESOURCE",
        group = "resource_input",
        help = "Sensitive resource identifier, for example `secret/api-token`"
    )]
    resource: Option<String>,
    #[arg(long = "resource", hide = true, group = "resource_input")]
    resource_flag: Option<String>,
    #[arg(long, help = "Why this access attempt is needed")]
    reason: String,
    #[arg(
        long,
        help = "Requester identity. Defaults to the current OS user when omitted"
    )]
    requested_by: Option<String>,
    #[arg(
        long = "env",
        value_name = "KEY=VALUE",
        help = "Repeat to record environment variables in request context"
    )]
    env_vars: Vec<String>,
    #[arg(
        long = "metadata",
        value_name = "KEY=VALUE",
        help = "Repeat to attach extra request metadata"
    )]
    metadata: Vec<String>,
    #[arg(
        long,
        value_enum,
        default_value_t = CliPolicyMode::ManualOnly,
        help = "Choose Human Review, assisted review with an LLM suggestion, or fully automatic LLM disposition"
    )]
    policy_mode: CliPolicyMode,
}

#[derive(Debug, Args)]
struct ListArgs {}

#[derive(Debug, Args)]
struct SearchArgs {
    #[arg(
        value_name = "QUERY",
        help = "Case-insensitive fuzzy match against resource identifiers"
    )]
    query: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum SuggestionStatus {
    NotRequested,
    Available,
    Failed,
    Missing,
}

#[derive(Debug, Clone, Serialize)]
struct SuggestionReport {
    request_id: String,
    policy_mode: PolicyMode,
    approval_status: ApprovalStatus,
    final_decision: Option<Decision>,
    suggestion_status: SuggestionStatus,
    suggestion: Option<SuggestionView>,
}

#[derive(Debug, Clone, Serialize)]
struct SuggestionView {
    suggested_decision: SuggestedDecision,
    rationale_summary: String,
    risk_score: u8,
    risk_level: String,
    template_id: String,
    template_version: String,
    prompt_contract_version: String,
    prompt_sha256: String,
    provider_kind: String,
    provider_model: Option<String>,
    trace_id: Option<String>,
    provider_response_id: Option<String>,
    generated_at: chrono::DateTime<chrono::Utc>,
    error: Option<String>,
    usage: Option<LlmSuggestionUsage>,
    acp_trace: Option<AcpTraceView>,
    claude_trace: Option<ClaudeTraceView>,
}

#[derive(Debug, Clone, Serialize)]
struct AcpTraceView {
    acp_session_id: Option<String>,
    acp_agent_name: Option<String>,
    acp_agent_version: Option<String>,
    acp_package_name: Option<String>,
    acp_package_version: Option<String>,
    acp_transport: Option<String>,
    acp_client_request_id: Option<String>,
}

impl AcpTraceView {
    fn is_empty(&self) -> bool {
        self.acp_session_id.is_none()
            && self.acp_agent_name.is_none()
            && self.acp_agent_version.is_none()
            && self.acp_package_name.is_none()
            && self.acp_package_version.is_none()
            && self.acp_transport.is_none()
            && self.acp_client_request_id.is_none()
    }
}

#[derive(Debug, Clone, Serialize)]
struct ClaudeTraceView {
    protocol: Option<String>,
    api_version: Option<String>,
    output_format: Option<String>,
    stop_reason: Option<String>,
}

impl ClaudeTraceView {
    fn is_empty(&self) -> bool {
        self.protocol.is_none()
            && self.api_version.is_none()
            && self.output_format.is_none()
            && self.stop_reason.is_none()
    }
}

#[derive(Debug, Clone, Serialize)]
struct AutomaticDecisionView {
    auto_disposition: AutomaticDisposition,
    decision_source: AutomaticDecisionSource,
    matched_rule_ids: Vec<String>,
    secret_exposure_risk: bool,
    provider_called: bool,
    suggested_decision: Option<SuggestedDecision>,
    risk_score: Option<u8>,
    template_id: Option<String>,
    template_version: Option<String>,
    prompt_contract_version: Option<String>,
    provider_kind: Option<String>,
    provider_model: Option<String>,
    trace_id: Option<String>,
    provider_response_id: Option<String>,
    redacted_fields: Vec<String>,
    redaction_summary: String,
    auto_rationale_summary: String,
    fail_closed: bool,
    evaluated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize)]
struct RequestSummaryView {
    request_id: String,
    resource: String,
    requested_by: String,
    reason: String,
    policy_mode: PolicyMode,
    approval_status: ApprovalStatus,
    final_decision: Option<Decision>,
    provider_kind: Option<String>,
    script_path: Option<String>,
    call_chain: Vec<String>,
    env_vars: BTreeMap<String, String>,
    metadata: BTreeMap<String, String>,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
    resolved_at: Option<chrono::DateTime<chrono::Utc>>,
    suggestion_status: SuggestionStatus,
    suggestion: Option<SuggestionView>,
    automatic_decision: Option<AutomaticDecisionView>,
}

#[derive(Debug, Clone, Serialize)]
struct StatusOutputView {
    request: RequestSummaryView,
    audit_record_count: usize,
    audit_records: Vec<AuditEntryView>,
}

#[derive(Debug, Clone, Serialize)]
struct AccessibleResourceView {
    resource: String,
    granted_by_request_id: String,
    policy_mode: PolicyMode,
    provider_kind: Option<String>,
    granted_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize)]
struct AccessibleResourceListOutputView {
    resource_count: usize,
    resources: Vec<AccessibleResourceView>,
}

#[cfg(test)]
#[derive(Debug, Clone, Serialize)]
struct AuditOutputView {
    request_id: Option<String>,
    audit_record_count: usize,
    audit_records: Vec<AuditEntryView>,
}

#[derive(Debug, Clone, Serialize)]
struct AuditEntryView {
    request_id: String,
    action: AuditAction,
    actor: String,
    note: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
    suggestion: Option<SuggestionAuditView>,
    automatic_decision: Option<AutomaticDecisionAuditView>,
    payload: Value,
}

#[derive(Debug, Clone, Serialize)]
struct SuggestionAuditView {
    rationale_summary: Option<String>,
    error: Option<String>,
    suggested_decision: Option<SuggestedDecision>,
    risk_score: Option<u8>,
    template_id: Option<String>,
    template_version: Option<String>,
    prompt_contract_version: Option<String>,
    prompt_sha256: Option<String>,
    provider_kind: Option<String>,
    provider_model: Option<String>,
    trace_id: Option<String>,
    provider_response_id: Option<String>,
    acp_trace: Option<AcpTraceView>,
    claude_trace: Option<ClaudeTraceView>,
}

#[derive(Debug, Clone, Serialize)]
struct AutomaticDecisionAuditView {
    auto_disposition: Option<AutomaticDisposition>,
    decision_source: Option<AutomaticDecisionSource>,
    matched_rule_ids: Vec<String>,
    secret_exposure_risk: Option<bool>,
    provider_called: Option<bool>,
    suggested_decision: Option<SuggestedDecision>,
    risk_score: Option<u8>,
    template_id: Option<String>,
    template_version: Option<String>,
    prompt_contract_version: Option<String>,
    provider_kind: Option<String>,
    provider_model: Option<String>,
    trace_id: Option<String>,
    provider_response_id: Option<String>,
    redacted_fields: Vec<String>,
    redaction_summary: Option<String>,
    auto_rationale_summary: Option<String>,
    fail_closed: Option<bool>,
    evaluated_at: Option<String>,
}

#[tokio::main]
async fn main() -> ExitCode {
    init_tracing();

    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            for cause in error.chain().skip(1) {
                eprintln!("caused by: {cause}");
            }

            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<()> {
    let Cli { output, command } = Cli::parse();
    let settings = load_settings().context("failed to load Plankton settings")?;
    let store = SqliteStore::new(&settings)
        .await
        .context("failed to initialize SQLite store")?;

    match command {
        Commands::Get(args) => {
            let GetArgs {
                resource,
                resource_flag,
                reason,
                requested_by,
                env_vars,
                metadata,
                policy_mode,
            } = args;
            let call_chain =
                collect_runtime_call_chain().context("failed to collect runtime call chain")?;
            let mut context = RequestContext::new(
                resource
                    .or(resource_flag)
                    .expect("clap should require a resource"),
                reason,
                requested_by.unwrap_or_else(default_actor),
            );
            context.script_path = derive_script_path(&call_chain);
            context.call_chain = call_chain;
            context.env_vars = parse_key_values("env", env_vars)?;
            context.metadata = parse_key_values("metadata", metadata)?;

            let request = store
                .submit_request(&settings, context, policy_mode.into())
                .await
                .context("failed to submit access request")?;
            maybe_trigger_desktop_handoff(&request)?;
            let result = wait_for_terminal_request(&store, &request.id).await?;
            let get_output = build_status_output(&result);
            print_output(output, &get_output, || render_status_text(&result))?;
        }
        Commands::List(_) => {
            let resources = store
                .list_accessible_resources()
                .await
                .context("failed to list accessible resource identifiers")?;
            let list_output = build_accessible_resource_list_output(&resources);
            print_output(output, &list_output, || {
                render_accessible_resource_list_text(&resources)
            })?;
        }
        Commands::Search(args) => {
            let resources = store
                .list_accessible_resources()
                .await
                .context("failed to load accessible resource identifiers for search")?;
            let filtered = filter_accessible_resources(&resources, &args.query);
            let list_output = build_accessible_resource_list_output(&filtered);
            print_output(output, &list_output, || {
                render_accessible_resource_list_text(&filtered)
            })?;
        }
    }

    Ok(())
}

async fn wait_for_terminal_request(
    store: &SqliteStore,
    request_id: &str,
) -> Result<RequestQueryResult> {
    loop {
        let result = store
            .get_request(request_id)
            .await
            .with_context(|| format!("failed to load request {request_id}"))?;
        if result.request.approval_status != ApprovalStatus::Pending {
            return Ok(result);
        }

        sleep(GET_POLL_INTERVAL).await;
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt().with_env_filter(filter).without_time().try_init();
}

fn default_actor() -> String {
    env::var("USER")
        .or_else(|_| env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn print_output<T>(
    output: OutputFormat,
    value: &T,
    render_text: impl FnOnce() -> String,
) -> Result<()>
where
    T: Serialize,
{
    match output {
        OutputFormat::Text => println!("{}", render_text()),
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(value).context("failed to serialize CLI output")?
        ),
    }

    Ok(())
}

fn filter_accessible_resources(
    resources: &[AccessibleResourceRecord],
    query: &str,
) -> Vec<AccessibleResourceRecord> {
    let query = query.trim().to_ascii_lowercase();
    resources
        .iter()
        .filter(|resource| resource.resource.to_ascii_lowercase().contains(&query))
        .cloned()
        .collect()
}

fn build_suggestion_report(request: &AccessRequest) -> SuggestionReport {
    let suggestion_status = match request.llm_suggestion.as_ref() {
        Some(suggestion) if suggestion.error.is_some() => SuggestionStatus::Failed,
        Some(_) => SuggestionStatus::Available,
        None if request.policy_mode == PolicyMode::ManualOnly => SuggestionStatus::NotRequested,
        None if request.policy_mode == PolicyMode::LlmAutomatic
            && request
                .automatic_decision
                .as_ref()
                .map(|decision| !decision.provider_called)
                .unwrap_or(false) =>
        {
            SuggestionStatus::NotRequested
        }
        None => SuggestionStatus::Missing,
    };

    SuggestionReport {
        request_id: request.id.clone(),
        policy_mode: request.policy_mode,
        approval_status: request.approval_status,
        final_decision: request.final_decision,
        suggestion_status,
        suggestion: request.llm_suggestion.as_ref().map(build_suggestion_view),
    }
}

fn build_suggestion_view(suggestion: &LlmSuggestion) -> SuggestionView {
    SuggestionView {
        suggested_decision: suggestion.suggested_decision,
        rationale_summary: suggestion.rationale_summary.clone(),
        risk_score: suggestion.risk_score,
        risk_level: classify_risk(suggestion.risk_score).to_string(),
        template_id: suggestion.template_id.clone(),
        template_version: suggestion.template_version.clone(),
        prompt_contract_version: suggestion.prompt_contract_version.clone(),
        prompt_sha256: suggestion.prompt_sha256.clone(),
        provider_kind: suggestion.provider_kind.clone(),
        provider_model: suggestion.provider_model.clone(),
        trace_id: suggestion.x_request_id.clone(),
        provider_response_id: suggestion.provider_response_id.clone(),
        generated_at: suggestion.generated_at,
        error: suggestion.error.clone(),
        usage: suggestion.usage.clone(),
        acp_trace: build_acp_trace_view(
            Some(suggestion.provider_kind.as_str()),
            suggestion.provider_trace.as_ref(),
        ),
        claude_trace: build_claude_trace_view(
            Some(suggestion.provider_kind.as_str()),
            suggestion.provider_trace.as_ref(),
        ),
    }
}

fn build_acp_trace_view(
    provider_kind: Option<&str>,
    trace: Option<&ProviderTrace>,
) -> Option<AcpTraceView> {
    build_acp_trace_view_from_parts(
        provider_kind,
        trace.and_then(|trace| trace.session_id.clone()),
        trace.and_then(|trace| trace.agent_name.clone()),
        trace.and_then(|trace| trace.agent_version.clone()),
        trace.and_then(|trace| trace.package_name.clone()),
        trace.and_then(|trace| trace.package_version.clone()),
        trace.and_then(|trace| trace.transport.clone()),
        trace.and_then(|trace| trace.client_request_id.clone()),
    )
}

fn build_audit_acp_trace_view(
    payload: &Value,
    provider_kind: Option<&str>,
) -> Option<AcpTraceView> {
    build_acp_trace_view_from_parts(
        provider_kind,
        payload_nested_string(payload, "provider_trace", "session_id"),
        payload_nested_string(payload, "provider_trace", "agent_name"),
        payload_nested_string(payload, "provider_trace", "agent_version"),
        payload_nested_string(payload, "provider_trace", "package_name"),
        payload_nested_string(payload, "provider_trace", "package_version"),
        payload_nested_string(payload, "provider_trace", "transport"),
        payload_nested_string(payload, "provider_trace", "client_request_id"),
    )
}

fn build_acp_trace_view_from_parts(
    provider_kind: Option<&str>,
    acp_session_id: Option<String>,
    acp_agent_name: Option<String>,
    acp_agent_version: Option<String>,
    acp_package_name: Option<String>,
    acp_package_version: Option<String>,
    acp_transport: Option<String>,
    acp_client_request_id: Option<String>,
) -> Option<AcpTraceView> {
    if provider_kind != Some("acp_codex") {
        return None;
    }

    let trace = AcpTraceView {
        acp_session_id,
        acp_agent_name,
        acp_agent_version,
        acp_package_name,
        acp_package_version,
        acp_transport,
        acp_client_request_id,
    };

    (!trace.is_empty()).then_some(trace)
}

fn build_request_summary_view(request: &AccessRequest) -> RequestSummaryView {
    let suggestion_report = build_suggestion_report(request);

    RequestSummaryView {
        request_id: request.id.clone(),
        resource: request.context.resource.clone(),
        requested_by: request.context.requested_by.clone(),
        reason: request.context.reason.clone(),
        policy_mode: request.policy_mode,
        approval_status: request.approval_status,
        final_decision: request.final_decision,
        provider_kind: request.provider_kind.clone(),
        script_path: request.context.script_path.clone(),
        call_chain: prompt_call_chain_paths(&request.context.call_chain),
        env_vars: request.context.env_vars.clone(),
        metadata: request.context.metadata.clone(),
        created_at: request.created_at,
        updated_at: request.updated_at,
        resolved_at: request.resolved_at,
        suggestion_status: suggestion_report.suggestion_status,
        suggestion: suggestion_report.suggestion,
        automatic_decision: request
            .automatic_decision
            .as_ref()
            .map(build_automatic_decision_view),
    }
}

fn build_claude_trace_view(
    provider_kind: Option<&str>,
    trace: Option<&ProviderTrace>,
) -> Option<ClaudeTraceView> {
    build_claude_trace_view_from_parts(
        provider_kind,
        trace.and_then(|trace| trace.protocol.clone()),
        trace.and_then(|trace| trace.api_version.clone()),
        trace.and_then(|trace| trace.output_format.clone()),
        trace.and_then(|trace| trace.stop_reason.clone()),
    )
}

fn build_audit_claude_trace_view(
    payload: &Value,
    provider_kind: Option<&str>,
) -> Option<ClaudeTraceView> {
    build_claude_trace_view_from_parts(
        provider_kind,
        payload_nested_string(payload, "provider_trace", "protocol"),
        payload_nested_string(payload, "provider_trace", "api_version"),
        payload_nested_string(payload, "provider_trace", "output_format"),
        payload_nested_string(payload, "provider_trace", "stop_reason"),
    )
}

fn build_claude_trace_view_from_parts(
    provider_kind: Option<&str>,
    protocol: Option<String>,
    api_version: Option<String>,
    output_format: Option<String>,
    stop_reason: Option<String>,
) -> Option<ClaudeTraceView> {
    if provider_kind != Some("claude") {
        return None;
    }

    let trace = ClaudeTraceView {
        protocol,
        api_version,
        output_format,
        stop_reason,
    };

    (!trace.is_empty()).then_some(trace)
}

fn build_status_output(result: &RequestQueryResult) -> StatusOutputView {
    StatusOutputView {
        request: build_request_summary_view(&result.request),
        audit_record_count: result.audit_records.len(),
        audit_records: result
            .audit_records
            .iter()
            .map(build_audit_entry_view)
            .collect(),
    }
}

fn build_accessible_resource_list_output(
    resources: &[AccessibleResourceRecord],
) -> AccessibleResourceListOutputView {
    AccessibleResourceListOutputView {
        resource_count: resources.len(),
        resources: resources
            .iter()
            .map(|resource| AccessibleResourceView {
                resource: resource.resource.clone(),
                granted_by_request_id: resource.granted_by_request_id.clone(),
                policy_mode: resource.policy_mode,
                provider_kind: resource.provider_kind.clone(),
                granted_at: resource.granted_at,
            })
            .collect(),
    }
}

#[cfg(test)]
fn build_audit_output(request_id: Option<&str>, records: &[AuditRecord]) -> AuditOutputView {
    AuditOutputView {
        request_id: request_id.map(ToOwned::to_owned),
        audit_record_count: records.len(),
        audit_records: records.iter().map(build_audit_entry_view).collect(),
    }
}

fn build_audit_entry_view(record: &AuditRecord) -> AuditEntryView {
    AuditEntryView {
        request_id: record.request_id.clone(),
        action: record.action,
        actor: record.actor.clone(),
        note: record.note.clone(),
        created_at: record.created_at,
        suggestion: build_suggestion_audit_view(record),
        automatic_decision: build_automatic_audit_view(record),
        payload: record.payload.clone(),
    }
}

fn build_suggestion_audit_view(record: &AuditRecord) -> Option<SuggestionAuditView> {
    match record.action {
        AuditAction::LlmSuggestionGenerated | AuditAction::LlmSuggestionFailed => {
            let provider_kind = payload_string(&record.payload, "provider_kind")
                .or_else(|| Some(record.actor.clone()));
            Some(SuggestionAuditView {
                rationale_summary: matches!(record.action, AuditAction::LlmSuggestionGenerated)
                    .then(|| record.note.clone())
                    .flatten(),
                error: matches!(record.action, AuditAction::LlmSuggestionFailed)
                    .then(|| record.note.clone())
                    .flatten(),
                suggested_decision: payload_enum::<SuggestedDecision>(
                    &record.payload,
                    "suggested_decision",
                ),
                risk_score: payload_u8(&record.payload, "risk_score"),
                template_id: payload_string(&record.payload, "template_id"),
                template_version: payload_string(&record.payload, "template_version"),
                prompt_contract_version: payload_string(&record.payload, "prompt_contract_version"),
                prompt_sha256: payload_string(&record.payload, "prompt_sha256"),
                provider_kind: provider_kind.clone(),
                provider_model: payload_string(&record.payload, "provider_model"),
                trace_id: payload_string(&record.payload, "x_request_id"),
                provider_response_id: payload_string(&record.payload, "provider_response_id"),
                acp_trace: build_audit_acp_trace_view(&record.payload, provider_kind.as_deref()),
                claude_trace: build_audit_claude_trace_view(
                    &record.payload,
                    provider_kind.as_deref(),
                ),
            })
        }
        AuditAction::HumanDecisionOverrodeLlm => Some(SuggestionAuditView {
            rationale_summary: record.note.clone(),
            error: None,
            suggested_decision: payload_enum::<SuggestedDecision>(
                &record.payload,
                "suggested_decision",
            ),
            risk_score: payload_u8(&record.payload, "risk_score"),
            template_id: None,
            template_version: None,
            prompt_contract_version: None,
            prompt_sha256: None,
            provider_kind: None,
            provider_model: None,
            trace_id: None,
            provider_response_id: None,
            acp_trace: None,
            claude_trace: None,
        }),
        _ => None,
    }
}

fn build_automatic_audit_view(record: &AuditRecord) -> Option<AutomaticDecisionAuditView> {
    match record.action {
        AuditAction::AutomaticDecisionRecorded | AuditAction::AutomaticEscalatedToHuman => {
            Some(AutomaticDecisionAuditView {
                auto_disposition: payload_enum::<AutomaticDisposition>(
                    &record.payload,
                    "auto_disposition",
                ),
                decision_source: payload_enum::<AutomaticDecisionSource>(
                    &record.payload,
                    "decision_source",
                ),
                matched_rule_ids: payload_string_vec(&record.payload, "matched_rule_ids"),
                secret_exposure_risk: payload_bool(&record.payload, "secret_exposure_risk"),
                provider_called: payload_bool(&record.payload, "provider_called"),
                suggested_decision: payload_enum::<SuggestedDecision>(
                    &record.payload,
                    "suggested_decision",
                ),
                risk_score: payload_u8(&record.payload, "risk_score"),
                template_id: payload_string(&record.payload, "template_id"),
                template_version: payload_string(&record.payload, "template_version"),
                prompt_contract_version: payload_string(&record.payload, "prompt_contract_version"),
                provider_kind: payload_string(&record.payload, "provider_kind"),
                provider_model: payload_string(&record.payload, "provider_model"),
                trace_id: payload_string(&record.payload, "x_request_id"),
                provider_response_id: payload_string(&record.payload, "provider_response_id"),
                redacted_fields: payload_string_vec(&record.payload, "redacted_fields"),
                redaction_summary: payload_string(&record.payload, "redaction_summary"),
                auto_rationale_summary: payload_string(&record.payload, "auto_rationale_summary")
                    .or_else(|| record.note.clone()),
                fail_closed: payload_bool(&record.payload, "fail_closed"),
                evaluated_at: payload_string(&record.payload, "evaluated_at"),
            })
        }
        _ => None,
    }
}

fn build_automatic_decision_view(decision: &AutomaticDecisionTrace) -> AutomaticDecisionView {
    AutomaticDecisionView {
        auto_disposition: decision.auto_disposition,
        decision_source: decision.decision_source,
        matched_rule_ids: decision.matched_rule_ids.clone(),
        secret_exposure_risk: decision.secret_exposure_risk,
        provider_called: decision.provider_called,
        suggested_decision: decision.suggested_decision,
        risk_score: decision.risk_score,
        template_id: decision.template_id.clone(),
        template_version: decision.template_version.clone(),
        prompt_contract_version: decision.prompt_contract_version.clone(),
        provider_kind: decision.provider_kind.clone(),
        provider_model: decision.provider_model.clone(),
        trace_id: decision.x_request_id.clone(),
        provider_response_id: decision.provider_response_id.clone(),
        redacted_fields: decision.redacted_fields.clone(),
        redaction_summary: decision.redaction_summary.clone(),
        auto_rationale_summary: decision.auto_rationale_summary.clone(),
        fail_closed: decision.fail_closed,
        evaluated_at: decision.evaluated_at,
    }
}

fn classify_risk(score: u8) -> &'static str {
    match score {
        0..=29 => "low",
        30..=69 => "medium",
        _ => "high",
    }
}

fn render_status_text(result: &RequestQueryResult) -> String {
    if result.audit_records.is_empty() {
        let lines = vec![
            render_request_text(&result.request),
            "audit_timeline: -".to_string(),
        ];
        return lines.join("\n");
    }

    let timeline = result
        .audit_records
        .iter()
        .map(|record| {
            format!(
                "- {} action={} actor={} note={} payload={}",
                record.created_at.to_rfc3339(),
                enum_label(&record.action),
                record.actor,
                optional_str(record.note.as_deref()),
                format_payload(&record.payload)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let lines = vec![
        render_request_text(&result.request),
        format!("audit_record_count: {}", result.audit_records.len()),
        "audit_timeline:".to_string(),
        timeline,
    ];

    lines.join("\n")
}

fn render_accessible_resource_list_text(resources: &[AccessibleResourceRecord]) -> String {
    if resources.is_empty() {
        return "resource_count: 0".to_string();
    }

    let entries = resources
        .iter()
        .enumerate()
        .map(|(index, resource)| {
            [
                format!("[{}]", index + 1),
                format!("resource: {}", resource.resource),
                format!("granted_by_request_id: {}", resource.granted_by_request_id),
                format!("policy_mode: {}", enum_label(&resource.policy_mode)),
                format!(
                    "provider_kind: {}",
                    optional_str(resource.provider_kind.as_deref())
                ),
                format!("granted_at: {}", resource.granted_at.to_rfc3339()),
            ]
            .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    format!("resource_count: {}\n\n{}", resources.len(), entries)
}

#[cfg(test)]
fn render_audit_text(records: &[AuditRecord], request_id: Option<&str>) -> String {
    let mut header = vec![format!("audit_record_count: {}", records.len())];
    if let Some(request_id) = request_id {
        header.push(format!("request_id: {request_id}"));
    }

    if records.is_empty() {
        header.push("audit_records: -".to_string());
        return header.join("\n");
    }

    let entries = records
        .iter()
        .enumerate()
        .map(|(index, record)| render_audit_record_text(index + 1, record))
        .collect::<Vec<_>>()
        .join("\n\n");

    header.push(String::new());
    header.push(entries);
    header.join("\n")
}

#[cfg(test)]
fn render_suggestion_report_text(report: &SuggestionReport) -> String {
    let mut lines = vec![
        format!("request_id: {}", report.request_id),
        format!("policy_mode: {}", enum_label(&report.policy_mode)),
        format!("approval_status: {}", enum_label(&report.approval_status)),
        format!(
            "final_decision: {}",
            optional_enum_label(&report.final_decision)
        ),
    ];
    lines.extend(render_suggestion_summary_lines(report));
    lines.join("\n")
}

#[cfg(test)]
fn render_queue_suggestion_summary(request: &AccessRequest) -> Option<String> {
    let report = build_suggestion_report(request);
    match &report.suggestion {
        Some(suggestion) if report.suggestion_status == SuggestionStatus::Failed => {
            let mut summary = format!(
                "llm_suggestion: failed provider={} model={} trace_id={} response_id={} error={}",
                suggestion.provider_kind,
                optional_str(suggestion.provider_model.as_deref()),
                optional_str(suggestion.trace_id.as_deref()),
                optional_str(suggestion.provider_response_id.as_deref()),
                optional_str(suggestion.error.as_deref())
            );
            if let Some(acp_summary) = render_inline_acp_trace(suggestion.acp_trace.as_ref()) {
                summary.push(' ');
                summary.push_str(acp_summary.as_str());
            }
            if let Some(claude_summary) =
                render_inline_claude_trace(suggestion.claude_trace.as_ref())
            {
                summary.push(' ');
                summary.push_str(claude_summary.as_str());
            }
            Some(summary)
        }
        Some(suggestion) => {
            let mut summary = format!(
                "llm_suggestion: {} risk={} ({}) provider={} model={} trace_id={} response_id={}",
                enum_label(&suggestion.suggested_decision),
                suggestion.risk_score,
                suggestion.risk_level,
                suggestion.provider_kind,
                optional_str(suggestion.provider_model.as_deref()),
                optional_str(suggestion.trace_id.as_deref()),
                optional_str(suggestion.provider_response_id.as_deref())
            );
            if let Some(acp_summary) = render_inline_acp_trace(suggestion.acp_trace.as_ref()) {
                summary.push(' ');
                summary.push_str(acp_summary.as_str());
            }
            if let Some(claude_summary) =
                render_inline_claude_trace(suggestion.claude_trace.as_ref())
            {
                summary.push(' ');
                summary.push_str(claude_summary.as_str());
            }
            Some(summary)
        }
        None if report.suggestion_status == SuggestionStatus::Missing => {
            Some("llm_suggestion: missing".to_string())
        }
        _ => None,
    }
}

#[cfg(test)]
fn render_queue_automatic_summary(request: &AccessRequest) -> Option<String> {
    request.automatic_decision.as_ref().map(|decision| {
        format!(
            "automatic_decision: {} source={} provider_called={} matched_rule_ids={} llm_decision={} llm_risk={} rationale={}",
            enum_label(&decision.auto_disposition),
            enum_label(&decision.decision_source),
            decision.provider_called,
            format_list(&decision.matched_rule_ids, ", "),
            optional_enum_label_or(&decision.suggested_decision, "-"),
            decision
                .risk_score
                .map(|score| score.to_string())
                .unwrap_or_else(|| "-".to_string()),
            decision.auto_rationale_summary
        )
    })
}

#[cfg(test)]
fn render_audit_record_text(index: usize, record: &AuditRecord) -> String {
    let mut lines = vec![
        format!("[{index}]"),
        format!("request_id: {}", record.request_id),
        format!("action: {}", enum_label(&record.action)),
        format!("actor: {}", record.actor),
        format!("created_at: {}", record.created_at.to_rfc3339()),
    ];

    match record.action {
        AuditAction::LlmSuggestionGenerated => {
            lines.push(format!(
                "rationale_summary: {}",
                optional_str(record.note.as_deref())
            ));
            lines.extend(render_audit_suggestion_fields(record));
        }
        AuditAction::LlmSuggestionFailed => {
            lines.push(format!("error: {}", optional_str(record.note.as_deref())));
            lines.extend(render_audit_suggestion_fields(record));
        }
        AuditAction::HumanDecisionOverrodeLlm => {
            lines.push(format!("note: {}", optional_str(record.note.as_deref())));
            lines.push(format!(
                "suggested_decision: {}",
                payload_field(&record.payload, "suggested_decision")
            ));
            lines.push(format!(
                "risk_score: {}",
                payload_field(&record.payload, "risk_score")
            ));
        }
        AuditAction::AutomaticDecisionRecorded | AuditAction::AutomaticEscalatedToHuman => {
            lines.push(format!("note: {}", optional_str(record.note.as_deref())));
            lines.extend(render_automatic_audit_fields(&record.payload));
        }
        _ => lines.push(format!("note: {}", optional_str(record.note.as_deref()))),
    }

    lines.push(format!("payload: {}", format_payload(&record.payload)));
    lines.join("\n")
}

#[cfg(test)]
fn render_audit_suggestion_fields(record: &AuditRecord) -> Vec<String> {
    let provider_kind =
        payload_string(&record.payload, "provider_kind").or_else(|| Some(record.actor.clone()));
    let acp_trace = build_audit_acp_trace_view(&record.payload, provider_kind.as_deref());
    let claude_trace = build_audit_claude_trace_view(&record.payload, provider_kind.as_deref());
    let mut lines = vec![
        format!(
            "suggested_decision: {}",
            payload_field(&record.payload, "suggested_decision")
        ),
        format!(
            "risk_score: {}",
            payload_field(&record.payload, "risk_score")
        ),
        format!(
            "template_version: {}",
            format_template_ref(
                payload_field(&record.payload, "template_id").as_str(),
                payload_field(&record.payload, "template_version").as_str()
            )
        ),
        format!("provider_kind: {}", optional_str(provider_kind.as_deref())),
        format!(
            "provider_model: {}",
            payload_field(&record.payload, "provider_model")
        ),
        format!(
            "trace_id: {}",
            payload_field(&record.payload, "x_request_id")
        ),
        format!(
            "provider_response_id: {}",
            payload_field(&record.payload, "provider_response_id")
        ),
    ];
    lines.extend(render_acp_trace_lines(acp_trace.as_ref()));
    lines.extend(render_claude_trace_lines(claude_trace.as_ref()));
    lines
}

#[cfg(test)]
fn render_automatic_audit_fields(payload: &Value) -> Vec<String> {
    vec![
        format!(
            "auto_disposition: {}",
            payload_field(payload, "auto_disposition")
        ),
        format!(
            "decision_source: {}",
            payload_field(payload, "decision_source")
        ),
        format!(
            "matched_rule_ids: {}",
            payload_field(payload, "matched_rule_ids")
        ),
        format!(
            "secret_exposure_risk: {}",
            payload_field(payload, "secret_exposure_risk")
        ),
        format!(
            "provider_called: {}",
            payload_field(payload, "provider_called")
        ),
        format!(
            "suggested_decision: {}",
            payload_field(payload, "suggested_decision")
        ),
        format!("risk_score: {}", payload_field(payload, "risk_score")),
        format!(
            "template_version: {}",
            format_template_ref(
                payload_field(payload, "template_id").as_str(),
                payload_field(payload, "template_version").as_str()
            )
        ),
        format!("trace_id: {}", payload_field(payload, "x_request_id")),
        format!(
            "redacted_fields: {}",
            payload_field(payload, "redacted_fields")
        ),
        format!(
            "redaction_summary: {}",
            payload_field(payload, "redaction_summary")
        ),
        format!(
            "auto_rationale_summary: {}",
            payload_field(payload, "auto_rationale_summary")
        ),
    ]
}

fn render_request_text(request: &AccessRequest) -> String {
    let suggestion_report = build_suggestion_report(request);
    let mut lines = vec![
        format!("request_id: {}", request.id),
        format!("resource: {}", request.context.resource),
        format!("requested_by: {}", request.context.requested_by),
        format!("reason: {}", request.context.reason),
        format!("policy_mode: {}", enum_label(&request.policy_mode)),
        format!("approval_status: {}", enum_label(&request.approval_status)),
        format!(
            "final_decision: {}",
            optional_enum_label(&request.final_decision)
        ),
        format!(
            "provider_kind: {}",
            optional_str(request.provider_kind.as_deref())
        ),
        format!(
            "script_path: {}",
            optional_str(request.context.script_path.as_deref())
        ),
        format!(
            "call_chain: {}",
            format_list(
                &prompt_call_chain_paths(&request.context.call_chain),
                " -> "
            )
        ),
        format!("env_vars: {}", format_map(&request.context.env_vars)),
        format!("metadata: {}", format_map(&request.context.metadata)),
        format!("created_at: {}", request.created_at.to_rfc3339()),
        format!("updated_at: {}", request.updated_at.to_rfc3339()),
        format!(
            "resolved_at: {}",
            request
                .resolved_at
                .as_ref()
                .map(|value| value.to_rfc3339())
                .unwrap_or_else(|| "-".to_string())
        ),
    ];

    lines.extend(render_suggestion_summary_lines(&suggestion_report));
    lines.extend(render_automatic_summary_lines(
        request.automatic_decision.as_ref(),
    ));

    if let Some(provider_input) = &request.provider_input {
        lines.extend([
            format!("provider_template_id: {}", provider_input.template_id),
            format!(
                "provider_template_version: {}",
                provider_input.template_version
            ),
            format!(
                "provider_prompt_contract_version: {}",
                provider_input.prompt_contract_version
            ),
            format!("provider_prompt_sha256: {}", provider_input.prompt_sha256),
            format!(
                "provider_visible_env_vars: {}",
                format_list(&provider_input.sanitized_context.env_var_names, ", ")
            ),
            format!(
                "provider_redacted_fields: {}",
                format_list(&provider_input.sanitized_context.redacted_fields, ", ")
            ),
            format!(
                "provider_redaction_summary: {}",
                provider_input.sanitized_context.redaction_summary
            ),
        ]);
    }

    lines.join("\n")
}

fn render_automatic_summary_lines(decision: Option<&AutomaticDecisionTrace>) -> Vec<String> {
    let Some(decision) = decision else {
        return vec!["automatic_disposition: -".to_string()];
    };
    let decision = build_automatic_decision_view(decision);

    vec![
        format!(
            "automatic_disposition: {}",
            enum_label(&decision.auto_disposition)
        ),
        format!(
            "automatic_decision_source: {}",
            enum_label(&decision.decision_source)
        ),
        format!(
            "automatic_matched_rule_ids: {}",
            format_list(&decision.matched_rule_ids, ", ")
        ),
        format!(
            "automatic_secret_exposure_risk: {}",
            decision.secret_exposure_risk
        ),
        format!("automatic_provider_called: {}", decision.provider_called),
        format!(
            "automatic_suggested_decision: {}",
            optional_enum_label_or(&decision.suggested_decision, "-")
        ),
        format!(
            "automatic_risk_score: {}",
            decision
                .risk_score
                .map(|score| score.to_string())
                .unwrap_or_else(|| "-".to_string())
        ),
        format!(
            "automatic_template_version: {}",
            format_template_ref(
                decision.template_id.as_deref().unwrap_or_default(),
                decision.template_version.as_deref().unwrap_or_default()
            )
        ),
        format!(
            "automatic_prompt_contract_version: {}",
            optional_str(decision.prompt_contract_version.as_deref())
        ),
        format!(
            "automatic_provider_kind: {}",
            optional_str(decision.provider_kind.as_deref())
        ),
        format!(
            "automatic_provider_model: {}",
            optional_str(decision.provider_model.as_deref())
        ),
        format!(
            "automatic_trace_id: {}",
            optional_str(decision.trace_id.as_deref())
        ),
        format!(
            "automatic_provider_response_id: {}",
            optional_str(decision.provider_response_id.as_deref())
        ),
        format!(
            "automatic_redacted_fields: {}",
            format_list(&decision.redacted_fields, ", ")
        ),
        format!(
            "automatic_redaction_summary: {}",
            decision.redaction_summary
        ),
        format!(
            "automatic_rationale_summary: {}",
            decision.auto_rationale_summary
        ),
        format!("automatic_fail_closed: {}", decision.fail_closed),
        format!(
            "automatic_evaluated_at: {}",
            decision.evaluated_at.to_rfc3339()
        ),
    ]
}

fn render_suggestion_summary_lines(report: &SuggestionReport) -> Vec<String> {
    let mut lines = vec![format!(
        "suggestion_status: {}",
        enum_label(&report.suggestion_status)
    )];

    let Some(suggestion) = &report.suggestion else {
        return lines;
    };

    lines.extend([
        format!(
            "suggested_decision: {}",
            enum_label(&suggestion.suggested_decision)
        ),
        format!("rationale_summary: {}", suggestion.rationale_summary),
        format!(
            "risk_score: {} ({})",
            suggestion.risk_score, suggestion.risk_level
        ),
        format!(
            "template_version: {}",
            format_template_ref(
                suggestion.template_id.as_str(),
                suggestion.template_version.as_str()
            )
        ),
        format!(
            "prompt_contract_version: {}",
            suggestion.prompt_contract_version
        ),
        format!("provider_kind: {}", suggestion.provider_kind),
        format!(
            "provider_model: {}",
            optional_str(suggestion.provider_model.as_deref())
        ),
        format!("trace_id: {}", optional_str(suggestion.trace_id.as_deref())),
        format!(
            "provider_response_id: {}",
            optional_str(suggestion.provider_response_id.as_deref())
        ),
        format!("generated_at: {}", suggestion.generated_at.to_rfc3339()),
        format!("error: {}", optional_str(suggestion.error.as_deref())),
        format!("usage: {}", format_usage(suggestion.usage.as_ref())),
        format!("prompt_sha256: {}", suggestion.prompt_sha256),
    ]);
    lines.extend(render_acp_trace_lines(suggestion.acp_trace.as_ref()));
    lines.extend(render_claude_trace_lines(suggestion.claude_trace.as_ref()));

    lines
}

fn render_acp_trace_lines(acp_trace: Option<&AcpTraceView>) -> Vec<String> {
    let Some(acp_trace) = acp_trace else {
        return Vec::new();
    };

    vec![
        format!(
            "acp_session_id: {}",
            optional_str(acp_trace.acp_session_id.as_deref())
        ),
        format!(
            "acp_agent_name: {}",
            optional_str(acp_trace.acp_agent_name.as_deref())
        ),
        format!(
            "acp_agent_version: {}",
            optional_str(acp_trace.acp_agent_version.as_deref())
        ),
        format!(
            "acp_package_name: {}",
            optional_str(acp_trace.acp_package_name.as_deref())
        ),
        format!(
            "acp_package_version: {}",
            optional_str(acp_trace.acp_package_version.as_deref())
        ),
        format!(
            "acp_transport: {}",
            optional_str(acp_trace.acp_transport.as_deref())
        ),
        format!(
            "acp_client_request_id: {}",
            optional_str(acp_trace.acp_client_request_id.as_deref())
        ),
    ]
}

#[cfg(test)]
fn render_inline_acp_trace(acp_trace: Option<&AcpTraceView>) -> Option<String> {
    let acp_trace = acp_trace?;

    Some(format!(
        "acp_session_id={} acp_agent_name={} acp_agent_version={} acp_package_version={} acp_transport={} acp_client_request_id={}",
        optional_str(acp_trace.acp_session_id.as_deref()),
        optional_str(acp_trace.acp_agent_name.as_deref()),
        optional_str(acp_trace.acp_agent_version.as_deref()),
        optional_str(acp_trace.acp_package_version.as_deref()),
        optional_str(acp_trace.acp_transport.as_deref()),
        optional_str(acp_trace.acp_client_request_id.as_deref())
    ))
}

fn render_claude_trace_lines(claude_trace: Option<&ClaudeTraceView>) -> Vec<String> {
    let Some(claude_trace) = claude_trace else {
        return Vec::new();
    };

    vec![
        format!(
            "provider_trace.protocol: {}",
            optional_str(claude_trace.protocol.as_deref())
        ),
        format!(
            "provider_trace.api_version: {}",
            optional_str(claude_trace.api_version.as_deref())
        ),
        format!(
            "provider_trace.output_format: {}",
            optional_str(claude_trace.output_format.as_deref())
        ),
        format!(
            "provider_trace.stop_reason: {}",
            optional_str(claude_trace.stop_reason.as_deref())
        ),
    ]
}

#[cfg(test)]
fn render_inline_claude_trace(claude_trace: Option<&ClaudeTraceView>) -> Option<String> {
    let claude_trace = claude_trace?;

    Some(format!(
        "provider_trace.protocol={} provider_trace.api_version={} provider_trace.output_format={} provider_trace.stop_reason={}",
        optional_str(claude_trace.protocol.as_deref()),
        optional_str(claude_trace.api_version.as_deref()),
        optional_str(claude_trace.output_format.as_deref()),
        optional_str(claude_trace.stop_reason.as_deref())
    ))
}

fn format_usage(usage: Option<&LlmSuggestionUsage>) -> String {
    usage
        .map(|usage| {
            format!(
                "prompt_tokens={}, completion_tokens={}, total_tokens={}",
                usage.prompt_tokens, usage.completion_tokens, usage.total_tokens
            )
        })
        .unwrap_or_else(|| "-".to_string())
}

fn format_template_ref(template_id: &str, template_version: &str) -> String {
    if template_id.is_empty() && template_version.is_empty() {
        return "-".to_string();
    }
    if template_id.is_empty() {
        return template_version.to_string();
    }
    if template_version.is_empty() {
        return template_id.to_string();
    }

    format!("{template_id}@{template_version}")
}

fn format_map(values: &BTreeMap<String, String>) -> String {
    if values.is_empty() {
        return "-".to_string();
    }

    values
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn format_list(values: &[String], separator: &str) -> String {
    if values.is_empty() {
        return "-".to_string();
    }

    values.join(separator)
}

fn optional_str(value: Option<&str>) -> String {
    value.unwrap_or("-").to_string()
}

fn optional_enum_label<T>(value: &Option<T>) -> String
where
    T: Serialize,
{
    optional_enum_label_or(value, "pending")
}

fn optional_enum_label_or<T>(value: &Option<T>, default: &str) -> String
where
    T: Serialize,
{
    value
        .as_ref()
        .map(enum_label)
        .unwrap_or_else(|| default.to_string())
}

fn enum_label<T>(value: &T) -> String
where
    T: Serialize,
{
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "-".to_string())
}

fn format_payload(payload: &Value) -> String {
    match payload {
        Value::Null => "-".to_string(),
        Value::Object(values) if values.is_empty() => "-".to_string(),
        Value::Object(values) => {
            let mut entries = values
                .iter()
                .map(|(key, value)| format!("{key}={}", format_json_value(value)))
                .collect::<Vec<_>>();
            entries.sort();
            entries.join(", ")
        }
        other => format_json_value(other),
    }
}

#[cfg(test)]
fn payload_field(payload: &Value, key: &str) -> String {
    payload
        .get(key)
        .map(format_json_value)
        .unwrap_or_else(|| "-".to_string())
}

fn payload_nested_string(payload: &Value, object_key: &str, key: &str) -> Option<String> {
    payload
        .get(object_key)
        .and_then(|value| value.get(key))
        .and_then(value_string)
}

fn payload_string(payload: &Value, key: &str) -> Option<String> {
    payload.get(key).and_then(value_string)
}

fn payload_bool(payload: &Value, key: &str) -> Option<bool> {
    payload.get(key).and_then(Value::as_bool)
}

fn payload_u8(payload: &Value, key: &str) -> Option<u8> {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| value.try_into().ok())
}

fn payload_string_vec(payload: &Value, key: &str) -> Vec<String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(value_string).collect())
        .unwrap_or_default()
}

fn value_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        other => Some(other.to_string()),
    }
}

fn payload_enum<T>(payload: &Value, key: &str) -> Option<T>
where
    T: for<'de> serde::Deserialize<'de>,
{
    payload
        .get(key)
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

fn format_json_value(value: &Value) -> String {
    match value {
        Value::Null => "-".to_string(),
        Value::String(value) => value.clone(),
        _ => value.to_string(),
    }
}

fn parse_key_values(flag: &str, values: Vec<String>) -> Result<BTreeMap<String, String>> {
    values
        .into_iter()
        .map(|item| {
            let (key, value) = item.split_once('=').with_context(|| {
                format!("invalid --{flag} value {item:?}; expected KEY=VALUE format")
            })?;

            if key.is_empty() {
                bail!("invalid --{flag} value {item:?}; key must not be empty");
            }

            Ok((key.to_string(), value.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;
    use tempfile::tempdir;
    use tokio::time::timeout;

    #[test]
    fn parses_get_command_with_positional_resource() {
        let cli = Cli::try_parse_from([
            "plankton",
            "get",
            "secret/api-token",
            "--reason",
            "Need smoke test access",
            "--requested-by",
            "alice",
            "--metadata",
            "environment=dev",
        ])
        .expect("get command should parse");

        match cli.command {
            Commands::Get(args) => {
                assert_eq!(args.resource.as_deref(), Some("secret/api-token"));
                assert_eq!(args.requested_by, Some("alice".to_string()));
                assert_eq!(args.metadata, vec!["environment=dev".to_string()]);
                assert_eq!(args.policy_mode, CliPolicyMode::ManualOnly);
            }
            _ => panic!("expected get command"),
        }
    }

    #[test]
    fn parses_request_alias_with_legacy_resource_flag() {
        let cli = Cli::try_parse_from([
            "plankton",
            "request",
            "--resource",
            "secret/api-token",
            "--reason",
            "Need smoke test access",
        ])
        .expect("request alias should parse");

        match cli.command {
            Commands::Get(args) => {
                assert_eq!(args.resource_flag.as_deref(), Some("secret/api-token"));
                assert_eq!(args.reason, "Need smoke test access");
                assert_eq!(args.policy_mode, CliPolicyMode::ManualOnly);
            }
            _ => panic!("expected get command"),
        }
    }

    #[test]
    fn parses_assisted_policy_mode() {
        let cli = Cli::try_parse_from([
            "plankton",
            "get",
            "secret/api-token",
            "--reason",
            "Need smoke test access",
            "--policy-mode",
            "assisted",
        ])
        .expect("assisted policy mode should parse");

        match cli.command {
            Commands::Get(args) => {
                assert_eq!(args.policy_mode, CliPolicyMode::Assisted);
            }
            _ => panic!("expected get command"),
        }
    }

    #[test]
    fn parses_auto_policy_mode() {
        let cli = Cli::try_parse_from([
            "plankton",
            "get",
            "secret/api-token",
            "--reason",
            "Need smoke test access",
            "--policy-mode",
            "auto",
        ])
        .expect("auto policy mode should parse");

        match cli.command {
            Commands::Get(args) => {
                assert_eq!(args.policy_mode, CliPolicyMode::Auto);
            }
            _ => panic!("expected get command"),
        }
    }

    #[test]
    fn parses_legacy_manual_only_policy_mode_alias() {
        let cli = Cli::try_parse_from([
            "plankton",
            "get",
            "secret/api-token",
            "--reason",
            "Need smoke test access",
            "--policy-mode",
            "manual-only",
        ])
        .expect("legacy manual-only policy mode should still parse");

        match cli.command {
            Commands::Get(args) => {
                assert_eq!(args.policy_mode, CliPolicyMode::ManualOnly);
            }
            _ => panic!("expected get command"),
        }
    }

    #[test]
    fn parses_list_command_happy_path() {
        let cli = Cli::try_parse_from(["plankton", "list"]).expect("list command should parse");

        match cli.command {
            Commands::List(_) => {}
            _ => panic!("expected list command"),
        }
    }

    #[test]
    fn parses_search_command_happy_path() {
        let cli = Cli::try_parse_from(["plankton", "search", "dev"])
            .expect("search command should parse");

        match cli.command {
            Commands::Search(args) => {
                assert_eq!(args.query, "dev");
            }
            _ => panic!("expected search command"),
        }
    }

    #[test]
    fn parses_key_value_pairs() {
        let parsed = parse_key_values(
            "metadata",
            vec!["team=security".to_string(), "environment=dev".to_string()],
        )
        .expect("key values should parse");

        assert_eq!(parsed.get("team"), Some(&"security".to_string()));
        assert_eq!(parsed.get("environment"), Some(&"dev".to_string()));
    }

    #[test]
    fn rejects_removed_review_commands() {
        let approve_error = Cli::try_parse_from(["plankton", "approve", "request-123"])
            .expect_err("approve should no longer parse");
        let reject_error = Cli::try_parse_from(["plankton", "reject", "request-123"])
            .expect_err("reject should no longer parse");

        assert!(approve_error
            .to_string()
            .contains("unrecognized subcommand"));
        assert!(reject_error.to_string().contains("unrecognized subcommand"));
    }

    #[test]
    fn help_text_marks_cli_as_read_only() {
        let mut command = Cli::command();
        let help = command.render_long_help().to_string();

        assert!(help.contains("desktop UI"));
        assert!(help.contains("`get`, `list`, and `search`"));
        assert!(help.contains("\n  get"));
        assert!(help.contains("\n  list"));
        assert!(help.contains("\n  search"));
        assert!(!help.contains("\n  status"));
        assert!(!help.contains("\n  suggestion"));
        assert!(!help.contains("\n  queue"));
        assert!(!help.contains("\n  audit"));
        assert!(!help.contains("approve <request-id>"));
        assert!(!help.contains("reject <request-id>"));
    }

    #[test]
    fn rejects_removed_management_commands() {
        for command in ["status", "suggestion", "queue", "audit"] {
            let error = Cli::try_parse_from(["plankton", command])
                .expect_err("removed management command should not parse");
            assert!(error.to_string().contains("unrecognized subcommand"));
        }
    }

    #[test]
    fn get_help_uses_productized_policy_mode_terms() {
        let mut command = Cli::command();
        let get_help = command
            .find_subcommand_mut("get")
            .expect("get subcommand should exist")
            .render_long_help()
            .to_string();

        assert!(get_help.contains("Choose Human Review"));
        assert!(get_help.contains("[default: human-review]"));
        assert!(get_help.contains("[possible values: human-review, auto, assisted]"));
        assert!(!get_help.contains("manual-only"));
    }

    #[test]
    fn list_help_describes_identifier_inventory() {
        let mut command = Cli::command();
        let list_help = command
            .find_subcommand_mut("list")
            .expect("list subcommand should exist")
            .render_long_help()
            .to_string();

        assert!(list_help.contains("resource identifiers"));
        assert!(list_help.contains("without revealing secret values"));
    }

    #[test]
    fn search_help_describes_fuzzy_identifier_matching() {
        let mut command = Cli::command();
        let search_help = command
            .find_subcommand_mut("search")
            .expect("search subcommand should exist")
            .render_long_help()
            .to_string();

        assert!(search_help.contains("Case-insensitive fuzzy match"));
        assert!(search_help.contains("resource identifiers"));
    }

    #[test]
    fn renders_status_text_with_audit_timeline() {
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
        let submission = request.record_submission_audit();
        let decision = request
            .apply_manual_decision(Decision::Allow, "reviewer", Some("looks safe".to_string()))
            .expect("manual decision should succeed");
        let result = RequestQueryResult {
            request,
            audit_records: {
                let mut records = vec![submission];
                records.extend(decision);
                records
            },
        };

        let rendered = render_status_text(&result);

        assert!(rendered.contains("request_id:"));
        assert!(rendered.contains("approval_status: approved"));
        assert!(rendered.contains("audit_record_count: 2"));
        assert!(rendered.contains("action=request_submitted"));
        assert!(rendered.contains("action=approval_recorded"));
    }

    #[test]
    fn renders_suggestion_report_with_key_fields() {
        let context = RequestContext::new(
            "secret/api-token".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        );
        let suggestion = LlmSuggestion {
            template_id: "llm_advice".to_string(),
            template_version: "v2".to_string(),
            prompt_contract_version: "2026-04-09".to_string(),
            prompt_sha256: "sha256-test".to_string(),
            suggested_decision: SuggestedDecision::Deny,
            rationale_summary: "Sensitive production secret requested from a dev shell".to_string(),
            risk_score: 82,
            provider_kind: "openai_compatible".to_string(),
            provider_model: Some("gpt-4.1-mini".to_string()),
            provider_response_id: Some("resp-123".to_string()),
            x_request_id: Some("trace-123".to_string()),
            provider_trace: None,
            usage: Some(LlmSuggestionUsage {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30,
            }),
            error: None,
            generated_at: chrono::Utc::now(),
        };
        let request = AccessRequest::new_pending(
            context,
            PolicyMode::Assisted,
            Some("openai_compatible".to_string()),
            "rendered prompt".to_string(),
            None,
            Some(suggestion),
        );

        let report = build_suggestion_report(&request);
        let rendered = render_suggestion_report_text(&report);

        assert!(rendered.contains("suggestion_status: available"));
        assert!(rendered.contains("suggested_decision: deny"));
        assert!(rendered
            .contains("rationale_summary: Sensitive production secret requested from a dev shell"));
        assert!(rendered.contains("risk_score: 82 (high)"));
        assert!(rendered.contains("template_version: llm_advice@v2"));
        assert!(rendered.contains("provider_kind: openai_compatible"));
        assert!(rendered.contains("provider_model: gpt-4.1-mini"));
        assert!(rendered.contains("trace_id: trace-123"));
    }

    #[test]
    fn renders_acp_trace_fields_in_suggestion_and_audit_views() {
        let context = RequestContext::new(
            "secret/api-token".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        );
        let suggestion = LlmSuggestion {
            template_id: "llm_advice".to_string(),
            template_version: "v2".to_string(),
            prompt_contract_version: "2026-04-10".to_string(),
            prompt_sha256: "sha256-test".to_string(),
            suggested_decision: SuggestedDecision::Allow,
            rationale_summary: "ACP assistant found a low-risk dev token access request"
                .to_string(),
            risk_score: 12,
            provider_kind: "acp_codex".to_string(),
            provider_model: Some("codex-mini".to_string()),
            provider_response_id: Some("resp-acp-123".to_string()),
            x_request_id: Some("trace-acp-123".to_string()),
            provider_trace: Some(ProviderTrace {
                transport: Some("stdio".to_string()),
                protocol: None,
                api_version: None,
                output_format: None,
                stop_reason: None,
                package_name: Some("@zed-industries/codex-acp".to_string()),
                package_version: Some("0.11.1".to_string()),
                session_id: Some("session-acp-123".to_string()),
                client_request_id: Some("client-acp-123".to_string()),
                agent_name: Some("codex-acp".to_string()),
                agent_version: Some("0.11.1".to_string()),
                beta_headers: Vec::new(),
            }),
            usage: Some(LlmSuggestionUsage {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30,
            }),
            error: None,
            generated_at: chrono::Utc::now(),
        };
        let request = AccessRequest::new_pending(
            context,
            PolicyMode::Assisted,
            Some("acp_codex".to_string()),
            "rendered prompt".to_string(),
            None,
            Some(suggestion),
        );
        let audit_record = request
            .record_llm_suggestion_audit()
            .expect("llm suggestion audit should exist");

        let report = build_suggestion_report(&request);
        let rendered = render_suggestion_report_text(&report);
        let audit_output =
            build_audit_output(Some(&request.id), std::slice::from_ref(&audit_record));
        let rendered_audit =
            render_audit_text(std::slice::from_ref(&audit_record), Some(&request.id));

        assert!(rendered.contains("provider_kind: acp_codex"));
        assert!(rendered.contains("acp_session_id: session-acp-123"));
        assert!(rendered.contains("acp_agent_name: codex-acp"));
        assert!(rendered.contains("acp_agent_version: 0.11.1"));
        assert!(rendered.contains("acp_package_version: 0.11.1"));
        assert!(rendered.contains("acp_transport: stdio"));
        assert!(rendered.contains("acp_client_request_id: client-acp-123"));
        assert_eq!(
            report
                .suggestion
                .as_ref()
                .and_then(|suggestion| suggestion.acp_trace.as_ref())
                .and_then(|trace| trace.acp_session_id.as_deref()),
            Some("session-acp-123")
        );
        assert_eq!(
            audit_output
                .audit_records
                .first()
                .and_then(|record| record.suggestion.as_ref())
                .and_then(|suggestion| suggestion.provider_kind.as_deref()),
            Some("acp_codex")
        );
        assert_eq!(
            audit_output
                .audit_records
                .first()
                .and_then(|record| record.suggestion.as_ref())
                .and_then(|suggestion| suggestion.acp_trace.as_ref())
                .and_then(|trace| trace.acp_transport.as_deref()),
            Some("stdio")
        );
        assert!(rendered_audit.contains("provider_kind: acp_codex"));
        assert!(rendered_audit.contains("acp_session_id: session-acp-123"));
        assert!(rendered_audit.contains("acp_package_version: 0.11.1"));
    }

    #[test]
    fn renders_claude_trace_fields_in_suggestion_queue_and_audit_views() {
        let context = RequestContext::new(
            "config/dev-readonly".to_string(),
            "Need readonly dev config".to_string(),
            "alice".to_string(),
        );
        let suggestion = LlmSuggestion {
            template_id: "llm_advice".to_string(),
            template_version: "v3".to_string(),
            prompt_contract_version: "2026-04-10".to_string(),
            prompt_sha256: "sha256-claude".to_string(),
            suggested_decision: SuggestedDecision::Allow,
            rationale_summary: "readonly dev config access is low risk".to_string(),
            risk_score: 12,
            provider_kind: "claude".to_string(),
            provider_model: Some("claude-sonnet-4-5".to_string()),
            provider_response_id: Some("msg_123".to_string()),
            x_request_id: Some("req_claude_123".to_string()),
            provider_trace: Some(ProviderTrace {
                transport: Some("https".to_string()),
                protocol: Some("anthropic_messages".to_string()),
                api_version: Some("2023-06-01".to_string()),
                output_format: Some("json_schema".to_string()),
                stop_reason: Some("end_turn".to_string()),
                package_name: None,
                package_version: None,
                session_id: None,
                client_request_id: None,
                agent_name: None,
                agent_version: None,
                beta_headers: Vec::new(),
            }),
            usage: Some(LlmSuggestionUsage {
                prompt_tokens: 18,
                completion_tokens: 9,
                total_tokens: 27,
            }),
            error: None,
            generated_at: chrono::Utc::now(),
        };
        let request = AccessRequest::new_pending(
            context,
            PolicyMode::Assisted,
            Some("claude".to_string()),
            "rendered prompt".to_string(),
            None,
            Some(suggestion),
        );
        let audit_record = request
            .record_llm_suggestion_audit()
            .expect("llm suggestion audit should exist");

        let report = build_suggestion_report(&request);
        let rendered = render_suggestion_report_text(&report);
        let rendered_queue = render_queue_suggestion_summary(&request)
            .expect("queue suggestion summary should exist");
        let audit_output =
            build_audit_output(Some(&request.id), std::slice::from_ref(&audit_record));
        let rendered_audit =
            render_audit_text(std::slice::from_ref(&audit_record), Some(&request.id));

        assert!(rendered.contains("provider_kind: claude"));
        assert!(rendered.contains("provider_model: claude-sonnet-4-5"));
        assert!(rendered.contains("provider_response_id: msg_123"));
        assert!(rendered.contains("trace_id: req_claude_123"));
        assert!(rendered.contains("usage: prompt_tokens=18, completion_tokens=9, total_tokens=27"));
        assert!(rendered.contains("provider_trace.protocol: anthropic_messages"));
        assert!(rendered.contains("provider_trace.api_version: 2023-06-01"));
        assert!(rendered.contains("provider_trace.output_format: json_schema"));
        assert!(rendered.contains("provider_trace.stop_reason: end_turn"));
        assert!(rendered_queue.contains("response_id=msg_123"));
        assert!(rendered_queue.contains("provider_trace.protocol=anthropic_messages"));
        assert!(rendered_queue.contains("provider_trace.stop_reason=end_turn"));
        assert_eq!(
            report
                .suggestion
                .as_ref()
                .and_then(|suggestion| suggestion.claude_trace.as_ref())
                .and_then(|trace| trace.output_format.as_deref()),
            Some("json_schema")
        );
        assert_eq!(
            audit_output
                .audit_records
                .first()
                .and_then(|record| record.suggestion.as_ref())
                .and_then(|suggestion| suggestion.claude_trace.as_ref())
                .and_then(|trace| trace.protocol.as_deref()),
            Some("anthropic_messages")
        );
        assert!(rendered_audit.contains("provider_response_id: msg_123"));
        assert!(rendered_audit.contains("provider_trace.protocol: anthropic_messages"));
        assert!(rendered_audit.contains("provider_trace.api_version: 2023-06-01"));
        assert!(rendered_audit.contains("provider_trace.output_format: json_schema"));
        assert!(rendered_audit.contains("provider_trace.stop_reason: end_turn"));
    }

    #[test]
    fn renders_automatic_decision_fields_for_auto_status() {
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
        let submission = request.record_submission_audit();
        let auto_audits = request
            .apply_automatic_decision(AutomaticDecisionTrace {
                auto_disposition: AutomaticDisposition::Escalate,
                decision_source: AutomaticDecisionSource::CombinedGuardrail,
                matched_rule_ids: vec!["guard_mid_risk_or_inconclusive".to_string()],
                secret_exposure_risk: true,
                provider_called: false,
                suggested_decision: None,
                risk_score: None,
                template_id: Some("llm_advice_request".to_string()),
                template_version: Some("1".to_string()),
                prompt_contract_version: Some("sanitized_prompt_context.v1".to_string()),
                provider_kind: Some("mock".to_string()),
                provider_model: None,
                x_request_id: Some("trace-123".to_string()),
                provider_response_id: None,
                redacted_fields: vec!["env_vars.OPENAI_API_KEY".to_string()],
                redaction_summary: "redacted sensitive environment variable value".to_string(),
                auto_rationale_summary:
                    "Automatic mode escalated before provider execution because secret_exposure_risk=true"
                        .to_string(),
                fail_closed: true,
                evaluated_at: chrono::Utc::now(),
            })
            .expect("automatic decision should succeed");
        let result = RequestQueryResult {
            request,
            audit_records: {
                let mut records = vec![submission];
                records.extend(auto_audits);
                records
            },
        };

        let rendered = render_status_text(&result);
        let rendered_audit = render_audit_text(&result.audit_records, Some(&result.request.id));

        assert!(rendered.contains("policy_mode: llm_automatic"));
        assert!(rendered.contains("automatic_disposition: escalate"));
        assert!(rendered.contains("automatic_provider_called: false"));
        assert!(rendered.contains("automatic_secret_exposure_risk: true"));
        assert!(rendered.contains("automatic_trace_id: trace-123"));
        assert!(rendered_audit.contains("action: automatic_decision_recorded"));
        assert!(rendered_audit.contains("action: automatic_escalated_to_human"));
        assert!(rendered_audit.contains("auto_disposition: escalate"));
    }

    #[test]
    fn builds_focused_status_and_audit_output_for_auto_mode() {
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
        let submission = request.record_submission_audit();
        let auto_audits = request
            .apply_automatic_decision(AutomaticDecisionTrace {
                auto_disposition: AutomaticDisposition::Escalate,
                decision_source: AutomaticDecisionSource::CombinedGuardrail,
                matched_rule_ids: vec!["guard_secret_exposure_risk".to_string()],
                secret_exposure_risk: true,
                provider_called: false,
                suggested_decision: None,
                risk_score: None,
                template_id: Some("llm_advice_request".to_string()),
                template_version: Some("1".to_string()),
                prompt_contract_version: Some("sanitized_prompt_context.v1".to_string()),
                provider_kind: Some("mock".to_string()),
                provider_model: None,
                x_request_id: None,
                provider_response_id: None,
                redacted_fields: vec!["env_vars.OPENAI_API_KEY".to_string()],
                redaction_summary: "redacted sensitive environment variable value".to_string(),
                auto_rationale_summary:
                    "Automatic mode escalated before provider execution because secret_exposure_risk=true"
                        .to_string(),
                fail_closed: true,
                evaluated_at: chrono::Utc::now(),
            })
            .expect("automatic decision should succeed");
        let result = RequestQueryResult {
            request,
            audit_records: {
                let mut records = vec![submission];
                records.extend(auto_audits);
                records
            },
        };

        let status_output = build_status_output(&result);
        let audit_output = build_audit_output(Some(&result.request.id), &result.audit_records);

        assert_eq!(
            status_output.request.suggestion_status,
            SuggestionStatus::NotRequested
        );
        assert_eq!(
            status_output
                .request
                .automatic_decision
                .as_ref()
                .map(|decision| decision.auto_disposition),
            Some(AutomaticDisposition::Escalate)
        );
        assert_eq!(
            status_output
                .request
                .automatic_decision
                .as_ref()
                .map(|decision| decision.matched_rule_ids.clone()),
            Some(vec!["guard_secret_exposure_risk".to_string()])
        );
        assert_eq!(audit_output.audit_record_count, 3);
        assert!(audit_output.audit_records.iter().any(|record| {
            record.action == AuditAction::AutomaticDecisionRecorded
                && record
                    .automatic_decision
                    .as_ref()
                    .map(|decision| decision.provider_called)
                    == Some(Some(false))
        }));
    }

    #[tokio::test]
    async fn wait_for_terminal_request_blocks_until_human_review_resolves() {
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
                    "secret/manual-token".to_string(),
                    "Need manual access".to_string(),
                    "alice".to_string(),
                ),
                PolicyMode::ManualOnly,
            )
            .await
            .expect("request should be inserted");

        let decision_store = store.clone();
        let decision_request_id = request.id.clone();
        tokio::spawn(async move {
            sleep(Duration::from_millis(50)).await;
            decision_store
                .record_decision(
                    &decision_request_id,
                    Decision::Allow,
                    "reviewer",
                    Some("approved".to_string()),
                )
                .await
                .expect("decision should persist");
        });

        let result = timeout(
            Duration::from_secs(2),
            wait_for_terminal_request(&store, &request.id),
        )
        .await
        .expect("manual review should eventually resolve")
        .expect("terminal request query should succeed");

        assert_eq!(result.request.approval_status, ApprovalStatus::Approved);
        assert_eq!(result.request.final_decision, Some(Decision::Allow));
        assert!(result
            .audit_records
            .iter()
            .any(|record| record.action == AuditAction::ApprovalRecorded));
    }

    #[tokio::test]
    async fn wait_for_terminal_request_returns_immediately_for_auto_allow() {
        let temp = tempdir().expect("temp directory should be created");
        let mut settings = load_settings().expect("default settings should load");
        settings.database_url = format!("sqlite://{}", temp.path().join("plankton.db").display());
        settings.provider_kind = "mock".to_string();

        let store = SqliteStore::new(&settings)
            .await
            .expect("store should initialize");

        let mut context = RequestContext::new(
            "secret/auto-token".to_string(),
            "Need automatic access".to_string(),
            "alice".to_string(),
        );
        context
            .metadata
            .insert("environment".to_string(), "dev".to_string());

        let request = store
            .submit_request(&settings, context, PolicyMode::LlmAutomatic)
            .await
            .expect("automatic request should be inserted");

        let result = timeout(
            Duration::from_millis(250),
            wait_for_terminal_request(&store, &request.id),
        )
        .await
        .expect("automatic allow should not block")
        .expect("terminal request query should succeed");

        assert_eq!(result.request.approval_status, ApprovalStatus::Approved);
        assert_eq!(result.request.final_decision, Some(Decision::Allow));
    }

    #[test]
    fn renders_accessible_resource_list_as_identifiers_only() {
        let resources = vec![AccessibleResourceRecord {
            resource: "secret/dev-token".to_string(),
            granted_by_request_id: "req-123".to_string(),
            policy_mode: PolicyMode::Assisted,
            provider_kind: Some("mock".to_string()),
            granted_at: chrono::Utc::now(),
        }];

        let rendered = render_accessible_resource_list_text(&resources);
        let output = build_accessible_resource_list_output(&resources);

        assert!(rendered.contains("resource: secret/dev-token"));
        assert!(rendered.contains("granted_by_request_id: req-123"));
        assert!(rendered.contains("policy_mode: assisted"));
        assert!(!rendered.contains("secret_value"));
        assert_eq!(output.resource_count, 1);
        assert_eq!(output.resources[0].resource, "secret/dev-token");
    }

    #[test]
    fn filters_accessible_resources_by_case_insensitive_resource_substring() {
        let resources = vec![
            AccessibleResourceRecord {
                resource: "secret/dev-token".to_string(),
                granted_by_request_id: "req-123".to_string(),
                policy_mode: PolicyMode::Assisted,
                provider_kind: Some("mock".to_string()),
                granted_at: chrono::Utc::now(),
            },
            AccessibleResourceRecord {
                resource: "config/prod-readonly".to_string(),
                granted_by_request_id: "req-456".to_string(),
                policy_mode: PolicyMode::ManualOnly,
                provider_kind: None,
                granted_at: chrono::Utc::now(),
            },
        ];

        let filtered = filter_accessible_resources(&resources, "DEV");

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].resource, "secret/dev-token");
    }

    #[test]
    fn rejects_invalid_key_values() {
        let error = parse_key_values("metadata", vec!["broken".to_string()])
            .expect_err("missing equals sign should fail");

        assert!(error.to_string().contains("invalid --metadata value"));
    }
}
