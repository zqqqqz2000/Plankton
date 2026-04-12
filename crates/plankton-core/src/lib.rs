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
    AcpPromptResult, AcpSessionClient, AcpSessionConfig, ACP_CODEX_PACKAGE_NAME,
    ACP_CODEX_PACKAGE_VERSION, ACP_CODEX_PROVIDER_KIND, ACP_TRANSPORT_STDIO,
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
    load_settings, save_user_default_policy_mode, save_user_settings, user_settings_path,
    PlanktonSettings, SettingsError, SettingsPersistError, UserSettings,
    DEFAULT_USER_PROVIDER_KIND,
};
pub use domain::{
    AccessRequest, ApprovalStatus, AuditAction, AuditRecord, DashboardData, Decision, DomainError,
    LlmSuggestion, LlmSuggestionUsage, PolicyMode, ProviderInputSnapshot, ProviderTrace,
    RequestContext, SanitizedPromptContext, SuggestedDecision,
};
pub use provider::{
    build_provider_input_snapshot, generate_llm_suggestion, request_llm_suggestion,
    AcpCodexAdapter, ClaudeAdapter, ClaudeMessagesAdapter, MockProviderAdapter,
    OpenAiCompatibleAdapter, ProviderAdapter, ProviderError, ProviderRequest, ProviderResponse,
    CLAUDE_PROVIDER_KIND,
};
pub use sanitization::{sanitize_prompt_context, sanitize_request_context_for_storage};
pub use template::{
    render_llm_advice_template, render_request_template, TemplateError,
    DEFAULT_LLM_ADVICE_TEMPLATE, DEFAULT_LLM_SYSTEM_PROMPT, DEFAULT_REQUEST_TEMPLATE,
    LLM_ADVICE_TEMPLATE_ID, LLM_ADVICE_TEMPLATE_VERSION, PROMPT_CONTRACT_VERSION,
    REQUEST_TEMPLATE_ID, REQUEST_TEMPLATE_VERSION,
};
pub use value_resolver::{
    default_value_resolver, local_secret_catalog_path, LocalSecretCatalogResolver, ValueResolver,
    ValueResolverError,
};
