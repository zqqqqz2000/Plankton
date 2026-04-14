pub mod acp;
pub mod automatic;
pub mod call_chain;
pub mod config;
pub mod domain;
pub mod provider;
pub mod sanitization;
pub mod template;
pub mod value_resolver;

pub use acp::{
    AcpPromptResult, AcpSessionClient, AcpSessionConfig, ACP_DEFAULT_ARGS, ACP_DEFAULT_PROGRAM,
    ACP_LEGACY_CODEX_PROVIDER_KIND, ACP_PROVIDER_KIND, ACP_TRANSPORT_STDIO,
};
pub use automatic::{
    escalate_for_secret_exposure_risk, evaluate_automatic_disposition, evaluate_local_hard_rules,
    secret_exposure_risk, AutomaticDecisionSource, AutomaticDecisionTrace, AutomaticDisposition,
    AUTO_ALLOW_MAX_RISK_SCORE, AUTO_DENY_MIN_RISK_SCORE,
};
pub use call_chain::{
    collect_runtime_call_chain, derive_script_path, deserialize_call_chain_nodes,
    preview_call_chain_for_desktop, prompt_call_chain_paths, read_allowlisted_call_chain_file,
    read_allowlisted_paths_file, CallChainError, CallChainNode, CallChainNodeSource,
    CallChainPreviewStatus, CallChainReadFileResult,
};
pub use config::{
    load_settings, save_user_default_policy_mode, save_user_locale, save_user_settings,
    user_settings_path,
    PlanktonSettings, SettingsError, SettingsPersistError, UserSettings,
    DEFAULT_LOCALE, DEFAULT_USER_PROVIDER_KIND, SUPPORTED_LOCALES,
};
pub use domain::{
    AccessRequest, ApprovalStatus, AuditAction, AuditRecord, DashboardData, Decision, DomainError,
    LlmSuggestion, LlmSuggestionUsage, PolicyMode, ProviderInputSnapshot, ProviderTrace,
    RequestContext, SanitizedPromptContext, SuggestedDecision,
};
pub use provider::{
    build_provider_input_snapshot, generate_llm_suggestion, request_llm_suggestion, AcpAdapter,
    ClaudeAdapter, ClaudeMessagesAdapter, MockProviderAdapter, OpenAiCompatibleAdapter,
    ProviderAdapter, ProviderError, ProviderRequest, ProviderResponse, CLAUDE_PROVIDER_KIND,
};
pub use sanitization::{sanitize_prompt_context, sanitize_request_context_for_storage};
pub use template::{
    render_llm_advice_template, render_request_template, TemplateError,
    DEFAULT_LLM_ADVICE_TEMPLATE, DEFAULT_LLM_SYSTEM_PROMPT, DEFAULT_REQUEST_TEMPLATE,
    LLM_ADVICE_TEMPLATE_ID, LLM_ADVICE_TEMPLATE_VERSION, PROMPT_CONTRACT_VERSION,
    REQUEST_TEMPLATE_ID, REQUEST_TEMPLATE_VERSION,
};
pub use value_resolver::{
    default_value_resolver, delete_imported_secret_reference, delete_local_secret_entry,
    import_secret_reference, import_secret_references, list_imported_secret_references,
    list_local_secret_catalog, local_secret_catalog_path, update_imported_secret_reference,
    upsert_local_secret_literal, ImportedSecretBatchReceipt, ImportedSecretCatalog,
    ImportedSecretReceipt, ImportedSecretReference, ImportedSecretReferenceUpdate,
    LocalSecretCatalog, LocalSecretCatalogResolver, LocalSecretLiteralEntry,
    LocalSecretLiteralUpsert, SecretImportBatchSpec, SecretImportError, SecretImportSpec,
    SecretSourceLocator, ValueResolver, ValueResolverError, BITWARDEN_CLI_PROVIDER_KIND,
    DOTENV_FILE_PROVIDER_KIND, ONEPASSWORD_CLI_PROVIDER_KIND,
};
