use crate::{
    config::{RuntimeState, Settings},
    viewer_gateway::{self, GatewayHandle},
};
use std::{
    fs,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, UdpSocket},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Command,
    process::Stdio,
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
}

impl ServiceManager {
    pub fn new() -> Self {
        Self {
            server_child: None,
            gateway: None,
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

        let child = tokio::process::Command::new(&sidecar_path)
            .env("MEDIA_ROOT", &settings.home_dir)
            .env("PORT", api_port.to_string())
            .env("SERVER_HOST", "127.0.0.1")
            .env("MEDIA_ACCESS_TOKEN", &media_access_token)
            .env("REQUIRE_LAN_TOKEN", "true")
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
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
        let gateway =
            viewer_gateway::start_gateway(viewer_dir, viewer_port, api_port, media_access_token)
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

    let destination = runtime_bin_dir.join(SIDECAR_NAME);
    // Always overwrite the runtime sidecar so DMG upgrades never keep stale binaries.
    fs::copy(source, &destination).map_err(|error| {
        format!(
            "Failed to copy sidecar from {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })?;

    let mut permissions = fs::metadata(&destination)
        .map_err(|error| format!("Failed to read runtime sidecar metadata: {error}"))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&destination, permissions)
        .map_err(|error| format!("Failed to set runtime sidecar executable bit: {error}"))?;

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
