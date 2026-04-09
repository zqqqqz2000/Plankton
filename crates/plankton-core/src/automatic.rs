use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    sanitization::{looks_absolute_path, looks_sensitive_value, REDACTED_VALUE},
    LlmSuggestion, ProviderInputSnapshot, RequestContext, SanitizedPromptContext,
    SuggestedDecision, LLM_ADVICE_TEMPLATE_ID, LLM_ADVICE_TEMPLATE_VERSION,
    PROMPT_CONTRACT_VERSION,
};

pub const AUTO_ALLOW_MAX_RISK_SCORE: u8 = 25;
pub const AUTO_DENY_MIN_RISK_SCORE: u8 = 70;

const HIGH_RISK_KEYWORDS: [&str; 4] = ["prod", "production", "breakglass", "root"];
const EXFILTRATION_KEYWORDS: [&str; 6] = [
    "dump",
    "export",
    "upload",
    "share",
    "print secret",
    "send to llm",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutomaticDisposition {
    Allow,
    Deny,
    Escalate,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutomaticDecisionSource {
    LocalRule,
    LlmSuggestion,
    CombinedGuardrail,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutomaticDecisionTrace {
    pub auto_disposition: AutomaticDisposition,
    pub decision_source: AutomaticDecisionSource,
    pub matched_rule_ids: Vec<String>,
    pub secret_exposure_risk: bool,
    pub provider_called: bool,
    pub suggested_decision: Option<SuggestedDecision>,
    pub risk_score: Option<u8>,
    pub template_id: Option<String>,
    pub template_version: Option<String>,
    pub prompt_contract_version: Option<String>,
    pub provider_kind: Option<String>,
    pub provider_model: Option<String>,
    pub x_request_id: Option<String>,
    pub provider_response_id: Option<String>,
    pub redacted_fields: Vec<String>,
    pub redaction_summary: String,
    pub auto_rationale_summary: String,
    pub fail_closed: bool,
    pub evaluated_at: DateTime<Utc>,
}

pub fn evaluate_local_hard_rules(
    context: &RequestContext,
    sanitized_context: &SanitizedPromptContext,
) -> Option<AutomaticDecisionTrace> {
    let mut matched_rule_ids = Vec::new();
    let mut rationale_parts = Vec::new();

    let resource = context.resource.trim().to_ascii_lowercase();
    let requested_by = context.requested_by.trim();
    let reason = context.reason.trim();
    let environment = context
        .metadata
        .get("environment")
        .map(|value| value.trim().to_ascii_lowercase());
    let breakglass = context
        .metadata
        .get("breakglass")
        .map(|value| value.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let call_chain = context
        .call_chain
        .iter()
        .map(|value| value.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let reason_lc = reason.to_ascii_lowercase();

    if resource.is_empty() {
        matched_rule_ids.push("local_missing_resource".to_string());
        rationale_parts.push("resource was empty".to_string());
    }

    if requested_by.is_empty() {
        matched_rule_ids.push("local_missing_requester".to_string());
        rationale_parts.push("requested_by was empty".to_string());
    }

    if reason.len() < 8 {
        matched_rule_ids.push("local_reason_too_short".to_string());
        rationale_parts
            .push("reason was too short for stable automatic classification".to_string());
    }

    if !matched_rule_ids.is_empty() {
        return Some(local_trace(
            AutomaticDisposition::Escalate,
            matched_rule_ids,
            rationale_parts.join("; "),
            sanitized_context,
            false,
        ));
    }

    let resource_hits_high_risk = HIGH_RISK_KEYWORDS
        .iter()
        .any(|keyword| resource.contains(keyword));
    let environment_hits_high_risk = environment.as_deref().is_some_and(|value| {
        HIGH_RISK_KEYWORDS
            .iter()
            .any(|keyword| value.contains(keyword))
    });
    let call_chain_hits_exfiltration = call_chain.iter().any(|value| {
        EXFILTRATION_KEYWORDS
            .iter()
            .any(|keyword| value.contains(keyword))
    });
    let reason_hits_exfiltration = EXFILTRATION_KEYWORDS
        .iter()
        .any(|keyword| reason_lc.contains(keyword));

    if resource_hits_high_risk {
        matched_rule_ids.push("local_prod_resource".to_string());
        rationale_parts.push("resource matched a high-risk keyword".to_string());
    }
    if environment_hits_high_risk {
        matched_rule_ids.push("local_prod_environment".to_string());
        rationale_parts.push("metadata.environment matched a high-risk keyword".to_string());
    }
    if breakglass {
        matched_rule_ids.push("local_breakglass".to_string());
        rationale_parts.push("metadata.breakglass=true".to_string());
    }
    if reason_hits_exfiltration || call_chain_hits_exfiltration {
        matched_rule_ids.push("local_exfiltration_intent".to_string());
        rationale_parts.push(
            "reason or call_chain indicated dump/export/upload/share/LLM exfiltration intent"
                .to_string(),
        );
    }

    if matched_rule_ids.is_empty() {
        None
    } else {
        Some(local_trace(
            AutomaticDisposition::Deny,
            matched_rule_ids,
            rationale_parts.join("; "),
            sanitized_context,
            false,
        ))
    }
}

pub fn secret_exposure_risk(sanitized_context: &SanitizedPromptContext) -> bool {
    !sanitized_context.redacted_fields.is_empty()
        || sanitized_context
            .redaction_summary
            .to_ascii_lowercase()
            .contains("redacted")
        || sanitized_context
            .redaction_summary
            .to_ascii_lowercase()
            .contains("trimmed absolute path")
        || sanitized_context
            .redaction_summary
            .to_ascii_lowercase()
            .contains("environment variable value")
}

pub fn escalate_for_secret_exposure_risk(
    sanitized_context: &SanitizedPromptContext,
    provider_input: Option<&ProviderInputSnapshot>,
) -> AutomaticDecisionTrace {
    AutomaticDecisionTrace {
        auto_disposition: AutomaticDisposition::Escalate,
        decision_source: AutomaticDecisionSource::CombinedGuardrail,
        matched_rule_ids: vec!["guard_secret_exposure_risk".to_string()],
        secret_exposure_risk: true,
        provider_called: false,
        suggested_decision: None,
        risk_score: None,
        template_id: provider_input.map(|input| input.template_id.clone()),
        template_version: provider_input.map(|input| input.template_version.clone()),
        prompt_contract_version: provider_input.map(|input| input.prompt_contract_version.clone()),
        provider_kind: None,
        provider_model: None,
        x_request_id: None,
        provider_response_id: None,
        redacted_fields: sanitized_context.redacted_fields.clone(),
        redaction_summary: sanitized_context.redaction_summary.clone(),
        auto_rationale_summary:
            "Automatic mode escalated before provider execution because secret_exposure_risk=true"
                .to_string(),
        fail_closed: true,
        evaluated_at: Utc::now(),
    }
}

pub fn evaluate_automatic_disposition(
    request_provider_kind: Option<&str>,
    provider_input: Option<&ProviderInputSnapshot>,
    suggestion: Option<&LlmSuggestion>,
    sanitized_context: &SanitizedPromptContext,
) -> AutomaticDecisionTrace {
    let mut matched_rule_ids = Vec::new();

    let mut base_trace = AutomaticDecisionTrace {
        auto_disposition: AutomaticDisposition::Escalate,
        decision_source: AutomaticDecisionSource::CombinedGuardrail,
        matched_rule_ids: Vec::new(),
        secret_exposure_risk: secret_exposure_risk(sanitized_context),
        provider_called: provider_input.is_some() || suggestion.is_some(),
        suggested_decision: suggestion.map(|suggestion| suggestion.suggested_decision),
        risk_score: suggestion.map(|suggestion| suggestion.risk_score),
        template_id: provider_input.map(|input| input.template_id.clone()),
        template_version: provider_input.map(|input| input.template_version.clone()),
        prompt_contract_version: provider_input.map(|input| input.prompt_contract_version.clone()),
        provider_kind: suggestion
            .map(|suggestion| suggestion.provider_kind.clone())
            .or_else(|| request_provider_kind.map(ToOwned::to_owned)),
        provider_model: suggestion.and_then(|suggestion| suggestion.provider_model.clone()),
        x_request_id: suggestion.and_then(|suggestion| suggestion.x_request_id.clone()),
        provider_response_id: suggestion
            .and_then(|suggestion| suggestion.provider_response_id.clone()),
        redacted_fields: sanitized_context.redacted_fields.clone(),
        redaction_summary: sanitized_context.redaction_summary.clone(),
        auto_rationale_summary:
            "Automatic mode escalated because no final automatic disposition could be proven"
                .to_string(),
        fail_closed: true,
        evaluated_at: Utc::now(),
    };

    let Some(provider_input) = provider_input else {
        matched_rule_ids.push("guard_provider_input_missing".to_string());
        base_trace.matched_rule_ids = matched_rule_ids;
        base_trace.auto_rationale_summary =
            "Automatic mode escalated because provider_input was missing".to_string();
        return base_trace;
    };

    let Some(suggestion) = suggestion else {
        matched_rule_ids.push("guard_llm_suggestion_missing".to_string());
        base_trace.matched_rule_ids = matched_rule_ids;
        base_trace.auto_rationale_summary =
            "Automatic mode escalated because no LLM suggestion was returned".to_string();
        return base_trace;
    };

    if suggestion.error.is_some() {
        matched_rule_ids.push("guard_provider_error".to_string());
        base_trace.matched_rule_ids = matched_rule_ids;
        base_trace.auto_rationale_summary = format!(
            "Automatic mode escalated because the provider failed: {}",
            suggestion
                .error
                .as_deref()
                .unwrap_or("unknown provider error")
        );
        return base_trace;
    }

    if provider_input.template_id != LLM_ADVICE_TEMPLATE_ID
        || provider_input.template_version != LLM_ADVICE_TEMPLATE_VERSION
        || provider_input.prompt_contract_version != PROMPT_CONTRACT_VERSION
    {
        matched_rule_ids.push("guard_template_not_allowlisted".to_string());
        base_trace.matched_rule_ids = matched_rule_ids;
        base_trace.auto_rationale_summary =
            "Automatic mode escalated because template/provider contract was not allow-listed"
                .to_string();
        return base_trace;
    }

    if provider_input.prompt_contract_version != suggestion.prompt_contract_version {
        matched_rule_ids.push("guard_prompt_contract_mismatch".to_string());
        base_trace.matched_rule_ids = matched_rule_ids;
        base_trace.auto_rationale_summary =
            "Automatic mode escalated because provider_input and suggestion used different prompt contracts"
                .to_string();
        return base_trace;
    }

    if provider_input.template_id != suggestion.template_id
        || provider_input.template_version != suggestion.template_version
    {
        matched_rule_ids.push("guard_template_trace_mismatch".to_string());
        base_trace.matched_rule_ids = matched_rule_ids;
        base_trace.auto_rationale_summary =
            "Automatic mode escalated because template trace mismatched between provider_input and suggestion"
                .to_string();
        return base_trace;
    }

    if provider_input.prompt_sha256 != suggestion.prompt_sha256 {
        matched_rule_ids.push("guard_prompt_sha_mismatch".to_string());
        base_trace.matched_rule_ids = matched_rule_ids;
        base_trace.auto_rationale_summary =
            "Automatic mode escalated because provider_input and suggestion referenced different prompt digests"
                .to_string();
        return base_trace;
    }

    if suggestion.rationale_summary.trim().is_empty() {
        matched_rule_ids.push("guard_missing_rationale_summary".to_string());
        base_trace.matched_rule_ids = matched_rule_ids;
        base_trace.auto_rationale_summary =
            "Automatic mode escalated because the provider returned an empty rationale".to_string();
        return base_trace;
    }

    if let Some(request_provider_kind) = request_provider_kind {
        let request_provider_kind = request_provider_kind.trim();
        if !request_provider_kind.is_empty() && request_provider_kind != suggestion.provider_kind {
            matched_rule_ids.push("guard_provider_kind_mismatch".to_string());
            base_trace.matched_rule_ids = matched_rule_ids;
            base_trace.auto_rationale_summary =
                "Automatic mode escalated because request/provider kinds did not match".to_string();
            return base_trace;
        }
    }

    let provider_input_issues = provider_input_boundary_issues(provider_input);
    if !provider_input_issues.is_empty() {
        matched_rule_ids.push("guard_provider_input_not_safe".to_string());
        base_trace.matched_rule_ids = matched_rule_ids;
        base_trace.auto_rationale_summary = format!(
            "Automatic mode escalated because provider_input was not safe: {}",
            provider_input_issues.join("; ")
        );
        return base_trace;
    }

    match suggestion.suggested_decision {
        SuggestedDecision::Allow if suggestion.risk_score <= AUTO_ALLOW_MAX_RISK_SCORE => {
            AutomaticDecisionTrace {
                auto_disposition: AutomaticDisposition::Allow,
                decision_source: AutomaticDecisionSource::CombinedGuardrail,
                matched_rule_ids: vec!["llm_allow_low_risk".to_string()],
                secret_exposure_risk: false,
                provider_called: true,
                suggested_decision: Some(SuggestedDecision::Allow),
                risk_score: Some(suggestion.risk_score),
                template_id: Some(provider_input.template_id.clone()),
                template_version: Some(provider_input.template_version.clone()),
                prompt_contract_version: Some(provider_input.prompt_contract_version.clone()),
                provider_kind: Some(suggestion.provider_kind.clone()),
                provider_model: suggestion.provider_model.clone(),
                x_request_id: suggestion.x_request_id.clone(),
                provider_response_id: suggestion.provider_response_id.clone(),
                redacted_fields: sanitized_context.redacted_fields.clone(),
                redaction_summary: sanitized_context.redaction_summary.clone(),
                auto_rationale_summary: format!(
                    "Automatic mode allowed because the low-risk LLM suggestion passed all local guardrails. {}",
                    suggestion.rationale_summary
                ),
                fail_closed: false,
                evaluated_at: Utc::now(),
            }
        }
        SuggestedDecision::Deny if suggestion.risk_score >= AUTO_DENY_MIN_RISK_SCORE => {
            AutomaticDecisionTrace {
                auto_disposition: AutomaticDisposition::Deny,
                decision_source: AutomaticDecisionSource::CombinedGuardrail,
                matched_rule_ids: vec!["llm_deny_high_risk".to_string()],
                secret_exposure_risk: false,
                provider_called: true,
                suggested_decision: Some(SuggestedDecision::Deny),
                risk_score: Some(suggestion.risk_score),
                template_id: Some(provider_input.template_id.clone()),
                template_version: Some(provider_input.template_version.clone()),
                prompt_contract_version: Some(provider_input.prompt_contract_version.clone()),
                provider_kind: Some(suggestion.provider_kind.clone()),
                provider_model: suggestion.provider_model.clone(),
                x_request_id: suggestion.x_request_id.clone(),
                provider_response_id: suggestion.provider_response_id.clone(),
                redacted_fields: sanitized_context.redacted_fields.clone(),
                redaction_summary: sanitized_context.redaction_summary.clone(),
                auto_rationale_summary: format!(
                    "Automatic mode denied because the high-risk LLM suggestion passed all local guardrails. {}",
                    suggestion.rationale_summary
                ),
                fail_closed: false,
                evaluated_at: Utc::now(),
            }
        }
        SuggestedDecision::Escalate => {
            matched_rule_ids.push("llm_requested_escalation".to_string());
            base_trace.matched_rule_ids = matched_rule_ids;
            base_trace.decision_source = AutomaticDecisionSource::LlmSuggestion;
            base_trace.auto_rationale_summary =
                "Automatic mode escalated because the LLM explicitly requested human review"
                    .to_string();
            base_trace.fail_closed = false;
            base_trace
        }
        _ => {
            matched_rule_ids.push("guard_mid_risk_or_inconclusive".to_string());
            base_trace.matched_rule_ids = matched_rule_ids;
            base_trace.auto_rationale_summary =
                "Automatic mode escalated because the LLM suggestion was not in an automatic allow/deny band"
                    .to_string();
            base_trace
        }
    }
}

fn local_trace(
    auto_disposition: AutomaticDisposition,
    matched_rule_ids: Vec<String>,
    rationale: String,
    sanitized_context: &SanitizedPromptContext,
    fail_closed: bool,
) -> AutomaticDecisionTrace {
    AutomaticDecisionTrace {
        auto_disposition,
        decision_source: AutomaticDecisionSource::LocalRule,
        matched_rule_ids,
        secret_exposure_risk: false,
        provider_called: false,
        suggested_decision: None,
        risk_score: None,
        template_id: None,
        template_version: None,
        prompt_contract_version: None,
        provider_kind: None,
        provider_model: None,
        x_request_id: None,
        provider_response_id: None,
        redacted_fields: sanitized_context.redacted_fields.clone(),
        redaction_summary: sanitized_context.redaction_summary.clone(),
        auto_rationale_summary: rationale,
        fail_closed,
        evaluated_at: Utc::now(),
    }
}

fn provider_input_boundary_issues(provider_input: &ProviderInputSnapshot) -> Vec<String> {
    let mut issues = Vec::new();

    for (key, value) in &provider_input.sanitized_context.env_vars {
        if value != REDACTED_VALUE {
            issues.push(format!(
                "provider-visible env var {key} was not redacted before automatic evaluation"
            ));
        }
    }

    if contains_sensitive_fragment(&provider_input.prompt) {
        issues.push(
            "rendered provider prompt still contained a secret-like token or absolute path"
                .to_string(),
        );
    }

    for (field, value) in collect_provider_visible_values(provider_input) {
        if value == REDACTED_VALUE {
            continue;
        }

        if looks_sensitive_value(value.as_str()) {
            issues.push(format!(
                "provider-visible field {field} still looked secret-like after sanitization"
            ));
        } else if looks_absolute_path(value.as_str()) {
            issues.push(format!(
                "provider-visible field {field} still exposed an absolute path after sanitization"
            ));
        }
    }

    issues
}

fn collect_provider_visible_values(
    provider_input: &ProviderInputSnapshot,
) -> Vec<(String, String)> {
    let mut values = vec![
        (
            "resource".to_string(),
            provider_input.sanitized_context.resource.clone(),
        ),
        (
            "reason".to_string(),
            provider_input.sanitized_context.reason.clone(),
        ),
        (
            "requested_by".to_string(),
            provider_input.sanitized_context.requested_by.clone(),
        ),
    ];

    if let Some(script_path) = &provider_input.sanitized_context.script_path {
        values.push(("script_path".to_string(), script_path.clone()));
    }

    values.extend(
        provider_input
            .sanitized_context
            .env_vars
            .iter()
            .map(|(key, value)| (format!("env_vars.{key}"), value.clone())),
    );
    values.extend(
        provider_input
            .sanitized_context
            .call_chain
            .iter()
            .enumerate()
            .map(|(index, value)| (format!("call_chain[{index}]"), value.clone())),
    );
    values.extend(
        provider_input
            .sanitized_context
            .metadata
            .iter()
            .map(|(key, value)| (format!("metadata.{key}"), value.clone())),
    );

    values
}

fn contains_sensitive_fragment(value: &str) -> bool {
    value.split_whitespace().any(|token| {
        let token = token.trim_matches(|char: char| {
            matches!(
                char,
                ',' | ';' | ':' | '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>'
            )
        });
        !token.is_empty()
            && token != REDACTED_VALUE
            && (looks_sensitive_value(token) || looks_absolute_path(token))
    })
}

#[cfg(test)]
mod tests {
    use crate::{
        sanitize_prompt_context, LlmSuggestion, ProviderInputSnapshot, RequestContext,
        SuggestedDecision, LLM_ADVICE_TEMPLATE_ID, LLM_ADVICE_TEMPLATE_VERSION,
        PROMPT_CONTRACT_VERSION,
    };

    use super::*;

    fn sample_request_context() -> RequestContext {
        let mut context = RequestContext::new(
            "secret/dev-token".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        );
        context
            .metadata
            .insert("environment".to_string(), "dev".to_string());
        context
    }

    fn sample_provider_input() -> ProviderInputSnapshot {
        let sanitized = sanitize_prompt_context(&sample_request_context());

        ProviderInputSnapshot {
            template_id: LLM_ADVICE_TEMPLATE_ID.to_string(),
            template_version: LLM_ADVICE_TEMPLATE_VERSION.to_string(),
            prompt_contract_version: PROMPT_CONTRACT_VERSION.to_string(),
            prompt_sha256: "digest-1".to_string(),
            prompt: "safe prompt".to_string(),
            sanitized_context: sanitized,
        }
    }

    fn sample_suggestion(decision: SuggestedDecision, risk_score: u8) -> LlmSuggestion {
        LlmSuggestion {
            template_id: LLM_ADVICE_TEMPLATE_ID.to_string(),
            template_version: LLM_ADVICE_TEMPLATE_VERSION.to_string(),
            prompt_contract_version: PROMPT_CONTRACT_VERSION.to_string(),
            prompt_sha256: "digest-1".to_string(),
            suggested_decision: decision,
            rationale_summary: "model rationale".to_string(),
            risk_score,
            provider_kind: "mock".to_string(),
            provider_model: Some("mock-suggestion-v1".to_string()),
            provider_response_id: None,
            x_request_id: None,
            provider_trace: None,
            usage: None,
            error: None,
            generated_at: Utc::now(),
        }
    }

    #[test]
    fn local_rule_denies_prod_requests_before_provider_execution() {
        let mut context = sample_request_context();
        context.resource = "secret/prod-root".to_string();
        let sanitized = sanitize_prompt_context(&context);

        let trace = evaluate_local_hard_rules(&context, &sanitized)
            .expect("prod requests should be denied by a local rule");

        assert_eq!(trace.auto_disposition, AutomaticDisposition::Deny);
        assert_eq!(trace.decision_source, AutomaticDecisionSource::LocalRule);
        assert!(!trace.provider_called);
        assert!(trace
            .matched_rule_ids
            .contains(&"local_prod_resource".to_string()));
    }

    #[test]
    fn secret_exposure_risk_blocks_provider_execution() {
        let mut context = sample_request_context();
        context.env_vars.insert(
            "OPENAI_API_KEY".to_string(),
            "sk-live-super-secret-value".to_string(),
        );
        let sanitized = sanitize_prompt_context(&context);

        assert!(secret_exposure_risk(&sanitized));

        let trace = escalate_for_secret_exposure_risk(&sanitized, None);

        assert_eq!(trace.auto_disposition, AutomaticDisposition::Escalate);
        assert!(trace.secret_exposure_risk);
        assert!(!trace.provider_called);
    }

    #[test]
    fn automatic_path_allows_low_risk_allow_suggestion() {
        let context = sample_request_context();
        let sanitized = sanitize_prompt_context(&context);
        let provider_input = sample_provider_input();
        let suggestion = sample_suggestion(SuggestedDecision::Allow, 20);

        let trace = evaluate_automatic_disposition(
            Some("mock"),
            Some(&provider_input),
            Some(&suggestion),
            &sanitized,
        );

        assert_eq!(trace.auto_disposition, AutomaticDisposition::Allow);
        assert!(trace.provider_called);
        assert_eq!(
            trace.decision_source,
            AutomaticDecisionSource::CombinedGuardrail
        );
        assert!(trace
            .matched_rule_ids
            .contains(&"llm_allow_low_risk".to_string()));
    }

    #[test]
    fn automatic_path_denies_high_risk_deny_suggestion() {
        let context = sample_request_context();
        let sanitized = sanitize_prompt_context(&context);
        let provider_input = sample_provider_input();
        let suggestion = sample_suggestion(SuggestedDecision::Deny, 82);

        let trace = evaluate_automatic_disposition(
            Some("mock"),
            Some(&provider_input),
            Some(&suggestion),
            &sanitized,
        );

        assert_eq!(trace.auto_disposition, AutomaticDisposition::Deny);
        assert!(trace
            .matched_rule_ids
            .contains(&"llm_deny_high_risk".to_string()));
    }

    #[test]
    fn automatic_path_escalates_mid_risk_allow_suggestion() {
        let context = sample_request_context();
        let sanitized = sanitize_prompt_context(&context);
        let provider_input = sample_provider_input();
        let suggestion = sample_suggestion(SuggestedDecision::Allow, 55);

        let trace = evaluate_automatic_disposition(
            Some("mock"),
            Some(&provider_input),
            Some(&suggestion),
            &sanitized,
        );

        assert_eq!(trace.auto_disposition, AutomaticDisposition::Escalate);
        assert!(trace.fail_closed);
        assert!(trace
            .matched_rule_ids
            .contains(&"guard_mid_risk_or_inconclusive".to_string()));
    }
}
