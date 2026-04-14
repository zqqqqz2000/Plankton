mod import_browse;

use std::sync::Mutex;

use anyhow::{Context, Result};
use import_browse::{
    inspect_dotenv_file, list_bitwarden_accounts, list_bitwarden_containers, list_bitwarden_fields,
    list_bitwarden_items, list_onepassword_accounts, list_onepassword_fields,
    list_onepassword_items, list_onepassword_vaults, pick_dotenv_file, BitwardenContainerOption,
    DotenvInspection, ImportFieldOption, ImportPickerOption,
};
use plankton_core::{
    delete_imported_secret_reference, import_secret_reference, import_secret_references,
    list_imported_secret_references, load_settings, preview_call_chain_for_desktop,
    save_user_default_policy_mode, save_user_settings, update_imported_secret_reference,
    AccessRequest, DashboardData, Decision, ImportedSecretBatchReceipt, ImportedSecretCatalog,
    ImportedSecretReceipt, ImportedSecretReferenceUpdate, PlanktonSettings, PolicyMode,
    SecretImportBatchSpec, SecretImportSpec, UserSettings,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime, State};
use tokio::task;
use url::Url;

const DEEP_LINK_EVENT: &str = "deep-link://new-url";
const HANDOFF_EVENT: &str = "plankton://handoff-request";

struct AppState {
    settings: Mutex<PlanktonSettings>,
    store: SqliteStore,
    pending_handoff_request_id: Mutex<Option<String>>,
}

#[derive(Debug, Clone, Serialize)]
struct DesktopPreferences {
    default_policy_mode: PolicyMode,
}

#[derive(Debug, Clone, Serialize)]
struct DesktopHandoff {
    request_id: String,
}

use plankton_store::SqliteStore;

fn lock_settings<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, PlanktonSettings>, String> {
    state
        .settings
        .lock()
        .map_err(|_| "failed to lock desktop settings".to_string())
}

fn lock_pending_handoff_request<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, Option<String>>, String> {
    state
        .pending_handoff_request_id
        .lock()
        .map_err(|_| "failed to lock handoff state".to_string())
}

fn current_user_settings(state: &State<'_, AppState>) -> Result<UserSettings, String> {
    let settings = lock_settings(state)?;
    Ok(UserSettings::from(&*settings))
}

fn reload_runtime_settings(state: &State<'_, AppState>) -> Result<UserSettings, String> {
    let reloaded = load_settings()
        .map_err(|error| format!("failed to reload settings after save: {error}"))?;
    let snapshot = UserSettings::from(&reloaded);
    let mut settings = lock_settings(state)?;
    *settings = reloaded;
    Ok(snapshot)
}

fn normalize_request_id(value: impl AsRef<str>) -> Option<String> {
    let trimmed = value.as_ref().trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn extract_request_id_from_url(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "plankton" {
        return None;
    }

    for (key, value) in url.query_pairs() {
        if key == "request_id" {
            if let Some(request_id) = normalize_request_id(value.as_ref()) {
                return Some(request_id);
            }
        }
    }

    if let Some(request_id) = url.path_segments().and_then(|segments| {
        segments
            .filter(|segment| !segment.is_empty())
            .next_back()
            .and_then(normalize_request_id)
    }) {
        return Some(request_id);
    }

    url.host_str().and_then(|host| match host {
        "handoff" | "request" | "review" => None,
        _ => normalize_request_id(host),
    })
}

fn extract_handoff_request_id(argv: &[String]) -> Option<String> {
    let mut index = 0;
    while index < argv.len() {
        let current = &argv[index];
        if matches!(current.as_str(), "--handoff-request-id" | "--request-id") {
            if let Some(request_id) = argv.get(index + 1).and_then(normalize_request_id) {
                return Some(request_id);
            }
        }

        if let Some(request_id) = extract_request_id_from_url(current) {
            return Some(request_id);
        }

        index += 1;
    }

    None
}

async fn run_import_browse_task<T, F>(task_fn: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    task::spawn_blocking(task_fn)
        .await
        .map_err(|error| format!("import browse task failed: {error}"))?
        .map_err(|error| error.to_string())
}

fn store_pending_handoff_request<R: Runtime>(app: &AppHandle<R>, request_id: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut pending) = state.pending_handoff_request_id.lock() {
            *pending = Some(request_id.to_string());
        }
    }
}

fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn dispatch_handoff_request<R: Runtime>(app: &AppHandle<R>, request_id: String) {
    store_pending_handoff_request(app, &request_id);
    focus_main_window(app);

    let _ = app.emit_to("main", HANDOFF_EVENT, DesktopHandoff { request_id });
}

fn handle_deep_link_payload<R: Runtime>(app: &AppHandle<R>, payload: &str) {
    if let Ok(urls) = serde_json::from_str::<Vec<String>>(payload) {
        if let Some(request_id) = urls
            .into_iter()
            .find_map(|url| extract_request_id_from_url(&url))
        {
            dispatch_handoff_request(app, request_id);
        }
    }
}

#[tauri::command]
async fn dashboard(state: State<'_, AppState>) -> Result<DashboardData, String> {
    let recent_audit_limit = {
        let settings = lock_settings(&state)?;
        settings.recent_audit_limit
    };

    let mut data = state
        .store
        .dashboard(recent_audit_limit)
        .await
        .map_err(|error| error.to_string())?;

    for request in &mut data.pending_requests {
        preview_call_chain_for_desktop(&mut request.context.call_chain);
    }

    Ok(data)
}

#[tauri::command]
async fn desktop_preferences(state: State<'_, AppState>) -> Result<DesktopPreferences, String> {
    let settings = lock_settings(&state)?;
    Ok(DesktopPreferences {
        default_policy_mode: settings.default_policy_mode,
    })
}

#[tauri::command]
async fn desktop_settings(state: State<'_, AppState>) -> Result<UserSettings, String> {
    current_user_settings(&state)
}

#[tauri::command]
async fn set_default_policy_mode(
    policy_mode: PolicyMode,
    state: State<'_, AppState>,
) -> Result<DesktopPreferences, String> {
    save_user_default_policy_mode(policy_mode).map_err(|error| error.to_string())?;
    let settings = reload_runtime_settings(&state)?;

    Ok(DesktopPreferences {
        default_policy_mode: settings.default_policy_mode,
    })
}

#[tauri::command]
async fn save_desktop_settings(
    settings: UserSettings,
    state: State<'_, AppState>,
) -> Result<UserSettings, String> {
    save_user_settings(&settings).map_err(|error| error.to_string())?;
    reload_runtime_settings(&state)
}

#[tauri::command]
async fn import_secret_source(spec: SecretImportSpec) -> Result<ImportedSecretReceipt, String> {
    import_secret_reference(spec).map_err(|error| error.to_string())
}

#[tauri::command]
async fn import_secret_sources(
    spec: SecretImportBatchSpec,
) -> Result<ImportedSecretBatchReceipt, String> {
    import_secret_references(spec).map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_imported_secret_sources() -> Result<ImportedSecretCatalog, String> {
    list_imported_secret_references().map_err(|error| error.to_string())
}

#[tauri::command]
async fn update_imported_secret_source(
    update: ImportedSecretReferenceUpdate,
) -> Result<ImportedSecretReceipt, String> {
    update_imported_secret_reference(update).map_err(|error| error.to_string())
}

#[tauri::command]
async fn delete_imported_secret_source(resource: String) -> Result<bool, String> {
    delete_imported_secret_reference(resource.as_str()).map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_onepassword_accounts_command() -> Result<Vec<ImportPickerOption>, String> {
    run_import_browse_task(list_onepassword_accounts).await
}

#[tauri::command]
async fn list_onepassword_vaults_command(
    account_id: String,
) -> Result<Vec<ImportPickerOption>, String> {
    run_import_browse_task(move || list_onepassword_vaults(account_id.as_str())).await
}

#[tauri::command]
async fn list_onepassword_items_command(
    account_id: String,
    vault_id: String,
) -> Result<Vec<ImportPickerOption>, String> {
    run_import_browse_task(move || list_onepassword_items(account_id.as_str(), vault_id.as_str()))
        .await
}

#[tauri::command]
async fn list_onepassword_fields_command(
    account_id: String,
    vault_id: String,
    item_id: String,
) -> Result<Vec<ImportFieldOption>, String> {
    run_import_browse_task(move || {
        list_onepassword_fields(account_id.as_str(), vault_id.as_str(), item_id.as_str())
    })
    .await
}

#[tauri::command]
fn list_bitwarden_accounts_command() -> Result<Vec<ImportPickerOption>, String> {
    list_bitwarden_accounts().map_err(|error| error.to_string())
}

#[tauri::command]
fn list_bitwarden_containers_command() -> Result<Vec<BitwardenContainerOption>, String> {
    list_bitwarden_containers().map_err(|error| error.to_string())
}

#[tauri::command]
fn list_bitwarden_items_command(
    container_kind: Option<String>,
    container_id: Option<String>,
    organization_id: Option<String>,
) -> Result<Vec<ImportPickerOption>, String> {
    list_bitwarden_items(
        container_kind.as_deref(),
        container_id.as_deref(),
        organization_id.as_deref(),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_bitwarden_fields_command(item_id: String) -> Result<Vec<ImportFieldOption>, String> {
    list_bitwarden_fields(item_id.as_str()).map_err(|error| error.to_string())
}

#[tauri::command]
fn pick_dotenv_file_command() -> Result<Option<String>, String> {
    pick_dotenv_file().map_err(|error| error.to_string())
}

#[tauri::command]
fn inspect_dotenv_file_command(file_path: String) -> Result<DotenvInspection, String> {
    inspect_dotenv_file(file_path.as_str()).map_err(|error| error.to_string())
}

#[tauri::command]
async fn approve_request(
    request_id: String,
    note: Option<String>,
    state: State<'_, AppState>,
) -> Result<AccessRequest, String> {
    state
        .store
        .record_decision(&request_id, Decision::Allow, "desktop-reviewer", note)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn reject_request(
    request_id: String,
    note: Option<String>,
    state: State<'_, AppState>,
) -> Result<AccessRequest, String> {
    state
        .store
        .record_decision(&request_id, Decision::Deny, "desktop-reviewer", note)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn consume_handoff_request(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let mut pending = lock_pending_handoff_request(&state)?;
    Ok(pending.take())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("plankton-desktop failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let settings = load_settings().context("failed to load settings")?;
    let store = tauri::async_runtime::block_on(SqliteStore::new(&settings))
        .context("failed to initialize SQLite store")?;
    let initial_handoff_request_id =
        extract_handoff_request_id(&std::env::args().collect::<Vec<_>>());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(request_id) = extract_handoff_request_id(&argv) {
                dispatch_handoff_request(app, request_id);
            } else {
                focus_main_window(app);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .manage(AppState {
            settings: Mutex::new(settings),
            store,
            pending_handoff_request_id: Mutex::new(initial_handoff_request_id),
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            app.listen(DEEP_LINK_EVENT, move |event| {
                handle_deep_link_payload(&app_handle, event.payload());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dashboard,
            desktop_preferences,
            desktop_settings,
            set_default_policy_mode,
            save_desktop_settings,
            import_secret_source,
            import_secret_sources,
            list_imported_secret_sources,
            update_imported_secret_source,
            delete_imported_secret_source,
            list_onepassword_accounts_command,
            list_onepassword_vaults_command,
            list_onepassword_items_command,
            list_onepassword_fields_command,
            list_bitwarden_accounts_command,
            list_bitwarden_containers_command,
            list_bitwarden_items_command,
            list_bitwarden_fields_command,
            pick_dotenv_file_command,
            inspect_dotenv_file_command,
            approve_request,
            reject_request,
            consume_handoff_request
        ])
        .run(tauri::generate_context!())
        .context("failed to run Tauri application")?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{extract_handoff_request_id, extract_request_id_from_url};

    #[test]
    fn extracts_request_id_from_query_string() {
        assert_eq!(
            extract_request_id_from_url("plankton://review?request_id=req-123"),
            Some("req-123".to_string())
        );
    }

    #[test]
    fn extracts_request_id_from_path_segment() {
        assert_eq!(
            extract_request_id_from_url("plankton://request/req-456"),
            Some("req-456".to_string())
        );
    }

    #[test]
    fn extracts_request_id_from_cli_flag() {
        let argv = vec![
            "Plankton".to_string(),
            "--handoff-request-id".to_string(),
            "req-789".to_string(),
        ];

        assert_eq!(
            extract_handoff_request_id(&argv),
            Some("req-789".to_string())
        );
    }

    #[test]
    fn ignores_non_plankton_urls() {
        assert_eq!(extract_request_id_from_url("https://example.com"), None);
    }
}
