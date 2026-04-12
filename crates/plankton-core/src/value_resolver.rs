use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

use directories::ProjectDirs;
use serde::Deserialize;

const LOCAL_SECRET_CATALOG_RESOLVER_KIND: &str = "local_secret_catalog";
const SECRET_CATALOG_BOOTSTRAP_TEMPLATE: &str = r#"# Plankton local secret catalog
# Map approved resource identifiers to the secret values that `plankton get` should print.
#
# Example:
# [secrets]
# "secret/demo" = "replace-me"
#
[secrets]
"#;

pub trait ValueResolver: Send + Sync {
    fn kind(&self) -> &'static str;

    fn resolve(&self, resource: &str) -> Result<String, ValueResolverError>;
}

#[derive(Debug, Clone)]
pub struct LocalSecretCatalogResolver {
    values: BTreeMap<String, String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ValueResolverError {
    #[error("secret catalog file not found at {path}")]
    CatalogMissing { path: String },
    #[error("local secret catalog setup is required at {path}")]
    CatalogBootstrapRequired { path: String, created: bool },
    #[error("failed to create local secret catalog at {path}: {message}")]
    CreateCatalog { path: String, message: String },
    #[error("failed to read secret catalog from {path}: {message}")]
    ReadCatalog { path: String, message: String },
    #[error("failed to parse secret catalog from {path}: {message}")]
    ParseCatalog { path: String, message: String },
    #[error("resource {resource} was not found in the local secret catalog")]
    ResourceNotFound { resource: String },
    #[error("resource {resource} resolved to an empty value")]
    EmptyValue { resource: String },
}

#[derive(Debug, Deserialize)]
struct SecretCatalogFile {
    #[serde(default)]
    secrets: BTreeMap<String, String>,
    #[serde(default)]
    values: BTreeMap<String, String>,
}

impl LocalSecretCatalogResolver {
    pub fn load_default() -> Result<Self, ValueResolverError> {
        let path = local_secret_catalog_path();
        if !path.exists() {
            let created = bootstrap_secret_catalog(path.as_path())?;
            return Err(ValueResolverError::CatalogBootstrapRequired {
                path: path.display().to_string(),
                created,
            });
        }
        Self::load_from_path(path.as_path())
    }

    pub fn load_from_path(path: &Path) -> Result<Self, ValueResolverError> {
        let display_path = path.display().to_string();
        let content = fs::read_to_string(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ValueResolverError::CatalogMissing {
                    path: display_path.clone(),
                }
            } else {
                ValueResolverError::ReadCatalog {
                    path: display_path.clone(),
                    message: error.to_string(),
                }
            }
        })?;

        let values = parse_secret_catalog(path, &content)?;

        Ok(Self { values })
    }
}

impl ValueResolver for LocalSecretCatalogResolver {
    fn kind(&self) -> &'static str {
        LOCAL_SECRET_CATALOG_RESOLVER_KIND
    }

    fn resolve(&self, resource: &str) -> Result<String, ValueResolverError> {
        let resource = resource.trim();
        let value = self.values.get(resource).cloned().ok_or_else(|| {
            ValueResolverError::ResourceNotFound {
                resource: resource.to_string(),
            }
        })?;

        if value.is_empty() {
            return Err(ValueResolverError::EmptyValue {
                resource: resource.to_string(),
            });
        }

        Ok(value)
    }
}

pub fn local_secret_catalog_path() -> PathBuf {
    if let Ok(path) = env::var("PLANKTON_SECRET_FILE") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    if let Some(project_dirs) = ProjectDirs::from("com", "OpenAquarium", "Plankton") {
        return project_dirs
            .config_local_dir()
            .join("plankton-secrets.toml");
    }

    std::env::temp_dir().join("plankton-secrets.toml")
}

pub fn default_value_resolver() -> Result<LocalSecretCatalogResolver, ValueResolverError> {
    LocalSecretCatalogResolver::load_default()
}

fn bootstrap_secret_catalog(path: &Path) -> Result<bool, ValueResolverError> {
    if path.exists() {
        return Ok(false);
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| ValueResolverError::CreateCatalog {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
    }

    fs::write(path, SECRET_CATALOG_BOOTSTRAP_TEMPLATE).map_err(|error| {
        ValueResolverError::CreateCatalog {
            path: path.display().to_string(),
            message: error.to_string(),
        }
    })?;

    Ok(true)
}

fn parse_secret_catalog(
    path: &Path,
    content: &str,
) -> Result<BTreeMap<String, String>, ValueResolverError> {
    let display_path = path.display().to_string();
    let parsed: SecretCatalogFile =
        toml::from_str(content).map_err(|error| ValueResolverError::ParseCatalog {
            path: display_path.clone(),
            message: error.to_string(),
        })?;

    if !parsed.secrets.is_empty() {
        return Ok(parsed.secrets);
    }
    if !parsed.values.is_empty() {
        return Ok(parsed.values);
    }

    let root = toml::from_str::<toml::Value>(content).map_err(|error| {
        ValueResolverError::ParseCatalog {
            path: display_path,
            message: error.to_string(),
        }
    })?;

    let values = root
        .as_table()
        .map(|table| {
            table
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();

    Ok(values)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::{
        default_value_resolver, LocalSecretCatalogResolver, ValueResolver, ValueResolverError,
    };

    #[test]
    fn resolves_value_from_secrets_table() {
        let temp = tempdir().expect("temp directory should be created");
        let path = temp.path().join("secrets.toml");
        fs::write(&path, "[secrets]\n\"secret/demo\" = \"demo-value\"\n")
            .expect("catalog should be written");

        let resolver = LocalSecretCatalogResolver::load_from_path(path.as_path())
            .expect("resolver should load");

        assert_eq!(
            resolver
                .resolve("secret/demo")
                .expect("value should resolve"),
            "demo-value"
        );
        assert_eq!(resolver.kind(), "local_secret_catalog");
    }

    #[test]
    fn resolves_value_from_root_mapping() {
        let temp = tempdir().expect("temp directory should be created");
        let path = temp.path().join("secrets.toml");
        fs::write(&path, "\"secret/demo\" = \"demo-value\"\n").expect("catalog should be written");

        let resolver = LocalSecretCatalogResolver::load_from_path(path.as_path())
            .expect("resolver should load");

        assert_eq!(
            resolver
                .resolve("secret/demo")
                .expect("value should resolve"),
            "demo-value"
        );
    }

    #[test]
    fn reports_missing_resource_without_leaking_value() {
        let temp = tempdir().expect("temp directory should be created");
        let path = temp.path().join("secrets.toml");
        fs::write(&path, "[secrets]\n\"secret/demo\" = \"super-secret\"\n")
            .expect("catalog should be written");

        let resolver = LocalSecretCatalogResolver::load_from_path(path.as_path())
            .expect("resolver should load");
        let error = resolver
            .resolve("secret/missing")
            .expect_err("missing key should fail");

        assert!(error.to_string().contains("secret/missing"));
        assert!(!error.to_string().contains("super-secret"));
    }

    #[test]
    fn default_value_resolver_honors_env_override() {
        let temp = tempdir().expect("temp directory should be created");
        let path = temp.path().join("catalog.toml");
        fs::write(&path, "[secrets]\n\"secret/demo\" = \"demo-value\"\n")
            .expect("catalog should be written");

        unsafe {
            std::env::set_var("PLANKTON_SECRET_FILE", path.as_os_str());
        }
        let resolver = default_value_resolver().expect("resolver should load");
        unsafe {
            std::env::remove_var("PLANKTON_SECRET_FILE");
        }

        assert_eq!(
            resolver
                .resolve("secret/demo")
                .expect("value should resolve"),
            "demo-value"
        );
    }

    #[test]
    fn default_value_resolver_bootstraps_missing_catalog() {
        let temp = tempdir().expect("temp directory should be created");
        let path = temp.path().join("catalog.toml");

        unsafe {
            std::env::set_var("PLANKTON_SECRET_FILE", path.as_os_str());
        }
        let error = default_value_resolver().expect_err("missing catalog should bootstrap");
        unsafe {
            std::env::remove_var("PLANKTON_SECRET_FILE");
        }

        match error {
            ValueResolverError::CatalogBootstrapRequired {
                path: error_path,
                created,
            } => {
                assert!(created);
                assert_eq!(error_path, path.display().to_string());
            }
            other => panic!("unexpected error: {other}"),
        }

        let content = fs::read_to_string(&path).expect("bootstrap catalog should be created");
        assert!(content.contains("[secrets]"));
        assert!(content.contains("\"secret/demo\" = \"replace-me\""));
    }
}
