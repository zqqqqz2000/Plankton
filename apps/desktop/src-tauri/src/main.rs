use anyhow::{Context, Result};
use plankton_core::{load_settings, AccessRequest, DashboardData, Decision, PlanktonSettings};
use plankton_store::SqliteStore;
use tauri::State;

struct AppState {
    settings: PlanktonSettings,
    store: SqliteStore,
}

#[tauri::command]
async fn dashboard(state: State<'_, AppState>) -> Result<DashboardData, String> {
    state
        .store
        .dashboard(state.settings.recent_audit_limit)
        .await
        .map_err(|error| error.to_string())
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

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .manage(AppState { settings, store })
        .invoke_handler(tauri::generate_handler![
            dashboard,
            approve_request,
            reject_request
        ])
        .run(tauri::generate_context!())
        .context("failed to run Tauri application")?;

    Ok(())
}
