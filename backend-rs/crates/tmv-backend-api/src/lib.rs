use anyhow::{anyhow, Result};
use axum::{
    body::Body,
    extract::{ConnectInfo, Form, Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    path::{Path as FsPath, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tmv_backend_core::{
    BackendService, FolderFavoriteInput, FolderFavoriteOutput, FolderIdentity, FolderMediaFilter,
    FolderMode, FolderPreview, FolderPreviewBatchOutput, FolderSnapshot, FolderSortOrder,
    FolderTotals, GetFolderOptions, MediaItem, MediaPage, PerfDiagEventsInput,
    PreviewDiagEventsInput, SystemUsageReport, ThumbnailError, ViewerPreferences,
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt},
};
use tokio_util::io::ReaderStream;
use url::Url;

const BASIC_AUTH_REALM: &str = "TinyMediaViewer";
const DEFAULT_ALLOWED_ORIGINS: &[&str] = &["http://localhost", "http://127.0.0.1", "http://[::1]"];
const DEFAULT_SYSTEM_USAGE_LIMIT: usize = 10;
const MAX_SYSTEM_USAGE_LIMIT: usize = 50;

#[derive(Clone)]
pub struct ApiState {
    pub service: BackendService,
    pub access_control: AccessControl,
    pub enable_light_root_mode: bool,
    pub preview_batch_limit: usize,
}

#[derive(Debug, Clone)]
pub enum AccessControl {
    DesktopManaged {
        access_mode: AccessMode,
        lan_password: String,
        session_token: String,
    },
    LegacyStandalone {
        require_lan_token: bool,
        media_access_token: String,
        cors_allowed_origins: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessMode {
    Local,
    Lan,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthQuery {
    return_to: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginFormInput {
    password: String,
    return_to: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderPayloadView<'a> {
    folder: &'a FolderIdentity,
    breadcrumb: &'a [FolderIdentity],
    subfolders: &'a [FolderPreview],
    media: Cow<'a, [MediaItem]>,
    totals: &'a FolderTotals,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

pub fn build_api_router() -> Router<ApiState> {
    Router::new()
        .route("/health", get(health))
        .route("/__tmv/login", get(show_login).post(submit_login))
        .route("/__tmv/auth", get(trigger_auth))
        .route("/__tmv/auth-complete", get(auth_complete))
        .route("/api/folder", get(get_folder))
        .route("/api/folder/favorite", post(set_folder_favorite))
        .route("/api/folder/previews", post(get_folder_previews))
        .route(
            "/api/viewer-preferences",
            get(get_viewer_preferences).post(save_viewer_preferences),
        )
        .route("/api/system-usage", get(get_system_usage))
        .route("/media/{*path}", get(get_media))
        .route("/thumb/{*path}", get(get_thumbnail))
        .route("/__tmv/diag/preview", post(record_preview_events))
        .route("/__tmv/diag/perf", post(record_perf_events))
}

pub async fn enforce_access(
    State(state): State<ApiState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    match &state.access_control {
        AccessControl::DesktopManaged {
            access_mode,
            lan_password,
            session_token,
        } => {
            if *access_mode == AccessMode::Local || is_loopback(remote_addr.ip()) {
                return next.run(request).await;
            }

            if is_public_desktop_route(request.uri().path()) {
                return next.run(request).await;
            }

            if has_valid_session_cookie(request.headers(), session_token)
                || validate_basic_auth(request.headers(), lan_password).is_ok()
            {
                return next.run(request).await;
            }

            let reason = validate_basic_auth(request.headers(), lan_password)
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "Missing session cookie".to_string());
            let _ = state
                .service
                .record_gateway_log(format!(
                    "{}\tauth\t{}\t{}\n",
                    now_ms_u64(),
                    remote_addr,
                    reason
                ))
                .await;

            if wants_login_redirect(&request) {
                return Redirect::to(&login_redirect_target(request.uri())).into_response();
            }

            unauthorized_response()
        }
        AccessControl::LegacyStandalone {
            require_lan_token,
            media_access_token,
            cors_allowed_origins,
        } => {
            let origin = request
                .headers()
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok());
            if !is_origin_allowed(origin, cors_allowed_origins) {
                return json_error(StatusCode::FORBIDDEN, "Origin not allowed");
            }

            if *require_lan_token && !is_loopback(remote_addr.ip()) {
                let provided_token = request
                    .headers()
                    .get("x-media-viewer-token")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default();
                if provided_token != media_access_token {
                    return json_error(StatusCode::UNAUTHORIZED, "Unauthorized LAN request");
                }
            }

            next.run(request).await
        }
    }
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

async fn trigger_auth(Query(query): Query<AuthQuery>) -> Redirect {
    Redirect::to(&login_path(query.return_to.as_deref()))
}

async fn auth_complete() -> Response {
    Redirect::to("/").into_response()
}

async fn show_login(
    State(state): State<ApiState>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
) -> Response {
    let return_to = sanitize_return_to(query.return_to.as_deref());
    if is_desktop_authenticated(&state.access_control, &headers) {
        return Redirect::to(&return_to).into_response();
    }
    render_login_page(None, &return_to, StatusCode::OK)
}

async fn submit_login(
    State(state): State<ApiState>,
    Form(input): Form<LoginFormInput>,
) -> Response {
    let return_to = sanitize_return_to(input.return_to.as_deref());
    let AccessControl::DesktopManaged {
        access_mode,
        lan_password,
        session_token,
    } = &state.access_control
    else {
        return Redirect::to(&return_to).into_response();
    };

    if *access_mode == AccessMode::Local {
        return Redirect::to(&return_to).into_response();
    }

    if input.password != *lan_password {
        return render_login_page(Some("密码错误"), &return_to, StatusCode::UNAUTHORIZED);
    }

    Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(header::LOCATION, return_to)
        .header(
            header::SET_COOKIE,
            build_session_cookie(session_token, 60 * 60 * 24 * 30),
        )
        .body(Body::empty())
        .unwrap_or_else(|_| Redirect::to("/").into_response())
}

async fn get_folder(
    State(state): State<ApiState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let target_path = query.get("path").map(String::as_str).unwrap_or("");
    let limit = match query.get("limit") {
        Some(raw) if !raw.is_empty() => match raw.parse::<usize>() {
            Ok(value) => Some(value),
            Err(_) => return json_error(StatusCode::BAD_REQUEST, "Unable to read folder"),
        },
        _ => None,
    };

    let mode = match parse_mode(
        query.get("mode").map(String::as_str),
        target_path,
        state.enable_light_root_mode,
    ) {
        Ok(mode) => mode,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error.to_string()),
    };
    let media_filter = match parse_media_filter(query.get("kind").map(String::as_str)) {
        Ok(filter) => filter,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error.to_string()),
    };
    let sort_order = match parse_sort_order(query.get("sort").map(String::as_str)) {
        Ok(order) => order,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error.to_string()),
    };
    let default_limit = state.service.default_folder_page_limit();
    let requested_limit = limit.unwrap_or(default_limit);
    let wants_preencoded_default_page = mode == FolderMode::Full
        && media_filter.is_none()
        && sort_order == FolderSortOrder::Desc
        && query.get("cursor").is_none_or(|value| value.is_empty())
        && requested_limit == default_limit;

    match state
        .service
        .get_folder_page(
            target_path,
            GetFolderOptions {
                cursor: query.get("cursor").cloned(),
                limit,
                mode,
                media_filter,
                sort_order,
            },
        )
        .await
    {
        Ok(page) => {
            if wants_preencoded_default_page
                && matches!(&page.media_page, MediaPage::BorrowedRange { start: 0, .. })
                && page.snapshot.default_page_media_json.is_some()
            {
                if let Ok(response) = build_preencoded_folder_response(
                    &page.snapshot,
                    page.snapshot
                        .default_page_media_json
                        .as_deref()
                        .unwrap_or("[]"),
                    page.next_cursor.clone(),
                ) {
                    return response;
                }
            }

            Json(build_folder_payload_view(
                &page.snapshot,
                page.media_page.as_cow(&page.snapshot.media),
                page.next_cursor,
            ))
            .into_response()
        }
        Err(error) => json_error(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

fn build_folder_payload_view<'a>(
    snapshot: &'a FolderSnapshot,
    media: Cow<'a, [MediaItem]>,
    next_cursor: Option<String>,
) -> FolderPayloadView<'a> {
    FolderPayloadView {
        folder: &snapshot.folder,
        breadcrumb: &snapshot.breadcrumb,
        subfolders: &snapshot.subfolders,
        media,
        totals: &snapshot.totals,
        next_cursor,
    }
}

fn build_preencoded_folder_response(
    snapshot: &FolderSnapshot,
    media_json: &str,
    next_cursor: Option<String>,
) -> Result<Response> {
    let folder_json = serde_json::to_string(&snapshot.folder)?;
    let breadcrumb_json = serde_json::to_string(&snapshot.breadcrumb)?;
    let subfolders_json = serde_json::to_string(&snapshot.subfolders)?;
    let totals_json = serde_json::to_string(&snapshot.totals)?;

    let mut body = String::with_capacity(
        folder_json.len()
            + breadcrumb_json.len()
            + subfolders_json.len()
            + totals_json.len()
            + media_json.len()
            + next_cursor.as_ref().map_or(0, String::len)
            + 96,
    );
    body.push_str("{\"folder\":");
    body.push_str(&folder_json);
    body.push_str(",\"breadcrumb\":");
    body.push_str(&breadcrumb_json);
    body.push_str(",\"subfolders\":");
    body.push_str(&subfolders_json);
    body.push_str(",\"media\":");
    body.push_str(media_json);
    body.push_str(",\"totals\":");
    body.push_str(&totals_json);
    if let Some(cursor) = next_cursor {
        body.push_str(",\"nextCursor\":");
        body.push_str(&serde_json::to_string(&cursor)?);
    }
    body.push('}');

    Ok((
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        )],
        Body::from(body),
    )
        .into_response())
}

async fn get_folder_previews(State(state): State<ApiState>, Json(input): Json<Value>) -> Response {
    let Some(paths_value) = input.get("paths") else {
        return json_error(StatusCode::BAD_REQUEST, "paths must be an array");
    };
    let Some(paths_array) = paths_value.as_array() else {
        return json_error(StatusCode::BAD_REQUEST, "paths must be an array");
    };
    if paths_array.is_empty() {
        return Json(json!({ "items": [] })).into_response();
    }
    if paths_array.len() > state.preview_batch_limit {
        return json_error(
            StatusCode::BAD_REQUEST,
            format!(
                "paths size exceeds PREVIEW_BATCH_LIMIT={}",
                state.preview_batch_limit
            ),
        );
    }

    let mut paths = Vec::with_capacity(paths_array.len());
    for item in paths_array {
        let Some(path) = item.as_str() else {
            return json_error(StatusCode::BAD_REQUEST, "paths must be string array");
        };
        paths.push(path.to_string());
    }

    let limit_per_folder = input
        .get("limitPerFolder")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.floor().max(1.0) as usize);

    let result = state
        .service
        .get_folder_previews(paths, limit_per_folder)
        .await;
    Json(FolderPreviewBatchOutput {
        items: result.items,
        errors: Some(result.errors),
    })
    .into_response()
}

async fn set_folder_favorite(
    State(state): State<ApiState>,
    Json(input): Json<FolderFavoriteInput>,
) -> Response {
    match state
        .service
        .set_folder_favorite(&input.path, input.favorite)
        .await
    {
        Ok(saved) => Json(FolderFavoriteOutput {
            path: saved.path,
            favorite: saved.favorite,
        })
        .into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

async fn get_system_usage(
    State(state): State<ApiState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let limit = match query.get("limit") {
        Some(raw) if !raw.is_empty() => match raw.parse::<usize>() {
            Ok(value) => value.clamp(1, MAX_SYSTEM_USAGE_LIMIT),
            Err(_) => {
                return json_error(StatusCode::BAD_REQUEST, "Unable to read system usage limit")
            }
        },
        _ => DEFAULT_SYSTEM_USAGE_LIMIT,
    };

    match state.service.get_system_usage_report(limit).await {
        Ok(report) => Json::<SystemUsageReport>(report).into_response(),
        Err(error) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to scan system usage: {error}"),
        ),
    }
}

async fn get_viewer_preferences(State(state): State<ApiState>) -> Response {
    match state.service.load_viewer_preferences().await {
        Ok(preferences) => Json::<ViewerPreferences>(preferences).into_response(),
        Err(error) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to load viewer preferences: {error}"),
        ),
    }
}

async fn save_viewer_preferences(
    State(state): State<ApiState>,
    Json(input): Json<ViewerPreferences>,
) -> Response {
    match state.service.save_viewer_preferences(input).await {
        Ok(saved) => Json::<ViewerPreferences>(saved).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

async fn get_media(
    State(state): State<ApiState>,
    Path(path): Path<String>,
    request: Request,
) -> Response {
    let decoded = match percent_decode(&path) {
        Ok(value) => value,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "Invalid media path encoding"),
    };

    let resolved = match state.service.resolve_media_file(&decoded).await {
        Ok(value) => value,
        Err(error) => return map_media_resolution_error(error.to_string()),
    };

    let metadata = match fs::metadata(&resolved.absolute_path).await {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return json_error(StatusCode::NOT_FOUND, "Media file not found"),
    };

    let content_type = content_type_by_ext(&resolved.absolute_path);
    let cache_control = if content_type.starts_with("video/") {
        "no-store"
    } else {
        "public, max-age=86400"
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());

    match stream_file(
        resolved.absolute_path,
        content_type,
        metadata.len(),
        range,
        cache_control,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn get_thumbnail(State(state): State<ApiState>, Path(path): Path<String>) -> Response {
    let decoded = match percent_decode(&path) {
        Ok(value) => value,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "Invalid thumbnail path encoding"),
    };

    let resolved = match state.service.resolve_media_file(&decoded).await {
        Ok(value) => value,
        Err(error) => return map_thumbnail_resolution_error(error.to_string()),
    };

    let metadata = match fs::metadata(&resolved.absolute_path).await {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return json_error(StatusCode::NOT_FOUND, "Media file not found"),
    };

    match state
        .service
        .get_thumbnail_path(
            &resolved.safe_relative_path,
            &resolved.absolute_path,
            modified_ms(&metadata),
            resolved.kind,
        )
        .await
    {
        Ok(thumbnail_path) => match fs::read(&thumbnail_path).await {
            Ok(bytes) => (
                [
                    (
                        header::CACHE_CONTROL,
                        HeaderValue::from_static("public, max-age=31536000, immutable"),
                    ),
                    (header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg")),
                    (
                        header::CONTENT_LENGTH,
                        HeaderValue::from_str(&bytes.len().to_string())
                            .unwrap_or_else(|_| HeaderValue::from_static("0")),
                    ),
                ],
                bytes,
            )
                .into_response(),
            Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        },
        Err(error) => map_thumbnail_generation_error(&error),
    }
}

async fn record_preview_events(
    State(state): State<ApiState>,
    Json(input): Json<PreviewDiagEventsInput>,
) -> Response {
    match state.service.record_preview_events(input.events).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn record_perf_events(
    State(state): State<ApiState>,
    Json(input): Json<PerfDiagEventsInput>,
) -> Response {
    match state.service.record_perf_events(input.events).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

fn parse_mode(
    input: Option<&str>,
    target_path: &str,
    enable_light_root_mode: bool,
) -> Result<FolderMode> {
    match input {
        None | Some("") => {
            if enable_light_root_mode && target_path.trim().is_empty() {
                Ok(FolderMode::Light)
            } else {
                Ok(FolderMode::Full)
            }
        }
        Some("light") => Ok(FolderMode::Light),
        Some("full") => Ok(FolderMode::Full),
        Some(_) => Err(anyhow!("mode must be light or full")),
    }
}

fn parse_media_filter(input: Option<&str>) -> Result<Option<FolderMediaFilter>> {
    match input {
        None | Some("") => Ok(None),
        Some("image") => Ok(Some(FolderMediaFilter::Image)),
        Some("video") => Ok(Some(FolderMediaFilter::Video)),
        Some(_) => Err(anyhow!("kind must be image or video")),
    }
}

fn parse_sort_order(input: Option<&str>) -> Result<FolderSortOrder> {
    match input {
        None | Some("") | Some("desc") => Ok(FolderSortOrder::Desc),
        Some("asc") => Ok(FolderSortOrder::Asc),
        Some(_) => Err(anyhow!("sort must be asc or desc")),
    }
}

fn validate_basic_auth(headers: &HeaderMap, expected_password: &str) -> Result<()> {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        anyhow::bail!("Missing authorization header");
    };
    let Some(encoded) = value.strip_prefix("Basic ") else {
        anyhow::bail!("Invalid auth scheme");
    };
    let decoded = BASE64_STANDARD.decode(encoded)?;
    let decoded = String::from_utf8(decoded)?;
    let Some((username, password)) = decoded.split_once(':') else {
        anyhow::bail!("Malformed basic auth payload");
    };
    if username != "tmv" || password != expected_password {
        anyhow::bail!("Invalid username or password");
    }
    Ok(())
}

fn has_valid_session_cookie(headers: &HeaderMap, expected_token: &str) -> bool {
    headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_cookie(value, "tmv_session"))
        .is_some_and(|value| value == expected_token)
}

fn parse_cookie<'a>(cookie_header: &'a str, name: &str) -> Option<&'a str> {
    cookie_header.split(';').map(str::trim).find_map(|item| {
        let (cookie_name, value) = item.split_once('=')?;
        (cookie_name == name).then_some(value)
    })
}

fn build_session_cookie(token: &str, max_age_seconds: u64) -> String {
    format!("tmv_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_seconds}")
}

fn is_public_desktop_route(path: &str) -> bool {
    matches!(
        path,
        "/__tmv/login" | "/__tmv/auth" | "/__tmv/auth-complete"
    )
}

fn wants_login_redirect(request: &Request) -> bool {
    matches!(*request.method(), Method::GET | Method::HEAD)
        && !matches_api_like_path(request.uri().path())
}

fn matches_api_like_path(path: &str) -> bool {
    path.starts_with("/api/")
        || path.starts_with("/media/")
        || path.starts_with("/thumb/")
        || path.starts_with("/__tmv/diag/")
        || path == "/health"
}

fn login_path(return_to: Option<&str>) -> String {
    let sanitized = sanitize_return_to(return_to);
    format!(
        "/__tmv/login?returnTo={}",
        percent_encoding::utf8_percent_encode(&sanitized, percent_encoding::NON_ALPHANUMERIC)
    )
}

fn login_redirect_target(uri: &Uri) -> String {
    let mut target = uri.path().to_string();
    if let Some(query) = uri.query() {
        target.push('?');
        target.push_str(query);
    }
    login_path(Some(target.as_str()))
}

fn is_desktop_authenticated(access_control: &AccessControl, headers: &HeaderMap) -> bool {
    match access_control {
        AccessControl::DesktopManaged {
            access_mode,
            lan_password,
            session_token,
        } => {
            *access_mode == AccessMode::Local
                || has_valid_session_cookie(headers, session_token)
                || validate_basic_auth(headers, lan_password).is_ok()
        }
        AccessControl::LegacyStandalone { .. } => false,
    }
}

fn render_login_page(message: Option<&str>, return_to: &str, status: StatusCode) -> Response {
    let escaped_return_to = html_escape(return_to);
    let error_block = message.map_or(String::new(), |message| {
        format!("<p class=\"error\">{}</p>", html_escape(message))
    });
    let body = format!(
        r#"<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tiny Media Viewer 登录</title>
    <style>
      :root {{ color-scheme: dark; }}
      body {{
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top, rgba(50, 90, 220, 0.32), transparent 36%),
          linear-gradient(180deg, #061225 0%, #040812 100%);
        color: #f5f8ff;
      }}
      .panel {{
        width: min(420px, calc(100vw - 32px));
        padding: 28px;
        border-radius: 24px;
        background: rgba(6, 17, 39, 0.92);
        border: 1px solid rgba(112, 146, 235, 0.28);
        box-shadow: 0 22px 60px rgba(0, 0, 0, 0.45);
      }}
      h1 {{ margin: 0 0 8px; font-size: 28px; }}
      p {{ margin: 0 0 18px; color: rgba(230, 238, 255, 0.78); line-height: 1.5; }}
      label {{ display: block; margin-bottom: 10px; font-size: 14px; color: rgba(230, 238, 255, 0.82); }}
      input {{
        width: 100%;
        box-sizing: border-box;
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid rgba(112, 146, 235, 0.25);
        background: rgba(15, 28, 56, 0.92);
        color: #fff;
        font-size: 16px;
      }}
      button {{
        width: 100%;
        margin-top: 16px;
        padding: 14px 16px;
        border: 0;
        border-radius: 16px;
        background: linear-gradient(135deg, #3f8cff 0%, #6bbcff 100%);
        color: #fff;
        font-size: 16px;
        font-weight: 700;
      }}
      .error {{
        margin-bottom: 14px;
        color: #ffb4b4;
      }}
      .hint {{
        margin-top: 14px;
        font-size: 13px;
        color: rgba(230, 238, 255, 0.58);
      }}
    </style>
  </head>
  <body>
    <main class="panel">
      <h1>访问受保护</h1>
      <p>请输入局域网访问密码继续打开 Tiny Media Viewer。</p>
      {error_block}
      <form method="post" action="/__tmv/login">
        <input type="hidden" name="returnTo" value="{escaped_return_to}" />
        <label for="password">LAN 访问密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">登录</button>
      </form>
      <div class="hint">登录成功后会自动返回刚才的页面。</div>
    </main>
  </body>
</html>"#
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::from("Login")))
}

fn html_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_str(&format!("Basic realm=\"{BASIC_AUTH_REALM}\""))
                .unwrap_or_else(|_| HeaderValue::from_static("Basic realm=\"TinyMediaViewer\"")),
        )],
        Json(json!({ "error": "Unauthorized" })),
    )
        .into_response()
}

fn is_origin_allowed(origin: Option<&str>, allowed_origins: &[String]) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Ok(parsed) = Url::parse(origin) else {
        return false;
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    if matches!(host, "localhost" | "127.0.0.1" | "::1") {
        return true;
    }
    let normalized = normalize_origin(parsed.origin().ascii_serialization().as_str());
    if allowed_origins.iter().any(|origin| origin == "*") {
        return true;
    }
    allowed_origins
        .iter()
        .map(|origin| normalize_origin(origin))
        .any(|allowed| allowed == normalized)
}

fn normalize_origin(value: &str) -> String {
    value.trim_end_matches('/').trim().to_string()
}

fn legacy_allowed_origins(origins: &[String]) -> Vec<String> {
    if origins.is_empty() {
        return DEFAULT_ALLOWED_ORIGINS
            .iter()
            .map(|origin| origin.to_string())
            .collect();
    }
    origins.to_vec()
}

fn content_type_by_ext(path: &FsPath) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tiff" => "image/tiff",
        "gif" => "image/gif",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        _ => "application/octet-stream",
    }
}

fn parse_byte_range(range: &str, size: u64) -> Option<(u64, u64)> {
    let range = range.strip_prefix("bytes=")?;
    let (start_raw, end_raw) = range.split_once('-')?;
    let mut start = start_raw.parse::<u64>().ok();
    let mut end = end_raw.parse::<u64>().ok();

    if start.is_none() && end.is_none() {
        return None;
    }

    if start.is_none() {
        let suffix = end?;
        if suffix == 0 {
            return None;
        }
        start = Some(size.saturating_sub(suffix));
        end = Some(size.saturating_sub(1));
    } else if end.is_none() {
        end = Some(size.saturating_sub(1));
    }

    let start = start?;
    let end = end?;
    if start >= size || end < start {
        return None;
    }
    Some((start, end.min(size.saturating_sub(1))))
}

fn percent_decode(input: &str) -> Result<String> {
    Ok(percent_encoding::percent_decode_str(input)
        .decode_utf8()?
        .to_string())
}

async fn stream_file(
    path: PathBuf,
    content_type: &'static str,
    file_size: u64,
    range_header: Option<&str>,
    cache_control: &'static str,
) -> Result<Response> {
    let mut file = fs::File::open(&path).await?;
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, cache_control)
        .header(header::ACCEPT_RANGES, "bytes");

    let body = if let Some(range_header) = range_header {
        let Some((start, end)) = parse_byte_range(range_header, file_size) else {
            return Ok((
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(header::CONTENT_RANGE, format!("bytes */{file_size}"))],
            )
                .into_response());
        };

        file.seek(std::io::SeekFrom::Start(start)).await?;
        response = response
            .status(StatusCode::PARTIAL_CONTENT)
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{file_size}"),
            )
            .header(header::CONTENT_LENGTH, end - start + 1);
        Body::from_stream(ReaderStream::new(file.take(end - start + 1)))
    } else {
        response = response.header(header::CONTENT_LENGTH, file_size);
        Body::from_stream(ReaderStream::new(file))
    };

    Ok(response.body(body)?)
}

fn map_media_resolution_error(message: String) -> Response {
    if message.contains("Unsupported media extension") {
        json_error(StatusCode::FORBIDDEN, message)
    } else {
        json_error(StatusCode::NOT_FOUND, message)
    }
}

fn map_thumbnail_resolution_error(message: String) -> Response {
    if message.contains("Unsupported media extension") {
        json_error(StatusCode::FORBIDDEN, message)
    } else if message.contains("Missing media file path")
        || message.contains("Media file not found")
        || message.contains("escapes media root")
    {
        json_error(StatusCode::NOT_FOUND, message)
    } else {
        json_error(StatusCode::INTERNAL_SERVER_ERROR, message)
    }
}

fn map_thumbnail_generation_error(error: &ThumbnailError) -> Response {
    match error {
        ThumbnailError::UnsupportedVideoPlatform => {
            json_error(StatusCode::NOT_IMPLEMENTED, error.to_string())
        }
        _ => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

fn json_error(status: StatusCode, message: impl ToString) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .body(Body::from(
            json!({ "error": message.to_string() }).to_string(),
        ))
        .unwrap_or_else(|_| Response::new(Body::from("{\"error\":\"response build failure\"}")))
}

fn sanitize_return_to(value: Option<&str>) -> String {
    let Some(value) = value.map(str::trim) else {
        return "/".to_string();
    };
    if value.is_empty() || !value.starts_with('/') || value.starts_with("//") {
        return "/".to_string();
    }
    value.to_string()
}

fn is_loopback(ip: IpAddr) -> bool {
    ip.is_loopback()
}

fn modified_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

fn now_ms_u64() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

pub fn normalize_legacy_origins(origins: &[String]) -> Vec<String> {
    legacy_allowed_origins(origins)
        .into_iter()
        .map(|origin| normalize_origin(&origin))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        build_session_cookie, has_valid_session_cookie, is_origin_allowed, login_path,
        map_thumbnail_generation_error, parse_byte_range, parse_mode, sanitize_return_to,
        validate_basic_auth,
    };
    use crate::FolderMode;
    use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
    use tmv_backend_core::ThumbnailError;

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
    fn parses_root_mode_like_node() {
        assert!(matches!(
            parse_mode(None, "", true).expect("root light mode"),
            FolderMode::Light
        ));
        assert!(matches!(
            parse_mode(None, "alpha", true).expect("nested full mode"),
            FolderMode::Full
        ));
    }

    #[test]
    fn range_parser_accepts_suffix_ranges() {
        assert_eq!(parse_byte_range("bytes=0-10", 100), Some((0, 10)));
        assert_eq!(parse_byte_range("bytes=10-", 100), Some((10, 99)));
        assert_eq!(parse_byte_range("bytes=-10", 100), Some((90, 99)));
    }

    #[test]
    fn legacy_origin_rules_match_localhost_and_explicit_allowlist() {
        let allow = vec!["https://example.com".to_string()];
        assert!(is_origin_allowed(Some("http://127.0.0.1:3000"), &allow));
        assert!(is_origin_allowed(Some("https://example.com"), &allow));
        assert!(!is_origin_allowed(Some("https://evil.example"), &allow));
    }

    #[test]
    fn basic_auth_accepts_expected_credentials() {
        let headers = auth_headers("tmv", "supersecret");
        assert!(validate_basic_auth(&headers, "supersecret").is_ok());
    }

    #[test]
    fn sanitize_return_to_only_allows_local_paths() {
        assert_eq!(
            sanitize_return_to(Some("/gallery?path=alpha")),
            "/gallery?path=alpha"
        );
        assert_eq!(sanitize_return_to(Some("//evil.example")), "/");
        assert_eq!(sanitize_return_to(Some("https://evil.example")), "/");
        assert_eq!(sanitize_return_to(Some("  ")), "/");
    }

    #[test]
    fn session_cookie_roundtrip_matches_expected_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("other=value; tmv_session=secret-token"),
        );
        assert!(has_valid_session_cookie(&headers, "secret-token"));
        assert!(!has_valid_session_cookie(&headers, "wrong-token"));
        assert!(build_session_cookie("secret-token", 10).contains("tmv_session=secret-token"));
    }

    #[test]
    fn login_path_restricts_return_target() {
        assert_eq!(
            login_path(Some("/viewer?path=alpha")),
            "/__tmv/login?returnTo=%2Fviewer%3Fpath%3Dalpha"
        );
        assert_eq!(
            login_path(Some("//evil.example")),
            "/__tmv/login?returnTo=%2F"
        );
    }

    #[test]
    fn unsupported_video_thumbnails_map_to_not_implemented() {
        let response = map_thumbnail_generation_error(&ThumbnailError::UnsupportedVideoPlatform);
        assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
    }
}
