use crate::{
    apply_autostart,
    config::{self, AppStatePayload, RuntimeState, Settings, ViewerAccessMode},
    current_app_state,
    diagnostics::DiagnosticsState,
    emit_app_state_updated, set_runtime_state, set_starting_state, AppRuntime,
};
use serde::Deserialize;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    home_dir: String,
    preferred_viewer_port: u16,
    launch_at_login: bool,
    start_hidden: bool,
    viewer_access_mode: ViewerAccessMode,
    lan_password: String,
}

impl SettingsInput {
    fn into_settings(self) -> Settings {
        Settings {
            home_dir: self.home_dir,
            preferred_viewer_port: self.preferred_viewer_port,
            launch_at_login: self.launch_at_login,
            start_hidden: self.start_hidden,
            viewer_access_mode: self.viewer_access_mode,
            lan_password: self.lan_password,
        }
    }
}

#[tauri::command]
pub async fn get_app_state(state: State<'_, AppRuntime>) -> Result<AppStatePayload, String> {
    Ok(current_app_state(&state).await)
}

#[tauri::command]
pub async fn save_settings(
    input: SettingsInput,
    app: AppHandle,
    state: State<'_, AppRuntime>,
) -> Result<AppStatePayload, String> {
    validate_settings(&input)?;
    let settings = input.into_settings();

    let _operation = state.operation.lock().await;
    config::save_settings(&state.settings_path, &settings)?;
    apply_autostart(&app, settings.launch_at_login)?;

    let (active_settings, starting_payload) = set_starting_state(&state, Some(settings)).await;
    emit_app_state_updated(&app, &starting_payload);

    let next_runtime = {
        let mut service_manager = state.service_manager.lock().await;
        match service_manager.restart(&app, &active_settings).await {
            Ok(runtime_state) => runtime_state,
            Err(error) => RuntimeState::error(error),
        }
    };
    let payload = set_runtime_state(&state, next_runtime).await;
    emit_app_state_updated(&app, &payload);
    Ok(payload)
}

#[tauri::command]
pub async fn restart_services(
    app: AppHandle,
    state: State<'_, AppRuntime>,
) -> Result<AppStatePayload, String> {
    let _operation = state.operation.lock().await;
    let (settings, starting_payload) = set_starting_state(&state, None).await;
    emit_app_state_updated(&app, &starting_payload);

    let next_runtime = {
        let mut service_manager = state.service_manager.lock().await;
        match service_manager.restart(&app, &settings).await {
            Ok(runtime_state) => runtime_state,
            Err(error) => RuntimeState::error(error),
        }
    };
    let payload = set_runtime_state(&state, next_runtime).await;
    emit_app_state_updated(&app, &payload);
    Ok(payload)
}

#[tauri::command]
pub async fn pick_home_directory() -> Result<Option<String>, String> {
    let selected = tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .map_err(|error| format!("Failed to open directory picker: {error}"))?;

    Ok(selected.map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn open_viewer(app: AppHandle, state: State<'_, AppRuntime>) -> Result<(), String> {
    let viewer_url = state.state.lock().await.runtime.viewer_local_url.clone();

    if viewer_url.is_empty() {
        return Err("Viewer URL is empty. Start the service first.".to_string());
    }

    webbrowser::open(&viewer_url)
        .map_err(|error| format!("Failed to open viewer URL {viewer_url}: {error}"))?;

    let _ = app.emit("viewer-opened", viewer_url);
    Ok(())
}

#[tauri::command]
pub async fn get_diagnostics_state(
    state: State<'_, AppRuntime>,
) -> Result<DiagnosticsState, String> {
    Ok(state.diagnostics.state())
}

#[tauri::command]
pub async fn open_diagnostics_dir(state: State<'_, AppRuntime>) -> Result<(), String> {
    state.diagnostics.open_in_finder()
}

fn validate_settings(input: &SettingsInput) -> Result<(), String> {
    let trimmed = input.home_dir.trim();
    if trimmed.is_empty() {
        return Err("homeDir cannot be empty".to_string());
    }

    let path = Path::new(trimmed);
    if !path.exists() {
        return Err(format!("homeDir does not exist: {}", path.display()));
    }

    if !path.is_dir() {
        return Err(format!("homeDir is not a directory: {}", path.display()));
    }

    if input.preferred_viewer_port == 0 {
        return Err("preferredViewerPort must be in the range 1..65535".to_string());
    }

    if input.viewer_access_mode == ViewerAccessMode::Lan && input.lan_password.trim().len() < 8 {
        return Err("lanPassword must be at least 8 characters in LAN mode".to_string());
    }

    Ok(())
}
