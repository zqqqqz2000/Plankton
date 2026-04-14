use std::collections::BTreeMap;

use crate::{CallChainNode, RequestContext, SanitizedPromptContext};

pub const REDACTED_VALUE: &str = "[redacted]";
const SENSITIVE_MARKERS: [&str; 12] = [
    "secret",
    "token",
    "password",
    "passwd",
    "api_key",
    "apikey",
    "authorization",
    "auth",
    "cookie",
    "session",
    "credential",
    "private",
];

pub fn sanitize_prompt_context(context: &RequestContext) -> SanitizedPromptContext {
    let resource = context.resource.trim().to_string();
    let resource_tags = context
        .resource_tags
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let metadata = context
        .resource_metadata
        .iter()
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .filter(|(key, value)| !key.is_empty() && !value.is_empty())
        .collect::<BTreeMap<_, _>>();

    SanitizedPromptContext {
        resource,
        resource_tags,
        metadata,
        reason: String::new(),
        requested_by: String::new(),
        script_path: None,
        call_chain: Vec::new(),
        env_vars: BTreeMap::new(),
        env_var_names: Vec::new(),
        redaction_summary: String::new(),
        redacted_fields: Vec::new(),
    }
}

pub fn sanitize_request_context_for_storage(context: &RequestContext) -> RequestContext {
    RequestContext {
        resource: context.resource.trim().to_string(),
        resource_tags: context.resource_tags.clone(),
        resource_metadata: context.resource_metadata.clone(),
        reason: context.reason.trim().to_string(),
        requested_by: context.requested_by.trim().to_string(),
        script_path: context.script_path.clone(),
        call_chain: sanitize_call_chain_for_storage(context),
        env_vars: context
            .env_vars
            .keys()
            .map(|key| (key.clone(), REDACTED_VALUE.to_string()))
            .collect(),
        metadata: sanitize_request_metadata_for_storage(&context.metadata),
        created_at: context.created_at,
    }
}

fn sanitize_call_chain_for_storage(context: &RequestContext) -> Vec<CallChainNode> {
    context
        .call_chain
        .iter()
        .cloned()
        .map(|mut node| {
            node.process_name = node
                .process_name
                .map(|value| sanitize_path_value_for_storage(&value));
            node.executable_path = node
                .executable_path
                .map(|value| sanitize_path_value_for_storage(&value));
            node.argv = node
                .argv
                .into_iter()
                .map(|value| sanitize_path_value_for_storage(&value))
                .collect();
            node.resolved_file_path = node
                .resolved_file_path
                .map(|value| sanitize_path_value_for_storage(&value));
            node.clear_preview_content();
            node
        })
        .collect()
}

fn sanitize_path_value_for_storage(value: &str) -> String {
    if looks_sensitive_value(value) && !looks_absolute_path(value) {
        REDACTED_VALUE.to_string()
    } else {
        value.trim().to_string()
    }
}

pub(crate) fn looks_absolute_path(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }

    trimmed.starts_with('/')
        || trimmed.starts_with("~/")
        || trimmed.starts_with("\\\\")
        || matches!(
            trimmed.as_bytes(),
            [drive, b':', slash, ..]
                if drive.is_ascii_alphabetic() && matches!(slash, b'/' | b'\\')
        )
}

fn sanitize_request_metadata_for_storage(
    metadata: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    metadata
        .iter()
        .map(|(key, value)| {
            let sanitized = if looks_sensitive_key(key) || looks_sensitive_value(value) {
                REDACTED_VALUE.to_string()
            } else {
                value.trim().to_string()
            };
            (key.clone(), sanitized)
        })
        .collect()
}

fn looks_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    SENSITIVE_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
}

pub(crate) fn looks_sensitive_value(value: &str) -> bool {
    let normalized = value.trim();
    if normalized.is_empty() {
        return false;
    }

    let lowered = normalized.to_ascii_lowercase();
    if lowered.contains("bearer ")
        || lowered.contains("authorization:")
        || lowered.contains("token=")
        || lowered.contains("password=")
        || lowered.contains("-----begin")
        || lowered.starts_with("sk-")
        || lowered.starts_with("rk-")
        || lowered.starts_with("ghp_")
    {
        return true;
    }

    if normalized.contains('\n') {
        return false;
    }

    let is_tokenish = normalized.len() >= 24
        && normalized.chars().all(|char| {
            char.is_ascii_alphanumeric() || matches!(char, '-' | '_' | '/' | '+' | '=')
        });
    let class_count = [
        normalized.chars().any(|char| char.is_ascii_lowercase()),
        normalized.chars().any(|char| char.is_ascii_uppercase()),
        normalized.chars().any(|char| char.is_ascii_digit()),
        normalized
            .chars()
            .any(|char| matches!(char, '-' | '_' | '/' | '+' | '=')),
    ]
    .into_iter()
    .filter(|present| *present)
    .count();

    is_tokenish && class_count >= 2
}

#[cfg(test)]
mod tests {
    use crate::{CallChainNode, RequestContext};

    use super::{sanitize_prompt_context, sanitize_request_context_for_storage};

    #[test]
    fn limits_provider_context_to_resource_tags_and_resource_metadata() {
        let mut context = RequestContext::new(
            "secret/demo".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        );
        context.resource_tags = vec!["prod".to_string(), "db".to_string()];
        context
            .resource_metadata
            .insert("environment".to_string(), "dev".to_string());
        context.env_vars.insert(
            "OPENAI_API_KEY".to_string(),
            "sk-test-super-secret-value".to_string(),
        );
        context
            .metadata
            .insert("environment".to_string(), "dev".to_string());
        context.metadata.insert(
            "api_token".to_string(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        );

        let sanitized = sanitize_prompt_context(&context);

        assert_eq!(sanitized.resource, "secret/demo");
        assert_eq!(sanitized.resource_tags, vec!["prod".to_string(), "db".to_string()]);
        assert_eq!(
            sanitized.metadata.get("environment"),
            Some(&"dev".to_string())
        );
        assert!(sanitized.metadata.get("api_token").is_none());
        assert!(sanitized.env_vars.is_empty());
        assert!(sanitized.env_var_names.is_empty());
        assert!(sanitized.call_chain.is_empty());
        assert!(sanitized.reason.is_empty());
        assert!(sanitized.requested_by.is_empty());
        assert!(sanitized.redacted_fields.is_empty());
    }

    #[test]
    fn omits_paths_from_provider_context_and_strips_preview_content_from_storage_context() {
        let mut context = RequestContext::new(
            "secret/demo".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        );
        context.script_path = Some("/Users/jpx/private/run-secret.sh".to_string());
        context.call_chain = vec![
            CallChainNode::legacy_path("/Users/jpx/private/run-secret.sh"),
            CallChainNode::legacy_path("bash"),
        ];
        context.call_chain[0].preview_text = Some("echo secret".to_string());
        context.call_chain[0].preview_error = Some("Preview unavailable".to_string());

        let prompt_context = sanitize_prompt_context(&context);
        let stored_context = sanitize_request_context_for_storage(&context);

        assert_eq!(prompt_context.script_path.as_deref(), None);
        assert_eq!(
            stored_context.script_path.as_deref(),
            Some("/Users/jpx/private/run-secret.sh")
        );
        assert!(prompt_context.call_chain.is_empty());
        assert_eq!(
            stored_context.call_chain[0].resolved_file_path.as_deref(),
            Some("/Users/jpx/private/run-secret.sh")
        );
        assert_eq!(stored_context.call_chain[0].preview_text, None);
        assert_eq!(stored_context.call_chain[0].preview_error, None);
    }
}
