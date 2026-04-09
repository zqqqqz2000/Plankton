use std::{collections::BTreeMap, path::Path};

use crate::{RequestContext, SanitizedPromptContext};

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
    let mut redacted_fields = Vec::new();
    let mut notes = Vec::new();

    let resource = sanitize_text(
        "resource",
        &context.resource,
        &mut redacted_fields,
        &mut notes,
    );
    let reason = sanitize_text("reason", &context.reason, &mut redacted_fields, &mut notes);
    let requested_by = sanitize_text(
        "requested_by",
        &context.requested_by,
        &mut redacted_fields,
        &mut notes,
    );
    let script_path = context
        .script_path
        .as_ref()
        .map(|value| sanitize_text("script_path", value, &mut redacted_fields, &mut notes));
    let call_chain = context
        .call_chain
        .iter()
        .enumerate()
        .map(|(index, value)| {
            sanitize_text(
                &format!("call_chain[{index}]"),
                value,
                &mut redacted_fields,
                &mut notes,
            )
        })
        .collect::<Vec<_>>();

    let env_var_names = context.env_vars.keys().cloned().collect::<Vec<_>>();
    let env_vars = context
        .env_vars
        .keys()
        .map(|key| {
            redacted_fields.push(format!("env_vars.{key}"));
            (key.clone(), REDACTED_VALUE.to_string())
        })
        .collect::<BTreeMap<_, _>>();
    if !env_var_names.is_empty() {
        notes.push(format!(
            "provider input omits {} environment variable value(s)",
            env_var_names.len()
        ));
    }

    let metadata = sanitize_metadata(&context.metadata, &mut redacted_fields, &mut notes);

    redacted_fields.sort();
    redacted_fields.dedup();

    let redaction_summary = if notes.is_empty() {
        "provider input only exposes the explicit prompt-contract allow-list".to_string()
    } else {
        notes.join("; ")
    };

    SanitizedPromptContext {
        resource,
        reason,
        requested_by,
        script_path,
        call_chain,
        env_vars,
        env_var_names,
        metadata,
        redaction_summary,
        redacted_fields,
    }
}

pub fn sanitize_request_context_for_storage(context: &RequestContext) -> RequestContext {
    let sanitized = sanitize_prompt_context(context);

    RequestContext {
        resource: sanitized.resource,
        reason: sanitized.reason,
        requested_by: sanitized.requested_by,
        script_path: sanitized.script_path,
        call_chain: sanitized.call_chain,
        env_vars: sanitized.env_vars,
        metadata: sanitized.metadata,
        created_at: context.created_at,
    }
}

fn sanitize_metadata(
    values: &BTreeMap<String, String>,
    redacted_fields: &mut Vec<String>,
    notes: &mut Vec<String>,
) -> BTreeMap<String, String> {
    values
        .iter()
        .map(|(key, value)| {
            let value = if looks_sensitive_key(key) || looks_sensitive_value(value) {
                redacted_fields.push(format!("metadata.{key}"));
                notes.push(format!("redacted metadata field {key}"));
                REDACTED_VALUE.to_string()
            } else {
                sanitize_text(&format!("metadata.{key}"), value, redacted_fields, notes)
            };

            (key.clone(), value)
        })
        .collect()
}

fn sanitize_text(
    field_name: &str,
    value: &str,
    redacted_fields: &mut Vec<String>,
    notes: &mut Vec<String>,
) -> String {
    if looks_absolute_path(value) {
        redacted_fields.push(field_name.to_string());
        notes.push(format!("trimmed absolute path from {field_name}"));
        return sanitize_absolute_path(value);
    }

    if looks_sensitive_value(value) {
        redacted_fields.push(field_name.to_string());
        notes.push(format!(
            "redacted {field_name} because it looked secret-like"
        ));
        return REDACTED_VALUE.to_string();
    }

    value.trim().to_string()
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

fn sanitize_absolute_path(value: &str) -> String {
    let trimmed = value.trim();
    Path::new(trimmed)
        .file_name()
        .and_then(|segment| segment.to_str())
        .map(ToOwned::to_owned)
        .filter(|segment| !segment.is_empty())
        .unwrap_or_else(|| REDACTED_VALUE.to_string())
}

pub(crate) fn looks_sensitive_key(key: &str) -> bool {
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
    use crate::RequestContext;

    use super::{sanitize_prompt_context, sanitize_request_context_for_storage};

    #[test]
    fn redacts_env_values_and_sensitive_metadata() {
        let mut context = RequestContext::new(
            "secret/demo".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        );
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

        assert_eq!(
            sanitized.env_vars.get("OPENAI_API_KEY"),
            Some(&"[redacted]".to_string())
        );
        assert_eq!(
            sanitized.metadata.get("environment"),
            Some(&"dev".to_string())
        );
        assert_eq!(
            sanitized.metadata.get("api_token"),
            Some(&"[redacted]".to_string())
        );
        assert!(sanitized
            .redacted_fields
            .contains(&"env_vars.OPENAI_API_KEY".to_string()));
        assert!(sanitized
            .redacted_fields
            .contains(&"metadata.api_token".to_string()));
    }

    #[test]
    fn trims_absolute_paths_from_prompt_and_storage_contexts() {
        let mut context = RequestContext::new(
            "secret/demo".to_string(),
            "Need smoke test access".to_string(),
            "alice".to_string(),
        );
        context.script_path = Some("/Users/jpx/private/run-secret.sh".to_string());
        context.call_chain = vec![
            "/Users/jpx/private/run-secret.sh".to_string(),
            "bash".to_string(),
        ];

        let prompt_context = sanitize_prompt_context(&context);
        let stored_context = sanitize_request_context_for_storage(&context);

        assert_eq!(prompt_context.script_path.as_deref(), Some("run-secret.sh"));
        assert_eq!(stored_context.script_path.as_deref(), Some("run-secret.sh"));
        assert_eq!(prompt_context.call_chain[0], "run-secret.sh");
        assert_eq!(stored_context.call_chain[0], "run-secret.sh");
        assert!(prompt_context
            .redacted_fields
            .contains(&"script_path".to_string()));
    }
}
