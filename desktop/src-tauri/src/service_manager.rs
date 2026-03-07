use crate::{
    config::{RuntimeState, Settings, ViewerAccessMode},
    diagnostics::DiagnosticsStore,
};
use std::{
    fs,
    fs::OpenOptions,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, UdpSocket},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tauri::{path::BaseDirectory, AppHandle, Manager};
use tokio::process::Child;

const RUST_BACKEND_NAME: &str = "tmv-backend-app-aarch64-apple-darwin";
const HEALTH_CHECK_RETRIES: usize = 40;

pub struct ServiceManager {
    server_child: Option<Child>,
    diagnostics: Arc<DiagnosticsStore>,
}

impl ServiceManager {
    pub fn new(diagnostics: Arc<DiagnosticsStore>) -> Self {
        Self {
            server_child: None,
            diagnostics,
        }
    }

    pub async fn restart(
        &mut self,
        app: &AppHandle,
        settings: &Settings,
    ) -> Result<RuntimeState, String> {
        self.stop().await;
        self.restart_rust_backend(app, settings).await
    }

    pub async fn stop(&mut self) {
        if let Some(mut child) = self.server_child.take() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
    }

    async fn restart_rust_backend(
        &mut self,
        app: &AppHandle,
        settings: &Settings,
    ) -> Result<RuntimeState, String> {
        let viewer_port = find_available_port(settings.preferred_viewer_port)?;
        let backend_path = resolve_rust_backend_path(app)?;
        ensure_executable(&backend_path)?;
        let viewer_dir = resolve_viewer_assets_path(app)?;
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Failed to resolve app data dir: {error}"))?;
        let index_dir = app_data_dir.join("backend-index");
        let thumbnail_dir = app_data_dir.join("thumbnails");
        let diagnostics_dir = self.diagnostics.diagnostics_dir();
        let stdout_log = open_sidecar_log(&diagnostics_dir, "rust-backend.stdout.log")?;
        let stderr_log = open_sidecar_log(&diagnostics_dir, "rust-backend.stderr.log")?;

        let bind_host = match settings.viewer_access_mode {
            ViewerAccessMode::Local => "127.0.0.1",
            ViewerAccessMode::Lan => "0.0.0.0",
        };
        let access_mode = match settings.viewer_access_mode {
            ViewerAccessMode::Local => "local",
            ViewerAccessMode::Lan => "lan",
        };

        let child = tokio::process::Command::new(&backend_path)
            .env("TMV_RUNTIME_MODE", "desktop")
            .env("TMV_MEDIA_ROOT", &settings.home_dir)
            .env("TMV_PORT", viewer_port.to_string())
            .env("TMV_BIND_HOST", bind_host)
            .env("TMV_ACCESS_MODE", access_mode)
            .env("TMV_LAN_PASSWORD", &settings.lan_password)
            .env("TMV_VIEWER_DIR", &viewer_dir)
            .env("TMV_INDEX_DIR", &index_dir)
            .env("TMV_THUMBNAIL_DIR", &thumbnail_dir)
            .env("TMV_DIAGNOSTICS_DIR", diagnostics_dir)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout_log))
            .stderr(Stdio::from(stderr_log))
            .spawn()
            .map_err(|error| {
                format!(
                    "Failed to spawn Rust backend {}: {error}",
                    backend_path.display()
                )
            })?;

        self.server_child = Some(child);
        self.wait_for_server_health(&format!("http://127.0.0.1:{viewer_port}/health"))
            .await?;

        let viewer_url = match settings.viewer_access_mode {
            ViewerAccessMode::Lan => {
                let lan_ip = detect_lan_ipv4();
                Some(format!("http://{lan_ip}:{viewer_port}"))
            }
            ViewerAccessMode::Local => None,
        };

        Ok(RuntimeState::running(
            "rust",
            viewer_port,
            viewer_port,
            viewer_url,
        ))
    }

    async fn wait_for_server_health(&mut self, url: &str) -> Result<(), String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(400))
            .build()
            .map_err(|error| format!("Failed to initialize health-check HTTP client: {error}"))?;

        for _ in 0..HEALTH_CHECK_RETRIES {
            if let Some(child) = self.server_child.as_mut() {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|error| format!("Failed checking backend status: {error}"))?
                {
                    return Err(format!("Backend exited unexpectedly: {status}"));
                }
            }

            if let Ok(response) = client.get(url).send().await {
                if response.status().is_success() {
                    return Ok(());
                }
            }

            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        Err("Timed out waiting for backend health check".to_string())
    }
}

fn find_available_port(preferred_port: u16) -> Result<u16, String> {
    for port in preferred_port..=u16::MAX {
        let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port);
        if TcpListener::bind(address).is_ok() {
            return Ok(port);
        }
    }

    Err("No available viewer port found".to_string())
}

fn detect_lan_ipv4() -> String {
    if let Some(ip) = detect_macos_primary_lan_ipv4() {
        return ip.to_string();
    }

    if let Some(ip) = detect_route_ipv4() {
        return ip.to_string();
    }

    Ipv4Addr::LOCALHOST.to_string()
}

#[cfg(target_os = "macos")]
fn detect_macos_primary_lan_ipv4() -> Option<Ipv4Addr> {
    for interface in ["en0", "en1"] {
        if let Some(ip) = read_ipv4_from_ipconfig(interface) {
            return Some(ip);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn detect_macos_primary_lan_ipv4() -> Option<Ipv4Addr> {
    None
}

#[cfg(target_os = "macos")]
fn read_ipv4_from_ipconfig(interface: &str) -> Option<Ipv4Addr> {
    let output = Command::new("/usr/sbin/ipconfig")
        .args(["getifaddr", interface])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8(output.stdout).ok()?;
    let parsed = text.trim().parse::<Ipv4Addr>().ok()?;
    if parsed.is_loopback() || parsed.is_unspecified() {
        return None;
    }
    Some(parsed)
}

#[cfg(not(target_os = "macos"))]
fn read_ipv4_from_ipconfig(_interface: &str) -> Option<Ipv4Addr> {
    None
}

fn detect_route_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let local_addr = socket.local_addr().ok()?;
    let ipv4 = match local_addr.ip() {
        IpAddr::V4(ip) => ip,
        _ => return None,
    };

    if ipv4.is_loopback() || ipv4.is_unspecified() {
        return None;
    }

    if ipv4.is_private() {
        return Some(ipv4);
    }

    None
}

fn resolve_rust_backend_path(app: &AppHandle) -> Result<PathBuf, String> {
    resolve_backend_path(
        app,
        RUST_BACKEND_NAME,
        &[
            "backend-rs/target/debug/tmv-backend-app",
            "backend-rs/target/release/tmv-backend-app",
        ],
    )
}

fn resolve_backend_path(
    app: &AppHandle,
    bundled_name: &str,
    source_candidates: &[&str],
) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Failed to resolve resource dir: {error}"))?;
    let bundled = resource_dir.join("binaries").join(bundled_name);

    if bundled.exists() {
        return copy_sidecar_to_runtime_bin(app, bundled_name, &bundled);
    }

    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .map_err(|error| format!("Failed to resolve repo root: {error}"))?;
    for candidate in source_candidates {
        let path = repo_root.join(candidate);
        if path.exists() {
            return Ok(path);
        }
    }

    Err(format!(
        "Backend binary not found. Expected bundled {} or one of {:?}",
        bundled.display(),
        source_candidates
    ))
}

fn copy_sidecar_to_runtime_bin(
    app: &AppHandle,
    binary_name: &str,
    source: &PathBuf,
) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?;
    let runtime_bin_dir = app_data_dir.join("bin");
    fs::create_dir_all(&runtime_bin_dir)
        .map_err(|error| format!("Failed to create runtime bin dir: {error}"))?;

    cleanup_old_runtime_sidecars(&runtime_bin_dir, binary_name, 8)?;

    let destination = runtime_bin_dir.join(format!("{binary_name}-{}", std::process::id()));
    let temp_destination = runtime_bin_dir.join(format!(
        "{binary_name}-{}.tmp-{}",
        std::process::id(),
        build_tmp_suffix()
    ));

    fs::copy(source, &temp_destination).map_err(|error| {
        format!(
            "Failed to copy backend from {} to {}: {error}",
            source.display(),
            temp_destination.display()
        )
    })?;

    let mut permissions = fs::metadata(&temp_destination)
        .map_err(|error| format!("Failed to read runtime backend metadata: {error}"))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&temp_destination, permissions)
        .map_err(|error| format!("Failed to set runtime backend executable bit: {error}"))?;

    ad_hoc_codesign(&temp_destination)?;

    fs::rename(&temp_destination, &destination).map_err(|error| {
        format!(
            "Failed to finalize runtime backend {} -> {}: {error}",
            temp_destination.display(),
            destination.display()
        )
    })?;

    Ok(destination)
}

fn resolve_viewer_assets_path(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resolve("resources/viewer", BaseDirectory::Resource)
        .map_err(|error| format!("Failed to resolve bundled viewer assets path: {error}"))?;

    if bundled.join("index.html").exists() {
        return Ok(bundled);
    }

    let from_source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("viewer");

    if from_source.join("index.html").exists() {
        return Ok(from_source);
    }

    Err("Viewer assets missing. Run `npm run prepare:bundle` inside desktop first.".to_string())
}

fn ensure_executable(path: &PathBuf) -> Result<(), String> {
    #[cfg(unix)]
    {
        let metadata = std::fs::metadata(path)
            .map_err(|error| format!("Failed to read backend metadata: {error}"))?;
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions)
            .map_err(|error| format!("Failed to set backend executable bit: {error}"))?;
    }

    Ok(())
}

fn build_tmp_suffix() -> u128 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn cleanup_old_runtime_sidecars(dir: &Path, prefix: &str, keep: usize) -> Result<(), String> {
    let mut sidecars = fs::read_dir(dir)
        .map_err(|error| format!("Failed to read runtime bin dir {}: {error}", dir.display()))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(prefix))
        .collect::<Vec<_>>();

    if sidecars.len() <= keep {
        return Ok(());
    }

    sidecars.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH)
    });

    let remove_count = sidecars.len().saturating_sub(keep);
    for entry in sidecars.into_iter().take(remove_count) {
        let _ = fs::remove_file(entry.path());
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn ad_hoc_codesign(path: &Path) -> Result<(), String> {
    let output = Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-", "--timestamp=none"])
        .arg(path)
        .output()
        .map_err(|error| format!("Failed to invoke codesign for {}: {error}", path.display()))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(format!(
        "Failed to ad-hoc sign runtime backend {}: status={} stderr={} stdout={}",
        path.display(),
        output.status,
        stderr,
        stdout
    ))
}

#[cfg(not(target_os = "macos"))]
fn ad_hoc_codesign(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn open_sidecar_log(dir: &Path, filename: &str) -> Result<std::fs::File, String> {
    fs::create_dir_all(dir).map_err(|error| {
        format!(
            "Failed to create diagnostics dir {}: {error}",
            dir.display()
        )
    })?;
    let path = dir.join(filename);
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("Failed to open backend log {}: {error}", path.display()))
}
