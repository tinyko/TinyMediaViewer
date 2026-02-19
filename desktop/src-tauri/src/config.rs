use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const APP_CONFIG_DIR_NAME: &str = "TinyMediaViewer";
const SETTINGS_FILENAME: &str = "settings.json";
const DEFAULT_HOME_DIR: &str = "/Users/tiny/X";
const DEFAULT_VIEWER_PORT: u16 = 4300;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub home_dir: String,
    pub preferred_viewer_port: u16,
    pub launch_at_login: bool,
    pub start_hidden: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            home_dir: DEFAULT_HOME_DIR.to_string(),
            preferred_viewer_port: DEFAULT_VIEWER_PORT,
            launch_at_login: true,
            start_hidden: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeStatus {
    Starting,
    Running,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeState {
    pub status: RuntimeStatus,
    pub viewer_port: u16,
    pub api_port: u16,
    pub viewer_url: String,
    pub viewer_local_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl RuntimeState {
    pub fn stopped() -> Self {
        Self {
            status: RuntimeStatus::Stopped,
            viewer_port: 0,
            api_port: 0,
            viewer_url: String::new(),
            viewer_local_url: String::new(),
            last_error: None,
        }
    }

    pub fn starting() -> Self {
        Self {
            status: RuntimeStatus::Starting,
            viewer_port: 0,
            api_port: 0,
            viewer_url: String::new(),
            viewer_local_url: String::new(),
            last_error: None,
        }
    }

    pub fn running(viewer_port: u16, api_port: u16, lan_ip: &str) -> Self {
        Self {
            status: RuntimeStatus::Running,
            viewer_port,
            api_port,
            viewer_url: format!("http://{lan_ip}:{viewer_port}"),
            viewer_local_url: format!("http://127.0.0.1:{viewer_port}"),
            last_error: None,
        }
    }

    pub fn error(message: String) -> Self {
        Self {
            status: RuntimeStatus::Error,
            viewer_port: 0,
            api_port: 0,
            viewer_url: String::new(),
            viewer_local_url: String::new(),
            last_error: Some(message),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatePayload {
    pub settings: Settings,
    pub runtime: RuntimeState,
}

pub fn settings_path() -> Result<PathBuf, String> {
    let home_dir = dirs::home_dir().ok_or("Unable to resolve home directory")?;
    Ok(home_dir
        .join("Library")
        .join("Application Support")
        .join(APP_CONFIG_DIR_NAME)
        .join(SETTINGS_FILENAME))
}

pub fn load_settings(path: &Path) -> Result<Settings, String> {
    if path.exists() {
        let content = fs::read_to_string(path)
            .map_err(|error| format!("Failed to read settings file: {error}"))?;
        let settings: Settings = serde_json::from_str(&content)
            .map_err(|error| format!("Failed to parse settings file: {error}"))?;
        return Ok(settings);
    }

    let settings = Settings::default();
    save_settings(path, &settings)?;
    Ok(settings)
}

pub fn save_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create settings directory: {error}"))?;
    }

    let content = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Failed to serialize settings: {error}"))?;
    fs::write(path, content).map_err(|error| format!("Failed to write settings file: {error}"))
}
