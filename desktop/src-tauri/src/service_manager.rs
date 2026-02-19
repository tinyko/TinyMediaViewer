use crate::{
    config::{RuntimeState, Settings},
    diagnostics::DiagnosticsStore,
    viewer_gateway::{self, GatewayHandle},
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
    time::Duration,
    time::SystemTime,
    time::UNIX_EPOCH,
};
use tauri::{path::BaseDirectory, AppHandle, Manager};
use tokio::process::Child;

const SIDECAR_NAME: &str = "media-viewer-server-aarch64-apple-darwin";
const HEALTH_CHECK_RETRIES: usize = 40;

pub struct ServiceManager {
    server_child: Option<Child>,
    gateway: Option<GatewayHandle>,
    diagnostics: Arc<DiagnosticsStore>,
}

impl ServiceManager {
    pub fn new(diagnostics: Arc<DiagnosticsStore>) -> Self {
        Self {
            server_child: None,
            gateway: None,
            diagnostics,
        }
    }

    pub async fn restart(
        &mut self,
        app: &AppHandle,
        settings: &Settings,
    ) -> Result<RuntimeState, String> {
        self.stop().await;

        let api_port = reserve_ephemeral_port()?;
        let sidecar_path = resolve_sidecar_path(app)?;
        ensure_executable(&sidecar_path)?;
        let media_access_token = build_media_access_token(api_port);
        let diagnostics_dir = self.diagnostics.diagnostics_dir();
        let stdout_log = open_sidecar_log(&diagnostics_dir, "sidecar.stdout.log")?;
        let stderr_log = open_sidecar_log(&diagnostics_dir, "sidecar.stderr.log")?;

        let child = tokio::process::Command::new(&sidecar_path)
            .env("MEDIA_ROOT", &settings.home_dir)
            .env("PORT", api_port.to_string())
            .env("SERVER_HOST", "127.0.0.1")
            .env("TMV_PARENT_PID", std::process::id().to_string())
            .env("MEDIA_ACCESS_TOKEN", &media_access_token)
            .env("REQUIRE_LAN_TOKEN", "true")
            .env("TMV_DIAGNOSTICS_DIR", diagnostics_dir)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout_log))
            .stderr(Stdio::from(stderr_log))
            .spawn()
            .map_err(|error| {
                format!(
                    "Failed to spawn sidecar {}: {error}",
                    sidecar_path.display()
                )
            })?;

        self.server_child = Some(child);
        self.wait_for_server_health(api_port).await?;

        let viewer_port = find_available_port(settings.preferred_viewer_port)?;
        let viewer_dir = resolve_viewer_assets_path(app)?;
        let gateway = viewer_gateway::start_gateway(
            viewer_dir,
            viewer_port,
            api_port,
            media_access_token,
            self.diagnostics.clone(),
        )
        .await?;
        self.gateway = Some(gateway);
        let lan_ip = detect_lan_ipv4();

        Ok(RuntimeState::running(viewer_port, api_port, &lan_ip))
    }

    pub async fn stop(&mut self) {
        if let Some(gateway) = self.gateway.take() {
            gateway.stop().await;
        }

        if let Some(mut child) = self.server_child.take() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
    }

    async fn wait_for_server_health(&mut self, api_port: u16) -> Result<(), String> {
        let url = format!("http://127.0.0.1:{api_port}/health");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(400))
            .build()
            .map_err(|error| format!("Failed to initialize health-check HTTP client: {error}"))?;

        for _ in 0..HEALTH_CHECK_RETRIES {
            if let Some(child) = self.server_child.as_mut() {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|error| format!("Failed checking sidecar status: {error}"))?
                {
                    return Err(format!("Sidecar exited unexpectedly: {status}"));
                }
            }

            if let Ok(response) = client.get(&url).send().await {
                if response.status().is_success() {
                    return Ok(());
                }
            }

            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        Err("Timed out waiting for sidecar health check".to_string())
    }
}

fn reserve_ephemeral_port() -> Result<u16, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("Failed reserving API port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Failed reading reserved API port: {error}"))?
        .port();
    drop(listener);
    Ok(port)
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
    // Prioritize normal physical interfaces to avoid VPN/virtual adapter addresses.
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

    // Avoid showing VPN-like non-private addresses as LAN URL.
    None
}

fn resolve_sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Failed to resolve resource dir: {error}"))?;
    let bundled = resource_dir.join("binaries").join(SIDECAR_NAME);

    if bundled.exists() {
        return copy_sidecar_to_runtime_bin(app, &bundled);
    }

    let from_source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(SIDECAR_NAME);

    if from_source.exists() {
        return Ok(from_source);
    }

    Err(format!(
        "Sidecar binary not found. Expected {} or {}",
        bundled.display(),
        from_source.display()
    ))
}

fn copy_sidecar_to_runtime_bin(app: &AppHandle, source: &PathBuf) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?;
    let runtime_bin_dir = app_data_dir.join("bin");
    fs::create_dir_all(&runtime_bin_dir)
        .map_err(|error| format!("Failed to create runtime bin dir: {error}"))?;

    cleanup_old_runtime_sidecars(&runtime_bin_dir, 8)?;

    let destination = runtime_bin_dir.join(format!("{SIDECAR_NAME}-{}", std::process::id()));
    let temp_destination = runtime_bin_dir.join(format!(
        "{SIDECAR_NAME}-{}.tmp-{}",
        std::process::id(),
        build_tmp_suffix()
    ));

    // Copy to a temp file first, then atomically rename into place.
    fs::copy(source, &temp_destination).map_err(|error| {
        format!(
            "Failed to copy sidecar from {} to {}: {error}",
            source.display(),
            temp_destination.display()
        )
    })?;

    let mut permissions = fs::metadata(&temp_destination)
        .map_err(|error| format!("Failed to read runtime sidecar metadata: {error}"))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&temp_destination, permissions)
        .map_err(|error| format!("Failed to set runtime sidecar executable bit: {error}"))?;

    ad_hoc_codesign(&temp_destination)?;

    fs::rename(&temp_destination, &destination).map_err(|error| {
        format!(
            "Failed to finalize runtime sidecar {} -> {}: {error}",
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
            .map_err(|error| format!("Failed to read sidecar metadata: {error}"))?;
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions)
            .map_err(|error| format!("Failed to set sidecar executable bit: {error}"))?;
    }

    Ok(())
}

fn build_media_access_token(api_port: u16) -> String {
    let now_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("tmv-{api_port}-{pid}-{now_nanos}", pid = std::process::id())
}

fn build_tmp_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn cleanup_old_runtime_sidecars(dir: &Path, keep: usize) -> Result<(), String> {
    let mut sidecars = fs::read_dir(dir)
        .map_err(|error| format!("Failed to read runtime bin dir {}: {error}", dir.display()))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(SIDECAR_NAME)
        })
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
        "Failed to ad-hoc sign runtime sidecar {}: status={} stderr={} stdout={}",
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
        .map_err(|error| format!("Failed to open sidecar log {}: {error}", path.display()))
}
