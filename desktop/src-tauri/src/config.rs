use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const APP_CONFIG_DIR_NAME: &str = "TinyMediaViewer";
const SETTINGS_FILENAME: &str = "settings.json";
const SETTINGS_DB_FILENAME: &str = "settings.sqlite3";
const DEFAULT_HOME_DIR: &str = "/Users/tiny/X";
const DEFAULT_VIEWER_PORT: u16 = 4300;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ViewerAccessMode {
    Local,
    Lan,
}

impl Default for ViewerAccessMode {
    fn default() -> Self {
        Self::Local
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub home_dir: String,
    pub preferred_viewer_port: u16,
    pub launch_at_login: bool,
    pub start_hidden: bool,
    pub viewer_access_mode: ViewerAccessMode,
    pub lan_password: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            home_dir: DEFAULT_HOME_DIR.to_string(),
            preferred_viewer_port: DEFAULT_VIEWER_PORT,
            launch_at_login: true,
            start_hidden: true,
            viewer_access_mode: ViewerAccessMode::Local,
            lan_password: String::new(),
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
    pub backend_implementation: String,
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
            backend_implementation: String::new(),
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
            backend_implementation: String::new(),
            viewer_port: 0,
            api_port: 0,
            viewer_url: String::new(),
            viewer_local_url: String::new(),
            last_error: None,
        }
    }

    pub fn running(
        backend_implementation: impl Into<String>,
        viewer_port: u16,
        api_port: u16,
        viewer_url: Option<String>,
    ) -> Self {
        Self {
            status: RuntimeStatus::Running,
            backend_implementation: backend_implementation.into(),
            viewer_port,
            api_port,
            viewer_url: viewer_url.unwrap_or_default(),
            viewer_local_url: format!("http://127.0.0.1:{viewer_port}"),
            last_error: None,
        }
    }

    pub fn error(message: String) -> Self {
        Self {
            status: RuntimeStatus::Error,
            backend_implementation: String::new(),
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

fn settings_db_path_from_settings_path(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or("Unable to resolve settings directory from settings path")?;
    Ok(parent.join(SETTINGS_DB_FILENAME))
}

pub fn load_settings(path: &Path) -> Result<Settings, String> {
    let mut settings = if path.exists() {
        let content = fs::read_to_string(path)
            .map_err(|error| format!("Failed to read settings file: {error}"))?;
        serde_json::from_str(&content)
            .map_err(|error| format!("Failed to parse settings file: {error}"))?
    } else {
        let settings = Settings::default();
        save_settings(path, &settings)?;
        settings
    };

    let db_path = settings_db_path_from_settings_path(path)?;
    if let Some(access_settings) = load_access_settings(&db_path)? {
        settings.viewer_access_mode = access_settings.viewer_access_mode;
        settings.lan_password = access_settings.lan_password;
    } else {
        save_access_settings(
            &db_path,
            &settings.viewer_access_mode,
            &settings.lan_password,
        )?;
    }

    Ok(settings)
}

pub fn save_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create settings directory: {error}"))?;
    }

    let db_path = settings_db_path_from_settings_path(path)?;
    save_access_settings(
        &db_path,
        &settings.viewer_access_mode,
        &settings.lan_password,
    )?;

    let mut json_settings = settings.clone();
    json_settings.viewer_access_mode = ViewerAccessMode::Local;
    json_settings.lan_password.clear();

    let content = serde_json::to_string_pretty(&json_settings)
        .map_err(|error| format!("Failed to serialize settings: {error}"))?;
    fs::write(path, content).map_err(|error| format!("Failed to write settings file: {error}"))
}

fn load_access_settings(path: &Path) -> Result<Option<AccessSettings>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let conn = open_settings_db(path)?;
    conn.query_row(
        "SELECT viewer_access_mode, lan_password
         FROM access_settings
         WHERE id = 1",
        [],
        |row| {
            let mode = row.get::<_, String>(0)?;
            let lan_password = row.get::<_, String>(1)?;
            Ok(AccessSettings {
                viewer_access_mode: parse_viewer_access_mode(&mode),
                lan_password,
            })
        },
    )
    .optional()
    .map_err(|error| format!("Failed to load access settings from sqlite: {error}"))
}

fn save_access_settings(
    path: &Path,
    viewer_access_mode: &ViewerAccessMode,
    lan_password: &str,
) -> Result<(), String> {
    let conn = open_settings_db(path)?;
    conn.execute(
        "INSERT INTO access_settings (id, viewer_access_mode, lan_password, updated_at)
         VALUES (1, ?1, ?2, unixepoch('now') * 1000)
         ON CONFLICT(id) DO UPDATE SET
           viewer_access_mode = excluded.viewer_access_mode,
           lan_password = excluded.lan_password,
           updated_at = excluded.updated_at",
        params![viewer_access_mode.as_str(), lan_password],
    )
    .map_err(|error| format!("Failed to save access settings into sqlite: {error}"))?;
    Ok(())
}

fn open_settings_db(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create settings sqlite directory: {error}"))?;
    }

    let conn = Connection::open(path)
        .map_err(|error| format!("Failed to open settings sqlite {}: {error}", path.display()))?;
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS access_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          viewer_access_mode TEXT NOT NULL,
          lan_password TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        ",
    )
    .map_err(|error| format!("Failed to initialize settings sqlite schema: {error}"))?;
    Ok(conn)
}

fn parse_viewer_access_mode(raw: &str) -> ViewerAccessMode {
    match raw.trim().to_ascii_lowercase().as_str() {
        "lan" => ViewerAccessMode::Lan,
        _ => ViewerAccessMode::Local,
    }
}

#[derive(Debug)]
struct AccessSettings {
    viewer_access_mode: ViewerAccessMode,
    lan_password: String,
}

impl ViewerAccessMode {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Lan => "lan",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        load_settings, save_settings, settings_db_path_from_settings_path, Settings,
        ViewerAccessMode,
    };
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn settings_default_to_local_access() {
        let settings = Settings::default();
        assert_eq!(settings.viewer_access_mode, ViewerAccessMode::Local);
        assert!(settings.lan_password.is_empty());
    }

    #[test]
    fn loading_legacy_settings_fills_new_fields_with_defaults() {
        let legacy = r#"{
          "homeDir": "/tmp/media",
          "preferredViewerPort": 4310,
          "launchAtLogin": false,
          "startHidden": false
        }"#;

        let settings: Settings = serde_json::from_str(legacy).expect("legacy settings should load");
        assert_eq!(settings.home_dir, "/tmp/media");
        assert_eq!(settings.preferred_viewer_port, 4310);
        assert_eq!(settings.viewer_access_mode, ViewerAccessMode::Local);
        assert!(settings.lan_password.is_empty());
    }

    #[test]
    fn sqlite_roundtrip_persists_access_mode_and_password() {
        let temp = tempdir().expect("tempdir");
        let settings_path = temp.path().join("settings.json");
        let settings = Settings {
            home_dir: "/tmp/media".to_string(),
            preferred_viewer_port: 4310,
            launch_at_login: false,
            start_hidden: false,
            viewer_access_mode: ViewerAccessMode::Lan,
            lan_password: "super-secret".to_string(),
        };

        save_settings(&settings_path, &settings).expect("save settings");
        let loaded = load_settings(&settings_path).expect("load settings");
        let json = fs::read_to_string(&settings_path).expect("read json");
        let db_path = settings_db_path_from_settings_path(&settings_path).expect("db path");

        assert_eq!(loaded.viewer_access_mode, ViewerAccessMode::Lan);
        assert_eq!(loaded.lan_password, "super-secret");
        assert!(json.contains("\"viewerAccessMode\": \"local\""));
        assert!(json.contains("\"lanPassword\": \"\""));
        assert!(db_path.exists());
    }

    #[test]
    fn loading_legacy_json_migrates_access_settings_to_sqlite() {
        let temp = tempdir().expect("tempdir");
        let settings_path = temp.path().join("settings.json");
        fs::write(
            &settings_path,
            r#"{
              "homeDir": "/tmp/media",
              "preferredViewerPort": 4310,
              "launchAtLogin": false,
              "startHidden": false,
              "viewerAccessMode": "lan",
              "lanPassword": "legacy-secret"
            }"#,
        )
        .expect("write legacy settings");

        let loaded = load_settings(&settings_path).expect("load settings");
        let reloaded = load_settings(&settings_path).expect("reload settings");

        assert_eq!(loaded.viewer_access_mode, ViewerAccessMode::Lan);
        assert_eq!(loaded.lan_password, "legacy-secret");
        assert_eq!(reloaded.viewer_access_mode, ViewerAccessMode::Lan);
        assert_eq!(reloaded.lan_password, "legacy-secret");
    }
}
