use std::sync::Mutex;

use anyhow::{Context, Result};
use plankton_core::{
    load_settings, save_user_default_policy_mode, AccessRequest, DashboardData, Decision,
    PlanktonSettings, PolicyMode,
};
use serde::Serialize;
use plankton_store::SqliteStore;
use tauri::State;

struct AppState {
    settings: Mutex<PlanktonSettings>,
    store: SqliteStore,
}

#[derive(Debug, Clone, Serialize)]
struct DesktopPreferences {
    default_policy_mode: PolicyMode,
}

fn lock_settings(state: &State<'_, AppState>) -> Result<std::sync::MutexGuard<'_, PlanktonSettings>, String> {
    state
        .settings
        .lock()
        .map_err(|_| "failed to lock desktop settings".to_string())
}

#[tauri::command]
async fn dashboard(state: State<'_, AppState>) -> Result<DashboardData, String> {
    let recent_audit_limit = {
        let settings = lock_settings(&state)?;
        settings.recent_audit_limit
    };

    state
        .store
        .dashboard(recent_audit_limit)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_preferences(state: State<'_, AppState>) -> Result<DesktopPreferences, String> {
    let settings = lock_settings(&state)?;
    Ok(DesktopPreferences {
        default_policy_mode: settings.default_policy_mode,
    })
}

#[tauri::command]
async fn set_default_policy_mode(
    policy_mode: PolicyMode,
    state: State<'_, AppState>,
) -> Result<DesktopPreferences, String> {
    save_user_default_policy_mode(policy_mode).map_err(|error| error.to_string())?;

    let mut settings = lock_settings(&state)?;
    settings.default_policy_mode = policy_mode;

    Ok(DesktopPreferences {
        default_policy_mode: settings.default_policy_mode,
    })
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
        .manage(AppState {
            settings: Mutex::new(settings),
            store,
        })
        .invoke_handler(tauri::generate_handler![
            dashboard,
            desktop_preferences,
            set_default_policy_mode,
            approve_request,
            reject_request
        ])
        .run(tauri::generate_context!())
        .context("failed to run Tauri application")?;

    Ok(())
}
