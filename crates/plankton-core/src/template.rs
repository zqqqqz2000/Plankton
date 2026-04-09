use minijinja::{context, Environment, UndefinedBehavior};

use crate::{PolicyMode, SanitizedPromptContext};

pub const PROMPT_CONTRACT_VERSION: &str = "sanitized_prompt_context.v1";
pub const REQUEST_TEMPLATE_ID: &str = "manual_review_summary";
pub const REQUEST_TEMPLATE_VERSION: &str = "1";
pub const LLM_ADVICE_TEMPLATE_ID: &str = "llm_advice_request";
pub const LLM_ADVICE_TEMPLATE_VERSION: &str = "1";

pub const DEFAULT_REQUEST_TEMPLATE: &str = r#"Manual review request
Actor: {{ context.requested_by }}
Resource: {{ context.resource }}
Reason: {{ context.reason }}
Script path: {{ context.script_path or "n/a" }}
Policy mode: {{ policy_mode }}
Call chain:
{% for step in context.call_chain %}
- {{ step }}
{% else %}
- n/a
{% endfor %}
Environment variables (values already redacted):
{% for key, value in context.env_vars|items %}
- {{ key }}={{ value }}
{% else %}
- n/a
{% endfor %}
Metadata:
{% for key, value in context.metadata|items %}
- {{ key }}={{ value }}
{% else %}
- n/a
{% endfor %}
Redaction summary: {{ context.redaction_summary }}"#;

pub const DEFAULT_LLM_SYSTEM_PROMPT: &str = r#"You are a cautious security review assistant.
You only receive sanitized request context. Do not infer omitted or redacted secret values.
Return only a compact JSON object with keys:
- suggested_decision: allow | deny | escalate
- rationale_summary: short string
- risk_score: integer from 0 to 100
Use escalate when the request is ambiguous or the redacted context is not enough."#;

pub const DEFAULT_LLM_ADVICE_TEMPLATE: &str = r#"Review this sanitized access request.
Prompt contract version: {{ prompt_contract_version }}
Policy mode: {{ policy_mode }}
Resource: {{ context.resource }}
Requester: {{ context.requested_by }}
Reason: {{ context.reason }}
Script path: {{ context.script_path or "n/a" }}
Call chain:
{% for step in context.call_chain %}
- {{ step }}
{% else %}
- n/a
{% endfor %}
Environment variable names:
{% for name in context.env_var_names %}
- {{ name }}
{% else %}
- n/a
{% endfor %}
Metadata:
{% for key, value in context.metadata|items %}
- {{ key }}={{ value }}
{% else %}
- n/a
{% endfor %}
Redaction summary: {{ context.redaction_summary }}
Redacted fields:
{% for field in context.redacted_fields %}
- {{ field }}
{% else %}
- none
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
    let rendered = template.render(context! {
        context => context,
        policy_mode => serde_json::to_string(&policy_mode).unwrap_or_else(|_| "manual_only".to_string()).replace('"', ""),
        prompt_contract_version => PROMPT_CONTRACT_VERSION,
    })?;

    Ok(rendered)
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
        context
            .metadata
            .insert("environment".to_string(), "dev".to_string());
        context
            .env_vars
            .insert("OPENAI_API_KEY".to_string(), "sk-secret-value".to_string());
        let context = sanitize_prompt_context(&context);

        let rendered =
            render_request_template(DEFAULT_REQUEST_TEMPLATE, &context, PolicyMode::ManualOnly)
                .expect("template should render");

        assert!(rendered.contains("alice"));
        assert!(rendered.contains("secret/api-token"));
        assert!(rendered.contains("environment=dev"));
        assert!(rendered.contains("OPENAI_API_KEY=[redacted]"));
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
}
