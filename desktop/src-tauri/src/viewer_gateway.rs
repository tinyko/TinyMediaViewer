use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{header, StatusCode, Uri},
    response::Response,
    routing::any,
    Router,
};
use reqwest::Client;
use std::{
    net::{Ipv4Addr, SocketAddr},
    path::{Component, PathBuf},
};
use tauri::async_runtime::JoinHandle;
use tokio::sync::oneshot;

const MAX_PROXY_BODY_BYTES: usize = 32 * 1024 * 1024;

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
    };

    let router = Router::new()
        .route("/api", any(proxy_to_api))
        .route("/api/{*path}", any(proxy_to_api))
        .route("/media", any(proxy_to_api))
        .route("/media/{*path}", any(proxy_to_api))
        .fallback(any(serve_viewer))
        .with_state(app_state);

    let address = SocketAddr::from((Ipv4Addr::UNSPECIFIED, viewer_port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| format!("Failed to bind viewer gateway port {viewer_port}: {error}"))?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let task = tauri::async_runtime::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async move {
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

async fn proxy_to_api(State(state): State<GatewayState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let method = parts.method.clone();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");

    let upstream_url = format!("http://127.0.0.1:{}{path_and_query}", state.api_port);

    let request_body = match to_bytes(body, MAX_PROXY_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return build_plain_response(
                StatusCode::BAD_REQUEST,
                format!("Failed to read request body: {error}"),
            )
        }
    };

    let mut upstream_request = state.client.request(method, upstream_url);
    for (name, value) in &parts.headers {
        if *name == header::HOST || *name == header::CONTENT_LENGTH || *name == header::CONNECTION {
            continue;
        }
        upstream_request = upstream_request.header(name, value);
    }
    upstream_request = upstream_request.header("x-media-viewer-token", &state.access_token);

    let upstream_response = match upstream_request.body(request_body).send().await {
        Ok(response) => response,
        Err(error) => {
            return build_plain_response(
                StatusCode::BAD_GATEWAY,
                format!("Failed to contact backend service: {error}"),
            )
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

    builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|error| {
            build_plain_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to build proxy response: {error}"),
            )
        })
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
                    build_plain_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Failed to build file response: {error}"),
                    )
                })
        }
        Err(error) => build_plain_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to read viewer asset: {error}"),
        ),
    }
}

fn build_plain_response(status: StatusCode, message: String) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(message))
        .unwrap_or_else(|_| Response::new(Body::from("Gateway response build failure")))
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
