use anyhow::{Context, Result};
use axum::{middleware, Router};
use clap::{Parser, ValueEnum};
use sha1::{Digest, Sha1};
use std::{env, net::SocketAddr, path::PathBuf, process, time::SystemTime};
use tmv_backend_api::{
    build_api_router, enforce_access, normalize_legacy_origins, AccessControl, AccessMode, ApiState,
};
use tmv_backend_core::{BackendConfig, BackendService, DiagnosticsWriter};
use tmv_backend_index::IndexStore;
use tower_http::services::{ServeDir, ServeFile};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Debug, Clone, Copy, ValueEnum)]
enum AccessModeCli {
    Local,
    Lan,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum RuntimeModeCli {
    Desktop,
    Legacy,
}

#[derive(Debug, Parser)]
#[command(name = "tmv-backend-app")]
struct Cli {
    #[arg(long)]
    media_root: Option<PathBuf>,
    #[arg(long)]
    viewer_dir: Option<PathBuf>,
    #[arg(long)]
    index_dir: Option<PathBuf>,
    #[arg(long)]
    thumbnail_dir: Option<PathBuf>,
    #[arg(long)]
    diagnostics_dir: Option<PathBuf>,
    #[arg(long)]
    host: Option<String>,
    #[arg(long)]
    port: Option<u16>,
    #[arg(long)]
    preview_limit: Option<usize>,
    #[arg(long)]
    preview_batch_limit: Option<usize>,
    #[arg(long)]
    folder_page_limit: Option<usize>,
    #[arg(long)]
    max_folder_page_limit: Option<usize>,
    #[arg(long)]
    max_items_per_folder: Option<usize>,
    #[arg(long)]
    stat_concurrency: Option<usize>,
    #[arg(long, value_enum)]
    runtime_mode: Option<RuntimeModeCli>,
    #[arg(long, value_enum)]
    access_mode: Option<AccessModeCli>,
    #[arg(long)]
    lan_password: Option<String>,
    #[arg(long)]
    enable_light_root_mode: Option<bool>,
    #[arg(long)]
    require_lan_token: Option<bool>,
    #[arg(long)]
    media_access_token: Option<String>,
    #[arg(long)]
    cors_allowed_origins: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tmv_backend_app=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cli = Cli::parse();
    let runtime_mode = cli
        .runtime_mode
        .or_else(|| env_value_enum::<RuntimeModeCli>("TMV_RUNTIME_MODE"))
        .unwrap_or(RuntimeModeCli::Legacy);
    let access_mode = cli
        .access_mode
        .or_else(|| env_value_enum::<AccessModeCli>("TMV_ACCESS_MODE"))
        .unwrap_or(AccessModeCli::Local);
    let media_root = cli
        .media_root
        .or_else(|| env_path("TMV_MEDIA_ROOT"))
        .or_else(|| env_path("MEDIA_ROOT"))
        .unwrap_or(default_media_root()?);
    let viewer_dir = resolve_viewer_dir(cli.viewer_dir.or_else(|| env_path("TMV_VIEWER_DIR")))?;
    let app_support_dir = default_app_support_dir();
    let index_dir = cli
        .index_dir
        .or_else(|| env_path("TMV_INDEX_DIR"))
        .or_else(|| env_path("INDEX_DIR"))
        .unwrap_or_else(|| app_support_dir.join("backend-index"));
    let thumbnail_dir = cli
        .thumbnail_dir
        .or_else(|| env_path("TMV_THUMBNAIL_DIR"))
        .or_else(|| env_path("THUMBNAIL_CACHE_DIR"))
        .unwrap_or_else(|| app_support_dir.join("thumbnails"));
    let diagnostics_dir = cli
        .diagnostics_dir
        .or_else(|| env_path("TMV_DIAGNOSTICS_DIR"))
        .unwrap_or_else(|| app_support_dir.join("diagnostics"));
    let bind_host = cli
        .host
        .or_else(|| env_string("TMV_BIND_HOST"))
        .or_else(|| env_string("SERVER_HOST"))
        .unwrap_or_else(|| default_bind_host(runtime_mode, access_mode));
    let port = cli
        .port
        .or_else(|| env_u16("TMV_PORT"))
        .or_else(|| env_u16("PORT"))
        .unwrap_or_else(|| default_port(runtime_mode));
    let preview_limit = cli
        .preview_limit
        .or_else(|| env_usize("TMV_PREVIEW_LIMIT"))
        .or_else(|| env_usize("PREVIEW_LIMIT"))
        .unwrap_or(6);
    let preview_batch_limit = cli
        .preview_batch_limit
        .or_else(|| env_usize("TMV_PREVIEW_BATCH_LIMIT"))
        .or_else(|| env_usize("PREVIEW_BATCH_LIMIT"))
        .unwrap_or(64);
    let folder_page_limit = cli
        .folder_page_limit
        .or_else(|| env_usize("TMV_FOLDER_PAGE_LIMIT"))
        .or_else(|| env_usize("FOLDER_PAGE_LIMIT"))
        .unwrap_or(240);
    let max_folder_page_limit = cli
        .max_folder_page_limit
        .or_else(|| env_usize("TMV_MAX_FOLDER_PAGE_LIMIT"))
        .or_else(|| env_usize("MAX_FOLDER_PAGE_LIMIT"))
        .unwrap_or(1000);
    let max_items_per_folder = cli
        .max_items_per_folder
        .or_else(|| env_usize("TMV_MAX_ITEMS_PER_FOLDER"))
        .or_else(|| env_usize("MAX_ITEMS_PER_FOLDER"))
        .unwrap_or(20_000);
    let stat_concurrency = cli
        .stat_concurrency
        .or_else(|| env_usize("TMV_STAT_CONCURRENCY"))
        .or_else(|| env_usize("STAT_CONCURRENCY"))
        .unwrap_or(24);
    let enable_light_root_mode = cli
        .enable_light_root_mode
        .or_else(|| env_bool("TMV_ENABLE_LIGHT_ROOT_MODE"))
        .or_else(|| env_bool("ENABLE_LIGHT_ROOT_MODE"))
        .unwrap_or(true);
    let require_lan_token = cli
        .require_lan_token
        .or_else(|| env_bool("TMV_REQUIRE_LAN_TOKEN"))
        .or_else(|| env_bool("REQUIRE_LAN_TOKEN"))
        .unwrap_or(true);
    let lan_password = cli
        .lan_password
        .or_else(|| env_string("TMV_LAN_PASSWORD"))
        .unwrap_or_default();
    let media_access_token = cli
        .media_access_token
        .or_else(|| env_string("TMV_MEDIA_ACCESS_TOKEN"))
        .or_else(|| env_string("MEDIA_ACCESS_TOKEN"))
        .unwrap_or_else(random_token);
    let cors_allowed_origins = parse_origins(
        cli.cors_allowed_origins
            .or_else(|| env_string("TMV_CORS_ALLOWED_ORIGINS"))
            .or_else(|| env_string("CORS_ALLOWED_ORIGINS")),
    );

    let backend = BackendService::new(
        BackendConfig {
            media_root,
            preview_limit,
            preview_batch_limit,
            folder_page_limit,
            max_folder_page_limit,
            max_items_per_folder,
            stat_concurrency,
            thumbnail_cache_dir: thumbnail_dir,
        },
        IndexStore::new(index_dir).await?,
        DiagnosticsWriter::new(diagnostics_dir).await?,
    )
    .await?;

    let access_control = match runtime_mode {
        RuntimeModeCli::Desktop => AccessControl::DesktopManaged {
            access_mode: match access_mode {
                AccessModeCli::Local => AccessMode::Local,
                AccessModeCli::Lan => AccessMode::Lan,
            },
            lan_password,
            session_token: random_token(),
        },
        RuntimeModeCli::Legacy => AccessControl::LegacyStandalone {
            require_lan_token,
            media_access_token,
            cors_allowed_origins: normalize_legacy_origins(&cors_allowed_origins),
        },
    };

    let api_state = ApiState {
        service: backend.clone(),
        access_control,
        enable_light_root_mode,
        preview_batch_limit,
    };
    let index_file = viewer_dir.join("index.html");
    let app = Router::new()
        .merge(build_api_router())
        .fallback_service(ServeDir::new(&viewer_dir).not_found_service(ServeFile::new(index_file)))
        .with_state(api_state.clone())
        .layer(middleware::from_fn_with_state(api_state, enforce_access));

    let address: SocketAddr = format!("{bind_host}:{port}")
        .parse()
        .with_context(|| format!("parse bind address {bind_host}:{port}"))?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!("tmv backend listening on {}", listener.local_addr()?);

    let backend_for_shutdown = backend.clone();
    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = tokio::signal::ctrl_c().await;
        backend_for_shutdown.close();
    });

    server.await?;
    Ok(())
}

fn default_app_support_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library")
        .join("Application Support")
        .join("TinyMediaViewer")
}

fn default_media_root() -> Result<PathBuf> {
    let cwd = env::current_dir().context("resolve current dir for default media root")?;
    Ok(cwd.join("..").join(".."))
}

fn default_bind_host(runtime_mode: RuntimeModeCli, access_mode: AccessModeCli) -> String {
    match runtime_mode {
        RuntimeModeCli::Legacy => "0.0.0.0".to_string(),
        RuntimeModeCli::Desktop => match access_mode {
            AccessModeCli::Local => "127.0.0.1".to_string(),
            AccessModeCli::Lan => "0.0.0.0".to_string(),
        },
    }
}

fn default_port(runtime_mode: RuntimeModeCli) -> u16 {
    match runtime_mode {
        RuntimeModeCli::Legacy => 4000,
        RuntimeModeCli::Desktop => 4300,
    }
}

fn resolve_viewer_dir(explicit: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(viewer_dir) = explicit {
        return Ok(viewer_dir);
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir.join("../../../../desktop/src-tauri/resources/viewer"),
        manifest_dir.join("../../../../web/dist"),
    ];
    for candidate in candidates {
        if candidate.join("index.html").exists() {
            return Ok(candidate);
        }
    }
    anyhow::bail!("Unable to resolve viewer_dir; pass --viewer-dir or TMV_VIEWER_DIR")
}

fn env_string(name: &str) -> Option<String> {
    let value = env::var(name).ok()?;
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn env_path(name: &str) -> Option<PathBuf> {
    env_string(name).map(PathBuf::from)
}

fn env_usize(name: &str) -> Option<usize> {
    env_string(name)?.parse().ok()
}

fn env_u16(name: &str) -> Option<u16> {
    env_string(name)?.parse().ok()
}

fn env_bool(name: &str) -> Option<bool> {
    let raw = env_string(name)?;
    match raw.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn env_value_enum<T>(name: &str) -> Option<T>
where
    T: ValueEnum,
{
    let raw = env_string(name)?;
    T::from_str(&raw, true).ok()
}

fn parse_origins(value: Option<String>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let items = value
        .split(',')
        .map(|item| item.trim().trim_end_matches('/').to_string())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    if items.is_empty() {
        Vec::new()
    } else {
        items
    }
}

fn random_token() -> String {
    let salt = format!(
        "{}:{}:{}",
        SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0),
        process::id(),
        env::var("USER").unwrap_or_default()
    );
    let mut digest = Sha1::new();
    digest.update(salt.as_bytes());
    format!("{:x}", digest.finalize())
}
