use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use chrono::{DateTime, Utc};
use directories::ProjectDirs;
use dotenvy::from_path_iter;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const LOCAL_SECRET_CATALOG_RESOLVER_KIND: &str = "local_secret_catalog";
pub const ONEPASSWORD_CLI_PROVIDER_KIND: &str = "1password_cli";
pub const BITWARDEN_CLI_PROVIDER_KIND: &str = "bitwarden_cli";
pub const DOTENV_FILE_PROVIDER_KIND: &str = "dotenv_file";

const SECRET_CATALOG_BOOTSTRAP_TEMPLATE: &str = r#"# Plankton local secret catalog
# Map resource identifiers either to literal secret values or to imported source locators.
#
# Direct value example:
# [secrets]
# "secret/demo" = "replace-me"
#
# Imported reference example:
# [[imports]]
# resource = "secret/demo"
# display_name = "Demo token"
# provider_kind = "dotenv_file"
# file_path = "/abs/path/to/.env"
# key = "DEMO_TOKEN"
#
[secrets]
"#;

pub trait ValueResolver: Send + Sync {
    fn kind(&self) -> &'static str;

    fn list_resources(&self) -> Vec<String>;

    fn resolve(&self, resource: &str) -> Result<String, ValueResolverError>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretImportSpec {
    pub resource: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub source_locator: SecretSourceLocator,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportedSecretReference {
    pub resource: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(flatten)]
    pub source_locator: SecretSourceLocator,
    pub imported_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_verified_at: Option<DateTime<Utc>>,
}

impl ImportedSecretReference {
    pub fn provider_kind(&self) -> &'static str {
        self.source_locator.provider_kind()
    }

    pub fn container_label(&self) -> Option<&str> {
        self.source_locator.container_label()
    }

    pub fn field_selector(&self) -> &str {
        self.source_locator.field_selector()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "provider_kind", rename_all = "snake_case")]
pub enum SecretSourceLocator {
    #[serde(rename = "1password_cli")]
    OnePasswordCli {
        account: String,
        vault: String,
        item: String,
        field: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        vault_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        field_id: Option<String>,
    },
    #[serde(rename = "bitwarden_cli")]
    BitwardenCli {
        account: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        organization: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        collection: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        folder: Option<String>,
        item: String,
        field: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
    },
    #[serde(rename = "dotenv_file")]
    DotenvFile {
        file_path: PathBuf,
        #[serde(skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        prefix: Option<String>,
        key: String,
    },
}

impl SecretSourceLocator {
    pub fn provider_kind(&self) -> &'static str {
        match self {
            Self::OnePasswordCli { .. } => ONEPASSWORD_CLI_PROVIDER_KIND,
            Self::BitwardenCli { .. } => BITWARDEN_CLI_PROVIDER_KIND,
            Self::DotenvFile { .. } => DOTENV_FILE_PROVIDER_KIND,
        }
    }

    pub fn container_label(&self) -> Option<&str> {
        match self {
            Self::OnePasswordCli { vault, .. } => Some(vault.as_str()),
            Self::BitwardenCli {
                collection,
                folder,
                organization,
                account,
                ..
            } => collection
                .as_deref()
                .or(folder.as_deref())
                .or(organization.as_deref())
                .or(Some(account.as_str())),
            Self::DotenvFile {
                namespace,
                prefix,
                file_path,
                ..
            } => namespace
                .as_deref()
                .or(prefix.as_deref())
                .or_else(|| file_path.file_name().and_then(|name| name.to_str())),
        }
    }

    pub fn field_selector(&self) -> &str {
        match self {
            Self::OnePasswordCli { field, .. } => field.as_str(),
            Self::BitwardenCli { field, .. } => field.as_str(),
            Self::DotenvFile { key, .. } => key.as_str(),
        }
    }

    fn default_display_name(&self) -> String {
        match self {
            Self::OnePasswordCli { item, field, .. } => format!("{item}:{field}"),
            Self::BitwardenCli { item, field, .. } => format!("{item}:{field}"),
            Self::DotenvFile { key, .. } => key.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportedSecretReceipt {
    pub catalog_path: PathBuf,
    pub reference: ImportedSecretReference,
}

#[derive(Debug, Clone)]
pub struct LocalSecretCatalogResolver {
    entries: BTreeMap<String, SecretCatalogEntry>,
}

#[derive(Debug, Clone)]
enum SecretCatalogEntry {
    Literal(String),
    Imported(ImportedSecretReference),
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct SecretCatalogFile {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    secrets: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    values: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    imports: Vec<ImportedSecretReference>,
}

#[derive(Debug, Clone)]
struct VendorCliPrograms {
    onepassword: PathBuf,
    bitwarden: PathBuf,
}

impl VendorCliPrograms {
    fn from_env() -> Self {
        Self {
            onepassword: env::var_os("PLANKTON_1PASSWORD_CLI_BIN")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("op")),
            bitwarden: env::var_os("PLANKTON_BITWARDEN_CLI_BIN")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("bw")),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SecretImportError {
    #[error("resource key is required")]
    MissingResource,
    #[error("failed to load local secret catalog from {path}: {message}")]
    LoadCatalog { path: String, message: String },
    #[error("failed to serialize local secret catalog to {path}: {message}")]
    SerializeCatalog { path: String, message: String },
    #[error("failed to write local secret catalog to {path}: {message}")]
    WriteCatalog { path: String, message: String },
    #[error("failed to verify imported source for {resource}: {source}")]
    VerifySource {
        resource: String,
        #[source]
        source: ValueResolverError,
    },
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
    #[error("{provider_kind} source locator for {resource} is invalid: {message}")]
    InvalidSourceLocator {
        provider_kind: String,
        resource: String,
        message: String,
    },
    #[error("{provider_kind} CLI is not available for {resource}: {message}")]
    ToolUnavailable {
        provider_kind: String,
        resource: String,
        message: String,
    },
    #[error("failed to read {provider_kind} source for {resource}: {message}")]
    SourceReadFailed {
        provider_kind: String,
        resource: String,
        message: String,
    },
    #[error("failed to parse {provider_kind} response for {resource}: {message}")]
    SourceParseFailed {
        provider_kind: String,
        resource: String,
        message: String,
    },
    #[error("{provider_kind} source for {resource} did not contain field {field}")]
    SourceFieldNotFound {
        provider_kind: String,
        resource: String,
        field: String,
    },
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
        let catalog = load_secret_catalog_file(path)?;
        Ok(Self {
            entries: catalog_entries(catalog),
        })
    }

    fn resolve_with_programs(
        &self,
        resource: &str,
        programs: &VendorCliPrograms,
    ) -> Result<String, ValueResolverError> {
        let resource = resource.trim();
        let entry =
            self.entries
                .get(resource)
                .ok_or_else(|| ValueResolverError::ResourceNotFound {
                    resource: resource.to_string(),
                })?;

        match entry {
            SecretCatalogEntry::Literal(value) => {
                if value.is_empty() {
                    Err(ValueResolverError::EmptyValue {
                        resource: resource.to_string(),
                    })
                } else {
                    Ok(value.clone())
                }
            }
            SecretCatalogEntry::Imported(reference) => {
                resolve_imported_reference(reference, resource, programs)
            }
        }
    }
}

impl ValueResolver for LocalSecretCatalogResolver {
    fn kind(&self) -> &'static str {
        LOCAL_SECRET_CATALOG_RESOLVER_KIND
    }

    fn list_resources(&self) -> Vec<String> {
        self.entries.keys().cloned().collect()
    }

    fn resolve(&self, resource: &str) -> Result<String, ValueResolverError> {
        self.resolve_with_programs(resource, &VendorCliPrograms::from_env())
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

pub fn import_secret_reference(
    spec: SecretImportSpec,
) -> Result<ImportedSecretReceipt, SecretImportError> {
    import_secret_reference_at(local_secret_catalog_path().as_path(), spec)
}

pub fn import_secret_reference_at(
    path: &Path,
    spec: SecretImportSpec,
) -> Result<ImportedSecretReceipt, SecretImportError> {
    import_secret_reference_at_with_programs(path, spec, &VendorCliPrograms::from_env())
}

fn import_secret_reference_at_with_programs(
    path: &Path,
    spec: SecretImportSpec,
    programs: &VendorCliPrograms,
) -> Result<ImportedSecretReceipt, SecretImportError> {
    let mut catalog = load_secret_catalog_file_optional(path)?;
    let now = Utc::now();
    let resource = spec.resource.trim().to_string();
    if resource.is_empty() {
        return Err(SecretImportError::MissingResource);
    }

    let display_name = spec
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| spec.source_locator.default_display_name());
    let description = spec
        .description
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let tags = spec
        .tags
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();

    let mut reference = ImportedSecretReference {
        resource: resource.clone(),
        display_name,
        description,
        tags,
        source_locator: spec.source_locator,
        imported_at: now,
        last_verified_at: None,
    };

    resolve_imported_reference(&reference, resource.as_str(), programs).map_err(|source| {
        SecretImportError::VerifySource {
            resource: resource.clone(),
            source,
        }
    })?;
    reference.last_verified_at = Some(now);

    catalog.secrets.remove(resource.as_str());
    catalog.values.remove(resource.as_str());
    if let Some(existing) = catalog
        .imports
        .iter_mut()
        .find(|existing| existing.resource == resource)
    {
        *existing = reference.clone();
    } else {
        catalog.imports.push(reference.clone());
    }

    save_secret_catalog_file(path, &catalog)?;

    Ok(ImportedSecretReceipt {
        catalog_path: path.to_path_buf(),
        reference,
    })
}

fn bootstrap_secret_catalog(path: &Path) -> Result<bool, ValueResolverError> {
    if path.exists() {
        return Ok(false);
    }

    ensure_catalog_parent_dir(path).map_err(|error| ValueResolverError::CreateCatalog {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;

    fs::write(path, SECRET_CATALOG_BOOTSTRAP_TEMPLATE).map_err(|error| {
        ValueResolverError::CreateCatalog {
            path: path.display().to_string(),
            message: error.to_string(),
        }
    })?;

    Ok(true)
}

fn load_secret_catalog_file(path: &Path) -> Result<SecretCatalogFile, ValueResolverError> {
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

    parse_secret_catalog(path, &content)
}

fn load_secret_catalog_file_optional(path: &Path) -> Result<SecretCatalogFile, SecretImportError> {
    if !path.exists() {
        return Ok(SecretCatalogFile::default());
    }

    let content = fs::read_to_string(path).map_err(|error| SecretImportError::LoadCatalog {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;

    parse_secret_catalog(path, &content).map_err(|error| SecretImportError::LoadCatalog {
        path: path.display().to_string(),
        message: error.to_string(),
    })
}

fn save_secret_catalog_file(
    path: &Path,
    catalog: &SecretCatalogFile,
) -> Result<(), SecretImportError> {
    ensure_catalog_parent_dir(path).map_err(|error| SecretImportError::WriteCatalog {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    let content =
        toml::to_string_pretty(catalog).map_err(|error| SecretImportError::SerializeCatalog {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
    fs::write(path, content).map_err(|error| SecretImportError::WriteCatalog {
        path: path.display().to_string(),
        message: error.to_string(),
    })
}

fn ensure_catalog_parent_dir(path: &Path) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn parse_secret_catalog(
    path: &Path,
    content: &str,
) -> Result<SecretCatalogFile, ValueResolverError> {
    let display_path = path.display().to_string();
    let root: toml::Value =
        toml::from_str(content).map_err(|error| ValueResolverError::ParseCatalog {
            path: display_path.clone(),
            message: error.to_string(),
        })?;

    let table = root.as_table().cloned().unwrap_or_default();
    let mut catalog = SecretCatalogFile::default();

    merge_string_table(&mut catalog.secrets, table.get("secrets"));
    merge_string_table(&mut catalog.secrets, table.get("values"));

    if let Some(imports_value) = table.get("imports") {
        catalog.imports =
            imports_value
                .clone()
                .try_into()
                .map_err(|error| ValueResolverError::ParseCatalog {
                    path: display_path.clone(),
                    message: error.to_string(),
                })?;
    }

    for (key, value) in &table {
        if matches!(key.as_str(), "secrets" | "values" | "imports") {
            continue;
        }
        if let Some(value) = value.as_str() {
            catalog.secrets.insert(key.clone(), value.to_string());
        }
    }

    Ok(catalog)
}

fn merge_string_table(target: &mut BTreeMap<String, String>, value: Option<&toml::Value>) {
    let Some(table) = value.and_then(toml::Value::as_table) else {
        return;
    };
    for (key, value) in table {
        if let Some(value) = value.as_str() {
            target.insert(key.clone(), value.to_string());
        }
    }
}

fn catalog_entries(catalog: SecretCatalogFile) -> BTreeMap<String, SecretCatalogEntry> {
    let mut entries = BTreeMap::new();

    for (resource, value) in catalog
        .secrets
        .into_iter()
        .chain(catalog.values.into_iter())
    {
        entries.insert(resource, SecretCatalogEntry::Literal(value));
    }

    for reference in catalog.imports {
        entries.insert(
            reference.resource.clone(),
            SecretCatalogEntry::Imported(reference),
        );
    }

    entries
}

fn resolve_imported_reference(
    reference: &ImportedSecretReference,
    resource: &str,
    programs: &VendorCliPrograms,
) -> Result<String, ValueResolverError> {
    match &reference.source_locator {
        SecretSourceLocator::OnePasswordCli {
            account,
            vault,
            item,
            field,
            vault_id,
            item_id,
            field_id,
        } => resolve_onepassword_reference(
            programs.onepassword.as_path(),
            OnePasswordCliLocator {
                account,
                vault,
                item,
                field,
                vault_id: vault_id.as_deref(),
                item_id: item_id.as_deref(),
                field_id: field_id.as_deref(),
            },
            resource,
        ),
        SecretSourceLocator::BitwardenCli {
            item,
            field,
            item_id,
            ..
        } => resolve_bitwarden_reference(
            programs.bitwarden.as_path(),
            BitwardenCliLocator {
                item,
                field,
                item_id: item_id.as_deref(),
            },
            resource,
        ),
        SecretSourceLocator::DotenvFile {
            file_path,
            namespace: _,
            prefix,
            key,
        } => resolve_dotenv_reference(
            DotenvLocator {
                file_path: file_path.as_path(),
                prefix: prefix.as_deref(),
                key,
            },
            resource,
        ),
    }
}

struct OnePasswordCliLocator<'a> {
    account: &'a str,
    vault: &'a str,
    item: &'a str,
    field: &'a str,
    vault_id: Option<&'a str>,
    item_id: Option<&'a str>,
    field_id: Option<&'a str>,
}

fn resolve_onepassword_reference(
    program: &Path,
    locator: OnePasswordCliLocator<'_>,
    resource: &str,
) -> Result<String, ValueResolverError> {
    if locator.account.trim().is_empty()
        || locator.vault.trim().is_empty()
        || locator.item.trim().is_empty()
        || locator.field.trim().is_empty()
    {
        return Err(ValueResolverError::InvalidSourceLocator {
            provider_kind: ONEPASSWORD_CLI_PROVIDER_KIND.to_string(),
            resource: resource.to_string(),
            message: "account, vault, item, and field are required".to_string(),
        });
    }

    let item_selector = locator.item_id.unwrap_or(locator.item);
    let vault_selector = locator.vault_id.unwrap_or(locator.vault);
    let args = vec![
        "item".to_string(),
        "get".to_string(),
        item_selector.to_string(),
        "--vault".to_string(),
        vault_selector.to_string(),
        "--format".to_string(),
        "json".to_string(),
        "--account".to_string(),
        locator.account.to_string(),
    ];
    let stdout =
        run_command_capture_stdout(program, &args, ONEPASSWORD_CLI_PROVIDER_KIND, resource)?;
    let item: Value =
        serde_json::from_slice(&stdout).map_err(|error| ValueResolverError::SourceParseFailed {
            provider_kind: ONEPASSWORD_CLI_PROVIDER_KIND.to_string(),
            resource: resource.to_string(),
            message: error.to_string(),
        })?;

    if normalize_match(locator.field, "notes") || normalize_match(locator.field, "notesplain") {
        if let Some(notes) = item.get("notesPlain").and_then(Value::as_str) {
            return ensure_non_empty_value(
                ONEPASSWORD_CLI_PROVIDER_KIND,
                resource,
                locator.field,
                notes,
            );
        }
    }

    let field_entry = item
        .get("fields")
        .and_then(Value::as_array)
        .and_then(|fields| {
            fields.iter().find(|field| {
                let id_matches = field
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|value| normalize_match(locator.field_id.unwrap_or(locator.field), value))
                    .unwrap_or(false);
                let selector_matches = field
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|value| normalize_match(locator.field, value))
                    .unwrap_or(false)
                    || field
                        .get("label")
                        .and_then(Value::as_str)
                        .map(|value| normalize_match(locator.field, value))
                        .unwrap_or(false)
                    || field
                        .get("purpose")
                        .and_then(Value::as_str)
                        .map(|value| normalize_match(locator.field, value))
                        .unwrap_or(false);
                id_matches || selector_matches
            })
        });

    let Some(field_entry) = field_entry else {
        return Err(ValueResolverError::SourceFieldNotFound {
            provider_kind: ONEPASSWORD_CLI_PROVIDER_KIND.to_string(),
            resource: resource.to_string(),
            field: locator.field.to_string(),
        });
    };

    if let Some(value) = field_entry.get("value").and_then(Value::as_str) {
        return ensure_non_empty_value(
            ONEPASSWORD_CLI_PROVIDER_KIND,
            resource,
            locator.field,
            value,
        );
    }

    if let Some(reference) = field_entry.get("reference").and_then(Value::as_str) {
        let reference_args = vec![
            "read".to_string(),
            reference.to_string(),
            "--account".to_string(),
            locator.account.to_string(),
        ];
        let stdout = run_command_capture_stdout(
            program,
            &reference_args,
            ONEPASSWORD_CLI_PROVIDER_KIND,
            resource,
        )?;
        let value =
            String::from_utf8(stdout).map_err(|error| ValueResolverError::SourceParseFailed {
                provider_kind: ONEPASSWORD_CLI_PROVIDER_KIND.to_string(),
                resource: resource.to_string(),
                message: error.to_string(),
            })?;
        return ensure_non_empty_value(
            ONEPASSWORD_CLI_PROVIDER_KIND,
            resource,
            locator.field,
            value.trim_end_matches('\n'),
        );
    }

    Err(ValueResolverError::SourceFieldNotFound {
        provider_kind: ONEPASSWORD_CLI_PROVIDER_KIND.to_string(),
        resource: resource.to_string(),
        field: locator.field.to_string(),
    })
}

struct BitwardenCliLocator<'a> {
    item: &'a str,
    field: &'a str,
    item_id: Option<&'a str>,
}

fn resolve_bitwarden_reference(
    program: &Path,
    locator: BitwardenCliLocator<'_>,
    resource: &str,
) -> Result<String, ValueResolverError> {
    if locator.item.trim().is_empty() || locator.field.trim().is_empty() {
        return Err(ValueResolverError::InvalidSourceLocator {
            provider_kind: BITWARDEN_CLI_PROVIDER_KIND.to_string(),
            resource: resource.to_string(),
            message: "item and field are required".to_string(),
        });
    }

    let item_selector = locator.item_id.unwrap_or(locator.item);
    let args = vec![
        "get".to_string(),
        "item".to_string(),
        item_selector.to_string(),
    ];
    let stdout = run_command_capture_stdout(program, &args, BITWARDEN_CLI_PROVIDER_KIND, resource)?;
    let item: Value =
        serde_json::from_slice(&stdout).map_err(|error| ValueResolverError::SourceParseFailed {
            provider_kind: BITWARDEN_CLI_PROVIDER_KIND.to_string(),
            resource: resource.to_string(),
            message: error.to_string(),
        })?;

    if normalize_match(locator.field, "notes") {
        if let Some(notes) = item.get("notes").and_then(Value::as_str) {
            return ensure_non_empty_value(
                BITWARDEN_CLI_PROVIDER_KIND,
                resource,
                locator.field,
                notes,
            );
        }
    }

    if normalize_match(locator.field, "username") {
        if let Some(username) = item
            .get("login")
            .and_then(|login| login.get("username"))
            .and_then(Value::as_str)
        {
            return ensure_non_empty_value(
                BITWARDEN_CLI_PROVIDER_KIND,
                resource,
                locator.field,
                username,
            );
        }
    }

    if normalize_match(locator.field, "password") {
        if let Some(password) = item
            .get("login")
            .and_then(|login| login.get("password"))
            .and_then(Value::as_str)
        {
            return ensure_non_empty_value(
                BITWARDEN_CLI_PROVIDER_KIND,
                resource,
                locator.field,
                password,
            );
        }
    }

    let field_entry = item
        .get("fields")
        .and_then(Value::as_array)
        .and_then(|fields| {
            fields.iter().find(|field| {
                field
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|value| normalize_match(locator.field, value))
                    .unwrap_or(false)
            })
        });

    if let Some(value) = field_entry
        .and_then(|field| field.get("value"))
        .and_then(Value::as_str)
    {
        return ensure_non_empty_value(BITWARDEN_CLI_PROVIDER_KIND, resource, locator.field, value);
    }

    Err(ValueResolverError::SourceFieldNotFound {
        provider_kind: BITWARDEN_CLI_PROVIDER_KIND.to_string(),
        resource: resource.to_string(),
        field: locator.field.to_string(),
    })
}

struct DotenvLocator<'a> {
    file_path: &'a Path,
    prefix: Option<&'a str>,
    key: &'a str,
}

fn resolve_dotenv_reference(
    locator: DotenvLocator<'_>,
    resource: &str,
) -> Result<String, ValueResolverError> {
    let file_display = locator.file_path.display().to_string();
    let mut parsed = BTreeMap::new();
    let iter = from_path_iter(locator.file_path).map_err(|error| {
        ValueResolverError::SourceReadFailed {
            provider_kind: DOTENV_FILE_PROVIDER_KIND.to_string(),
            resource: resource.to_string(),
            message: format!("{file_display}: {error}"),
        }
    })?;

    for entry in iter {
        let (key, value) = entry.map_err(|error| ValueResolverError::SourceParseFailed {
            provider_kind: DOTENV_FILE_PROVIDER_KIND.to_string(),
            resource: resource.to_string(),
            message: format!("{file_display}: {error}"),
        })?;
        parsed.insert(key, value);
    }

    for candidate in dotenv_candidate_keys(locator.prefix, locator.key) {
        if let Some(value) = parsed.get(candidate.as_str()) {
            return ensure_non_empty_value(
                DOTENV_FILE_PROVIDER_KIND,
                resource,
                candidate.as_str(),
                value,
            );
        }
    }

    Err(ValueResolverError::SourceFieldNotFound {
        provider_kind: DOTENV_FILE_PROVIDER_KIND.to_string(),
        resource: resource.to_string(),
        field: locator.key.to_string(),
    })
}

fn dotenv_candidate_keys(prefix: Option<&str>, key: &str) -> Vec<String> {
    let key = key.trim();
    let mut candidates = Vec::new();

    if let Some(prefix) = prefix.map(str::trim).filter(|prefix| !prefix.is_empty()) {
        if key.starts_with(prefix) {
            candidates.push(key.to_string());
        } else {
            candidates.push(format!("{prefix}{key}"));
        }
    }

    if candidates.iter().all(|candidate| candidate != key) {
        candidates.push(key.to_string());
    }

    candidates
}

fn ensure_non_empty_value(
    provider_kind: &str,
    resource: &str,
    field: &str,
    value: &str,
) -> Result<String, ValueResolverError> {
    if value.is_empty() {
        return Err(ValueResolverError::SourceFieldNotFound {
            provider_kind: provider_kind.to_string(),
            resource: resource.to_string(),
            field: field.to_string(),
        });
    }

    Ok(value.to_string())
}

fn run_command_capture_stdout(
    program: &Path,
    args: &[String],
    provider_kind: &str,
    resource: &str,
) -> Result<Vec<u8>, ValueResolverError> {
    let output = Command::new(program).args(args).output().map_err(|error| {
        let message = if error.kind() == std::io::ErrorKind::NotFound {
            format!("{} was not found in PATH", program.display())
        } else {
            error.to_string()
        };
        ValueResolverError::ToolUnavailable {
            provider_kind: provider_kind.to_string(),
            resource: resource.to_string(),
            message,
        }
    })?;

    if !output.status.success() {
        return Err(ValueResolverError::SourceReadFailed {
            provider_kind: provider_kind.to_string(),
            resource: resource.to_string(),
            message: compact_process_message(&output),
        });
    }

    Ok(output.stdout)
}

fn compact_process_message(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr = stderr
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned);

    stderr.unwrap_or_else(|| format!("process exited with status {}", output.status))
}

fn normalize_match(left: &str, right: &str) -> bool {
    left.trim().eq_ignore_ascii_case(right.trim())
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use tempfile::tempdir;

    use super::{
        default_value_resolver, import_secret_reference_at_with_programs,
        LocalSecretCatalogResolver, SecretImportSpec, SecretSourceLocator, ValueResolver,
        ValueResolverError, VendorCliPrograms, BITWARDEN_CLI_PROVIDER_KIND,
        DOTENV_FILE_PROVIDER_KIND, ONEPASSWORD_CLI_PROVIDER_KIND,
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
    fn lists_resource_keys_from_catalog() {
        let temp = tempdir().expect("temp directory should be created");
        let path = temp.path().join("secrets.toml");
        fs::write(
            &path,
            "[secrets]\n\"secret/z-token\" = \"z\"\n\"secret/a-token\" = \"a\"\n",
        )
        .expect("catalog should be written");

        let resolver = LocalSecretCatalogResolver::load_from_path(path.as_path())
            .expect("resolver should load");

        assert_eq!(
            resolver.list_resources(),
            vec!["secret/a-token".to_string(), "secret/z-token".to_string()]
        );
    }

    #[test]
    fn dotenv_import_writes_reference_without_persisting_secret_value() {
        let temp = tempdir().expect("temp directory should be created");
        let env_path = temp.path().join(".env");
        let catalog_path = temp.path().join("catalog.toml");
        fs::write(&env_path, "APP_SECRET_DEMO=demo-value\n").expect(".env should be written");

        let receipt = import_secret_reference_at_with_programs(
            catalog_path.as_path(),
            SecretImportSpec {
                resource: "secret/demo".to_string(),
                display_name: Some("Demo secret".to_string()),
                description: Some("imported from dotenv".to_string()),
                tags: vec!["demo".to_string()],
                source_locator: SecretSourceLocator::DotenvFile {
                    file_path: env_path.clone(),
                    namespace: Some("app".to_string()),
                    prefix: Some("APP_".to_string()),
                    key: "SECRET_DEMO".to_string(),
                },
            },
            &VendorCliPrograms::from_env(),
        )
        .expect("dotenv import should succeed");

        let resolver = LocalSecretCatalogResolver::load_from_path(catalog_path.as_path())
            .expect("resolver should load");
        let catalog_content =
            fs::read_to_string(catalog_path.as_path()).expect("catalog should be readable");

        assert_eq!(receipt.reference.provider_kind(), DOTENV_FILE_PROVIDER_KIND);
        assert!(receipt.reference.last_verified_at.is_some());
        assert_eq!(
            resolver
                .resolve("secret/demo")
                .expect("dotenv value should resolve"),
            "demo-value"
        );
        assert_eq!(resolver.list_resources(), vec!["secret/demo".to_string()]);
        assert!(catalog_content.contains("provider_kind = \"dotenv_file\""));
        assert!(!catalog_content.contains("demo-value"));
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

    #[test]
    fn loads_imported_references_from_catalog_for_listing() {
        let temp = tempdir().expect("temp directory should be created");
        let env_path = temp.path().join(".env");
        let path = temp.path().join("catalog.toml");
        fs::write(&env_path, "SERVICE_TOKEN=service-value\n").expect(".env should be written");
        fs::write(
            &path,
            format!(
                "[secrets]\n\"secret/literal\" = \"literal-value\"\n\n[[imports]]\nresource = \"secret/imported\"\ndisplay_name = \"Imported\"\nprovider_kind = \"dotenv_file\"\nfile_path = \"{}\"\nkey = \"SERVICE_TOKEN\"\nimported_at = \"2026-04-12T00:00:00Z\"\n",
                env_path.display()
            ),
        )
        .expect("catalog should be written");

        let resolver = LocalSecretCatalogResolver::load_from_path(path.as_path())
            .expect("resolver should load");

        assert_eq!(
            resolver.list_resources(),
            vec!["secret/imported".to_string(), "secret/literal".to_string()]
        );
        assert_eq!(
            resolver
                .resolve("secret/imported")
                .expect("imported value should resolve"),
            "service-value"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_1password_reference_via_cli_contract() {
        let temp = tempdir().expect("temp directory should be created");
        let op_path = temp.path().join("op");
        write_executable(
            op_path.as_path(),
            r#"#!/bin/sh
if [ "$1" = "item" ] && [ "$2" = "get" ]; then
  cat <<'JSON'
{"fields":[{"label":"password","value":"op-secret"}],"notesPlain":"op notes"}
JSON
  exit 0
fi
echo "unexpected op invocation" >&2
exit 1
"#,
        );
        let catalog_path = temp.path().join("catalog.toml");

        let receipt = import_secret_reference_at_with_programs(
            catalog_path.as_path(),
            SecretImportSpec {
                resource: "secret/op-demo".to_string(),
                display_name: None,
                description: None,
                tags: Vec::new(),
                source_locator: SecretSourceLocator::OnePasswordCli {
                    account: "personal".to_string(),
                    vault: "Engineering".to_string(),
                    item: "API Token".to_string(),
                    field: "password".to_string(),
                    vault_id: None,
                    item_id: None,
                    field_id: None,
                },
            },
            &VendorCliPrograms {
                onepassword: op_path.clone(),
                bitwarden: temp.path().join("bw"),
            },
        )
        .expect("1Password import should succeed");

        assert_eq!(
            receipt.reference.provider_kind(),
            ONEPASSWORD_CLI_PROVIDER_KIND
        );
        let resolver = LocalSecretCatalogResolver::load_from_path(catalog_path.as_path())
            .expect("resolver should load");
        assert_eq!(
            resolver
                .resolve_with_programs(
                    "secret/op-demo",
                    &VendorCliPrograms {
                        onepassword: op_path,
                        bitwarden: temp.path().join("bw"),
                    },
                )
                .expect("1Password value should resolve"),
            "op-secret"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_bitwarden_reference_via_cli_contract() {
        let temp = tempdir().expect("temp directory should be created");
        let bw_path = temp.path().join("bw");
        write_executable(
            bw_path.as_path(),
            r#"#!/bin/sh
if [ "$1" = "get" ] && [ "$2" = "item" ]; then
  cat <<'JSON'
{"login":{"password":"bw-secret","username":"demo-user"},"notes":"bw notes","fields":[{"name":"custom_token","value":"custom-secret"}]}
JSON
  exit 0
fi
echo "unexpected bw invocation" >&2
exit 1
"#,
        );
        let catalog_path = temp.path().join("catalog.toml");

        let receipt = import_secret_reference_at_with_programs(
            catalog_path.as_path(),
            SecretImportSpec {
                resource: "secret/bw-demo".to_string(),
                display_name: None,
                description: None,
                tags: Vec::new(),
                source_locator: SecretSourceLocator::BitwardenCli {
                    account: "personal".to_string(),
                    organization: None,
                    collection: None,
                    folder: Some("Dev".to_string()),
                    item: "API Token".to_string(),
                    field: "password".to_string(),
                    item_id: None,
                },
            },
            &VendorCliPrograms {
                onepassword: temp.path().join("op"),
                bitwarden: bw_path.clone(),
            },
        )
        .expect("Bitwarden import should succeed");

        assert_eq!(
            receipt.reference.provider_kind(),
            BITWARDEN_CLI_PROVIDER_KIND
        );
        let resolver = LocalSecretCatalogResolver::load_from_path(catalog_path.as_path())
            .expect("resolver should load");
        assert_eq!(
            resolver
                .resolve_with_programs(
                    "secret/bw-demo",
                    &VendorCliPrograms {
                        onepassword: temp.path().join("op"),
                        bitwarden: bw_path,
                    },
                )
                .expect("Bitwarden value should resolve"),
            "bw-secret"
        );
    }

    #[cfg(unix)]
    fn write_executable(path: &Path, content: &str) {
        use std::os::unix::fs::PermissionsExt;

        fs::write(path, content).expect("script should be written");
        let mut permissions = fs::metadata(path)
            .expect("metadata should load")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("permissions should be updated");
    }
}
