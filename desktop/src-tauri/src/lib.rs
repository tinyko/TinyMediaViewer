mod commands;
mod config;
mod diagnostics;
mod service_manager;
mod viewer_gateway;

use crate::{
    config::{AppStatePayload, RuntimeState, Settings},
    diagnostics::DiagnosticsStore,
    service_manager::ServiceManager,
};
use std::{path::PathBuf, sync::Arc};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::Color,
    ActivationPolicy, AppHandle, Emitter, Manager, PhysicalPosition, Position, Rect, Size,
};
use tauri_plugin_autostart::ManagerExt;
use tokio::sync::Mutex;

const MENU_OPEN_VIEWER: &str = "open_viewer";
const MENU_OPEN_SETTINGS: &str = "open_settings";
const MENU_RESTART_SERVICE: &str = "restart_service";
const MENU_QUIT: &str = "quit";
const POPOVER_MARGIN_TOP: f64 = 8.0;

pub struct AppRuntime {
    pub settings_path: PathBuf,
    pub diagnostics: Arc<DiagnosticsStore>,
    pub inner: Mutex<RuntimeInner>,
}

pub struct RuntimeInner {
    pub settings: Settings,
    pub runtime: RuntimeState,
    pub service_manager: ServiceManager,
}

impl RuntimeInner {
    fn to_payload(&self) -> AppStatePayload {
        AppStatePayload {
            settings: self.settings.clone(),
            runtime: self.runtime.clone(),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_settings_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(ActivationPolicy::Accessory);

            let settings_path = config::settings_path()?;
            let settings = config::load_settings(&settings_path)?;
            let start_hidden = settings.start_hidden;
            let diagnostics_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("Failed to resolve app data dir: {error}"))?
                .join("diagnostics");
            let diagnostics = Arc::new(DiagnosticsStore::new(diagnostics_dir)?);

            app.manage(AppRuntime {
                settings_path,
                diagnostics: diagnostics.clone(),
                inner: Mutex::new(RuntimeInner {
                    settings: settings.clone(),
                    runtime: RuntimeState::stopped(),
                    service_manager: ServiceManager::new(diagnostics),
                }),
            });

            apply_autostart(app.handle(), settings.launch_at_login)?;
            setup_main_window_behavior(app.handle())?;
            apply_main_window_appearance(app.handle())?;
            setup_tray(app.handle())?;

            if !start_hidden {
                show_settings_window(app.handle());
            }

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = restart_services_internal(&app_handle).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::save_settings,
            commands::pick_home_directory,
            commands::restart_services,
            commands::open_viewer,
            commands::get_diagnostics_state,
            commands::open_diagnostics_dir,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            tauri::async_runtime::block_on(stop_services_internal(app_handle));
        }
    });
}

pub fn apply_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        app.autolaunch()
            .enable()
            .map_err(|error| format!("Failed to enable launch at login: {error}"))
    } else {
        app.autolaunch()
            .disable()
            .map_err(|error| format!("Failed to disable launch at login: {error}"))
    }
}

pub async fn restart_services_internal(app: &AppHandle) -> Result<AppStatePayload, String> {
    let state = app.state::<AppRuntime>();

    let payload = {
        let mut inner = state.inner.lock().await;
        inner.runtime = RuntimeState::starting();
        let settings = inner.settings.clone();

        inner.runtime = match inner.service_manager.restart(app, &settings).await {
            Ok(runtime) => runtime,
            Err(error) => RuntimeState::error(error),
        };

        inner.to_payload()
    };

    let _ = app.emit("app-state-updated", payload.clone());
    Ok(payload)
}

pub async fn stop_services_internal(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppRuntime>() {
        let mut inner = state.inner.lock().await;
        inner.service_manager.stop().await;
        inner.runtime = RuntimeState::stopped();
        let payload = inner.to_payload();
        let _ = app.emit("app-state-updated", payload);
    }
}

fn setup_main_window_behavior(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    let window_for_handler = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window_for_handler.hide();
        }
        tauri::WindowEvent::Focused(false) => {
            let _ = window_for_handler.hide();
        }
        _ => {}
    });

    Ok(())
}

fn apply_main_window_appearance(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    window
        .set_background_color(Some(Color(0, 0, 0, 0)))
        .map_err(|error| format!("Failed setting transparent window background: {error}"))?;
    window
        .set_shadow(false)
        .map_err(|error| format!("Failed disabling rectangular window shadow/border: {error}"))?;

    Ok(())
}

fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let open_viewer_item = MenuItemBuilder::with_id(MENU_OPEN_VIEWER, "Open Viewer")
        .build(app)
        .map_err(|error| format!("Failed building menu item Open Viewer: {error}"))?;
    let open_settings_item = MenuItemBuilder::with_id(MENU_OPEN_SETTINGS, "Open Settings")
        .build(app)
        .map_err(|error| format!("Failed building menu item Open Settings: {error}"))?;
    let restart_item = MenuItemBuilder::with_id(MENU_RESTART_SERVICE, "Restart Service")
        .build(app)
        .map_err(|error| format!("Failed building menu item Restart Service: {error}"))?;
    let quit_item = MenuItemBuilder::with_id(MENU_QUIT, "Quit")
        .build(app)
        .map_err(|error| format!("Failed building menu item Quit: {error}"))?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &open_viewer_item,
            &open_settings_item,
            &restart_item,
            &quit_item,
        ])
        .build()
        .map_err(|error| format!("Failed building tray menu: {error}"))?;

    let mut tray_builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("TinyMediaViewer")
        .show_menu_on_left_click(false);

    // Explicitly set a menu bar icon on macOS to avoid an invisible status item.
    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon).icon_as_template(true);
    } else {
        // Fallback text ensures the status item is still visible if icon loading fails.
        tray_builder = tray_builder.title("TMV");
    }

    tray_builder
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_settings_window(tray.app_handle(), Some(rect));
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN_VIEWER => {
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<AppRuntime>();
                    let viewer_url = {
                        let inner = state.inner.lock().await;
                        inner.runtime.viewer_url.clone()
                    };

                    if !viewer_url.is_empty() {
                        let _ = webbrowser::open(&viewer_url);
                    }
                });
            }
            MENU_OPEN_SETTINGS => {
                show_settings_window(app);
            }
            MENU_RESTART_SERVICE => {
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = restart_services_internal(&app_handle).await;
                });
            }
            MENU_QUIT => {
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    stop_services_internal(&app_handle).await;
                    app_handle.exit(0);
                });
            }
            _ => {}
        })
        .build(app)
        .map_err(|error| format!("Failed building tray icon: {error}"))?;

    Ok(())
}

fn show_settings_window(app: &AppHandle) {
    show_settings_window_with_anchor(app, None);
}

fn toggle_settings_window(app: &AppHandle, anchor_rect: Option<Rect>) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            Ok(false) | Err(_) => {
                show_settings_window_with_anchor(app, anchor_rect);
            }
        }
    }
}

fn show_settings_window_with_anchor(app: &AppHandle, anchor_rect: Option<Rect>) {
    if let Some(window) = app.get_webview_window("main") {
        if let Some(rect) = anchor_rect {
            let size = window.outer_size().ok();
            let width = size.map(|it| it.width as f64).unwrap_or(420.0);

            let (rect_x, rect_y) = match rect.position {
                Position::Physical(position) => (position.x as f64, position.y as f64),
                Position::Logical(position) => (position.x, position.y),
            };
            let (rect_width, rect_height) = match rect.size {
                Size::Physical(value) => (value.width as f64, value.height as f64),
                Size::Logical(value) => (value.width, value.height),
            };

            let x = rect_x + (rect_width - width) / 2.0;
            let y = rect_y + rect_height + POPOVER_MARGIN_TOP;

            let _ = window.set_position(Position::Physical(PhysicalPosition::new(
                x.round() as i32,
                y.round() as i32,
            )));
        }

        let _ = window.show();
        let _ = window.set_focus();
    }
}
