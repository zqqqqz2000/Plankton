use std::path::PathBuf;

use config::{Config, ConfigError, Environment, File};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

use crate::template::{
    DEFAULT_LLM_ADVICE_TEMPLATE, DEFAULT_LLM_SYSTEM_PROMPT, DEFAULT_REQUEST_TEMPLATE,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanktonSettings {
    pub database_url: String,
    pub provider_kind: String,
    pub request_template: String,
    pub llm_advice_template: String,
    pub llm_advice_system_prompt: String,
    pub openai_api_base: String,
    pub openai_api_key: String,
    pub openai_model: String,
    pub openai_temperature: f32,
    pub claude_api_base: String,
    pub claude_api_key: String,
    pub claude_model: String,
    pub claude_anthropic_version: String,
    pub claude_max_tokens: u32,
    pub claude_temperature: f32,
    pub claude_timeout_secs: u64,
    pub acp_codex_program: String,
    pub acp_codex_args: String,
    pub acp_timeout_secs: u64,
    pub recent_audit_limit: u32,
}

impl Default for PlanktonSettings {
    fn default() -> Self {
        Self {
            database_url: default_database_url(),
            provider_kind: "mock".to_string(),
            request_template: DEFAULT_REQUEST_TEMPLATE.to_string(),
            llm_advice_template: DEFAULT_LLM_ADVICE_TEMPLATE.to_string(),
            llm_advice_system_prompt: DEFAULT_LLM_SYSTEM_PROMPT.to_string(),
            openai_api_base: "https://api.openai.com/v1".to_string(),
            openai_api_key: String::new(),
            openai_model: String::new(),
            openai_temperature: 0.0,
            claude_api_base: "https://api.anthropic.com".to_string(),
            claude_api_key: String::new(),
            claude_model: "claude-sonnet-4-5".to_string(),
            claude_anthropic_version: "2023-06-01".to_string(),
            claude_max_tokens: 512,
            claude_temperature: 0.0,
            claude_timeout_secs: 30,
            acp_codex_program: "npx".to_string(),
            acp_codex_args: "-y @zed-industries/codex-acp@0.11.1".to_string(),
            acp_timeout_secs: 30,
            recent_audit_limit: 20,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("failed to build configuration: {0}")]
    Build(#[from] ConfigError),
}

pub fn load_settings() -> Result<PlanktonSettings, SettingsError> {
    let defaults = PlanktonSettings::default();
    let config = Config::builder()
        .set_default("database_url", defaults.database_url.clone())?
        .set_default("provider_kind", defaults.provider_kind.clone())?
        .set_default("request_template", defaults.request_template.clone())?
        .set_default("llm_advice_template", defaults.llm_advice_template.clone())?
        .set_default(
            "llm_advice_system_prompt",
            defaults.llm_advice_system_prompt.clone(),
        )?
        .set_default("openai_api_base", defaults.openai_api_base.clone())?
        .set_default("openai_api_key", defaults.openai_api_key.clone())?
        .set_default("openai_model", defaults.openai_model.clone())?
        .set_default("openai_temperature", defaults.openai_temperature as f64)?
        .set_default("claude_api_base", defaults.claude_api_base.clone())?
        .set_default("claude_api_key", defaults.claude_api_key.clone())?
        .set_default("claude_model", defaults.claude_model.clone())?
        .set_default(
            "claude_anthropic_version",
            defaults.claude_anthropic_version.clone(),
        )?
        .set_default("claude_max_tokens", defaults.claude_max_tokens as i64)?
        .set_default("claude_temperature", defaults.claude_temperature as f64)?
        .set_default("claude_timeout_secs", defaults.claude_timeout_secs as i64)?
        .set_default("acp_codex_program", defaults.acp_codex_program.clone())?
        .set_default("acp_codex_args", defaults.acp_codex_args.clone())?
        .set_default("acp_timeout_secs", defaults.acp_timeout_secs as i64)?
        .set_default("recent_audit_limit", defaults.recent_audit_limit)?
        .add_source(File::with_name("plankton").required(false))
        .add_source(Environment::with_prefix("PLANKTON").separator("__"))
        .build()?;

    let mut settings: PlanktonSettings = config.try_deserialize()?;
    apply_env_overrides(&mut settings);

    Ok(settings)
}

pub fn default_database_url() -> String {
    let db_path = default_database_path();
    format!("sqlite://{}", db_path.display())
}

fn default_database_path() -> PathBuf {
    if let Some(project_dirs) = ProjectDirs::from("com", "OpenAquarium", "Plankton") {
        return project_dirs.data_local_dir().join("plankton.db");
    }

    std::env::temp_dir().join("plankton.db")
}

fn apply_env_overrides(settings: &mut PlanktonSettings) {
    if let Ok(database_url) = std::env::var("PLANKTON_DATABASE_URL") {
        if !database_url.trim().is_empty() {
            settings.database_url = database_url;
        }
    }

    if let Ok(provider_kind) = std::env::var("PLANKTON_PROVIDER_KIND") {
        if !provider_kind.trim().is_empty() {
            settings.provider_kind = provider_kind;
        }
    }

    if let Ok(template) = std::env::var("PLANKTON_REQUEST_TEMPLATE") {
        if !template.trim().is_empty() {
            settings.request_template = template;
        }
    }

    if let Ok(template) = std::env::var("PLANKTON_LLM_ADVICE_TEMPLATE") {
        if !template.trim().is_empty() {
            settings.llm_advice_template = template;
        }
    }

    if let Ok(system_prompt) = std::env::var("PLANKTON_LLM_ADVICE_SYSTEM_PROMPT") {
        if !system_prompt.trim().is_empty() {
            settings.llm_advice_system_prompt = system_prompt;
        }
    }

    if let Ok(api_base) = std::env::var("PLANKTON_OPENAI_API_BASE") {
        if !api_base.trim().is_empty() {
            settings.openai_api_base = api_base;
        }
    }

    if let Ok(api_key) = std::env::var("PLANKTON_OPENAI_API_KEY") {
        settings.openai_api_key = api_key;
    }

    if let Ok(model) = std::env::var("PLANKTON_OPENAI_MODEL") {
        if !model.trim().is_empty() {
            settings.openai_model = model;
        }
    }

    if let Ok(temperature) = std::env::var("PLANKTON_OPENAI_TEMPERATURE") {
        if let Ok(temperature) = temperature.parse::<f32>() {
            settings.openai_temperature = temperature;
        }
    }

    if let Ok(api_base) = std::env::var("PLANKTON_CLAUDE_API_BASE") {
        if !api_base.trim().is_empty() {
            settings.claude_api_base = api_base;
        }
    }

    if let Ok(api_key) = std::env::var("PLANKTON_CLAUDE_API_KEY") {
        settings.claude_api_key = api_key;
    }

    if let Ok(model) = std::env::var("PLANKTON_CLAUDE_MODEL") {
        if !model.trim().is_empty() {
            settings.claude_model = model;
        }
    }

    if let Ok(version) = std::env::var("PLANKTON_CLAUDE_ANTHROPIC_VERSION") {
        if !version.trim().is_empty() {
            settings.claude_anthropic_version = version;
        }
    }

    if let Ok(version) = std::env::var("PLANKTON_CLAUDE_VERSION") {
        if !version.trim().is_empty() {
            settings.claude_anthropic_version = version;
        }
    }

    if let Ok(max_tokens) = std::env::var("PLANKTON_CLAUDE_MAX_TOKENS") {
        if let Ok(max_tokens) = max_tokens.parse::<u32>() {
            settings.claude_max_tokens = max_tokens;
        }
    }

    if let Ok(temperature) = std::env::var("PLANKTON_CLAUDE_TEMPERATURE") {
        if let Ok(temperature) = temperature.parse::<f32>() {
            settings.claude_temperature = temperature;
        }
    }

    if let Ok(timeout_secs) = std::env::var("PLANKTON_CLAUDE_TIMEOUT_SECS") {
        if let Ok(timeout_secs) = timeout_secs.parse::<u64>() {
            settings.claude_timeout_secs = timeout_secs;
        }
    }

    if let Ok(program) = std::env::var("PLANKTON_ACP_CODEX_PROGRAM") {
        if !program.trim().is_empty() {
            settings.acp_codex_program = program;
        }
    }

    if let Ok(args) = std::env::var("PLANKTON_ACP_CODEX_ARGS") {
        if !args.trim().is_empty() {
            settings.acp_codex_args = args;
        }
    }

    if let Ok(timeout_secs) = std::env::var("PLANKTON_ACP_TIMEOUT_SECS") {
        if let Ok(timeout_secs) = timeout_secs.parse::<u64>() {
            settings.acp_timeout_secs = timeout_secs;
        }
    }

    if let Ok(limit) = std::env::var("PLANKTON_RECENT_AUDIT_LIMIT") {
        if let Ok(limit) = limit.parse::<u32>() {
            settings.recent_audit_limit = limit;
        }
    }
}
