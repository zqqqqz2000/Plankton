use minijinja::{context, Environment, UndefinedBehavior};
use serde_json::{json, Value};

use crate::{PolicyMode, SanitizedPromptContext};

pub const PROMPT_CONTRACT_VERSION: &str = "sanitized_prompt_context.v2";
pub const REQUEST_TEMPLATE_ID: &str = "manual_review_summary";
pub const REQUEST_TEMPLATE_VERSION: &str = "2";
pub const LLM_ADVICE_TEMPLATE_ID: &str = "llm_advice_request";
pub const LLM_ADVICE_TEMPLATE_VERSION: &str = "2";

pub const DEFAULT_REQUEST_TEMPLATE: &str = r#"Manual review request
Resource: {{ context.resource }}
Resource tags:
{% for tag in context.resource_tags %}
- {{ tag }}
{% else %}
- n/a
{% endfor %}
Metadata:
{% for key, value in context.metadata|items %}
- {{ key }}={{ value }}
{% else %}
- n/a
{% endfor %}"#;

pub const DEFAULT_LLM_SYSTEM_PROMPT: &str = r#"You are a cautious security review assistant.
You only receive the resource identifier, resource tags, and resource metadata.
Do not infer omitted details or secret values.
Return only a compact JSON object with keys:
- suggested_decision: allow | deny | escalate
- rationale_summary: short string
- risk_score: integer from 0 to 100
Use escalate when the request is ambiguous or the provided context is not enough."#;

pub const DEFAULT_LLM_ADVICE_TEMPLATE: &str = r#"Review this sanitized access request.
Prompt contract version: {{ prompt_contract_version }}
Resource: {{ context.resource }}
Resource tags:
{% for tag in context.resource_tags %}
- {{ tag }}
{% else %}
- n/a
{% endfor %}
Metadata:
{% for key, value in context.metadata|items %}
- {{ key }}={{ value }}
{% else %}
- n/a
{% endfor %}"#;

#[derive(Debug, thiserror::Error)]
pub enum TemplateError {
    #[error("template registration failed: {0}")]
    Register(#[from] minijinja::Error),
}

pub fn render_request_template(
    template: &str,
    context: &SanitizedPromptContext,
    policy_mode: PolicyMode,
) -> Result<String, TemplateError> {
    render_named_template(template, context, policy_mode)
}

pub fn render_llm_advice_template(
    template: &str,
    context: &SanitizedPromptContext,
    policy_mode: PolicyMode,
) -> Result<String, TemplateError> {
    render_named_template(template, context, policy_mode)
}

fn render_named_template(
    template: &str,
    context: &SanitizedPromptContext,
    policy_mode: PolicyMode,
) -> Result<String, TemplateError> {
    let mut environment = Environment::new();
    environment.set_undefined_behavior(UndefinedBehavior::Strict);
    environment.add_template("request", template)?;
    let template = environment.get_template("request")?;
    let template_context = legacy_compatible_template_context(context);
    let rendered = template.render(context! {
        context => template_context,
        policy_mode => serde_json::to_string(&policy_mode).unwrap_or_else(|_| "manual_only".to_string()).replace('"', ""),
        prompt_contract_version => PROMPT_CONTRACT_VERSION,
    })?;

    Ok(rendered)
}

fn legacy_compatible_template_context(context: &SanitizedPromptContext) -> Value {
    let mut value = serde_json::to_value(context).unwrap_or_else(|_| json!({}));
    let object = value
        .as_object_mut()
        .expect("sanitized prompt context should serialize to an object");

    object
        .entry("resource".to_string())
        .or_insert_with(|| json!(context.resource));
    object
        .entry("resource_tags".to_string())
        .or_insert_with(|| json!(context.resource_tags));
    object
        .entry("metadata".to_string())
        .or_insert_with(|| json!(context.metadata));
    object
        .entry("reason".to_string())
        .or_insert_with(|| json!(""));
    object
        .entry("requested_by".to_string())
        .or_insert_with(|| json!(""));
    object
        .entry("script_path".to_string())
        .or_insert_with(|| Value::Null);
    object
        .entry("call_chain".to_string())
        .or_insert_with(|| json!([]));
    object
        .entry("env_vars".to_string())
        .or_insert_with(|| json!({}));
    object
        .entry("env_var_names".to_string())
        .or_insert_with(|| json!([]));
    object
        .entry("redaction_summary".to_string())
        .or_insert_with(|| json!(""));
    object
        .entry("redacted_fields".to_string())
        .or_insert_with(|| json!([]));

    value
}

#[cfg(test)]
mod tests {
    use crate::{sanitize_prompt_context, RequestContext};

    use super::*;

    #[test]
    fn renders_request_template() {
        let mut context = RequestContext::new(
            "secret/api-token".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        );
        context.resource_tags = vec!["prod".to_string()];
        context
            .resource_metadata
            .insert("environment".to_string(), "dev".to_string());
        context
            .env_vars
            .insert("OPENAI_API_KEY".to_string(), "sk-secret-value".to_string());
        let context = sanitize_prompt_context(&context);

        let rendered =
            render_request_template(DEFAULT_REQUEST_TEMPLATE, &context, PolicyMode::ManualOnly)
                .expect("template should render");

        assert!(rendered.contains("secret/api-token"));
        assert!(rendered.contains("prod"));
        assert!(rendered.contains("environment=dev"));
        assert!(!rendered.contains("OPENAI_API_KEY"));
    }

    #[test]
    fn rejects_unknown_template_variables() {
        let context = sanitize_prompt_context(&RequestContext::new(
            "secret/api-token".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        ));

        let error = render_llm_advice_template(
            "{{ context.unknown_field }}",
            &context,
            PolicyMode::Assisted,
        )
        .expect_err("unknown prompt variables should fail");

        assert!(!error.to_string().trim().is_empty());
    }

    #[test]
    fn renders_legacy_template_fields_with_empty_defaults() {
        let context = sanitize_prompt_context(&RequestContext::new(
            "secret/api-token".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        ));

        let rendered = render_request_template(
            r#"Resource: {{ context.resource }}
Reason: {{ context.reason }}
Requester: {{ context.requested_by }}
Env vars: {{ context.env_vars|items|list|length }}
Call chain: {{ context.call_chain|length }}"#,
            &context,
            PolicyMode::ManualOnly,
        )
        .expect("legacy templates should still render with empty defaults");

        assert!(rendered.contains("Resource: secret/api-token"));
        assert!(rendered.contains("Reason: "));
        assert!(rendered.contains("Requester: "));
        assert!(rendered.contains("Env vars: 0"));
        assert!(rendered.contains("Call chain: 0"));
    }
}
