use minijinja::{context, Environment, UndefinedBehavior};
use serde::Serialize;

use crate::{PolicyMode, SanitizedPromptContext};

pub const PROMPT_CONTRACT_VERSION: &str = "sanitized_prompt_context.v3";
pub const REQUEST_TEMPLATE_ID: &str = "manual_review_summary";
pub const REQUEST_TEMPLATE_VERSION: &str = "3";
pub const LLM_ADVICE_TEMPLATE_ID: &str = "llm_advice_request";
pub const LLM_ADVICE_TEMPLATE_VERSION: &str = "3";

pub const DEFAULT_REQUEST_TEMPLATE: &str = r#"{{ i18n.manual_review_request }}
{{ i18n.resource_label }}: {{ context.resource }}
{{ i18n.resource_tags_label }}:
{% for tag in context.resource_tags %}
- {{ tag }}
{% else %}
- n/a
{% endfor %}
{{ i18n.metadata_label }}:
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

pub const DEFAULT_LLM_ADVICE_TEMPLATE: &str = r#"{{ i18n.review_sanitized_access_request }}
{{ i18n.prompt_contract_version_label }}: {{ prompt_contract_version }}
{{ i18n.resource_label }}: {{ context.resource }}
{{ i18n.resource_tags_label }}:
{% for tag in context.resource_tags %}
- {{ tag }}
{% else %}
- n/a
{% endfor %}
{{ i18n.metadata_label }}:
{% for key, value in context.metadata|items %}
- {{ key }}={{ value }}
{% else %}
- n/a
{% endfor %}"#;

#[derive(Debug, Clone, Serialize)]
pub struct PromptTemplateI18n {
    pub locale: String,
    pub manual_review_request: &'static str,
    pub review_sanitized_access_request: &'static str,
    pub prompt_contract_version_label: &'static str,
    pub resource_label: &'static str,
    pub resource_tags_label: &'static str,
    pub metadata_label: &'static str,
}

#[derive(Debug, thiserror::Error)]
pub enum TemplateError {
    #[error("template registration failed: {0}")]
    Register(#[from] minijinja::Error),
}

pub fn render_request_template(
    template: &str,
    context: &SanitizedPromptContext,
    policy_mode: PolicyMode,
    locale: &str,
) -> Result<String, TemplateError> {
    render_named_template(template, context, policy_mode, locale)
}

pub fn render_llm_advice_template(
    template: &str,
    context: &SanitizedPromptContext,
    policy_mode: PolicyMode,
    locale: &str,
) -> Result<String, TemplateError> {
    render_named_template(template, context, policy_mode, locale)
}

fn render_named_template(
    template: &str,
    context: &SanitizedPromptContext,
    policy_mode: PolicyMode,
    locale: &str,
) -> Result<String, TemplateError> {
    let mut environment = Environment::new();
    environment.set_undefined_behavior(UndefinedBehavior::Strict);
    environment.add_template("request", template)?;
    let template = environment.get_template("request")?;
    let i18n = prompt_template_i18n(locale);
    let rendered = template.render(context! {
        context => context,
        locale => i18n.locale,
        i18n => i18n,
        policy_mode => serde_json::to_string(&policy_mode).unwrap_or_else(|_| "manual_only".to_string()).replace('"', ""),
        prompt_contract_version => PROMPT_CONTRACT_VERSION,
    })?;

    Ok(rendered)
}

fn prompt_template_i18n(locale: &str) -> PromptTemplateI18n {
    match locale {
        "zh-CN" => PromptTemplateI18n {
            locale: "zh-CN".to_string(),
            manual_review_request: "人工审批请求",
            review_sanitized_access_request: "请审阅这条已净化的访问请求。",
            prompt_contract_version_label: "提示词契约版本",
            resource_label: "资源",
            resource_tags_label: "资源标签",
            metadata_label: "元信息",
        },
        _ => PromptTemplateI18n {
            locale: "en".to_string(),
            manual_review_request: "Manual review request",
            review_sanitized_access_request: "Review this sanitized access request.",
            prompt_contract_version_label: "Prompt contract version",
            resource_label: "Resource",
            resource_tags_label: "Resource tags",
            metadata_label: "Metadata",
        },
    }
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
            render_request_template(
                DEFAULT_REQUEST_TEMPLATE,
                &context,
                PolicyMode::ManualOnly,
                "en",
            )
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
            "en",
        )
        .expect_err("unknown prompt variables should fail");

        assert!(!error.to_string().trim().is_empty());
    }

    #[test]
    fn renders_locale_and_i18n_template_variables() {
        let context = sanitize_prompt_context(&RequestContext::new(
            "secret/api-token".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        ));

        let rendered = render_request_template(
            "{{ locale }} {{ i18n.resource_label }} {{ context.resource }}",
            &context,
            PolicyMode::ManualOnly,
            "zh-CN",
        )
        .expect("template should render");

        assert_eq!(rendered, "zh-CN 资源 secret/api-token");
    }
}
