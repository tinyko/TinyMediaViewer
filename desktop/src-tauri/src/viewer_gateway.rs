use crate::{
    config::ViewerAccessMode,
    diagnostics::{DiagnosticsStore, PerfDiagEventsInput, PreviewDiagEventsInput},
};
use axum::{
    body::{to_bytes, Body},
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, StatusCode, Uri},
    middleware::{self, Next},
    response::Response,
    routing::{any, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use reqwest::Client;
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Component, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::async_runtime::JoinHandle;
use tokio::sync::oneshot;

const MAX_PROXY_BODY_BYTES: usize = 32 * 1024 * 1024;
const TRACE_HEADER_ID: &str = "x-tmv-trace-id";
const TRACE_HEADER_ROUTE: &str = "x-tmv-route";
const TRACE_HEADER_UPSTREAM_STATUS: &str = "x-tmv-upstream-status";
const BASIC_AUTH_REALM: &str = "TinyMediaViewer";
const BASIC_AUTH_USERNAME: &str = "tmv";
static TRACE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub struct GatewayHandle {
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct GatewayState {
    api_port: u16,
    viewer_dir: PathBuf,
    client: Client,
    access_token: String,
    access_mode: ViewerAccessMode,
    lan_password: String,
    diagnostics: Arc<DiagnosticsStore>,
}

impl GatewayHandle {
    pub async fn stop(mut self) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }

        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

pub async fn start_gateway(
    viewer_dir: PathBuf,
    viewer_port: u16,
    api_port: u16,
    access_token: String,
    access_mode: ViewerAccessMode,
    lan_password: String,
    diagnostics: Arc<DiagnosticsStore>,
) -> Result<GatewayHandle, String> {
    let index_file = viewer_dir.join("index.html");

    if !index_file.exists() {
        return Err(format!(
            "Viewer assets not found at {}. Run `npm run prepare:bundle` in desktop first.",
            viewer_dir.display()
        ));
    }

    let client = Client::builder()
        .build()
        .map_err(|error| format!("Failed to initialize gateway HTTP client: {error}"))?;

    let app_state = GatewayState {
        api_port,
        viewer_dir,
        client,
        access_token,
        access_mode: access_mode.clone(),
        lan_password,
        diagnostics,
    };

    let router = Router::new()
        .route("/__tmv/diag/preview", post(record_preview_events))
        .route("/__tmv/diag/perf", post(record_perf_events))
        .route("/api", any(proxy_to_api))
        .route("/api/{*path}", any(proxy_to_api))
        .route("/media", any(proxy_to_api))
        .route("/media/{*path}", any(proxy_to_api))
        .route("/thumb", any(proxy_to_api))
        .route("/thumb/{*path}", any(proxy_to_api))
        .fallback(any(serve_viewer))
        .with_state(app_state.clone())
        .layer(middleware::from_fn_with_state(
            app_state,
            enforce_gateway_access,
        ));

    let bind_ip = match access_mode {
        ViewerAccessMode::Lan => Ipv4Addr::UNSPECIFIED,
        ViewerAccessMode::Local => Ipv4Addr::LOCALHOST,
    };
    let address = SocketAddr::from((bind_ip, viewer_port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| format!("Failed to bind viewer gateway port {viewer_port}: {error}"))?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let task = tauri::async_runtime::spawn(async move {
        let server = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });

        if let Err(error) = server.await {
            eprintln!("viewer gateway exited with error: {error}");
        }
    });

    Ok(GatewayHandle {
        shutdown_tx: Some(shutdown_tx),
        task: Some(task),
    })
}

async fn enforce_gateway_access(
    State(state): State<GatewayState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    if state.access_mode == ViewerAccessMode::Local || is_loopback_client(remote_addr.ip()) {
        return next.run(request).await;
    }

    let trace_id = next_trace_id();
    let started = Instant::now();
    let method_name = request.method().as_str().to_string();
    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());

    match validate_basic_auth(request.headers(), &state.lan_password) {
        Ok(()) => next.run(request).await,
        Err(reason) => {
            let message = format!("Gateway auth failed for {remote_addr}: {reason}");
            let _ = state.diagnostics.log_gateway_request(
                &trace_id,
                &method_name,
                "gateway-auth",
                &path_and_query,
                StatusCode::UNAUTHORIZED.as_u16(),
                None,
                started.elapsed().as_millis(),
                Some(&message),
            );
            build_auth_required_response(message, &trace_id)
        }
    }
}

async fn record_preview_events(
    State(state): State<GatewayState>,
    Json(payload): Json<PreviewDiagEventsInput>,
) -> Response {
    let trace_id = next_trace_id();
    let started = Instant::now();
    let events_len = payload.events.len();

    let result = state.diagnostics.record_preview_events(payload.events);
    match result {
        Ok(()) => {
            let _ = state.diagnostics.log_gateway_request(
                &trace_id,
                "POST",
                "diag-preview",
                "/__tmv/diag/preview",
                StatusCode::OK.as_u16(),
                Some(StatusCode::OK.as_u16()),
                started.elapsed().as_millis(),
                None,
            );
            build_trace_response(
                StatusCode::OK,
                format!("recorded {events_len} events"),
                &trace_id,
                "diag-preview",
                Some(StatusCode::OK.as_u16()),
            )
        }
        Err(error) => {
            let _ = state.diagnostics.log_gateway_request(
                &trace_id,
                "POST",
                "diag-preview",
                "/__tmv/diag/preview",
                StatusCode::INTERNAL_SERVER_ERROR.as_u16(),
                Some(StatusCode::INTERNAL_SERVER_ERROR.as_u16()),
                started.elapsed().as_millis(),
                Some(&error),
            );
            build_trace_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to record diagnostics events: {error}"),
                &trace_id,
                "diag-preview",
                Some(StatusCode::INTERNAL_SERVER_ERROR.as_u16()),
            )
        }
    }
}

async fn record_perf_events(
    State(state): State<GatewayState>,
    Json(payload): Json<PerfDiagEventsInput>,
) -> Response {
    let trace_id = next_trace_id();
    let started = Instant::now();
    let events_len = payload.events.len();

    let result = state.diagnostics.record_perf_events(payload.events);
    match result {
        Ok(()) => {
            let _ = state.diagnostics.log_gateway_request(
                &trace_id,
                "POST",
                "diag-perf",
                "/__tmv/diag/perf",
                StatusCode::OK.as_u16(),
                Some(StatusCode::OK.as_u16()),
                started.elapsed().as_millis(),
                None,
            );
            build_trace_response(
                StatusCode::OK,
                format!("recorded {events_len} perf events"),
                &trace_id,
                "diag-perf",
                Some(StatusCode::OK.as_u16()),
            )
        }
        Err(error) => {
            let _ = state.diagnostics.log_gateway_request(
                &trace_id,
                "POST",
                "diag-perf",
                "/__tmv/diag/perf",
                StatusCode::INTERNAL_SERVER_ERROR.as_u16(),
                Some(StatusCode::INTERNAL_SERVER_ERROR.as_u16()),
                started.elapsed().as_millis(),
                Some(&error),
            );
            build_trace_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to record perf diagnostics events: {error}"),
                &trace_id,
                "diag-perf",
                Some(StatusCode::INTERNAL_SERVER_ERROR.as_u16()),
            )
        }
    }
}

async fn proxy_to_api(State(state): State<GatewayState>, request: Request) -> Response {
    let trace_id = next_trace_id();
    let started = Instant::now();
    let (parts, body) = request.into_parts();
    let method = parts.method.clone();
    let method_name = method.as_str().to_string();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let route_tag = if path_and_query.starts_with("/media") || path_and_query.starts_with("/thumb")
    {
        "media-proxy"
    } else {
        "api-proxy"
    };

    let upstream_url = format!("http://127.0.0.1:{}{path_and_query}", state.api_port);

    let request_body = match to_bytes(body, MAX_PROXY_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(error) => {
            let message = format!("Failed to read request body: {error}");
            let _ = state.diagnostics.log_gateway_request(
                &trace_id,
                &method_name,
                route_tag,
                path_and_query,
                StatusCode::BAD_REQUEST.as_u16(),
                None,
                started.elapsed().as_millis(),
                Some(&message),
            );
            return build_trace_response(
                StatusCode::BAD_REQUEST,
                message,
                &trace_id,
                route_tag,
                None,
            );
        }
    };

    let mut upstream_request = state.client.request(method, upstream_url);
    for (name, value) in &parts.headers {
        if *name == header::HOST
            || *name == header::CONTENT_LENGTH
            || *name == header::CONNECTION
            || *name == header::ORIGIN
            || *name == header::REFERER
        {
            continue;
        }
        upstream_request = upstream_request.header(name, value);
    }
    upstream_request = upstream_request.header("x-media-viewer-token", &state.access_token);

    let upstream_response = match upstream_request.body(request_body).send().await {
        Ok(response) => response,
        Err(error) => {
            let message = format!("Failed to contact backend service: {error}");
            let _ = state.diagnostics.log_gateway_request(
                &trace_id,
                &method_name,
                route_tag,
                path_and_query,
                StatusCode::BAD_GATEWAY.as_u16(),
                None,
                started.elapsed().as_millis(),
                Some(&message),
            );
            return build_trace_response(
                StatusCode::BAD_GATEWAY,
                message,
                &trace_id,
                route_tag,
                None,
            );
        }
    };

    let status = upstream_response.status();
    let headers = upstream_response.headers().clone();
    let stream = upstream_response.bytes_stream();

    let mut builder = Response::builder().status(status);
    for (name, value) in &headers {
        if *name == header::CONTENT_LENGTH
            || *name == header::TRANSFER_ENCODING
            || *name == header::CONNECTION
        {
            continue;
        }
        builder = builder.header(name, value);
    }

    builder = builder
        .header(TRACE_HEADER_ID, trace_id.as_str())
        .header(TRACE_HEADER_ROUTE, route_tag)
        .header(TRACE_HEADER_UPSTREAM_STATUS, status.as_u16().to_string());

    let response = builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|error| {
            build_trace_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to build proxy response: {error}"),
                &trace_id,
                route_tag,
                Some(StatusCode::INTERNAL_SERVER_ERROR.as_u16()),
            )
        });

    let _ = state.diagnostics.log_gateway_request(
        &trace_id,
        &method_name,
        route_tag,
        path_and_query,
        status.as_u16(),
        Some(status.as_u16()),
        started.elapsed().as_millis(),
        None,
    );

    response
}

async fn serve_viewer(State(state): State<GatewayState>, uri: Uri) -> Response {
    let requested = uri.path().trim_start_matches('/');

    let safe_relative = sanitize_relative_path(requested);
    let mut candidate = match safe_relative {
        Some(relative) if !relative.as_os_str().is_empty() => state.viewer_dir.join(relative),
        _ => state.viewer_dir.join("index.html"),
    };

    if candidate.is_dir() {
        candidate = candidate.join("index.html");
    }

    if !candidate.is_file() {
        candidate = state.viewer_dir.join("index.html");
    }

    match tokio::fs::read(&candidate).await {
        Ok(bytes) => {
            let content_type = content_type_for_path(&candidate);
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type)
                .body(Body::from(bytes))
                .unwrap_or_else(|error| {
                    build_trace_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Failed to build file response: {error}"),
                        &next_trace_id(),
                        "viewer-static",
                        Some(StatusCode::INTERNAL_SERVER_ERROR.as_u16()),
                    )
                })
        }
        Err(error) => build_trace_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to read viewer asset: {error}"),
            &next_trace_id(),
            "viewer-static",
            Some(StatusCode::INTERNAL_SERVER_ERROR.as_u16()),
        ),
    }
}

fn build_trace_response(
    status: StatusCode,
    message: String,
    trace_id: &str,
    route: &str,
    upstream_status: Option<u16>,
) -> Response {
    let upstream_text = upstream_status
        .map(|value| value.to_string())
        .unwrap_or_else(|| "-".to_string());

    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(TRACE_HEADER_ID, trace_id)
        .header(TRACE_HEADER_ROUTE, route)
        .header(TRACE_HEADER_UPSTREAM_STATUS, upstream_text)
        .body(Body::from(message))
        .unwrap_or_else(|_| Response::new(Body::from("Gateway response build failure")))
}

fn build_auth_required_response(message: String, trace_id: &str) -> Response {
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(
            header::WWW_AUTHENTICATE,
            format!(r#"Basic realm="{BASIC_AUTH_REALM}""#),
        )
        .header(TRACE_HEADER_ID, trace_id)
        .header(TRACE_HEADER_ROUTE, "gateway-auth")
        .header(TRACE_HEADER_UPSTREAM_STATUS, "-")
        .body(Body::from(message))
        .unwrap_or_else(|_| Response::new(Body::from("Gateway response build failure")))
}

fn is_loopback_client(ip: IpAddr) -> bool {
    ip.is_loopback()
}

fn validate_basic_auth(headers: &HeaderMap, expected_password: &str) -> Result<(), &'static str> {
    if expected_password.is_empty() {
        return Err("LAN password is not configured");
    }

    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or("Missing Authorization header")?;
    let encoded = value
        .strip_prefix("Basic ")
        .ok_or("Authorization header is not Basic auth")?;
    let decoded = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "Authorization payload is not valid base64")?;
    let credentials =
        String::from_utf8(decoded).map_err(|_| "Authorization payload is not valid UTF-8")?;
    let (username, password) = credentials
        .split_once(':')
        .ok_or("Authorization payload is missing username/password")?;

    if username != BASIC_AUTH_USERNAME {
        return Err("Username is invalid");
    }

    if password != expected_password {
        return Err("Password is invalid");
    }

    Ok(())
}

fn sanitize_relative_path(path: &str) -> Option<PathBuf> {
    let mut clean = PathBuf::new();
    for component in PathBuf::from(path).components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(clean)
}

fn content_type_for_path(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "map" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn next_trace_id() -> String {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let sequence = TRACE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("tmv-{now_ms:016x}-{sequence:08x}")
}

#[cfg(test)]
mod tests {
    use super::{is_loopback_client, validate_basic_auth};
    use axum::http::{header, HeaderMap, HeaderValue};
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    fn auth_headers(username: &str, password: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        let payload = BASE64_STANDARD.encode(format!("{username}:{password}"));
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Basic {payload}")).expect("valid authorization header"),
        );
        headers
    }

    #[test]
    fn basic_auth_accepts_expected_credentials() {
        let headers = auth_headers("tmv", "supersecret");
        assert!(validate_basic_auth(&headers, "supersecret").is_ok());
    }

    #[test]
    fn basic_auth_rejects_wrong_password() {
        let headers = auth_headers("tmv", "wrong");
        assert!(validate_basic_auth(&headers, "supersecret").is_err());
    }

    #[test]
    fn loopback_detection_accepts_ipv4_and_ipv6_loopback() {
        assert!(is_loopback_client(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(is_loopback_client(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!is_loopback_client(IpAddr::V4(Ipv4Addr::new(
            192, 168, 1, 42
        ))));
    }
}
