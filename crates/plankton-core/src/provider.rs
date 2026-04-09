use async_openai::{
    config::OpenAIConfig,
    types::chat::{
        ChatCompletionRequestSystemMessageArgs, ChatCompletionRequestUserMessageArgs,
        CreateChatCompletionRequestArgs,
    },
    Client,
};
use async_trait::async_trait;
use std::time::Duration;

use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    render_llm_advice_template, AcpSessionClient, LlmSuggestion, LlmSuggestionUsage,
    PlanktonSettings, PolicyMode, ProviderInputSnapshot, ProviderTrace, SanitizedPromptContext,
    SuggestedDecision, TemplateError, ACP_CODEX_PROVIDER_KIND, LLM_ADVICE_TEMPLATE_ID,
    LLM_ADVICE_TEMPLATE_VERSION, PROMPT_CONTRACT_VERSION,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderRequest {
    pub template_id: String,
    pub template_version: String,
    pub prompt_contract_version: String,
    pub prompt_sha256: String,
    pub policy_mode: PolicyMode,
    pub prompt: String,
    pub sanitized_context: SanitizedPromptContext,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderResponse {
    pub suggested_decision: SuggestedDecision,
    pub rationale_summary: String,
    pub risk_score: u8,
    pub provider_response_id: Option<String>,
    pub x_request_id: Option<String>,
    pub provider_trace: Option<ProviderTrace>,
    pub usage: Option<LlmSuggestionUsage>,
    pub model: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("unsupported provider kind {0}")]
    Unsupported(String),
    #[error("provider configuration error: {0}")]
    Config(String),
    #[error("prompt template error: {0}")]
    Template(#[from] TemplateError),
    #[error("failed to build provider request: {0}")]
    RequestBuild(String),
    #[error("provider transport error: {0}")]
    Transport(String),
    #[error("provider response did not include any message content")]
    EmptyResponse,
    #[error("provider response was not valid JSON: {0}")]
    InvalidResponse(String),
}

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    fn kind(&self) -> &'static str;

    async fn evaluate(&self, request: ProviderRequest) -> Result<ProviderResponse, ProviderError>;
}

#[derive(Debug, Default)]
pub struct MockProviderAdapter;

#[async_trait]
impl ProviderAdapter for MockProviderAdapter {
    fn kind(&self) -> &'static str {
        "mock"
    }

    async fn evaluate(&self, request: ProviderRequest) -> Result<ProviderResponse, ProviderError> {
        let suggested_decision = if !request.sanitized_context.redacted_fields.is_empty() {
            SuggestedDecision::Escalate
        } else if request.sanitized_context.resource.contains("prod")
            || request
                .sanitized_context
                .reason
                .to_ascii_lowercase()
                .contains("production")
        {
            SuggestedDecision::Deny
        } else {
            SuggestedDecision::Allow
        };
        let (summary, risk_score) = match suggested_decision {
            SuggestedDecision::Allow => (
                "Low-risk mock suggestion based on sanitized non-production context".to_string(),
                20,
            ),
            SuggestedDecision::Deny => (
                "Mock provider marked the request as risky because it appears production-scoped"
                    .to_string(),
                82,
            ),
            SuggestedDecision::Escalate => (
                "Mock provider escalated because provider-visible context was redacted".to_string(),
                68,
            ),
        };

        Ok(ProviderResponse {
            suggested_decision,
            rationale_summary: summary,
            risk_score,
            provider_response_id: None,
            x_request_id: None,
            provider_trace: None,
            usage: None,
            model: Some("mock-suggestion-v1".to_string()),
        })
    }
}

#[derive(Debug, Clone)]
pub struct OpenAiCompatibleAdapter {
    client: Client<OpenAIConfig>,
    model: String,
    system_prompt: String,
    temperature: f32,
}

impl OpenAiCompatibleAdapter {
    pub fn try_from_settings(settings: &PlanktonSettings) -> Result<Self, ProviderError> {
        if settings.openai_api_key.trim().is_empty() {
            return Err(ProviderError::Config(
                "PLANKTON_OPENAI_API_KEY must be set for openai_compatible".to_string(),
            ));
        }

        if settings.openai_model.trim().is_empty() {
            return Err(ProviderError::Config(
                "PLANKTON_OPENAI_MODEL must be set for openai_compatible".to_string(),
            ));
        }

        let mut config = OpenAIConfig::new().with_api_key(settings.openai_api_key.clone());
        let api_base = settings.openai_api_base.trim().trim_end_matches('/');
        if !api_base.is_empty() {
            config = config.with_api_base(api_base.to_string());
        }

        Ok(Self {
            client: Client::with_config(config),
            model: settings.openai_model.clone(),
            system_prompt: settings.llm_advice_system_prompt.clone(),
            temperature: settings.openai_temperature,
        })
    }
}

#[async_trait]
impl ProviderAdapter for OpenAiCompatibleAdapter {
    fn kind(&self) -> &'static str {
        "openai_compatible"
    }

    async fn evaluate(&self, request: ProviderRequest) -> Result<ProviderResponse, ProviderError> {
        let system_message = ChatCompletionRequestSystemMessageArgs::default()
            .content(self.system_prompt.clone())
            .build()
            .map_err(|error| ProviderError::RequestBuild(error.to_string()))?;
        let user_message = ChatCompletionRequestUserMessageArgs::default()
            .content(request.prompt)
            .build()
            .map_err(|error| ProviderError::RequestBuild(error.to_string()))?;
        let completion_request = CreateChatCompletionRequestArgs::default()
            .model(self.model.clone())
            .temperature(self.temperature)
            .messages([system_message.into(), user_message.into()])
            .build()
            .map_err(|error| ProviderError::RequestBuild(error.to_string()))?;
        let response = self
            .client
            .chat()
            .create(completion_request)
            .await
            .map_err(|error| ProviderError::Transport(error.to_string()))?;
        let content = response
            .choices
            .first()
            .and_then(|choice| choice.message.content.clone())
            .ok_or(ProviderError::EmptyResponse)?;
        let payload = parse_suggestion_payload(&content)?;

        Ok(ProviderResponse {
            suggested_decision: payload.suggested_decision,
            rationale_summary: payload.rationale_summary,
            risk_score: payload.risk_score.min(100),
            provider_response_id: Some(response.id),
            x_request_id: None,
            provider_trace: None,
            usage: response.usage.map(|usage| LlmSuggestionUsage {
                prompt_tokens: usage.prompt_tokens as u32,
                completion_tokens: usage.completion_tokens as u32,
                total_tokens: usage.total_tokens as u32,
            }),
            model: Some(response.model),
        })
    }
}

pub const CLAUDE_PROVIDER_KIND: &str = "claude";
const CLAUDE_TRANSPORT_HTTPS: &str = "https";
const CLAUDE_PROTOCOL_ANTHROPIC_MESSAGES: &str = "anthropic_messages";
const CLAUDE_OUTPUT_FORMAT_JSON_SCHEMA: &str = "json_schema";
const CLAUDE_STOP_REASON_END_TURN: &str = "end_turn";
const CLAUDE_STOP_REASON_REFUSAL: &str = "refusal";
const CLAUDE_FAIL_CLOSED_STOP_REASONS: &[&str] = &[
    "tool_use",
    "pause_turn",
    "max_tokens",
    "model_context_window_exceeded",
    "stop_sequence",
];

#[derive(Debug, Clone)]
pub struct ClaudeMessagesAdapter {
    client: HttpClient,
    api_base: String,
    api_key: String,
    model: String,
    anthropic_version: String,
    max_tokens: u32,
    system_prompt: String,
}

pub type ClaudeAdapter = ClaudeMessagesAdapter;

impl ClaudeMessagesAdapter {
    pub fn try_from_settings(settings: &PlanktonSettings) -> Result<Self, ProviderError> {
        if settings.claude_api_key.trim().is_empty() {
            return Err(ProviderError::Config(
                "PLANKTON_CLAUDE_API_KEY must be set for claude".to_string(),
            ));
        }

        if settings.claude_model.trim().is_empty() {
            return Err(ProviderError::Config(
                "PLANKTON_CLAUDE_MODEL must be set for claude".to_string(),
            ));
        }

        if settings.claude_anthropic_version.trim().is_empty() {
            return Err(ProviderError::Config(
                "PLANKTON_CLAUDE_ANTHROPIC_VERSION must be set for claude".to_string(),
            ));
        }

        if settings.claude_max_tokens == 0 {
            return Err(ProviderError::Config(
                "PLANKTON_CLAUDE_MAX_TOKENS must be greater than zero".to_string(),
            ));
        }

        let client = HttpClient::builder()
            .timeout(Duration::from_secs(settings.claude_timeout_secs.max(1)))
            .build()
            .map_err(|error| {
                ProviderError::Config(format!("failed to build Claude HTTP client: {error}"))
            })?;

        Ok(Self {
            client,
            api_base: settings
                .claude_api_base
                .trim()
                .trim_end_matches('/')
                .to_string(),
            api_key: settings.claude_api_key.clone(),
            model: settings.claude_model.clone(),
            anthropic_version: settings.claude_anthropic_version.clone(),
            max_tokens: settings.claude_max_tokens,
            system_prompt: settings.llm_advice_system_prompt.clone(),
        })
    }
}

#[async_trait]
impl ProviderAdapter for ClaudeMessagesAdapter {
    fn kind(&self) -> &'static str {
        CLAUDE_PROVIDER_KIND
    }

    async fn evaluate(&self, request: ProviderRequest) -> Result<ProviderResponse, ProviderError> {
        let response = self
            .client
            .post(format!("{}/v1/messages", self.api_base))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", &self.anthropic_version)
            .header("content-type", "application/json")
            .json(&build_claude_messages_request(
                self.model.clone(),
                self.max_tokens,
                self.system_prompt.clone(),
                request.prompt,
            ))
            .send()
            .await
            .map_err(|error| ProviderError::Transport(error.to_string()))?;

        let request_id = extract_response_request_id(&response);
        let status = response.status();
        if !status.is_success() {
            let body = response
                .text()
                .await
                .map_err(|error| ProviderError::Transport(error.to_string()))?;
            return Err(ProviderError::Transport(format!(
                "Claude messages API returned {}{}: {}",
                status,
                request_id
                    .as_deref()
                    .map(|value| format!(" request_id={value}"))
                    .unwrap_or_default(),
                summarize_provider_error_body(&body)
            )));
        }

        let response_body: ClaudeMessagesResponse = response
            .json()
            .await
            .map_err(|error| ProviderError::InvalidResponse(error.to_string()))?;

        parse_claude_provider_response(response_body, request_id, &self.anthropic_version)
    }
}

#[derive(Debug, Clone)]
pub struct AcpCodexAdapter {
    client: AcpSessionClient,
    system_prompt: String,
}

impl AcpCodexAdapter {
    pub fn try_from_settings(settings: &PlanktonSettings) -> Result<Self, ProviderError> {
        Ok(Self {
            client: AcpSessionClient::from_settings(settings)?,
            system_prompt: settings.llm_advice_system_prompt.clone(),
        })
    }
}

#[async_trait]
impl ProviderAdapter for AcpCodexAdapter {
    fn kind(&self) -> &'static str {
        ACP_CODEX_PROVIDER_KIND
    }

    async fn evaluate(&self, request: ProviderRequest) -> Result<ProviderResponse, ProviderError> {
        let prompt = compose_acp_prompt(&self.system_prompt, &request.prompt);
        let result = self.client.prompt_json_suggestion(prompt).await?;
        let payload = parse_suggestion_payload(&result.content)?;

        Ok(ProviderResponse {
            suggested_decision: payload.suggested_decision,
            rationale_summary: payload.rationale_summary,
            risk_score: payload.risk_score.min(100),
            provider_response_id: None,
            x_request_id: result.trace.client_request_id.clone(),
            provider_trace: Some(result.trace),
            usage: None,
            model: result.provider_model,
        })
    }
}

pub async fn generate_llm_suggestion(
    settings: &PlanktonSettings,
    policy_mode: PolicyMode,
    sanitized_context: &SanitizedPromptContext,
) -> Result<(ProviderInputSnapshot, LlmSuggestion), ProviderError> {
    let provider_input = build_provider_input_snapshot(settings, policy_mode, sanitized_context)?;
    let suggestion = request_llm_suggestion(settings, policy_mode, &provider_input).await;

    Ok((provider_input, suggestion))
}

pub fn build_provider_input_snapshot(
    settings: &PlanktonSettings,
    policy_mode: PolicyMode,
    sanitized_context: &SanitizedPromptContext,
) -> Result<ProviderInputSnapshot, ProviderError> {
    let prompt = render_llm_advice_template(
        &settings.llm_advice_template,
        sanitized_context,
        policy_mode,
    )?;
    let prompt_sha256 = format!("{:x}", Sha256::digest(prompt.as_bytes()));
    Ok(ProviderInputSnapshot {
        template_id: LLM_ADVICE_TEMPLATE_ID.to_string(),
        template_version: LLM_ADVICE_TEMPLATE_VERSION.to_string(),
        prompt_contract_version: PROMPT_CONTRACT_VERSION.to_string(),
        prompt_sha256: prompt_sha256.clone(),
        prompt: prompt.clone(),
        sanitized_context: sanitized_context.clone(),
    })
}

pub async fn request_llm_suggestion(
    settings: &PlanktonSettings,
    policy_mode: PolicyMode,
    provider_input: &ProviderInputSnapshot,
) -> LlmSuggestion {
    let request = ProviderRequest {
        template_id: provider_input.template_id.clone(),
        template_version: provider_input.template_version.clone(),
        prompt_contract_version: provider_input.prompt_contract_version.clone(),
        prompt_sha256: provider_input.prompt_sha256.clone(),
        policy_mode,
        prompt: provider_input.prompt.clone(),
        sanitized_context: provider_input.sanitized_context.clone(),
    };
    let provider_kind = settings.provider_kind.trim().to_ascii_lowercase();
    let suggestion = match build_provider_adapter(settings) {
        Ok(adapter) => match adapter.evaluate(request).await {
            Ok(response) => LlmSuggestion {
                template_id: provider_input.template_id.clone(),
                template_version: provider_input.template_version.clone(),
                prompt_contract_version: provider_input.prompt_contract_version.clone(),
                prompt_sha256: provider_input.prompt_sha256.clone(),
                suggested_decision: response.suggested_decision,
                rationale_summary: response.rationale_summary,
                risk_score: response.risk_score.min(100),
                provider_kind: adapter.kind().to_string(),
                provider_model: response.model,
                provider_response_id: response.provider_response_id,
                x_request_id: response.x_request_id,
                provider_trace: response.provider_trace,
                usage: response.usage,
                error: None,
                generated_at: chrono::Utc::now(),
            },
            Err(error) => llm_suggestion_from_error(&provider_input, adapter.kind(), &error),
        },
        Err(error) => llm_suggestion_from_error(&provider_input, &provider_kind, &error),
    };

    suggestion
}

fn build_provider_adapter(
    settings: &PlanktonSettings,
) -> Result<Box<dyn ProviderAdapter>, ProviderError> {
    match settings.provider_kind.trim().to_ascii_lowercase().as_str() {
        "" => Ok(Box::new(MockProviderAdapter)),
        "mock" => Ok(Box::new(MockProviderAdapter)),
        "openai_compatible" => Ok(Box::new(OpenAiCompatibleAdapter::try_from_settings(
            settings,
        )?)),
        CLAUDE_PROVIDER_KIND => Ok(Box::new(ClaudeMessagesAdapter::try_from_settings(
            settings,
        )?)),
        ACP_CODEX_PROVIDER_KIND => Ok(Box::new(AcpCodexAdapter::try_from_settings(settings)?)),
        other => Err(ProviderError::Unsupported(other.to_string())),
    }
}

fn llm_suggestion_from_error(
    provider_input: &ProviderInputSnapshot,
    provider_kind: &str,
    error: &ProviderError,
) -> LlmSuggestion {
    LlmSuggestion {
        template_id: provider_input.template_id.clone(),
        template_version: provider_input.template_version.clone(),
        prompt_contract_version: provider_input.prompt_contract_version.clone(),
        prompt_sha256: provider_input.prompt_sha256.clone(),
        suggested_decision: SuggestedDecision::Escalate,
        rationale_summary: "Provider suggestion unavailable; manual review remains required"
            .to_string(),
        risk_score: 100,
        provider_kind: provider_kind.to_string(),
        provider_model: None,
        provider_response_id: None,
        x_request_id: None,
        provider_trace: None,
        usage: None,
        error: Some(error.to_string()),
        generated_at: chrono::Utc::now(),
    }
}

fn compose_acp_prompt(system_prompt: &str, prompt: &str) -> String {
    let system_prompt = system_prompt.trim();
    let prompt = prompt.trim();

    if system_prompt.is_empty() {
        prompt.to_string()
    } else {
        format!("{system_prompt}\n\n{prompt}")
    }
}

#[derive(Debug, Serialize)]
struct ClaudeMessagesRequest {
    model: String,
    max_tokens: u32,
    temperature: f32,
    stream: bool,
    system: String,
    messages: Vec<ClaudeMessageInput>,
    tools: Vec<ClaudeToolDefinition>,
    output_config: ClaudeOutputConfig,
}

#[derive(Debug, Serialize)]
struct ClaudeMessageInput {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct ClaudeToolDefinition {}

#[derive(Debug, Serialize)]
struct ClaudeOutputConfig {
    format: ClaudeOutputFormat,
}

#[derive(Debug, Serialize)]
struct ClaudeOutputFormat {
    #[serde(rename = "type")]
    kind: String,
    schema: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct ClaudeMessagesResponse {
    id: String,
    model: String,
    stop_reason: Option<String>,
    #[serde(default)]
    content: Vec<ClaudeContentBlock>,
    #[serde(default)]
    usage: Option<ClaudeUsage>,
}

#[derive(Debug, Deserialize)]
struct ClaudeContentBlock {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaudeUsage {
    input_tokens: u32,
    output_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct SuggestionPayload {
    suggested_decision: SuggestedDecision,
    rationale_summary: String,
    risk_score: u8,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StrictSuggestionPayload {
    suggested_decision: SuggestedDecision,
    rationale_summary: String,
    risk_score: u8,
}

impl From<StrictSuggestionPayload> for SuggestionPayload {
    fn from(value: StrictSuggestionPayload) -> Self {
        Self {
            suggested_decision: value.suggested_decision,
            rationale_summary: value.rationale_summary,
            risk_score: value.risk_score,
        }
    }
}

fn build_claude_messages_request(
    model: String,
    max_tokens: u32,
    system_prompt: String,
    prompt: String,
) -> ClaudeMessagesRequest {
    ClaudeMessagesRequest {
        model,
        max_tokens,
        temperature: 0.0,
        stream: false,
        system: system_prompt,
        messages: vec![ClaudeMessageInput {
            role: "user".to_string(),
            content: prompt,
        }],
        tools: Vec::new(),
        output_config: ClaudeOutputConfig {
            format: ClaudeOutputFormat {
                kind: CLAUDE_OUTPUT_FORMAT_JSON_SCHEMA.to_string(),
                schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "suggested_decision",
                        "rationale_summary",
                        "risk_score"
                    ],
                    "properties": {
                        "suggested_decision": {
                            "type": "string",
                            "enum": ["allow", "deny", "escalate"]
                        },
                        "rationale_summary": {
                            "type": "string",
                            "minLength": 1
                        },
                        "risk_score": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 100
                        }
                    }
                }),
            },
        },
    }
}

fn parse_suggestion_payload(content: &str) -> Result<SuggestionPayload, ProviderError> {
    serde_json::from_str(normalize_json_payload(content))
        .map_err(|error| ProviderError::InvalidResponse(error.to_string()))
}

fn parse_strict_suggestion_payload(content: &str) -> Result<SuggestionPayload, ProviderError> {
    let payload: StrictSuggestionPayload = serde_json::from_str(normalize_json_payload(content))
        .map_err(|error| {
            ProviderError::InvalidResponse(format!(
                "Claude structured output did not match the suggestion schema: {error}"
            ))
        })?;

    Ok(payload.into())
}

fn normalize_json_payload(content: &str) -> &str {
    let content = content.trim();
    if let Some(stripped) = content.strip_prefix("```json") {
        stripped.trim().trim_end_matches("```").trim()
    } else if let Some(stripped) = content.strip_prefix("```") {
        stripped.trim().trim_end_matches("```").trim()
    } else {
        content
    }
}

fn extract_response_request_id(response: &reqwest::Response) -> Option<String> {
    ["request-id", "x-request-id"]
        .iter()
        .find_map(|header_name| {
            response
                .headers()
                .get(*header_name)
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned)
        })
}

fn summarize_provider_error_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return "empty error body".to_string();
    }

    #[derive(Deserialize)]
    struct ErrorEnvelope {
        error: ProviderErrorBody,
    }

    #[derive(Deserialize)]
    struct ProviderErrorBody {
        #[serde(rename = "type")]
        kind: Option<String>,
        message: Option<String>,
    }

    if let Ok(envelope) = serde_json::from_str::<ErrorEnvelope>(trimmed) {
        let kind = envelope
            .error
            .kind
            .unwrap_or_else(|| "unknown_error".to_string());
        let message = envelope
            .error
            .message
            .unwrap_or_else(|| "provider returned an error without a message".to_string());
        format!("{kind}: {message}")
    } else {
        trimmed.to_string()
    }
}

fn parse_claude_provider_response(
    response: ClaudeMessagesResponse,
    request_id: Option<String>,
    anthropic_version: &str,
) -> Result<ProviderResponse, ProviderError> {
    let stop_reason = response.stop_reason.clone().ok_or_else(|| {
        ProviderError::InvalidResponse("Claude response did not include stop_reason".to_string())
    })?;
    let usage = response.usage.as_ref().map(build_claude_usage);
    let trace = build_claude_provider_trace(anthropic_version, stop_reason.clone());

    match stop_reason.as_str() {
        CLAUDE_STOP_REASON_END_TURN => {
            let content = extract_optional_claude_text_content(&response.content)?
                .ok_or(ProviderError::EmptyResponse)?;
            let payload = parse_strict_suggestion_payload(&content)?;
            Ok(ProviderResponse {
                suggested_decision: payload.suggested_decision,
                rationale_summary: payload.rationale_summary,
                risk_score: payload.risk_score.min(100),
                provider_response_id: Some(response.id),
                x_request_id: request_id,
                provider_trace: Some(trace),
                usage,
                model: Some(response.model),
            })
        }
        CLAUDE_STOP_REASON_REFUSAL => Ok(ProviderResponse {
            suggested_decision: SuggestedDecision::Deny,
            rationale_summary: extract_optional_claude_text_content(&response.content)?
                .unwrap_or_else(|| {
                    "Claude refused to provide an automatic suggestion for this request".to_string()
                }),
            risk_score: 100,
            provider_response_id: Some(response.id),
            x_request_id: request_id,
            provider_trace: Some(trace),
            usage,
            model: Some(response.model),
        }),
        reason if CLAUDE_FAIL_CLOSED_STOP_REASONS.contains(&reason) => {
            Err(ProviderError::InvalidResponse(format!(
                "Claude stop_reason {reason} requires fail-closed escalation"
            )))
        }
        reason => Err(ProviderError::InvalidResponse(format!(
            "Claude returned unsupported stop_reason {reason}"
        ))),
    }
}

fn extract_optional_claude_text_content(
    content: &[ClaudeContentBlock],
) -> Result<Option<String>, ProviderError> {
    if content.is_empty() {
        return Ok(None);
    }

    if content.len() != 1 {
        return Err(ProviderError::InvalidResponse(format!(
            "Claude returned {} content blocks; expected exactly one text block",
            content.len()
        )));
    }

    let block = &content[0];
    if block.kind != "text" {
        return Err(ProviderError::InvalidResponse(format!(
            "Claude returned unsupported content block type {}",
            block.kind
        )));
    }

    Ok(block
        .text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned))
}

fn build_claude_usage(usage: &ClaudeUsage) -> LlmSuggestionUsage {
    let total_tokens = usage.input_tokens.saturating_add(usage.output_tokens);
    LlmSuggestionUsage {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens,
    }
}

fn build_claude_provider_trace(anthropic_version: &str, stop_reason: String) -> ProviderTrace {
    ProviderTrace {
        transport: Some(CLAUDE_TRANSPORT_HTTPS.to_string()),
        protocol: Some(CLAUDE_PROTOCOL_ANTHROPIC_MESSAGES.to_string()),
        api_version: Some(anthropic_version.to_string()),
        output_format: Some(CLAUDE_OUTPUT_FORMAT_JSON_SCHEMA.to_string()),
        stop_reason: Some(stop_reason),
        package_name: None,
        package_version: None,
        session_id: None,
        client_request_id: None,
        agent_name: None,
        agent_version: None,
        beta_headers: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use wiremock::{
        matchers::{body_partial_json, header, method, path},
        Mock, MockServer, ResponseTemplate,
    };

    use crate::{sanitize_prompt_context, RequestContext};

    use super::*;

    #[tokio::test]
    async fn openai_compatible_adapter_parses_json_suggestion() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "resp_123",
                "object": "chat.completion",
                "created": 1,
                "model": "mock-model",
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": "{\"suggested_decision\":\"deny\",\"rationale_summary\":\"production secret access is risky\",\"risk_score\":87}"
                    }
                }],
                "usage": {
                    "prompt_tokens": 23,
                    "completion_tokens": 17,
                    "total_tokens": 40
                }
            })))
            .mount(&server)
            .await;

        let mut settings = PlanktonSettings::default();
        settings.provider_kind = "openai_compatible".to_string();
        settings.openai_api_base = server.uri();
        settings.openai_api_key = "test-key".to_string();
        settings.openai_model = "mock-model".to_string();
        let context = sanitize_prompt_context(&RequestContext::new(
            "secret/prod".to_string(),
            "Need production access".to_string(),
            "alice".to_string(),
        ));

        let (_, suggestion) = generate_llm_suggestion(&settings, PolicyMode::Assisted, &context)
            .await
            .expect("suggestion generation should succeed");

        assert_eq!(suggestion.provider_kind, "openai_compatible");
        assert_eq!(suggestion.suggested_decision, SuggestedDecision::Deny);
        assert_eq!(suggestion.risk_score, 87);
        assert_eq!(suggestion.provider_response_id.as_deref(), Some("resp_123"));
        assert_eq!(
            suggestion.usage,
            Some(LlmSuggestionUsage {
                prompt_tokens: 23,
                completion_tokens: 17,
                total_tokens: 40,
            })
        );
    }

    #[tokio::test]
    async fn claude_adapter_parses_json_suggestion() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", "test-key"))
            .and(header("anthropic-version", "2023-06-01"))
            .and(body_partial_json(json!({
                "model": "claude-sonnet-4-5",
                "max_tokens": 512,
                "temperature": 0.0,
                "stream": false,
                "system": PlanktonSettings::default().llm_advice_system_prompt,
                "messages": [{
                    "role": "user"
                }],
                "tools": [],
                "output_config": {
                    "format": {
                        "type": "json_schema"
                    }
                }
            })))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("request-id", "req_claude_123")
                    .set_body_json(json!({
                        "id": "msg_123",
                        "type": "message",
                        "role": "assistant",
                        "model": "claude-sonnet-4-5",
                        "stop_reason": "end_turn",
                        "content": [{
                            "type": "text",
                            "text": "{\"suggested_decision\":\"allow\",\"rationale_summary\":\"readonly dev request is low risk\",\"risk_score\":12}"
                        }],
                        "usage": {
                            "input_tokens": 18,
                            "output_tokens": 9
                        }
                    })),
            )
            .mount(&server)
            .await;

        let mut settings = PlanktonSettings::default();
        settings.provider_kind = CLAUDE_PROVIDER_KIND.to_string();
        settings.claude_api_base = server.uri();
        settings.claude_api_key = "test-key".to_string();
        settings.claude_model = "claude-sonnet-4-5".to_string();
        let context = sanitize_prompt_context(&RequestContext::new(
            "config/dev-readonly".to_string(),
            "Need readonly dev config".to_string(),
            "alice".to_string(),
        ));

        let (_, suggestion) = generate_llm_suggestion(&settings, PolicyMode::Assisted, &context)
            .await
            .expect("suggestion generation should succeed");

        assert_eq!(suggestion.provider_kind, CLAUDE_PROVIDER_KIND);
        assert_eq!(suggestion.suggested_decision, SuggestedDecision::Allow);
        assert_eq!(suggestion.risk_score, 12);
        assert_eq!(suggestion.provider_response_id.as_deref(), Some("msg_123"));
        assert_eq!(suggestion.x_request_id.as_deref(), Some("req_claude_123"));
        assert_eq!(
            suggestion.provider_model.as_deref(),
            Some("claude-sonnet-4-5")
        );
        assert_eq!(
            suggestion.usage,
            Some(LlmSuggestionUsage {
                prompt_tokens: 18,
                completion_tokens: 9,
                total_tokens: 27,
            })
        );
        assert_eq!(
            suggestion
                .provider_trace
                .as_ref()
                .and_then(|trace| trace.transport.as_deref()),
            Some(CLAUDE_TRANSPORT_HTTPS)
        );
        assert_eq!(
            suggestion
                .provider_trace
                .as_ref()
                .and_then(|trace| trace.protocol.as_deref()),
            Some(CLAUDE_PROTOCOL_ANTHROPIC_MESSAGES)
        );
        assert_eq!(
            suggestion
                .provider_trace
                .as_ref()
                .and_then(|trace| trace.api_version.as_deref()),
            Some("2023-06-01")
        );
        assert_eq!(
            suggestion
                .provider_trace
                .as_ref()
                .and_then(|trace| trace.output_format.as_deref()),
            Some(CLAUDE_OUTPUT_FORMAT_JSON_SCHEMA)
        );
        assert_eq!(
            suggestion
                .provider_trace
                .as_ref()
                .and_then(|trace| trace.stop_reason.as_deref()),
            Some(CLAUDE_STOP_REASON_END_TURN)
        );
        assert_eq!(
            suggestion
                .provider_trace
                .as_ref()
                .map(|trace| trace.beta_headers.clone()),
            Some(Vec::new())
        );
    }

    #[tokio::test]
    async fn claude_adapter_fails_closed_on_non_end_turn_stop_reason() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("request-id", "req_claude_stop")
                    .set_body_json(json!({
                        "id": "msg_stop",
                        "type": "message",
                        "role": "assistant",
                        "model": "claude-sonnet-4-5",
                        "stop_reason": "max_tokens",
                        "content": [{
                            "type": "text",
                            "text": "{\"suggested_decision\":\"allow\",\"rationale_summary\":\"truncated\",\"risk_score\":5}"
                        }]
                    })),
            )
            .mount(&server)
            .await;

        let mut settings = PlanktonSettings::default();
        settings.provider_kind = CLAUDE_PROVIDER_KIND.to_string();
        settings.claude_api_base = server.uri();
        settings.claude_api_key = "test-key".to_string();
        settings.claude_model = "claude-sonnet-4-5".to_string();
        let context = sanitize_prompt_context(&RequestContext::new(
            "config/dev-readonly".to_string(),
            "Need readonly dev config".to_string(),
            "alice".to_string(),
        ));

        let (_, suggestion) =
            generate_llm_suggestion(&settings, PolicyMode::LlmAutomatic, &context)
                .await
                .expect("suggestion generation should succeed");

        assert_eq!(suggestion.provider_kind, CLAUDE_PROVIDER_KIND);
        assert_eq!(suggestion.suggested_decision, SuggestedDecision::Escalate);
        assert_eq!(suggestion.risk_score, 100);
        assert!(
            suggestion
                .error
                .as_deref()
                .is_some_and(|error| error.contains("stop_reason max_tokens")),
            "unexpected error: {:?}",
            suggestion.error
        );
    }

    #[tokio::test]
    async fn claude_adapter_maps_refusal_to_deny() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("request-id", "req_claude_refusal")
                    .set_body_json(json!({
                        "id": "msg_refusal",
                        "type": "message",
                        "role": "assistant",
                        "model": "claude-sonnet-4-5",
                        "stop_reason": "refusal",
                        "content": [{
                            "type": "text",
                            "text": "I will not provide an automatic allow recommendation for a request that could expose a secret."
                        }],
                        "usage": {
                            "input_tokens": 21,
                            "output_tokens": 11
                        }
                    })),
            )
            .mount(&server)
            .await;

        let mut settings = PlanktonSettings::default();
        settings.provider_kind = CLAUDE_PROVIDER_KIND.to_string();
        settings.claude_api_base = server.uri();
        settings.claude_api_key = "test-key".to_string();
        settings.claude_model = "claude-sonnet-4-5".to_string();
        let context = sanitize_prompt_context(&RequestContext::new(
            "secret/prod-token".to_string(),
            "Need production token access".to_string(),
            "alice".to_string(),
        ));

        let (_, suggestion) = generate_llm_suggestion(&settings, PolicyMode::Assisted, &context)
            .await
            .expect("suggestion generation should succeed");

        assert_eq!(suggestion.provider_kind, CLAUDE_PROVIDER_KIND);
        assert_eq!(suggestion.suggested_decision, SuggestedDecision::Deny);
        assert_eq!(suggestion.risk_score, 100);
        assert_eq!(
            suggestion.rationale_summary,
            "I will not provide an automatic allow recommendation for a request that could expose a secret."
        );
        assert_eq!(
            suggestion
                .provider_trace
                .as_ref()
                .and_then(|trace| trace.stop_reason.as_deref()),
            Some(CLAUDE_STOP_REASON_REFUSAL)
        );
        assert!(suggestion.error.is_none());
    }
}
