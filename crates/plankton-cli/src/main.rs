mod desktop_handoff;

use std::{
    collections::BTreeMap,
    env,
    io::{self, Write},
    path::PathBuf,
    process::ExitCode,
    time::Duration,
};

use anyhow::{bail, Context, Result};
use clap::{ArgGroup, Args, Parser, Subcommand, ValueEnum};
use desktop_handoff::maybe_trigger_desktop_handoff;
use plankton_core::{
    collect_runtime_call_chain, default_value_resolver, derive_script_path,
    import_secret_reference, list_local_secret_catalog, load_settings, prompt_call_chain_paths,
    AccessRequest, ApprovalStatus, AuditAction, AuditRecord, AutomaticDecisionSource,
    AutomaticDecisionTrace, AutomaticDisposition, Decision, LlmSuggestion, LlmSuggestionUsage,
    LocalSecretCatalog, LocalSecretLiteralEntry, PlanktonSettings, PolicyMode, ProviderTrace,
    RequestContext, SecretImportSpec, SecretSourceLocator, SuggestedDecision, ValueResolver,
    ValueResolverError,
};
use plankton_store::{RequestQueryResult, SqliteStore};
use serde::Serialize;
use serde_json::Value;
use tokio::time::sleep;
use tracing_subscriber::{fmt, EnvFilter};

const GET_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Parser)]
#[command(
    author,
    version,
    about = "Plankton command-line companion for listing resources, importing password sources, and requesting access",
    arg_required_else_help = true,
    after_help = "Examples:\n  plankton list\n  plankton search api-token\n  plankton import dotenv-file --resource secret/api-token --file .env --key API_TOKEN\n  plankton get secret/api-token --reason \"Smoke test\" --requested-by alice\n  plankton get secret/api-token --reason \"Auto smoke\" --policy-mode auto\n  plankton get secret/api-token --reason \"Scripted smoke\" --output json\n\nSuccessful `get` text output prints only the resolved secret value. Use `--output json` for a minimal machine-readable envelope. When a request is denied and a recorded reason is available, Plankton appends that reason to the deny error.\n\nHuman approvals and request history live in the desktop UI. The public CLI surface is intentionally limited to `get`, `list`, `search`, and `import`."
)]
struct Cli {
    #[arg(
        long,
        global = true,
        value_enum,
        help = "Choose text, JSON, or JSON Lines output"
    )]
    output: Option<OutputFormat>,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum OutputFormat {
    Text,
    Json,
    Jsonl,
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
        about = "Request access to one resource and print only its resolved value on successful text output",
        after_help = "Output contract:\n  text (default): when Plankton both allows the request and resolves the value, stdout prints only the raw value.\n  json: prints a minimal envelope for scripts and tooling.\n  deny, pending, or resolver errors: stdout stays empty and the error or status is reported on stderr. Deny output includes the recorded reason when one is available.\n\nValue source:\n  Values are resolved at runtime from the local secret catalog, not from SQLite, audit records, or provider payloads."
    )]
    Get(GetArgs),
    #[command(
        about = "List local secret catalog entries with metadata and source annotations without revealing secret values"
    )]
    List(ListArgs),
    #[command(about = "Fuzzy-search the same catalog fields used by `list` and `get`")]
    Search(SearchArgs),
    #[command(
        name = "import",
        alias = "import-source",
        about = "Import a password source locator into the local catalog without storing secret values",
        after_help = "Supported source kinds:\n  1password-cli: account -> vault -> item -> field\n  bitwarden-cli: account -> organization/collection/folder -> item -> field\n  dotenv-file: file -> namespace/prefix -> key\n\nPlankton verifies the source at import time, then stores only the source locator in the local secret catalog. Secret values, vendor sessions, and provider tokens are not written into SQLite, audit payloads, or provider payloads."
    )]
    Import(ImportArgs),
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
        help = "Choose Human Review, assisted review with an LLM suggestion, or fully automatic LLM disposition. When omitted, Plankton uses the configured default policy mode from settings."
    )]
    policy_mode: Option<CliPolicyMode>,
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

#[derive(Debug, Args)]
struct ImportArgs {
    #[command(subcommand)]
    source: ImportSourceCommand,
}

#[derive(Debug, Subcommand)]
enum ImportSourceCommand {
    #[command(name = "1password-cli", alias = "1password_cli")]
    OnePasswordCli(OnePasswordImportArgs),
    #[command(name = "bitwarden-cli", alias = "bitwarden_cli")]
    BitwardenCli(BitwardenImportArgs),
    #[command(name = "dotenv-file", alias = "dotenv_file")]
    DotenvFile(DotenvImportArgs),
}

#[derive(Debug, Args, Clone)]
struct ImportCommonArgs {
    #[arg(
        long,
        value_name = "RESOURCE",
        help = "Optional resource identifier override. When omitted, Plankton generates one from the active import rule."
    )]
    resource: Option<String>,
    #[arg(long, value_name = "NAME")]
    display_name: Option<String>,
    #[arg(long, value_name = "TEXT")]
    description: Option<String>,
    #[arg(long = "tag", value_name = "TAG")]
    tags: Vec<String>,
    #[arg(
        long = "metadata",
        value_name = "KEY=VALUE",
        help = "Repeat to attach import metadata without storing secret values"
    )]
    metadata: Vec<String>,
}

#[derive(Debug, Args, Clone)]
struct OnePasswordImportArgs {
    #[command(flatten)]
    common: ImportCommonArgs,
    #[arg(long, value_name = "ACCOUNT")]
    account: String,
    #[arg(long, value_name = "VAULT")]
    vault: String,
    #[arg(long, value_name = "ITEM")]
    item: String,
    #[arg(long, value_name = "FIELD")]
    field: String,
    #[arg(long, value_name = "VAULT_ID")]
    vault_id: Option<String>,
    #[arg(long, value_name = "ITEM_ID")]
    item_id: Option<String>,
    #[arg(long, value_name = "FIELD_ID")]
    field_id: Option<String>,
}

#[derive(Debug, Args, Clone)]
struct BitwardenImportArgs {
    #[command(flatten)]
    common: ImportCommonArgs,
    #[arg(long, value_name = "ACCOUNT")]
    account: String,
    #[arg(long, value_name = "ORG")]
    organization: Option<String>,
    #[arg(long, value_name = "COLLECTION")]
    collection: Option<String>,
    #[arg(long, value_name = "FOLDER")]
    folder: Option<String>,
    #[arg(long, value_name = "ITEM")]
    item: String,
    #[arg(long, value_name = "FIELD")]
    field: String,
    #[arg(long, value_name = "ITEM_ID")]
    item_id: Option<String>,
}

#[derive(Debug, Args, Clone)]
struct DotenvImportArgs {
    #[command(flatten)]
    common: ImportCommonArgs,
    #[arg(long, value_name = "PATH")]
    file: PathBuf,
    #[arg(long, value_name = "NAMESPACE")]
    namespace: Option<String>,
    #[arg(long, value_name = "PREFIX")]
    prefix: Option<String>,
    #[arg(long, value_name = "KEY")]
    key: String,
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

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum GetDecision {
    Allow,
    Deny,
    Pending,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
struct GetOutputEnvelope {
    resource: String,
    request_id: String,
    decision: GetDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolver_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum ResourceDirectoryEntryKind {
    Literal,
    Imported,
}

#[derive(Debug, Clone, Serialize)]
struct ResourceDirectoryEntryView {
    resource: String,
    entry_kind: ResourceDirectoryEntryKind,
    display_name: Option<String>,
    description: Option<String>,
    tags: Vec<String>,
    metadata: BTreeMap<String, String>,
    provider_kind: Option<String>,
    container_label: Option<String>,
    field_selector: Option<String>,
    imported_at: Option<chrono::DateTime<chrono::Utc>>,
    last_verified_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Serialize)]
struct ImportReceiptOutputView {
    catalog_path: String,
    resource: String,
    display_name: String,
    description: Option<String>,
    tags: Vec<String>,
    metadata: BTreeMap<String, String>,
    provider_kind: String,
    container_label: Option<String>,
    field_selector: String,
    imported_at: chrono::DateTime<chrono::Utc>,
    last_verified_at: Option<chrono::DateTime<chrono::Utc>>,
    source_locator: SecretSourceLocator,
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
        Ok(code) => code,
        Err(error) => {
            eprintln!("error: {error}");
            for cause in error.chain().skip(1) {
                eprintln!("caused by: {cause}");
            }

            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<ExitCode> {
    let Cli { output, command } = Cli::parse();

    match command {
        Commands::Get(args) => {
            let output = resolve_output(output, OutputFormat::Text);
            let settings = load_settings().context("failed to load Plankton settings")?;
            let store = SqliteStore::new(&settings)
                .await
                .context("failed to initialize SQLite store")?;
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
            let requested_resource = resource
                .or(resource_flag)
                .expect("clap should require a resource");
            let mut context = RequestContext::new(
                requested_resource.clone(),
                reason,
                requested_by.unwrap_or_else(default_actor),
            );
            let (resource_tags, resource_metadata) =
                load_request_resource_annotations(requested_resource.as_str())?;
            context.resource_tags = resource_tags;
            context.resource_metadata = resource_metadata;
            context.script_path = derive_script_path(&call_chain);
            context.call_chain = call_chain;
            context.env_vars = parse_key_values("env", env_vars)?;
            context.metadata = parse_key_values("metadata", metadata)?;

            let request = store
                .submit_request(
                    &settings,
                    context,
                    resolve_requested_policy_mode(policy_mode, &settings),
                )
                .await
                .context("failed to submit access request")?;
            maybe_trigger_desktop_handoff(&request)?;
            let result = wait_for_terminal_request(&store, &request.id).await?;
            return handle_get_result(output, &result);
        }
        Commands::List(_) => {
            let output = resolve_output(output, OutputFormat::Jsonl);
            let entries = load_active_resource_directory()?;
            match output {
                OutputFormat::Text => println!("{}", render_resource_directory_text(&entries)),
                OutputFormat::Json => print_json_output(&entries)?,
                OutputFormat::Jsonl => print_jsonl_output(&entries)?,
            }
        }
        Commands::Search(args) => {
            let output = resolve_output(output, OutputFormat::Jsonl);
            let entries = load_active_resource_directory()?;
            let filtered = filter_resource_directory(&entries, &args.query);
            match output {
                OutputFormat::Text => println!("{}", render_resource_directory_text(&filtered)),
                OutputFormat::Json => print_json_output(&filtered)?,
                OutputFormat::Jsonl => print_jsonl_output(&filtered)?,
            }
        }
        Commands::Import(args) => {
            let output = resolve_output(output, OutputFormat::Text);
            let spec = build_import_spec(args);
            let receipt = import_secret_reference(spec).context(
                "failed to import password manager source into the local secret catalog",
            )?;
            let output_view = build_import_receipt_output(&receipt);
            print_output(output, &output_view, || {
                render_import_receipt_text(&output_view)
            })?;
        }
    }

    Ok(ExitCode::SUCCESS)
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

fn load_request_resource_annotations(
    resource: &str,
) -> Result<(Vec<String>, BTreeMap<String, String>)> {
    let catalog = list_local_secret_catalog()
        .context("failed to inspect the local secret catalog for resource metadata")?;
    let literal_entry = catalog
        .literals
        .into_iter()
        .find(|literal| literal.resource == resource);
    if let Some(literal) = literal_entry {
        return Ok((literal.tags, literal.metadata));
    }
    let imported_entry = catalog
        .imports
        .into_iter()
        .find(|reference| reference.resource == resource);

    Ok(match imported_entry {
        Some(reference) => (reference.tags, reference.metadata),
        None => (Vec::new(), BTreeMap::new()),
    })
}

fn default_actor() -> String {
    env::var("USER")
        .or_else(|_| env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn resolve_requested_policy_mode(
    requested: Option<CliPolicyMode>,
    settings: &PlanktonSettings,
) -> PolicyMode {
    requested
        .map(PolicyMode::from)
        .unwrap_or(settings.default_policy_mode)
}

fn resolve_output(
    override_output: Option<OutputFormat>,
    default_output: OutputFormat,
) -> OutputFormat {
    override_output.unwrap_or(default_output)
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
        OutputFormat::Jsonl => println!(
            "{}",
            serde_json::to_string(value).context("failed to serialize CLI output")?
        ),
    }

    Ok(())
}

fn print_json_output<T>(value: &T) -> Result<()>
where
    T: Serialize,
{
    println!(
        "{}",
        serde_json::to_string_pretty(value).context("failed to serialize CLI output")?
    );
    Ok(())
}

fn print_jsonl_output<T>(values: &[T]) -> Result<()>
where
    T: Serialize,
{
    for value in values {
        println!(
            "{}",
            serde_json::to_string(value).context("failed to serialize CLI output")?
        );
    }
    Ok(())
}

fn build_resource_directory_entries(
    catalog: LocalSecretCatalog,
) -> Vec<ResourceDirectoryEntryView> {
    let mut entries = catalog
        .literals
        .into_iter()
        .map(build_literal_resource_directory_entry)
        .chain(
            catalog
                .imports
                .into_iter()
                .map(build_imported_resource_directory_entry),
        )
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.resource.cmp(&right.resource));
    entries
}

fn build_literal_resource_directory_entry(
    literal: LocalSecretLiteralEntry,
) -> ResourceDirectoryEntryView {
    ResourceDirectoryEntryView {
        resource: literal.resource,
        entry_kind: ResourceDirectoryEntryKind::Literal,
        display_name: literal.display_name,
        description: literal.description,
        tags: literal.tags,
        metadata: literal.metadata,
        provider_kind: None,
        container_label: None,
        field_selector: None,
        imported_at: None,
        last_verified_at: None,
    }
}

fn build_imported_resource_directory_entry(
    reference: plankton_core::ImportedSecretReference,
) -> ResourceDirectoryEntryView {
    let provider_kind = reference.provider_kind().to_string();
    let container_label = reference
        .source_locator
        .container_label()
        .map(ToOwned::to_owned);
    let field_selector = reference.source_locator.field_selector().to_string();

    ResourceDirectoryEntryView {
        resource: reference.resource,
        entry_kind: ResourceDirectoryEntryKind::Imported,
        display_name: Some(reference.display_name),
        description: reference.description,
        tags: reference.tags,
        metadata: reference.metadata,
        provider_kind: Some(provider_kind),
        container_label,
        field_selector: Some(field_selector),
        imported_at: Some(reference.imported_at),
        last_verified_at: reference.last_verified_at,
    }
}

fn load_active_resource_directory() -> Result<Vec<ResourceDirectoryEntryView>> {
    let catalog = list_local_secret_catalog()
        .context("failed to load the active resource directory from the local secret catalog")?;
    Ok(build_resource_directory_entries(catalog))
}

fn render_resource_directory_text(entries: &[ResourceDirectoryEntryView]) -> String {
    entries
        .iter()
        .map(|entry| {
            let mut lines = vec![entry.resource.clone()];
            if let Some(display_name) = &entry.display_name {
                lines.push(format!("  display_name: {display_name}"));
            }
            if let Some(description) = &entry.description {
                lines.push(format!("  description: {description}"));
            }
            if !entry.tags.is_empty() {
                lines.push(format!("  tags: {}", entry.tags.join(", ")));
            }
            if !entry.metadata.is_empty() {
                lines.push(format!(
                    "  metadata: {}",
                    entry
                        .metadata
                        .iter()
                        .map(|(key, value)| format!("{key}={value}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            if let Some(provider_kind) = &entry.provider_kind {
                lines.push(format!("  provider_kind: {provider_kind}"));
            }
            if let Some(container_label) = &entry.container_label {
                lines.push(format!("  container: {container_label}"));
            }
            if let Some(field_selector) = &entry.field_selector {
                lines.push(format!("  field: {field_selector}"));
            }
            lines.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn resource_directory_search_text(entry: &ResourceDirectoryEntryView) -> String {
    let mut parts = vec![
        entry.resource.clone(),
        entry.display_name.clone().unwrap_or_default(),
        entry.description.clone().unwrap_or_default(),
    ];
    parts.extend(entry.tags.iter().cloned());
    parts.extend(
        entry
            .metadata
            .iter()
            .flat_map(|(key, value)| [key.clone(), value.clone(), format!("{key}={value}")]),
    );
    if let Some(provider_kind) = &entry.provider_kind {
        parts.push(provider_kind.clone());
    }
    if let Some(container_label) = &entry.container_label {
        parts.push(container_label.clone());
    }
    if let Some(field_selector) = &entry.field_selector {
        parts.push(field_selector.clone());
    }
    parts.join("\n").to_ascii_lowercase()
}

fn filter_resource_directory(
    entries: &[ResourceDirectoryEntryView],
    query: &str,
) -> Vec<ResourceDirectoryEntryView> {
    let normalized_query = query.trim().to_ascii_lowercase();
    if normalized_query.is_empty() {
        return entries.to_vec();
    }

    entries
        .iter()
        .filter(|entry| resource_directory_search_text(entry).contains(&normalized_query))
        .cloned()
        .collect()
}

fn build_import_spec(args: ImportArgs) -> SecretImportSpec {
    match args.source {
        ImportSourceCommand::OnePasswordCli(args) => SecretImportSpec {
            resource: args.common.resource.unwrap_or_default(),
            display_name: args.common.display_name,
            description: args.common.description,
            tags: args.common.tags,
            metadata: parse_key_values("metadata", args.common.metadata)
                .expect("clap should validate import metadata"),
            source_locator: SecretSourceLocator::OnePasswordCli {
                account: args.account,
                account_id: None,
                vault: args.vault,
                item: args.item,
                field: args.field,
                vault_id: args.vault_id,
                item_id: args.item_id,
                field_id: args.field_id,
            },
        },
        ImportSourceCommand::BitwardenCli(args) => SecretImportSpec {
            resource: args.common.resource.unwrap_or_default(),
            display_name: args.common.display_name,
            description: args.common.description,
            tags: args.common.tags,
            metadata: parse_key_values("metadata", args.common.metadata)
                .expect("clap should validate import metadata"),
            source_locator: SecretSourceLocator::BitwardenCli {
                account: args.account,
                organization: args.organization,
                collection: args.collection,
                folder: args.folder,
                item: args.item,
                field: args.field,
                item_id: args.item_id,
            },
        },
        ImportSourceCommand::DotenvFile(args) => SecretImportSpec {
            resource: args.common.resource.unwrap_or_default(),
            display_name: args.common.display_name,
            description: args.common.description,
            tags: args.common.tags,
            metadata: parse_key_values("metadata", args.common.metadata)
                .expect("clap should validate import metadata"),
            source_locator: SecretSourceLocator::DotenvFile {
                file_path: args.file,
                namespace: args.namespace,
                prefix: args.prefix,
                key: args.key,
            },
        },
    }
}

fn print_raw_value(value: &str) -> Result<()> {
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(value.as_bytes())
        .context("failed to write secret value to stdout")?;
    stdout
        .write_all(b"\n")
        .context("failed to terminate secret value output")?;
    stdout.flush().context("failed to flush stdout")?;
    Ok(())
}

fn handle_get_result(output: OutputFormat, result: &RequestQueryResult) -> Result<ExitCode> {
    match result.request.final_decision {
        Some(Decision::Allow) => {
            let resolver = match default_value_resolver() {
                Ok(resolver) => resolver,
                Err(error) => {
                    return handle_get_failure(
                        output,
                        &result.request,
                        GetDecision::Allow,
                        build_get_resolver_bootstrap_error(&result.request, &error),
                    );
                }
            };

            match resolver.resolve(&result.request.context.resource) {
                Ok(value) => match output {
                    OutputFormat::Text => {
                        print_raw_value(&value)?;
                        Ok(ExitCode::SUCCESS)
                    }
                    OutputFormat::Json => {
                        print_json_output(&build_get_success_output(
                            &result.request,
                            value,
                            resolver.kind(),
                        ))?;
                        Ok(ExitCode::SUCCESS)
                    }
                    OutputFormat::Jsonl => {
                        println!(
                            "{}",
                            serde_json::to_string(&build_get_success_output(
                                &result.request,
                                value,
                                resolver.kind(),
                            ))
                            .context("failed to serialize CLI output")?
                        );
                        Ok(ExitCode::SUCCESS)
                    }
                },
                Err(error) => handle_get_failure(
                    output,
                    &result.request,
                    GetDecision::Allow,
                    format!(
                        "request {} was allowed for resource {} but the value resolver failed: {}",
                        result.request.id, result.request.context.resource, error
                    ),
                ),
            }
        }
        Some(Decision::Deny) => handle_get_failure(
            output,
            &result.request,
            GetDecision::Deny,
            build_get_deny_error_message(result),
        ),
        None => handle_get_failure(
            output,
            &result.request,
            GetDecision::Pending,
            format!(
                "request {} for resource {} did not resolve to a final allow or deny decision",
                result.request.id, result.request.context.resource
            ),
        ),
    }
}

fn handle_get_failure(
    output: OutputFormat,
    request: &AccessRequest,
    decision: GetDecision,
    error: String,
) -> Result<ExitCode> {
    match output {
        OutputFormat::Text => bail!(error),
        OutputFormat::Json => {
            print_json_output(&build_get_error_output(request, decision, error))?;
            Ok(ExitCode::FAILURE)
        }
        OutputFormat::Jsonl => {
            println!(
                "{}",
                serde_json::to_string(&build_get_error_output(request, decision, error))
                    .context("failed to serialize CLI output")?
            );
            Ok(ExitCode::FAILURE)
        }
    }
}

fn build_get_resolver_bootstrap_error(
    request: &AccessRequest,
    error: &ValueResolverError,
) -> String {
    let prefix = format!(
        "request {} was allowed for resource {} but Plankton could not return the value",
        request.id, request.context.resource
    );

    match error {
        ValueResolverError::CatalogBootstrapRequired { path, created } => {
            let bootstrap_action = if *created {
                format!("a starter local secret catalog was created at {path}")
            } else {
                format!("set up the local secret catalog at {path}")
            };
            format!(
                "{prefix}: {bootstrap_action}; add an entry like [secrets] \"{}\" = \"<value>\" and run `plankton get` again",
                request.context.resource
            )
        }
        ValueResolverError::CatalogMissing { path } => format!(
            "{prefix}: set up the local secret catalog at {path}; add an entry like [secrets] \"{}\" = \"<value>\" and run `plankton get` again",
            request.context.resource
        ),
        _ => format!("{prefix}: {error}"),
    }
}

fn build_get_deny_error_message(result: &RequestQueryResult) -> String {
    let prefix = format!(
        "request {} was denied for resource {}",
        result.request.id, result.request.context.resource
    );

    match extract_deny_reason(result) {
        Some(reason) => format!("{prefix}: {reason}"),
        None => prefix,
    }
}

fn extract_deny_reason(result: &RequestQueryResult) -> Option<String> {
    result
        .audit_records
        .iter()
        .rev()
        .find_map(extract_deny_reason_from_record)
}

fn extract_deny_reason_from_record(record: &AuditRecord) -> Option<String> {
    let note = record.note.as_deref()?.trim();
    if note.is_empty() {
        return None;
    }

    match record.action {
        AuditAction::ApprovalRecorded | AuditAction::HumanDecisionOverrodeLlm => {
            payload_string(&record.payload, "decision")
                .filter(|decision| decision == "deny")
                .map(|_| note.to_string())
        }
        AuditAction::AutomaticDecisionRecorded => {
            payload_string(&record.payload, "auto_disposition")
                .or_else(|| payload_string(&record.payload, "decision"))
                .filter(|decision| decision == "deny")
                .map(|_| note.to_string())
        }
        _ => None,
    }
}

fn build_get_success_output(
    request: &AccessRequest,
    value: String,
    resolver_kind: &str,
) -> GetOutputEnvelope {
    GetOutputEnvelope {
        resource: request.context.resource.clone(),
        request_id: request.id.clone(),
        decision: GetDecision::Allow,
        value: Some(value),
        resolver_kind: Some(resolver_kind.to_string()),
        error: None,
    }
}

fn build_get_error_output(
    request: &AccessRequest,
    decision: GetDecision,
    error: String,
) -> GetOutputEnvelope {
    GetOutputEnvelope {
        resource: request.context.resource.clone(),
        request_id: request.id.clone(),
        decision,
        value: None,
        resolver_kind: None,
        error: Some(error),
    }
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
    if !matches!(provider_kind, Some("acp" | "acp_codex")) {
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

fn build_import_receipt_output(
    receipt: &plankton_core::ImportedSecretReceipt,
) -> ImportReceiptOutputView {
    ImportReceiptOutputView {
        catalog_path: receipt.catalog_path.display().to_string(),
        resource: receipt.reference.resource.clone(),
        display_name: receipt.reference.display_name.clone(),
        description: receipt.reference.description.clone(),
        tags: receipt.reference.tags.clone(),
        metadata: receipt.reference.metadata.clone(),
        provider_kind: receipt.reference.provider_kind().to_string(),
        container_label: receipt.reference.container_label().map(ToOwned::to_owned),
        field_selector: receipt.reference.field_selector().to_string(),
        imported_at: receipt.reference.imported_at,
        last_verified_at: receipt.reference.last_verified_at,
        source_locator: receipt.reference.source_locator.clone(),
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

fn render_import_receipt_text(output: &ImportReceiptOutputView) -> String {
    let mut lines = vec![
        format!("catalog_path: {}", output.catalog_path),
        format!("resource: {}", output.resource),
        format!("display_name: {}", output.display_name),
        format!("provider_kind: {}", output.provider_kind),
    ];

    if let Some(description) = output.description.as_deref() {
        lines.push(format!("description: {description}"));
    }

    if !output.tags.is_empty() {
        lines.push(format!("tags: {}", output.tags.join(",")));
    }

    if !output.metadata.is_empty() {
        lines.push(format!("metadata: {}", format_map(&output.metadata)));
    }

    if let Some(container_label) = output.container_label.as_deref() {
        lines.push(format!("container_label: {container_label}"));
    }

    lines.extend([
        format!("field_selector: {}", output.field_selector),
        format!("imported_at: {}", output.imported_at.to_rfc3339()),
    ]);

    if let Some(last_verified_at) = output.last_verified_at {
        lines.push(format!(
            "last_verified_at: {}",
            last_verified_at.to_rfc3339()
        ));
    }

    lines.push(format!(
        "source_locator: {}",
        render_source_locator_summary(&output.source_locator)
    ));

    lines.join("\n")
}

fn render_source_locator_summary(locator: &SecretSourceLocator) -> String {
    match locator {
        SecretSourceLocator::OnePasswordCli {
            account,
            vault,
            item,
            field,
            ..
        } => format!("account={account} vault={vault} item={item} field={field}"),
        SecretSourceLocator::BitwardenCli {
            account,
            organization,
            collection,
            folder,
            item,
            field,
            ..
        } => {
            let mut parts = vec![format!("account={account}")];
            if let Some(organization) = organization.as_deref() {
                parts.push(format!("organization={organization}"));
            }
            if let Some(collection) = collection.as_deref() {
                parts.push(format!("collection={collection}"));
            }
            if let Some(folder) = folder.as_deref() {
                parts.push(format!("folder={folder}"));
            }
            parts.push(format!("item={item}"));
            parts.push(format!("field={field}"));
            parts.join(" ")
        }
        SecretSourceLocator::DotenvFile {
            file_path,
            namespace,
            prefix,
            key,
        } => {
            let mut parts = vec![format!("file={}", file_path.display())];
            if let Some(namespace) = namespace.as_deref() {
                parts.push(format!("namespace={namespace}"));
            }
            if let Some(prefix) = prefix.as_deref() {
                parts.push(format!("prefix={prefix}"));
            }
            parts.push(format!("key={key}"));
            parts.join(" ")
        }
    }
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
                assert_eq!(args.policy_mode, None);
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
                assert_eq!(args.policy_mode, None);
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
                assert_eq!(args.policy_mode, Some(CliPolicyMode::Assisted));
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
                assert_eq!(args.policy_mode, Some(CliPolicyMode::Auto));
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
                assert_eq!(args.policy_mode, Some(CliPolicyMode::ManualOnly));
            }
            _ => panic!("expected get command"),
        }
    }

    #[test]
    fn resolves_policy_mode_from_settings_when_flag_is_omitted() {
        let mut settings = load_settings().expect("default settings should load");
        settings.default_policy_mode = PolicyMode::LlmAutomatic;

        assert_eq!(
            resolve_requested_policy_mode(None, &settings),
            PolicyMode::LlmAutomatic
        );
        assert_eq!(
            resolve_requested_policy_mode(Some(CliPolicyMode::Assisted), &settings),
            PolicyMode::Assisted
        );
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
    fn get_success_output_uses_minimal_value_envelope() {
        let request = AccessRequest::new_pending(
            RequestContext::new(
                "secret/demo".to_string(),
                "Need demo value".to_string(),
                "alice".to_string(),
            ),
            PolicyMode::LlmAutomatic,
            Some("mock".to_string()),
            "rendered prompt".to_string(),
            None,
            None,
        );

        let output = build_get_success_output(
            &request,
            "resolved-secret".to_string(),
            "local_secret_catalog",
        );
        let serialized =
            serde_json::to_value(&output).expect("get success output should serialize to JSON");

        assert_eq!(serialized["resource"], "secret/demo");
        assert_eq!(serialized["request_id"], request.id);
        assert_eq!(serialized["decision"], "allow");
        assert_eq!(serialized["value"], "resolved-secret");
        assert_eq!(serialized["resolver_kind"], "local_secret_catalog");
        assert!(serialized.get("error").is_none());
    }

    #[test]
    fn get_error_output_omits_value_and_resolver_kind() {
        let request = AccessRequest::new_pending(
            RequestContext::new(
                "secret/demo".to_string(),
                "Need demo value".to_string(),
                "alice".to_string(),
            ),
            PolicyMode::ManualOnly,
            None,
            "rendered prompt".to_string(),
            None,
            None,
        );

        let output = build_get_error_output(
            &request,
            GetDecision::Allow,
            "request was allowed but the local catalog entry is missing".to_string(),
        );
        let serialized =
            serde_json::to_value(&output).expect("get error output should serialize to JSON");

        assert_eq!(serialized["resource"], "secret/demo");
        assert_eq!(serialized["request_id"], request.id);
        assert_eq!(serialized["decision"], "allow");
        assert_eq!(
            serialized["error"],
            "request was allowed but the local catalog entry is missing"
        );
        assert!(serialized.get("value").is_none());
        assert!(serialized.get("resolver_kind").is_none());
    }

    #[test]
    fn resolver_bootstrap_error_guides_user_to_local_catalog() {
        let request = AccessRequest::new_pending(
            RequestContext::new(
                "secret/demo".to_string(),
                "Need demo value".to_string(),
                "alice".to_string(),
            ),
            PolicyMode::LlmAutomatic,
            Some("mock".to_string()),
            "rendered prompt".to_string(),
            None,
            None,
        );

        let message = build_get_resolver_bootstrap_error(
            &request,
            &ValueResolverError::CatalogBootstrapRequired {
                path: "/tmp/plankton-secrets.toml".to_string(),
                created: true,
            },
        );

        assert!(message.contains("Plankton could not return the value"));
        assert!(message
            .contains("a starter local secret catalog was created at /tmp/plankton-secrets.toml"));
        assert!(message.contains("[secrets] \"secret/demo\" = \"<value>\""));
        assert!(!message.contains("could not be initialized"));
    }

    #[test]
    fn resolver_missing_catalog_error_uses_setup_language() {
        let request = AccessRequest::new_pending(
            RequestContext::new(
                "secret/demo".to_string(),
                "Need demo value".to_string(),
                "alice".to_string(),
            ),
            PolicyMode::LlmAutomatic,
            Some("mock".to_string()),
            "rendered prompt".to_string(),
            None,
            None,
        );

        let message = build_get_resolver_bootstrap_error(
            &request,
            &ValueResolverError::CatalogMissing {
                path: "/tmp/plankton-secrets.toml".to_string(),
            },
        );

        assert!(message.contains("set up the local secret catalog at /tmp/plankton-secrets.toml"));
        assert!(message.contains("run `plankton get` again"));
        assert!(!message.contains("value resolver could not be initialized"));
    }

    #[test]
    fn deny_error_message_includes_reason_when_decision_note_exists() {
        let mut request = AccessRequest::new_pending(
            RequestContext::new(
                "secret/demo".to_string(),
                "Need demo value".to_string(),
                "alice".to_string(),
            ),
            PolicyMode::ManualOnly,
            None,
            "rendered prompt".to_string(),
            None,
            None,
        );
        let audits = request
            .apply_manual_decision(
                Decision::Deny,
                "reviewer",
                Some("outside the approved maintenance window".to_string()),
            )
            .expect("manual deny should succeed");
        let result = RequestQueryResult {
            request,
            audit_records: audits,
        };

        let message = build_get_deny_error_message(&result);

        assert_eq!(
            message,
            format!(
                "request {} was denied for resource secret/demo: outside the approved maintenance window",
                result.request.id
            )
        );
    }

    #[test]
    fn deny_error_message_stays_compact_without_decision_reason() {
        let mut request = AccessRequest::new_pending(
            RequestContext::new(
                "secret/demo".to_string(),
                "Need demo value".to_string(),
                "alice".to_string(),
            ),
            PolicyMode::ManualOnly,
            None,
            "rendered prompt".to_string(),
            None,
            None,
        );
        let audits = request
            .apply_manual_decision(Decision::Deny, "reviewer", None)
            .expect("manual deny should succeed");
        let result = RequestQueryResult {
            request,
            audit_records: audits,
        };

        let message = build_get_deny_error_message(&result);

        assert_eq!(
            message,
            format!(
                "request {} was denied for resource secret/demo",
                result.request.id
            )
        );
    }

    #[test]
    fn deny_failure_json_error_includes_reason_when_present() {
        let mut request = AccessRequest::new_pending(
            RequestContext::new(
                "secret/demo".to_string(),
                "Need demo value".to_string(),
                "alice".to_string(),
            ),
            PolicyMode::ManualOnly,
            None,
            "rendered prompt".to_string(),
            None,
            None,
        );
        let audits = request
            .apply_manual_decision(
                Decision::Deny,
                "reviewer",
                Some("change request was not approved".to_string()),
            )
            .expect("manual deny should succeed");
        let result = RequestQueryResult {
            request,
            audit_records: audits,
        };

        let output = build_get_error_output(
            &result.request,
            GetDecision::Deny,
            build_get_deny_error_message(&result),
        );
        let serialized =
            serde_json::to_value(&output).expect("get error output should serialize to JSON");

        assert_eq!(serialized["decision"], "deny");
        assert_eq!(
            serialized["error"],
            format!(
                "request {} was denied for resource secret/demo: change request was not approved",
                result.request.id
            )
        );
        assert!(serialized.get("value").is_none());
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
    fn help_text_marks_cli_as_non_approval_surface() {
        let mut command = Cli::command();
        let help = command.render_long_help().to_string();

        assert!(help.contains("desktop UI"));
        assert!(help.contains("`get`, `list`, `search`, and `import`"));
        assert!(help.contains("\n  get"));
        assert!(help.contains("\n  list"));
        assert!(help.contains("\n  search"));
        assert!(help.contains("\n  import"));
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
        assert!(get_help.contains(
            "When omitted, Plankton uses the configured default policy mode from settings."
        ));
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

        assert!(list_help.contains("local secret catalog entries"));
        assert!(list_help.contains("metadata and source annotations"));
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
            provider_kind: "acp".to_string(),
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
            Some("acp".to_string()),
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

        assert!(rendered.contains("provider_kind: acp"));
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
            Some("acp")
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
        assert!(rendered_audit.contains("provider_kind: acp"));
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
                template_version: Some("2".to_string()),
                prompt_contract_version: Some("sanitized_prompt_context.v2".to_string()),
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
                template_version: Some("2".to_string()),
                prompt_contract_version: Some("sanitized_prompt_context.v2".to_string()),
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
    fn renders_accessible_resource_list_with_metadata() {
        let resources = vec![ResourceDirectoryEntryView {
            resource: "secret/dev-token".to_string(),
            entry_kind: ResourceDirectoryEntryKind::Imported,
            display_name: Some("Dev Token".to_string()),
            description: Some("temporary token".to_string()),
            tags: vec!["dev".to_string(), "api".to_string()],
            metadata: BTreeMap::from([("owner".to_string(), "alice".to_string())]),
            provider_kind: Some("dotenv_file".to_string()),
            container_label: Some("dev".to_string()),
            field_selector: Some("API_TOKEN".to_string()),
            imported_at: None,
            last_verified_at: None,
        }];

        let rendered = render_resource_directory_text(&resources);

        assert!(rendered.contains("secret/dev-token"));
        assert!(rendered.contains("display_name: Dev Token"));
        assert!(rendered.contains("description: temporary token"));
        assert!(rendered.contains("tags: dev, api"));
        assert!(rendered.contains("metadata: owner=alice"));
        assert!(rendered.contains("provider_kind: dotenv_file"));
    }

    #[test]
    fn filters_accessible_resources_by_case_insensitive_directory_fields() {
        let resources = vec![
            ResourceDirectoryEntryView {
                resource: "secret/dev-token".to_string(),
                entry_kind: ResourceDirectoryEntryKind::Imported,
                display_name: Some("Dev Token".to_string()),
                description: Some("temporary token".to_string()),
                tags: vec!["dev".to_string()],
                metadata: BTreeMap::new(),
                provider_kind: Some("dotenv_file".to_string()),
                container_label: Some("dev".to_string()),
                field_selector: Some("API_TOKEN".to_string()),
                imported_at: None,
                last_verified_at: None,
            },
            ResourceDirectoryEntryView {
                resource: "config/prod-readonly".to_string(),
                entry_kind: ResourceDirectoryEntryKind::Literal,
                display_name: Some("Readonly".to_string()),
                description: None,
                tags: vec!["prod".to_string()],
                metadata: BTreeMap::from([("team".to_string(), "platform".to_string())]),
                provider_kind: None,
                container_label: None,
                field_selector: None,
                imported_at: None,
                last_verified_at: None,
            },
        ];

        let filtered = filter_resource_directory(&resources, "platform");

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].resource, "config/prod-readonly");
    }

    #[test]
    fn parses_hidden_dotenv_import_command() {
        let cli = Cli::try_parse_from([
            "plankton",
            "import-source",
            "dotenv-file",
            "--resource",
            "secret/demo",
            "--file",
            "/tmp/demo.env",
            "--namespace",
            "dev",
            "--prefix",
            "APP_",
            "--key",
            "DEMO_TOKEN",
        ])
        .expect("hidden import command should parse");

        let spec = match cli.command {
            Commands::Import(args) => build_import_spec(args),
            _ => panic!("expected hidden import command"),
        };

        assert_eq!(spec.resource, "secret/demo");
        assert_eq!(spec.display_name, None);
        assert!(matches!(
            spec.source_locator,
            SecretSourceLocator::DotenvFile {
                file_path,
                namespace,
                prefix,
                key
            } if file_path == PathBuf::from("/tmp/demo.env")
                && namespace.as_deref() == Some("dev")
                && prefix.as_deref() == Some("APP_")
                && key == "DEMO_TOKEN"
        ));
    }

    #[test]
    fn parses_public_dotenv_import_command() {
        let cli = Cli::try_parse_from([
            "plankton",
            "import",
            "dotenv-file",
            "--resource",
            "secret/demo",
            "--file",
            "/tmp/demo.env",
            "--key",
            "DEMO_TOKEN",
        ])
        .expect("public import command should parse");

        let spec = match cli.command {
            Commands::Import(args) => build_import_spec(args),
            _ => panic!("expected import command"),
        };

        assert_eq!(spec.resource, "secret/demo");
        assert!(matches!(
            spec.source_locator,
            SecretSourceLocator::DotenvFile {
                file_path,
                namespace,
                prefix,
                key
            } if file_path == PathBuf::from("/tmp/demo.env")
                && namespace.is_none()
                && prefix.is_none()
                && key == "DEMO_TOKEN"
        ));
    }

    #[test]
    fn parses_public_dotenv_import_command_without_resource() {
        let cli = Cli::try_parse_from([
            "plankton",
            "import",
            "dotenv-file",
            "--file",
            "/tmp/demo.env",
            "--key",
            "DEMO_TOKEN",
        ])
        .expect("public import command should parse without an explicit resource");

        let spec = match cli.command {
            Commands::Import(args) => build_import_spec(args),
            _ => panic!("expected import command"),
        };

        assert_eq!(spec.resource, "");
        assert!(matches!(
            spec.source_locator,
            SecretSourceLocator::DotenvFile {
                file_path,
                namespace,
                prefix,
                key
            } if file_path == PathBuf::from("/tmp/demo.env")
                && namespace.is_none()
                && prefix.is_none()
                && key == "DEMO_TOKEN"
        ));
    }

    #[test]
    fn renders_import_receipt_without_secret_value() {
        let output = build_import_receipt_output(&plankton_core::ImportedSecretReceipt {
            catalog_path: PathBuf::from("/tmp/plankton-secrets.toml"),
            reference: plankton_core::ImportedSecretReference {
                resource: "secret/demo".to_string(),
                display_name: "Demo token".to_string(),
                description: Some("dotenv-backed".to_string()),
                tags: vec!["demo".to_string()],
                metadata: BTreeMap::from([("owner".to_string(), "alice".to_string())]),
                source_locator: SecretSourceLocator::DotenvFile {
                    file_path: PathBuf::from("/tmp/demo.env"),
                    namespace: Some("dev".to_string()),
                    prefix: Some("APP_".to_string()),
                    key: "DEMO_TOKEN".to_string(),
                },
                imported_at: chrono::Utc::now(),
                last_verified_at: None,
            },
        });

        let rendered = render_import_receipt_text(&output);
        let serialized =
            serde_json::to_value(&output).expect("import receipt output should serialize");

        assert!(rendered.contains("resource: secret/demo"));
        assert!(rendered.contains("provider_kind: dotenv_file"));
        assert!(rendered.contains("metadata: owner=alice"));
        assert!(rendered.contains("source_locator: file=/tmp/demo.env"));
        assert!(!rendered.contains("demo-value"));
        assert_eq!(serialized["provider_kind"], "dotenv_file");
        assert!(serialized["source_locator"]["provider_kind"] == "dotenv_file");
    }

    #[test]
    fn rejects_invalid_key_values() {
        let error = parse_key_values("metadata", vec!["broken".to_string()])
            .expect_err("missing equals sign should fail");

        assert!(error.to_string().contains("invalid --metadata value"));
    }
}
