use anyhow::{anyhow, Context, Result};
use futures::{stream, StreamExt};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    collections::{HashMap, HashSet},
    fs::Metadata,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tmv_backend_index::{
    IndexStore, PersistedMediaRecord, PersistedThumbnailJobRecord, SaveManifestInput,
};
use tmv_backend_watch::WatchRegistry;
use tokio::{
    fs,
    sync::{mpsc, Notify, Semaphore},
};

mod contracts;
mod thumbnail;

pub use contracts::{
    CategoryPagePayload, EffectsMode, EffectsRenderer, FolderCounts, FolderFavoriteInput,
    FolderFavoriteOutput, FolderIdentity, FolderMediaFilter, FolderPreview,
    FolderPreviewBatchError, FolderPreviewBatchInput, FolderPreviewBatchOutput, FolderTotals,
    MediaItem, MediaKind, PerfDiagEvent, PerfDiagEventsInput, PreviewDiagEvent,
    PreviewDiagEventsInput, PreviewDiagPhase, RootSummaryPayload, SystemUsageAccount,
    SystemUsageFile, SystemUsageReport, ViewerAccountSortMode, ViewerMediaSortMode,
    ViewerPreferences, ViewerTheme,
};
pub use thumbnail::ThumbnailError;
use thumbnail::{default_thumbnail_generator, ThumbnailGenerator};

const IMAGE_THUMBNAIL_MIN_BYTES: u64 = 512 * 1024;
const PREVIEW_RESTORE_LIMIT: usize = 64;
const THUMBNAIL_FAILURE_TTL_MS: u64 = 60_000;
const SYSTEM_USAGE_CACHE_TTL_MS: u64 = 60_000;
const ENCODE_URI_COMPONENT_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[derive(Debug, Clone)]
pub struct BackendConfig {
    pub media_root: PathBuf,
    pub preview_limit: usize,
    pub preview_batch_limit: usize,
    pub folder_page_limit: usize,
    pub max_folder_page_limit: usize,
    pub max_items_per_folder: usize,
    pub stat_concurrency: usize,
    pub thumbnail_cache_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedMediaBlob {
    name: String,
    path: String,
    url: String,
    thumbnail_url: Option<String>,
    kind: MediaKind,
    size: u64,
    modified: f64,
}

#[derive(Debug, Clone)]
pub struct FolderPreviewBatchResult {
    pub items: Vec<FolderPreview>,
    pub errors: Vec<FolderPreviewBatchError>,
    pub slowest_path: Option<String>,
    pub slowest_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderSortOrder {
    Desc,
    Asc,
}

#[derive(Debug, Clone)]
pub struct GetCategoryOptions {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub media_filter: FolderMediaFilter,
    pub sort_order: FolderSortOrder,
}

impl Default for GetCategoryOptions {
    fn default() -> Self {
        Self {
            cursor: None,
            limit: None,
            media_filter: FolderMediaFilter::Image,
            sort_order: FolderSortOrder::Desc,
        }
    }
}

impl BackendService {
    pub fn default_folder_page_limit(&self) -> usize {
        self.config.folder_page_limit
    }

    pub async fn set_folder_favorite(
        &self,
        relative_path: &str,
        favorite: bool,
    ) -> Result<FolderFavoriteOutput> {
        let safe_relative_path = normalize_relative_path(relative_path)?;
        if safe_relative_path.is_empty() {
            return Err(anyhow!("Favorite path must not be empty"));
        }

        self.index
            .set_folder_favorite(safe_relative_path.clone(), favorite)
            .await?;
        self.clear_snapshot_cache();

        Ok(FolderFavoriteOutput {
            path: safe_relative_path,
            favorite,
        })
    }

    pub async fn get_system_usage_report(
        &self,
        limit: usize,
        bypass_cache: bool,
    ) -> Result<SystemUsageReport> {
        let max_items = limit.max(1);
        let root_generation = self.path_generation("");
        let cache_key = SystemUsageCacheKey {
            limit: max_items,
            root_generation,
        };

        if !bypass_cache {
            if let Some(cached) = self
                .caches
                .lock()
                .expect("scanner caches poisoned")
                .system_usage
                .get(&cache_key)
                .filter(|entry| {
                    now_ms_u64().saturating_sub(entry.cached_at_ms) <= SYSTEM_USAGE_CACHE_TTL_MS
                })
                .map(|entry| entry.report.clone())
            {
                return Ok(cached);
            }
        }

        let root_path = self.config.media_root.clone();
        let report =
            tokio::task::spawn_blocking(move || build_system_usage_report(&root_path, max_items))
                .await
                .map_err(|error| anyhow!("join system usage scan task: {error}"))??;

        self.caches
            .lock()
            .expect("scanner caches poisoned")
            .system_usage
            .insert(
                cache_key,
                SystemUsageCacheEntry {
                    cached_at_ms: now_ms_u64(),
                    report: report.clone(),
                },
            );

        Ok(report)
    }

    pub async fn load_viewer_preferences(&self) -> Result<ViewerPreferences> {
        let Some(payload_json) = self.index.load_viewer_preferences().await? else {
            return Ok(ViewerPreferences::default());
        };
        let parsed: ViewerPreferences =
            serde_json::from_str(&payload_json).context("parse persisted viewer preferences")?;
        sanitize_viewer_preferences(parsed)
    }

    pub async fn save_viewer_preferences(
        &self,
        preferences: ViewerPreferences,
    ) -> Result<ViewerPreferences> {
        let sanitized = sanitize_viewer_preferences(preferences)?;
        let payload_json =
            serde_json::to_string(&sanitized).context("serialize viewer preferences")?;
        self.index.save_viewer_preferences(payload_json).await?;
        Ok(sanitized)
    }
}

impl From<&MediaItem> for PersistedMediaBlob {
    fn from(value: &MediaItem) -> Self {
        Self {
            name: value.name.clone(),
            path: value.path.clone(),
            url: value.url.clone(),
            thumbnail_url: value.thumbnail_url.clone(),
            kind: value.kind.clone(),
            size: value.size,
            modified: value.modified,
        }
    }
}

impl From<PersistedMediaBlob> for MediaItem {
    fn from(value: PersistedMediaBlob) -> Self {
        Self {
            name: value.name,
            path: value.path,
            url: value.url,
            thumbnail_url: value.thumbnail_url,
            kind: value.kind,
            size: value.size,
            modified: value.modified,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedMedia {
    pub safe_relative_path: String,
    pub absolute_path: PathBuf,
    pub kind: MediaKind,
}

#[derive(Debug, Clone)]
pub struct FolderSnapshot {
    pub folder: FolderIdentity,
    pub breadcrumb: Vec<FolderIdentity>,
    pub subfolders: Vec<FolderPreview>,
    pub totals: FolderTotals,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FolderEntryCandidate {
    name: String,
    relative_path: String,
    absolute_path: PathBuf,
    modified: f64,
}

#[derive(Debug, Clone)]
struct MediaCandidate {
    name: String,
    relative_path: String,
    absolute_path: PathBuf,
    kind: MediaKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DirectoryManifest {
    root_modified: f64,
    stamp: String,
    media: Vec<MediaItem>,
    counts: FolderCounts,
    media_total: usize,
    default_page_media_json: String,
    subfolders: Vec<FolderEntryCandidate>,
    subfolder_count: usize,
    watched_directories: Vec<FolderEntryCandidate>,
}

#[derive(Default)]
struct ScannerCaches {
    light_snapshots: HashMap<String, (u64, Arc<FolderSnapshot>)>,
    previews: HashMap<PreviewCacheKey, (u64, FolderPreview)>,
    manifests: HashMap<String, (u64, DirectoryManifest)>,
    generations: HashMap<String, u64>,
    system_usage: HashMap<SystemUsageCacheKey, SystemUsageCacheEntry>,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct PreviewCacheKey {
    path: String,
    limit: usize,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct SystemUsageCacheKey {
    limit: usize,
    root_generation: u64,
}

#[derive(Debug, Clone)]
struct SystemUsageCacheEntry {
    cached_at_ms: u64,
    report: SystemUsageReport,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct ThumbnailRequestKey {
    relative_path: String,
    modified_ms: i64,
}

impl ThumbnailRequestKey {
    fn new(relative_path: &str, modified_ms: i64) -> Self {
        Self {
            relative_path: relative_path.to_string(),
            modified_ms,
        }
    }
}

type ThumbnailTaskResult = std::result::Result<PathBuf, ThumbnailError>;

#[derive(Debug, Default)]
struct ThumbnailTaskState {
    notify: Notify,
    result: Mutex<Option<ThumbnailTaskResult>>,
}

#[derive(Debug, Clone)]
struct ThumbnailFailureEntry {
    error: ThumbnailError,
    failed_at_ms: u64,
}

enum ThumbnailTaskSlot {
    Leader(Arc<ThumbnailTaskState>),
    Follower(Arc<ThumbnailTaskState>),
}

#[derive(Clone)]
pub struct DiagnosticsWriter {
    dir: Arc<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewBatchSummary<'a> {
    ts: u64,
    request_path_count: usize,
    success_count: usize,
    failed_count: usize,
    duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    slowest_path: Option<&'a str>,
    slowest_ms: u64,
    failures: &'a [FolderPreviewBatchError],
}

impl DiagnosticsWriter {
    pub async fn new(dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&dir)
            .await
            .with_context(|| format!("create diagnostics dir {}", dir.display()))?;
        Ok(Self { dir: Arc::new(dir) })
    }

    pub async fn record_preview_events(&self, events: Vec<PreviewDiagEvent>) -> Result<()> {
        self.append_jsonl("preview-events.jsonl", events).await
    }

    pub async fn record_perf_events(&self, events: Vec<PerfDiagEvent>) -> Result<()> {
        self.append_jsonl("perf-events.jsonl", events).await
    }

    pub async fn record_gateway_line(&self, line: String) -> Result<()> {
        let path = self.dir.join("gateway.log");
        use tokio::io::AsyncWriteExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .with_context(|| format!("open {}", path.display()))?;
        file.write_all(line.as_bytes()).await?;
        Ok(())
    }

    async fn record_preview_batch_summary<'a>(
        &self,
        summary: PreviewBatchSummary<'a>,
    ) -> Result<()> {
        self.append_jsonl("server-previews.log", vec![summary])
            .await
    }

    async fn append_jsonl<T: Serialize>(&self, filename: &str, items: Vec<T>) -> Result<()> {
        if items.is_empty() {
            return Ok(());
        }
        let path = self.dir.join(filename);
        use tokio::io::AsyncWriteExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .with_context(|| format!("open {}", path.display()))?;
        for item in items {
            let line = serde_json::to_string(&item)?;
            file.write_all(line.as_bytes()).await?;
            file.write_all(b"\n").await?;
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct BackendService {
    config: Arc<BackendConfig>,
    root_real: Arc<PathBuf>,
    category_dirs: Arc<HashSet<&'static str>>,
    index: IndexStore,
    diagnostics: DiagnosticsWriter,
    caches: Arc<Mutex<ScannerCaches>>,
    manifest_validations: Arc<Mutex<HashSet<String>>>,
    watch_registry: Arc<WatchRegistry>,
    thumbnail_semaphore: Arc<Semaphore>,
    thumbnail_inflight: Arc<Mutex<HashMap<ThumbnailRequestKey, Arc<ThumbnailTaskState>>>>,
    thumbnail_failures: Arc<Mutex<HashMap<ThumbnailRequestKey, ThumbnailFailureEntry>>>,
    thumbnail_generator: Arc<dyn ThumbnailGenerator>,
}

impl BackendService {
    pub async fn new(
        config: BackendConfig,
        index: IndexStore,
        diagnostics: DiagnosticsWriter,
    ) -> Result<Self> {
        Self::new_with_thumbnail_generator(
            config,
            index,
            diagnostics,
            default_thumbnail_generator(),
        )
        .await
    }

    async fn new_with_thumbnail_generator(
        config: BackendConfig,
        index: IndexStore,
        diagnostics: DiagnosticsWriter,
        thumbnail_generator: Arc<dyn ThumbnailGenerator>,
    ) -> Result<Self> {
        let root_real = fs::canonicalize(&config.media_root)
            .await
            .with_context(|| format!("canonicalize media root {}", config.media_root.display()))?;
        let caches = Arc::new(Mutex::new(ScannerCaches::default()));
        let (invalidate_tx, mut invalidate_rx) = mpsc::unbounded_channel::<Vec<String>>();
        let caches_for_task = caches.clone();
        tokio::spawn(async move {
            while let Some(paths) = invalidate_rx.recv().await {
                let mut caches = caches_for_task.lock().expect("scanner caches poisoned");
                for path in paths {
                    let invalidated = collect_path_and_ancestors(&path);
                    for invalidated_path in invalidated {
                        let next = caches
                            .generations
                            .get(&invalidated_path)
                            .copied()
                            .unwrap_or(0)
                            + 1;
                        caches.generations.insert(invalidated_path.clone(), next);
                        remove_runtime_path_caches(&mut caches, &invalidated_path);
                    }
                }
            }
        });
        let watch_registry = WatchRegistry::new(Arc::new(move |owners| {
            let _ = invalidate_tx.send(owners);
        }))?;

        let service = Self {
            config: Arc::new(config),
            root_real: Arc::new(root_real),
            category_dirs: Arc::new(HashSet::from([
                "image", "images", "video", "videos", "gif", "gifs", "media", "medias",
            ])),
            index,
            diagnostics,
            caches,
            manifest_validations: Arc::new(Mutex::new(HashSet::new())),
            watch_registry: Arc::new(watch_registry),
            thumbnail_semaphore: Arc::new(Semaphore::new(thumbnail_worker_limit())),
            thumbnail_inflight: Arc::new(Mutex::new(HashMap::new())),
            thumbnail_failures: Arc::new(Mutex::new(HashMap::new())),
            thumbnail_generator,
        };
        service
            .index
            .put_runtime_meta(
                "settings_snapshot".to_string(),
                serde_json::to_string(&serde_json::json!({
                    "mediaRoot": service.config.media_root,
                    "previewLimit": service.config.preview_limit,
                    "folderPageLimit": service.config.folder_page_limit,
                }))?,
            )
            .await?;
        Ok(service)
    }

    #[cfg(test)]
    async fn new_for_tests(
        config: BackendConfig,
        index: IndexStore,
        diagnostics: DiagnosticsWriter,
        thumbnail_generator: Arc<dyn ThumbnailGenerator>,
    ) -> Result<Self> {
        Self::new_with_thumbnail_generator(config, index, diagnostics, thumbnail_generator).await
    }

    pub async fn get_root_summary(&self) -> Result<RootSummaryPayload> {
        let snapshot = self.get_light_snapshot("").await?;
        Ok(RootSummaryPayload {
            folder: snapshot.folder.clone(),
            breadcrumb: snapshot.breadcrumb.clone(),
            subfolders: snapshot.subfolders.clone(),
            totals: snapshot.totals.clone(),
        })
    }

    pub async fn get_category_page(
        &self,
        relative_path: &str,
        options: GetCategoryOptions,
    ) -> Result<CategoryPagePayload> {
        let (safe_relative_path, absolute_path) = self.resolve_paths(relative_path).await?;
        if safe_relative_path.is_empty() {
            return Err(anyhow!("Category path must not be empty"));
        }

        let manifest = self
            .get_directory_manifest(&absolute_path, &safe_relative_path, false)
            .await?;
        self.ensure_media_entries_for_manifest(&safe_relative_path, &manifest)
            .await?;

        let cursor = parse_cursor(options.cursor.as_deref())?;
        let limit = options
            .limit
            .unwrap_or(self.config.folder_page_limit)
            .clamp(1, self.config.max_folder_page_limit);
        let filter_group = media_filter_group(options.media_filter).to_string();
        let filtered_total = usize::try_from(
            self.index
                .count_media_entries(safe_relative_path.clone(), Some(filter_group.clone()))
                .await?,
        )
        .unwrap_or(0);
        if cursor > filtered_total {
            return Err(anyhow!("Cursor exceeds media item count"));
        }

        let payloads = self
            .index
            .load_media_page_payloads(
                safe_relative_path.clone(),
                Some(filter_group),
                options.sort_order == FolderSortOrder::Desc,
                cursor as i64,
                limit as i64,
            )
            .await?;
        let media = deserialize_media_payloads(payloads)?;
        let next_cursor =
            (cursor + media.len() < filtered_total).then(|| (cursor + media.len()).to_string());

        Ok(CategoryPagePayload {
            folder: folder_identity(&self.config.media_root, &safe_relative_path),
            breadcrumb: build_breadcrumb(&safe_relative_path),
            media,
            counts: manifest.counts.clone(),
            total_media: manifest.media_total,
            filtered_total,
            next_cursor,
        })
    }

    pub async fn get_folder_previews(
        &self,
        paths: Vec<String>,
        limit_per_folder: Option<usize>,
    ) -> FolderPreviewBatchResult {
        let started_at = Instant::now();
        let unique_paths = dedupe_paths(paths);
        let request_path_count = unique_paths.len();
        let limit = clamp(
            limit_per_folder.unwrap_or(self.config.preview_limit),
            1,
            self.config
                .preview_limit
                .max(self.config.preview_limit.saturating_mul(4)),
        );
        let concurrency = clamp(self.config.stat_concurrency / 2, 2, 8);
        let results = stream::iter(unique_paths.into_iter().map(|path| async move {
            let started = Instant::now();
            let outcome = self.get_folder_preview(&path, limit).await;
            (
                path,
                started.elapsed().as_millis() as u64,
                outcome.map_err(|error| error.to_string()),
            )
        }))
        .buffered(concurrency)
        .collect::<Vec<_>>()
        .await;

        let mut items = Vec::new();
        let mut errors = Vec::new();
        let mut slowest_path = None;
        let mut slowest_ms = 0_u64;

        for (path, elapsed_ms, outcome) in results {
            if elapsed_ms > slowest_ms {
                slowest_ms = elapsed_ms;
                slowest_path = Some(path.clone());
            }
            match outcome {
                Ok(item) => items.push(item),
                Err(error) => errors.push(FolderPreviewBatchError { path, error }),
            }
        }

        let _ = self
            .diagnostics
            .record_preview_batch_summary(PreviewBatchSummary {
                ts: now_ms_u64(),
                request_path_count,
                success_count: items.len(),
                failed_count: errors.len(),
                duration_ms: started_at.elapsed().as_millis() as u64,
                slowest_path: slowest_path.as_deref(),
                slowest_ms,
                failures: &errors,
            })
            .await;

        FolderPreviewBatchResult {
            items,
            errors,
            slowest_path,
            slowest_ms,
        }
    }

    pub async fn resolve_media_file(&self, relative_path: &str) -> Result<ResolvedMedia> {
        let (safe_relative_path, absolute_path) = self.resolve_paths(relative_path).await?;
        if safe_relative_path.is_empty() {
            return Err(anyhow!("Missing media file path"));
        }
        let kind = detect_media_kind_from_path(&absolute_path)
            .ok_or_else(|| anyhow!("Unsupported media extension"))?;
        Ok(ResolvedMedia {
            safe_relative_path,
            absolute_path,
            kind,
        })
    }

    async fn lookup_cached_thumbnail_path(
        &self,
        request: &ThumbnailRequestKey,
    ) -> std::result::Result<Option<PathBuf>, ThumbnailError> {
        let Some(cached) = self
            .index
            .load_thumbnail_asset(request.relative_path.clone(), request.modified_ms)
            .await
            .map_err(|error| ThumbnailError::Io(format!("load cached thumbnail asset: {error}")))?
        else {
            return Ok(None);
        };

        let cached_path = PathBuf::from(&cached);
        if fs::metadata(&cached_path).await.is_ok() {
            return Ok(Some(cached_path));
        }

        Ok(None)
    }

    fn remember_thumbnail_failure(&self, request: &ThumbnailRequestKey, error: ThumbnailError) {
        let mut failures = self
            .thumbnail_failures
            .lock()
            .expect("thumbnail failures poisoned");
        let now = now_ms_u64();
        failures
            .retain(|_, entry| now.saturating_sub(entry.failed_at_ms) <= THUMBNAIL_FAILURE_TTL_MS);
        failures.insert(
            request.clone(),
            ThumbnailFailureEntry {
                error,
                failed_at_ms: now,
            },
        );
    }

    fn clear_thumbnail_failure(&self, request: &ThumbnailRequestKey) {
        let mut failures = self
            .thumbnail_failures
            .lock()
            .expect("thumbnail failures poisoned");
        failures.remove(request);
    }

    fn recent_thumbnail_failure_error(
        &self,
        request: &ThumbnailRequestKey,
    ) -> Option<ThumbnailError> {
        let mut failures = self
            .thumbnail_failures
            .lock()
            .expect("thumbnail failures poisoned");
        let now = now_ms_u64();
        failures
            .retain(|_, entry| now.saturating_sub(entry.failed_at_ms) <= THUMBNAIL_FAILURE_TTL_MS);
        failures.get(request).map(|entry| entry.error.clone())
    }

    async fn load_recent_thumbnail_failure(
        &self,
        request: &ThumbnailRequestKey,
    ) -> std::result::Result<Option<ThumbnailError>, ThumbnailError> {
        if let Some(error) = self.recent_thumbnail_failure_error(request) {
            return Ok(Some(error));
        }

        let Some(job) = self
            .index
            .load_thumbnail_job(request.relative_path.clone(), request.modified_ms)
            .await
            .map_err(|error| ThumbnailError::Io(format!("load cached thumbnail job: {error}")))?
        else {
            return Ok(None);
        };

        if let Some(error) = thumbnail_job_error_if_recent(&job) {
            let error = ThumbnailError::from_persisted(error);
            self.remember_thumbnail_failure(request, error.clone());
            return Ok(Some(error));
        }

        Ok(None)
    }

    fn start_thumbnail_task(&self, request: &ThumbnailRequestKey) -> ThumbnailTaskSlot {
        let mut inflight = self
            .thumbnail_inflight
            .lock()
            .expect("thumbnail inflight map poisoned");
        if let Some(state) = inflight.get(request) {
            return ThumbnailTaskSlot::Follower(state.clone());
        }

        let state = Arc::new(ThumbnailTaskState::default());
        inflight.insert(request.clone(), state.clone());
        ThumbnailTaskSlot::Leader(state)
    }

    fn finish_thumbnail_task(
        &self,
        request: &ThumbnailRequestKey,
        state: &Arc<ThumbnailTaskState>,
        result: ThumbnailTaskResult,
    ) -> ThumbnailTaskResult {
        {
            let mut slot = state.result.lock().expect("thumbnail task result poisoned");
            *slot = Some(result.clone());
        }
        let mut inflight = self
            .thumbnail_inflight
            .lock()
            .expect("thumbnail inflight map poisoned");
        inflight.remove(request);
        state.notify.notify_waiters();
        result
    }

    async fn wait_for_thumbnail_task(
        state: Arc<ThumbnailTaskState>,
    ) -> std::result::Result<PathBuf, ThumbnailError> {
        loop {
            let notified = state.notify.notified();
            if let Some(result) = state
                .result
                .lock()
                .expect("thumbnail task result poisoned")
                .clone()
            {
                return result;
            }
            notified.await;
        }
    }

    async fn generate_thumbnail_path(
        &self,
        request: &ThumbnailRequestKey,
        absolute_path: &Path,
        kind: MediaKind,
    ) -> std::result::Result<PathBuf, ThumbnailError> {
        if let Some(cached) = self.lookup_cached_thumbnail_path(request).await? {
            self.clear_thumbnail_failure(request);
            return Ok(cached);
        }

        let _permit = self.thumbnail_semaphore.acquire().await.map_err(|error| {
            ThumbnailError::Io(format!("acquire thumbnail worker permit: {error}"))
        })?;
        if let Some(cached) = self.lookup_cached_thumbnail_path(request).await? {
            self.clear_thumbnail_failure(request);
            return Ok(cached);
        }

        fs::create_dir_all(&self.config.thumbnail_cache_dir)
            .await
            .map_err(|error| {
                ThumbnailError::Io(format!(
                    "create thumbnail cache dir {}: {error}",
                    self.config.thumbnail_cache_dir.display()
                ))
            })?;
        let digest = sha1_hex(request.relative_path.as_bytes());
        let output_path = self
            .config
            .thumbnail_cache_dir
            .join(format!("{digest}.jpg"));
        let temp_path = self
            .config
            .thumbnail_cache_dir
            .join(format!("{digest}.tmp.jpg"));
        let _ = fs::remove_file(&temp_path).await;

        self.index
            .save_thumbnail_job(
                request.relative_path.clone(),
                request.modified_ms,
                "running".to_string(),
                None,
            )
            .await
            .map_err(|error| {
                ThumbnailError::Io(format!("persist running thumbnail job: {error}"))
            })?;

        let generator = self.thumbnail_generator.clone();
        let source_path = absolute_path.to_path_buf();
        let generated =
            tokio::task::spawn_blocking(move || generator.generate_jpeg(source_path, kind))
                .await
                .map_err(|error| {
                    ThumbnailError::Io(format!("join thumbnail generation task: {error}"))
                })?;
        let bytes = match generated {
            Ok(bytes) => bytes,
            Err(error) => {
                let message = error.to_string();
                self.index
                    .save_thumbnail_job(
                        request.relative_path.clone(),
                        request.modified_ms,
                        "error".to_string(),
                        Some(message.clone()),
                    )
                    .await
                    .map_err(|save_error| {
                        ThumbnailError::Io(format!("persist thumbnail job failure: {save_error}"))
                    })?;
                self.remember_thumbnail_failure(request, error.clone());
                return Err(error);
            }
        };

        fs::write(&temp_path, bytes).await.map_err(|error| {
            ThumbnailError::Io(format!(
                "write thumbnail temp file {}: {error}",
                temp_path.display()
            ))
        })?;

        if let Err(error) = fs::rename(&temp_path, &output_path).await {
            let _ = fs::remove_file(&temp_path).await;
            return Err(ThumbnailError::Io(format!(
                "rename thumbnail {} -> {}: {error}",
                temp_path.display(),
                output_path.display()
            )));
        }
        self.index
            .save_thumbnail_asset(
                request.relative_path.clone(),
                request.modified_ms,
                output_path.to_string_lossy().to_string(),
            )
            .await
            .map_err(|error| ThumbnailError::Io(format!("persist thumbnail asset: {error}")))?;
        self.index
            .save_thumbnail_job(
                request.relative_path.clone(),
                request.modified_ms,
                "ready".to_string(),
                None,
            )
            .await
            .map_err(|error| ThumbnailError::Io(format!("persist ready thumbnail job: {error}")))?;
        self.clear_thumbnail_failure(request);
        Ok(output_path)
    }

    pub async fn get_thumbnail_path(
        &self,
        relative_path: &str,
        absolute_path: &Path,
        modified_ms: i64,
        kind: MediaKind,
    ) -> std::result::Result<PathBuf, ThumbnailError> {
        let request = ThumbnailRequestKey::new(relative_path, modified_ms);

        if let Some(cached) = self.lookup_cached_thumbnail_path(&request).await? {
            self.clear_thumbnail_failure(&request);
            return Ok(cached);
        }

        if let Some(error) = self.load_recent_thumbnail_failure(&request).await? {
            return Err(error);
        }

        match self.start_thumbnail_task(&request) {
            ThumbnailTaskSlot::Leader(state) => {
                let result = self
                    .generate_thumbnail_path(&request, absolute_path, kind)
                    .await;
                self.finish_thumbnail_task(&request, &state, result)
            }
            ThumbnailTaskSlot::Follower(state) => Self::wait_for_thumbnail_task(state).await,
        }
    }

    pub async fn record_preview_events(&self, events: Vec<PreviewDiagEvent>) -> Result<()> {
        self.diagnostics.record_preview_events(events).await
    }

    pub async fn record_perf_events(&self, events: Vec<PerfDiagEvent>) -> Result<()> {
        self.diagnostics.record_perf_events(events).await
    }

    pub async fn record_gateway_log(&self, line: String) -> Result<()> {
        self.diagnostics.record_gateway_line(line).await
    }

    pub fn close(&self) {
        self.watch_registry.clear();
    }

    async fn get_light_snapshot(&self, relative_path: &str) -> Result<Arc<FolderSnapshot>> {
        let (safe_relative_path, absolute_path) = self.resolve_paths(relative_path).await?;
        let generation = self.path_generation(&safe_relative_path);
        let use_snapshot_cache = !safe_relative_path.is_empty();
        if use_snapshot_cache {
            if let Some(snapshot) = self.read_light_snapshot_cache(&safe_relative_path, generation)
            {
                return Ok(snapshot);
            }
        }

        let scan = self
            .scan_folder_entries(&absolute_path, &safe_relative_path, false, true)
            .await?;
        let mut subfolders = Vec::with_capacity(scan.subfolders.len());
        for entry in &scan.subfolders {
            subfolders.push(FolderPreview {
                name: entry.name.clone(),
                path: entry.relative_path.clone(),
                modified: entry.modified,
                counts: FolderCounts::default(),
                previews: Vec::new(),
                counts_ready: false,
                preview_ready: false,
                favorite: false,
                approximate: Some(true),
            });
        }
        subfolders.sort_by(|a, b| b.modified.total_cmp(&a.modified));
        subfolders = self.annotate_folder_favorites(subfolders).await?;

        let snapshot = Arc::new(FolderSnapshot {
            folder: folder_identity(&self.config.media_root, &safe_relative_path),
            breadcrumb: build_breadcrumb(&safe_relative_path),
            totals: FolderTotals {
                media: scan.media_candidates.len(),
                subfolders: subfolders.len(),
            },
            subfolders,
        });
        if use_snapshot_cache {
            self.write_light_snapshot_cache(safe_relative_path, generation, snapshot.clone());
        }
        Ok(snapshot)
    }

    async fn get_folder_preview(
        &self,
        relative_path: &str,
        preview_limit: usize,
    ) -> Result<FolderPreview> {
        let (safe_relative_path, absolute_path) = self.resolve_paths(relative_path).await?;
        self.get_resolved_folder_preview(&absolute_path, &safe_relative_path, preview_limit)
            .await
    }

    async fn get_resolved_folder_preview(
        &self,
        absolute_path: &Path,
        safe_relative_path: &str,
        preview_limit: usize,
    ) -> Result<FolderPreview> {
        let generation = self.path_generation(safe_relative_path);
        let cache_key = PreviewCacheKey {
            path: safe_relative_path.to_string(),
            limit: preview_limit,
        };
        if let Some(preview) = self.read_preview_cache(&cache_key, generation) {
            return self.annotate_folder_favorite(preview).await;
        }

        let manifest = self
            .get_directory_manifest(absolute_path, safe_relative_path, false)
            .await?;
        self.ensure_media_entries_for_manifest(safe_relative_path, &manifest)
            .await?;
        let stamp = preview_stamp(&manifest.stamp, preview_limit);
        if let Some(serialized) = self
            .index
            .load_preview(
                safe_relative_path.to_string(),
                preview_limit as i64,
                stamp.clone(),
            )
            .await?
        {
            let preview = serde_json::from_str::<FolderPreview>(&serialized)?;
            self.write_preview_cache(cache_key.clone(), generation, preview.clone());
            return self.annotate_folder_favorite(preview).await;
        }

        let previews = self
            .load_media_items_from_index(
                safe_relative_path,
                None,
                FolderSortOrder::Desc,
                0,
                preview_limit.min(PREVIEW_RESTORE_LIMIT),
            )
            .await?;
        let mut modified = previews
            .iter()
            .map(|item| item.modified)
            .fold(0.0_f64, f64::max);
        if modified == 0.0 {
            modified = dir_modified(absolute_path).await.unwrap_or(0.0);
        }

        let preview = FolderPreview {
            name: basename_or_root(safe_relative_path, &self.config.media_root),
            path: safe_relative_path.to_string(),
            modified,
            counts: manifest.counts.clone(),
            previews,
            counts_ready: true,
            preview_ready: true,
            favorite: false,
            approximate: Some(false),
        };

        self.index
            .save_preview(
                safe_relative_path.to_string(),
                preview_limit as i64,
                stamp,
                serde_json::to_string(&preview)?,
            )
            .await?;
        self.write_preview_cache(cache_key, generation, preview.clone());
        self.annotate_folder_favorite(preview).await
    }

    async fn get_directory_manifest(
        &self,
        absolute_path: &Path,
        safe_relative_path: &str,
        allow_fast_restore: bool,
    ) -> Result<DirectoryManifest> {
        let generation = self.path_generation(safe_relative_path);
        if let Some(manifest) = self.read_manifest_cache(safe_relative_path, generation) {
            return Ok(manifest);
        }

        let root_modified = dir_modified(absolute_path).await?;
        if let Some(record) = self
            .index
            .load_latest_manifest(safe_relative_path.to_string())
            .await?
        {
            if !self
                .index
                .has_media_entries(safe_relative_path.to_string())
                .await?
            {
                if let Some(backfilled) = self
                    .backfill_media_entries_from_legacy_manifest(safe_relative_path, &record)
                    .await?
                {
                    self.install_manifest_watches(absolute_path, safe_relative_path, &backfilled);
                    self.write_manifest_cache(
                        safe_relative_path.to_string(),
                        generation,
                        backfilled.clone(),
                    );
                    return Ok(backfilled);
                }
            }

            let persisted = self.hydrate_manifest_record(&record, false)?;
            if (persisted.root_modified - root_modified).abs() < f64::EPSILON {
                if allow_fast_restore {
                    self.install_manifest_watches(absolute_path, safe_relative_path, &persisted);
                    self.write_manifest_cache(
                        safe_relative_path.to_string(),
                        generation,
                        persisted.clone(),
                    );
                    self.schedule_manifest_validation(
                        absolute_path.to_path_buf(),
                        safe_relative_path.to_string(),
                        generation,
                        root_modified,
                        persisted.clone(),
                    );
                    return Ok(persisted);
                }

                if let Some((validated, should_persist)) = self
                    .validate_persisted_manifest(safe_relative_path, root_modified, persisted)
                    .await?
                {
                    if should_persist {
                        self.persist_manifest(safe_relative_path, &validated)
                            .await?;
                    }
                    self.install_manifest_watches(absolute_path, safe_relative_path, &validated);
                    self.write_manifest_cache(
                        safe_relative_path.to_string(),
                        generation,
                        validated.clone(),
                    );
                    return Ok(validated);
                }
            }
        }

        let manifest = self
            .build_directory_manifest(absolute_path, safe_relative_path, root_modified)
            .await?;
        self.persist_manifest(safe_relative_path, &manifest).await?;
        self.install_manifest_watches(absolute_path, safe_relative_path, &manifest);
        self.write_manifest_cache(safe_relative_path.to_string(), generation, manifest.clone());
        Ok(manifest)
    }

    async fn build_directory_manifest(
        &self,
        absolute_path: &Path,
        safe_relative_path: &str,
        root_modified: f64,
    ) -> Result<DirectoryManifest> {
        let scan = self
            .scan_folder_entries(absolute_path, safe_relative_path, true, true)
            .await?;
        let mut media = self.build_media_items(scan.media_candidates).await?;
        media.sort_by(compare_media_items_by_time_desc);
        let default_page_media_json =
            build_default_page_media_json(&media, self.config.folder_page_limit)?;
        let mut counts = FolderCounts {
            subfolders: scan.subfolder_count,
            ..FolderCounts::default()
        };
        for item in &media {
            increment_counts(&mut counts, &item.kind);
        }

        let mut manifest = DirectoryManifest {
            root_modified,
            stamp: String::new(),
            media,
            counts,
            media_total: 0,
            default_page_media_json,
            subfolders: scan.subfolders,
            subfolder_count: scan.subfolder_count,
            watched_directories: scan.watched_directories,
        };
        manifest.media_total = manifest.media.len();
        manifest.stamp = build_manifest_stamp_from_manifest(&manifest);
        Ok(manifest)
    }

    async fn persist_manifest(
        &self,
        safe_relative_path: &str,
        manifest: &DirectoryManifest,
    ) -> Result<()> {
        let media_records = manifest
            .media
            .iter()
            .enumerate()
            .map(|(ordinal, item)| PersistedMediaRecord {
                ordinal: ordinal as i64,
                media_path: item.path.clone(),
                filter_group: media_filter_group_for_item(item).to_string(),
                name: item.name.clone(),
                kind: media_kind_as_str(&item.kind).to_string(),
                sort_ts_ms: media_sort_time_key(item),
                modified: item.modified,
                size: item.size as i64,
                payload_json: serde_json::to_string(item).expect("serialize media item"),
            })
            .collect();

        self.index
            .save_manifest(SaveManifestInput {
                path: safe_relative_path.to_string(),
                stamp: manifest.stamp.clone(),
                root_modified: manifest.root_modified,
                media_total: manifest.media_total as i64,
                image_total: manifest.counts.images as i64,
                gif_total: manifest.counts.gifs as i64,
                video_total: manifest.counts.videos as i64,
                subfolders_json: serde_json::to_string(&manifest.subfolders)?,
                watched_dirs_json: serde_json::to_string(&manifest.watched_directories)?,
                media_json: "[]".to_string(),
                media_bin: Vec::new(),
                default_page_media_json: manifest.default_page_media_json.clone(),
                media: media_records,
            })
            .await
    }

    fn hydrate_manifest_record(
        &self,
        record: &tmv_backend_index::PersistedManifestRecord,
        include_legacy_media: bool,
    ) -> Result<DirectoryManifest> {
        let subfolders =
            serde_json::from_str::<Vec<FolderEntryCandidate>>(&record.subfolders_json)?;
        let watched_directories =
            serde_json::from_str::<Vec<FolderEntryCandidate>>(&record.watched_dirs_json)?;
        let mut media: Vec<MediaItem> = if include_legacy_media {
            match &record.media_bin {
                Some(media_bin) if !media_bin.is_empty() => {
                    let persisted = bincode::deserialize::<Vec<PersistedMediaBlob>>(media_bin)?;
                    persisted
                        .into_iter()
                        .map(MediaItem::from)
                        .map(normalize_media_item_capabilities)
                        .collect()
                }
                _ => serde_json::from_str::<Vec<MediaItem>>(&record.media_json)?
                    .into_iter()
                    .map(normalize_media_item_capabilities)
                    .collect(),
            }
        } else {
            Vec::new()
        };
        media.sort_by(compare_media_items_by_time_desc);
        let mut counts = FolderCounts {
            images: usize::try_from(record.image_total).unwrap_or(0),
            gifs: usize::try_from(record.gif_total).unwrap_or(0),
            videos: usize::try_from(record.video_total).unwrap_or(0),
            subfolders: subfolders.len(),
        };
        let mut media_total = usize::try_from(record.media_total).unwrap_or(0);
        if media_total == 0 && !media.is_empty() {
            media_total = media.len();
        }
        if counts.images == 0 && counts.gifs == 0 && counts.videos == 0 && !media.is_empty() {
            for item in &media {
                increment_counts(&mut counts, &item.kind);
            }
            media_total = media.len();
        }
        let default_page_media_json = match record.default_page_media_json.as_deref() {
            Some(value) if !value.trim().is_empty() => value.to_string(),
            _ => build_default_page_media_json(&media, self.config.folder_page_limit)?,
        };
        Ok(DirectoryManifest {
            root_modified: record.root_modified,
            stamp: record.stamp.clone(),
            subfolder_count: subfolders.len(),
            subfolders,
            watched_directories,
            media,
            counts,
            media_total,
            default_page_media_json,
        })
    }

    async fn backfill_media_entries_from_legacy_manifest(
        &self,
        safe_relative_path: &str,
        record: &tmv_backend_index::PersistedManifestRecord,
    ) -> Result<Option<DirectoryManifest>> {
        let hydrated = self.hydrate_manifest_record(record, true)?;
        if hydrated.media.is_empty() {
            return Ok(None);
        }
        self.persist_manifest(safe_relative_path, &hydrated).await?;
        Ok(Some(DirectoryManifest {
            media: Vec::new(),
            ..hydrated
        }))
    }

    async fn ensure_media_entries_for_manifest(
        &self,
        safe_relative_path: &str,
        manifest: &DirectoryManifest,
    ) -> Result<()> {
        if self
            .index
            .has_media_entries(safe_relative_path.to_string())
            .await?
        {
            return Ok(());
        }

        if manifest.media.is_empty() {
            return Err(anyhow!(
                "missing media index for folder {safe_relative_path}"
            ));
        }

        self.persist_manifest(safe_relative_path, manifest).await
    }

    async fn load_media_items_from_index(
        &self,
        safe_relative_path: &str,
        filter_group: Option<&str>,
        sort_order: FolderSortOrder,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<MediaItem>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let payloads = self
            .index
            .load_media_page_payloads(
                safe_relative_path.to_string(),
                filter_group.map(ToString::to_string),
                sort_order == FolderSortOrder::Desc,
                offset as i64,
                limit as i64,
            )
            .await?;
        deserialize_media_payloads(payloads)
    }

    fn schedule_manifest_validation(
        &self,
        absolute_path: PathBuf,
        safe_relative_path: String,
        generation: u64,
        root_modified: f64,
        persisted: DirectoryManifest,
    ) {
        {
            let mut validations = self
                .manifest_validations
                .lock()
                .expect("manifest validations poisoned");
            if !validations.insert(safe_relative_path.clone()) {
                return;
            }
        }

        let service = self.clone();
        tokio::spawn(async move {
            let result = service
                .validate_persisted_manifest(&safe_relative_path, root_modified, persisted)
                .await;

            match result {
                Ok(Some((validated, should_persist)))
                    if service.path_generation(&safe_relative_path) == generation =>
                {
                    service.install_manifest_watches(
                        &absolute_path,
                        &safe_relative_path,
                        &validated,
                    );
                    service.write_manifest_cache(
                        safe_relative_path.clone(),
                        generation,
                        validated.clone(),
                    );
                    if should_persist {
                        let _ = service
                            .persist_manifest(&safe_relative_path, &validated)
                            .await;
                    }
                }
                Ok(None) if service.path_generation(&safe_relative_path) == generation => {
                    service.invalidate_runtime_path(&safe_relative_path);
                }
                _ => {}
            }

            service
                .manifest_validations
                .lock()
                .expect("manifest validations poisoned")
                .remove(&safe_relative_path);
        });
    }

    async fn validate_persisted_manifest(
        &self,
        safe_relative_path: &str,
        root_modified: f64,
        persisted: DirectoryManifest,
    ) -> Result<Option<(DirectoryManifest, bool)>> {
        if (persisted.root_modified - root_modified).abs() >= f64::EPSILON {
            return Ok(None);
        }

        let refreshed_watch = self
            .refresh_persisted_watched_directories(&persisted.watched_directories)
            .await?;
        let Some(refreshed_watch) = refreshed_watch else {
            return Ok(None);
        };

        if !refreshed_watch.changed_category_dirs.is_empty()
            || !refreshed_watch.changed_subfolders.is_empty()
        {
            let (_, absolute_path) = self.resolve_paths(safe_relative_path).await?;
            let rebuilt = self
                .build_directory_manifest(&absolute_path, safe_relative_path, root_modified)
                .await?;
            return Ok(Some((rebuilt, true)));
        }

        let mut subfolders = Vec::with_capacity(persisted.subfolders.len());
        for subfolder in &persisted.subfolders {
            let Some(refreshed) = refreshed_watch.by_path.get(&subfolder.relative_path) else {
                return Ok(None);
            };
            subfolders.push(refreshed.clone());
        }

        Ok(Some((
            DirectoryManifest {
                subfolders,
                watched_directories: refreshed_watch.entries,
                media: Vec::new(),
                ..persisted
            },
            false,
        )))
    }

    async fn refresh_persisted_watched_directories(
        &self,
        watched_directories: &[FolderEntryCandidate],
    ) -> Result<Option<RefreshedWatchState>> {
        let watched_directories = watched_directories.to_vec();
        let watched_dir_count = watched_directories.len();
        let service = self.clone();
        let refreshed_entries = stream::iter(watched_directories.into_iter().map(move |entry| {
            let service = service.clone();
            async move {
                let refreshed = service
                    .resolve_persisted_directory_entry(&entry.relative_path)
                    .await?;
                Ok::<_, anyhow::Error>((entry, refreshed))
            }
        }))
        .buffered(clamp(self.config.stat_concurrency, 2, 16))
        .collect::<Vec<Result<(FolderEntryCandidate, Option<FolderEntryCandidate>)>>>()
        .await;

        let mut entries = Vec::with_capacity(watched_dir_count);
        let mut by_path = HashMap::new();
        let mut changed_category_dirs = Vec::new();
        let mut changed_subfolders = Vec::new();

        for entry in refreshed_entries {
            let (original, refreshed) = entry?;
            let Some(refreshed) = refreshed else {
                return Ok(None);
            };
            by_path.insert(refreshed.relative_path.clone(), refreshed.clone());
            entries.push(refreshed.clone());

            if (original.modified - refreshed.modified).abs() < f64::EPSILON {
                continue;
            }

            if self
                .category_dirs
                .contains(refreshed.name.to_lowercase().as_str())
            {
                changed_category_dirs.push(refreshed);
            } else {
                changed_subfolders.push(refreshed);
            }
        }

        Ok(Some(RefreshedWatchState {
            entries,
            by_path,
            changed_category_dirs,
            changed_subfolders,
        }))
    }

    async fn resolve_persisted_directory_entry(
        &self,
        relative_path: &str,
    ) -> Result<Option<FolderEntryCandidate>> {
        let (safe_relative_path, absolute_path) = match self.resolve_paths(relative_path).await {
            Ok(value) => value,
            Err(error) if is_ignorable_entry_resolution_error(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let stats = match fs::metadata(&absolute_path).await {
            Ok(stats) => stats,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !stats.is_dir() {
            return Ok(None);
        }
        Ok(Some(FolderEntryCandidate {
            name: basename_or_root(&safe_relative_path, &self.config.media_root),
            absolute_path,
            relative_path: safe_relative_path,
            modified: modified_ms(&stats),
        }))
    }

    fn invalidate_runtime_path(&self, path: &str) {
        let mut caches = self.caches.lock().expect("scanner caches poisoned");
        for invalidated_path in collect_path_and_ancestors(path) {
            let next = caches
                .generations
                .get(&invalidated_path)
                .copied()
                .unwrap_or(0)
                + 1;
            caches.generations.insert(invalidated_path.clone(), next);
            remove_runtime_path_caches(&mut caches, &invalidated_path);
        }
    }

    fn clear_snapshot_cache(&self) {
        let mut caches = self.caches.lock().expect("scanner caches poisoned");
        caches.light_snapshots.clear();
    }

    async fn annotate_folder_favorite(&self, mut preview: FolderPreview) -> Result<FolderPreview> {
        preview.favorite = self.index.is_folder_favorite(preview.path.clone()).await?;
        Ok(preview)
    }

    async fn annotate_folder_favorites(
        &self,
        mut previews: Vec<FolderPreview>,
    ) -> Result<Vec<FolderPreview>> {
        if previews.is_empty() {
            return Ok(previews);
        }

        let favorites = self
            .index
            .load_all_folder_favorites()
            .await?
            .into_iter()
            .collect::<HashSet<_>>();
        for preview in &mut previews {
            preview.favorite = favorites.contains(&preview.path);
        }
        Ok(previews)
    }

    async fn scan_folder_entries(
        &self,
        absolute_path: &Path,
        safe_relative_path: &str,
        flatten_category_dirs: bool,
        include_subfolders: bool,
    ) -> Result<FolderScanResult> {
        let mut subfolders = Vec::new();
        let mut media_candidates = Vec::new();
        let mut watched_directories = Vec::new();
        let mut directory_entries = read_visible_entries(absolute_path)
            .await?
            .into_iter()
            .filter(|entry| entry.absolute_path.starts_with(self.root_real.as_ref()))
            .collect::<Vec<_>>();

        directory_entries.sort_by(|a, b| a.name.cmp(&b.name));

        for entry in directory_entries {
            let entry_relative = join_relative(safe_relative_path, &entry.name);
            match entry.kind {
                EntryKind::File(kind) => {
                    media_candidates.push(MediaCandidate {
                        name: entry.name,
                        relative_path: entry_relative,
                        absolute_path: entry.absolute_path,
                        kind,
                    });
                }
                EntryKind::Directory => {
                    let modified = dir_modified(&entry.absolute_path).await.unwrap_or(0.0);
                    let candidate = FolderEntryCandidate {
                        name: entry.name.clone(),
                        relative_path: entry_relative.clone(),
                        absolute_path: entry.absolute_path.clone(),
                        modified,
                    };
                    if self
                        .category_dirs
                        .contains(entry.name.to_lowercase().as_str())
                        && flatten_category_dirs
                    {
                        watched_directories.push(candidate);
                        let nested = self
                            .collect_direct_media_candidates(&entry.absolute_path, &entry_relative)
                            .await?;
                        media_candidates.extend(nested);
                    } else if include_subfolders {
                        watched_directories.push(candidate.clone());
                        subfolders.push(candidate);
                    }
                }
            }
        }

        Ok(FolderScanResult {
            subfolders,
            subfolder_count: watched_directories
                .iter()
                .filter(|entry| {
                    !self
                        .category_dirs
                        .contains(entry.name.to_lowercase().as_str())
                })
                .count(),
            media_candidates,
            watched_directories,
        })
    }

    async fn collect_direct_media_candidates(
        &self,
        absolute_path: &Path,
        safe_relative_path: &str,
    ) -> Result<Vec<MediaCandidate>> {
        let mut media_candidates = Vec::new();
        let mut entries = read_visible_entries(absolute_path)
            .await?
            .into_iter()
            .filter(|entry| entry.absolute_path.starts_with(self.root_real.as_ref()))
            .collect::<Vec<_>>();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        for entry in entries {
            if let EntryKind::File(kind) = entry.kind {
                media_candidates.push(MediaCandidate {
                    name: entry.name.clone(),
                    relative_path: join_relative(safe_relative_path, &entry.name),
                    absolute_path: entry.absolute_path,
                    kind,
                });
            }
        }
        Ok(media_candidates)
    }

    async fn build_media_items(&self, candidates: Vec<MediaCandidate>) -> Result<Vec<MediaItem>> {
        let concurrency = self.config.stat_concurrency.max(1);
        let items = stream::iter(candidates.into_iter().map(|candidate| async move {
            let metadata = match fs::metadata(&candidate.absolute_path).await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(anyhow!(error)),
            };
            if !metadata.is_file() {
                return Ok(None);
            }
            Ok(Some(build_media_item(
                &candidate.name,
                &candidate.relative_path,
                &candidate.kind,
                metadata.len(),
                modified_ms(&metadata),
            )))
        }))
        .buffered(concurrency)
        .collect::<Vec<Result<Option<MediaItem>>>>()
        .await;

        let mut output = Vec::new();
        for item in items {
            if let Some(item) = item? {
                output.push(item);
            }
        }
        Ok(output)
    }

    async fn resolve_paths(&self, relative_path: &str) -> Result<(String, PathBuf)> {
        let safe_relative_path = normalize_relative_path(relative_path)?;
        let joined = if safe_relative_path.is_empty() {
            self.config.media_root.clone()
        } else {
            self.config.media_root.join(&safe_relative_path)
        };
        let absolute_path = fs::canonicalize(&joined)
            .await
            .with_context(|| format!("resolve {}", joined.display()))?;
        if !absolute_path.starts_with(self.root_real.as_ref()) {
            return Err(anyhow!("Path escapes media root"));
        }
        Ok((safe_relative_path, absolute_path))
    }

    fn install_manifest_watches(
        &self,
        absolute_path: &Path,
        safe_relative_path: &str,
        manifest: &DirectoryManifest,
    ) {
        self.watch_registry
            .watch_directory(absolute_path, safe_relative_path.to_string());
        for watched in &manifest.watched_directories {
            self.watch_registry
                .watch_directory(&watched.absolute_path, safe_relative_path.to_string());
        }
    }

    fn path_generation(&self, path: &str) -> u64 {
        self.caches
            .lock()
            .expect("scanner caches poisoned")
            .generations
            .get(path)
            .copied()
            .unwrap_or(0)
    }

    fn read_light_snapshot_cache(
        &self,
        path: &str,
        generation: u64,
    ) -> Option<Arc<FolderSnapshot>> {
        self.caches
            .lock()
            .expect("scanner caches poisoned")
            .light_snapshots
            .get(path)
            .filter(|(stored_generation, _)| *stored_generation == generation)
            .map(|(_, snapshot)| Arc::clone(snapshot))
    }

    fn write_light_snapshot_cache(
        &self,
        path: String,
        generation: u64,
        snapshot: Arc<FolderSnapshot>,
    ) {
        self.caches
            .lock()
            .expect("scanner caches poisoned")
            .light_snapshots
            .insert(path, (generation, snapshot));
    }

    fn read_preview_cache(&self, key: &PreviewCacheKey, generation: u64) -> Option<FolderPreview> {
        self.caches
            .lock()
            .expect("scanner caches poisoned")
            .previews
            .get(key)
            .filter(|(stored_generation, _)| *stored_generation == generation)
            .map(|(_, preview)| preview.clone())
    }

    fn write_preview_cache(&self, key: PreviewCacheKey, generation: u64, preview: FolderPreview) {
        self.caches
            .lock()
            .expect("scanner caches poisoned")
            .previews
            .insert(key, (generation, preview));
    }

    fn read_manifest_cache(&self, path: &str, generation: u64) -> Option<DirectoryManifest> {
        self.caches
            .lock()
            .expect("scanner caches poisoned")
            .manifests
            .get(path)
            .filter(|(stored_generation, _)| *stored_generation == generation)
            .map(|(_, manifest)| manifest.clone())
    }

    fn write_manifest_cache(&self, path: String, generation: u64, manifest: DirectoryManifest) {
        self.caches
            .lock()
            .expect("scanner caches poisoned")
            .manifests
            .insert(path, (generation, manifest));
    }
}

#[derive(Debug)]
struct FolderScanResult {
    subfolders: Vec<FolderEntryCandidate>,
    subfolder_count: usize,
    media_candidates: Vec<MediaCandidate>,
    watched_directories: Vec<FolderEntryCandidate>,
}

#[derive(Debug)]
struct RefreshedWatchState {
    entries: Vec<FolderEntryCandidate>,
    by_path: HashMap<String, FolderEntryCandidate>,
    changed_category_dirs: Vec<FolderEntryCandidate>,
    changed_subfolders: Vec<FolderEntryCandidate>,
}

#[derive(Debug)]
struct VisibleEntry {
    name: String,
    absolute_path: PathBuf,
    kind: EntryKind,
}

#[derive(Debug, Clone)]
enum EntryKind {
    File(MediaKind),
    Directory,
}

fn parse_cursor(cursor: Option<&str>) -> Result<usize> {
    match cursor {
        None => Ok(0),
        Some("") => Ok(0),
        Some(raw) => raw.parse::<usize>().map_err(|_| anyhow!("Invalid cursor")),
    }
}

fn clamp(value: usize, min: usize, max: usize) -> usize {
    value.max(min).min(max)
}

fn build_default_page_media_json(media: &[MediaItem], limit: usize) -> Result<String> {
    let end = media.len().min(limit);
    serde_json::to_string(&media[..end]).map_err(Into::into)
}

fn media_kind_as_str(kind: &MediaKind) -> &'static str {
    match kind {
        MediaKind::Image => "image",
        MediaKind::Gif => "gif",
        MediaKind::Video => "video",
    }
}

fn detect_media_kind_from_path(path: &Path) -> Option<MediaKind> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    match ext.as_str() {
        "gif" => Some(MediaKind::Gif),
        "jpg" | "jpeg" | "png" | "webp" | "bmp" | "tiff" => Some(MediaKind::Image),
        "mp4" | "mov" | "webm" | "mkv" | "avi" => Some(MediaKind::Video),
        _ => None,
    }
}

fn build_system_usage_report(root: &Path, limit: usize) -> Result<SystemUsageReport> {
    let mut items = Vec::new();
    for entry in
        std::fs::read_dir(root).with_context(|| format!("read media root {}", root.display()))?
    {
        let entry = entry.with_context(|| format!("read media root entry {}", root.display()))?;
        let file_name = entry.file_name();
        let account = file_name.to_string_lossy().into_owned();
        if account.starts_with('.') {
            continue;
        }

        let file_type = entry
            .file_type()
            .with_context(|| format!("read file type for {}", entry.path().display()))?;
        if !file_type.is_dir() {
            continue;
        }

        items.push(scan_system_usage_account(&account, &entry.path())?);
    }

    items.sort_by(|left, right| {
        right
            .total_size
            .cmp(&left.total_size)
            .then_with(|| left.account.cmp(&right.account))
    });
    items.truncate(limit);

    Ok(SystemUsageReport {
        root_path: root.display().to_string(),
        generated_at: now_ms_u64(),
        items,
    })
}

fn scan_system_usage_account(account: &str, root: &Path) -> Result<SystemUsageAccount> {
    let mut total_size = 0_u64;
    let mut image_size = 0_u64;
    let mut gif_size = 0_u64;
    let mut video_size = 0_u64;
    let mut other_size = 0_u64;
    let mut top_files = Vec::new();
    let mut pending = vec![root.to_path_buf()];

    while let Some(current) = pending.pop() {
        for entry in std::fs::read_dir(&current)
            .with_context(|| format!("read account directory {}", current.display()))?
        {
            let entry =
                entry.with_context(|| format!("read directory entry {}", current.display()))?;
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }

            let path = entry.path();
            let file_type = entry
                .file_type()
                .with_context(|| format!("read file type for {}", path.display()))?;
            if file_type.is_dir() {
                pending.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            let metadata = entry
                .metadata()
                .with_context(|| format!("read metadata for {}", path.display()))?;
            let size = metadata.len();
            total_size = total_size.saturating_add(size);
            match detect_media_kind_from_path(&path) {
                Some(MediaKind::Image) => image_size = image_size.saturating_add(size),
                Some(MediaKind::Gif) => gif_size = gif_size.saturating_add(size),
                Some(MediaKind::Video) => video_size = video_size.saturating_add(size),
                None => other_size = other_size.saturating_add(size),
            }

            let relative_path = path
                .strip_prefix(root)
                .unwrap_or(path.as_path())
                .to_string_lossy()
                .replace('\\', "/");
            remember_system_usage_top_file(&mut top_files, relative_path, size);
        }
    }

    Ok(SystemUsageAccount {
        account: account.to_string(),
        total_size,
        image_size,
        gif_size,
        video_size,
        other_size,
        top_files,
    })
}

fn remember_system_usage_top_file(top_files: &mut Vec<SystemUsageFile>, path: String, size: u64) {
    top_files.push(SystemUsageFile { path, size });
    top_files.sort_by(|left, right| {
        right
            .size
            .cmp(&left.size)
            .then_with(|| left.path.cmp(&right.path))
    });
    if top_files.len() > 5 {
        top_files.truncate(5);
    }
}

fn build_media_item(
    name: &str,
    relative_path: &str,
    kind: &MediaKind,
    size: u64,
    modified: f64,
) -> MediaItem {
    let encoded = encode_path(relative_path);
    let should_use_thumbnail = should_use_thumbnail(kind, size);
    MediaItem {
        name: name.to_string(),
        path: relative_path.to_string(),
        url: format!("/media/{encoded}"),
        thumbnail_url: should_use_thumbnail
            .then(|| format!("/thumb/{encoded}?m={}", modified.floor() as i64)),
        kind: kind.clone(),
        size,
        modified,
    }
}

fn should_use_thumbnail(kind: &MediaKind, size: u64) -> bool {
    match kind {
        MediaKind::Gif => true,
        MediaKind::Video => cfg!(target_os = "macos"),
        MediaKind::Image => size >= IMAGE_THUMBNAIL_MIN_BYTES,
    }
}

fn normalize_media_item_capabilities(item: MediaItem) -> MediaItem {
    build_media_item(&item.name, &item.path, &item.kind, item.size, item.modified)
}

fn compare_media_items_by_time_desc(left: &MediaItem, right: &MediaItem) -> std::cmp::Ordering {
    media_sort_time_key(right)
        .cmp(&media_sort_time_key(left))
        .then_with(|| left.name.cmp(&right.name))
        .then_with(|| left.path.cmp(&right.path))
}

fn media_sort_time_key(item: &MediaItem) -> i64 {
    timestamp_ms_from_name(&item.name).unwrap_or_else(|| item.modified.floor() as i64)
}

fn timestamp_ms_from_name(name: &str) -> Option<i64> {
    let bytes = name.as_bytes();
    if bytes.len() < 16 {
        return None;
    }

    for start in 0..=bytes.len() - 16 {
        let date_start = start + 1;
        let time_start = start + 10;
        if bytes[start] != b'_'
            || bytes[start + 9] != b'_'
            || !bytes[date_start..date_start + 8]
                .iter()
                .all(u8::is_ascii_digit)
            || !bytes[time_start..time_start + 6]
                .iter()
                .all(u8::is_ascii_digit)
        {
            continue;
        }

        let year = parse_ascii_digits(&bytes[date_start..date_start + 4])?;
        let month = parse_ascii_digits(&bytes[date_start + 4..date_start + 6])?;
        let day = parse_ascii_digits(&bytes[date_start + 6..date_start + 8])?;
        let hour = parse_ascii_digits(&bytes[time_start..time_start + 2])?;
        let minute = parse_ascii_digits(&bytes[time_start + 2..time_start + 4])?;
        let second = parse_ascii_digits(&bytes[time_start + 4..time_start + 6])?;

        if !(1..=12).contains(&month)
            || !(1..=31).contains(&day)
            || hour > 23
            || minute > 59
            || second > 59
        {
            continue;
        }

        let days = days_from_civil(year, month, day);
        let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second;
        return Some(seconds * 1_000);
    }

    None
}

fn parse_ascii_digits(bytes: &[u8]) -> Option<i64> {
    let mut value = 0_i64;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + i64::from(byte - b'0');
    }
    Some(value)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn encode_path(value: &str) -> String {
    value
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| utf8_percent_encode(segment, ENCODE_URI_COMPONENT_SET).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize_relative_path(input: &str) -> Result<String> {
    let normalized = input
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    if normalized.is_empty() {
        return Ok(String::new());
    }

    let path = Path::new(&normalized);
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir => return Err(anyhow!("Path escapes media root")),
            _ => return Err(anyhow!("Path escapes media root")),
        }
    }
    Ok(parts.join("/"))
}

fn sanitize_viewer_preferences(mut preferences: ViewerPreferences) -> Result<ViewerPreferences> {
    preferences.search = preferences.search.trim().to_string();
    preferences.category_path = match preferences.category_path.take() {
        Some(path) => {
            let normalized = normalize_relative_path(&path)?;
            if normalized.is_empty() {
                None
            } else {
                Some(normalized)
            }
        }
        None => None,
    };
    Ok(preferences)
}

fn folder_identity(root: &Path, safe_relative_path: &str) -> FolderIdentity {
    FolderIdentity {
        name: basename_or_root(safe_relative_path, root),
        path: safe_relative_path.to_string(),
    }
}

fn basename_or_root(relative_path: &str, root: &Path) -> String {
    if relative_path.is_empty() {
        return root
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "root".to_string());
    }
    relative_path
        .rsplit('/')
        .next()
        .map(ToString::to_string)
        .unwrap_or_else(|| "root".to_string())
}

fn build_breadcrumb(relative_path: &str) -> Vec<FolderIdentity> {
    let mut breadcrumb = vec![FolderIdentity {
        name: "root".to_string(),
        path: String::new(),
    }];
    let mut current = String::new();
    for segment in relative_path
        .split('/')
        .filter(|segment| !segment.is_empty())
    {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(segment);
        breadcrumb.push(FolderIdentity {
            name: segment.to_string(),
            path: current.clone(),
        });
    }
    breadcrumb
}

async fn read_visible_entries(directory: &Path) -> Result<Vec<VisibleEntry>> {
    let mut entries = Vec::new();
    let mut reader = fs::read_dir(directory).await?;
    while let Some(entry) = reader.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let entry_path = entry.path();
        let file_type = entry.file_type().await?;
        if file_type.is_dir() {
            entries.push(VisibleEntry {
                name,
                absolute_path: entry_path,
                kind: EntryKind::Directory,
            });
            continue;
        }
        if file_type.is_file() {
            let Some(kind) = detect_media_kind_from_path(&entry_path) else {
                continue;
            };
            entries.push(VisibleEntry {
                name,
                absolute_path: entry_path,
                kind: EntryKind::File(kind),
            });
            continue;
        }
        if !file_type.is_symlink() {
            continue;
        }
        let real_path = match fs::canonicalize(&entry_path).await {
            Ok(path) => path,
            Err(_) => continue,
        };
        let metadata = match fs::metadata(&real_path).await {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.is_dir() {
            entries.push(VisibleEntry {
                name,
                absolute_path: real_path,
                kind: EntryKind::Directory,
            });
            continue;
        }
        if metadata.is_file() {
            let Some(kind) = detect_media_kind_from_path(&real_path) else {
                continue;
            };
            entries.push(VisibleEntry {
                name,
                absolute_path: real_path,
                kind: EntryKind::File(kind),
            });
        }
    }
    Ok(entries)
}

async fn dir_modified(path: &Path) -> Result<f64> {
    let metadata = fs::metadata(path).await?;
    Ok(modified_ms(&metadata))
}

fn modified_ms(metadata: &Metadata) -> f64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let seconds = metadata.mtime() as f64 * 1000.0;
        let nanos = metadata.mtime_nsec() as f64 / 1_000_000.0;
        seconds + nanos
    }

    #[cfg(not(unix))]
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs_f64() * 1000.0)
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_secs_f64() * 1000.0)
                .unwrap_or(0.0)
        })
}

fn increment_counts(counts: &mut FolderCounts, kind: &MediaKind) {
    match kind {
        MediaKind::Image => counts.images += 1,
        MediaKind::Gif => counts.gifs += 1,
        MediaKind::Video => counts.videos += 1,
    }
}

fn preview_stamp(manifest_stamp: &str, preview_limit: usize) -> String {
    format!("{manifest_stamp}:{preview_limit}")
}

fn dedupe_paths(paths: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for path in paths {
        let trimmed = path.trim().replace('\\', "/");
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.clone()) {
            result.push(trimmed);
        }
    }
    result
}

fn join_relative(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{base}/{name}")
    }
}

fn collect_path_and_ancestors(path: &str) -> Vec<String> {
    let mut collected = Vec::new();
    let mut current = Some(path.to_string());
    while let Some(value) = current.take() {
        collected.push(value.clone());
        current = if value.is_empty() {
            None
        } else {
            Some(
                value
                    .rsplit_once('/')
                    .map(|(parent, _)| parent.to_string())
                    .unwrap_or_default(),
            )
        };
    }
    collected
}

fn remove_runtime_path_caches(caches: &mut ScannerCaches, path: &str) {
    caches.light_snapshots.remove(path);
    caches.manifests.remove(path);
    caches.previews.retain(|key, _| key.path.as_str() != path);
    caches.system_usage.clear();
}

fn deserialize_media_payloads(payloads: Vec<String>) -> Result<Vec<MediaItem>> {
    payloads
        .into_iter()
        .map(|payload| {
            serde_json::from_str::<MediaItem>(&payload)
                .map(normalize_media_item_capabilities)
                .map_err(Into::into)
        })
        .collect()
}

fn media_filter_group(filter: FolderMediaFilter) -> &'static str {
    match filter {
        FolderMediaFilter::Image => "image",
        FolderMediaFilter::Video => "video",
    }
}

fn media_filter_group_for_item(item: &MediaItem) -> &'static str {
    match item.kind {
        MediaKind::Video => "video",
        MediaKind::Image | MediaKind::Gif => "image",
    }
}

fn build_manifest_stamp_from_manifest(manifest: &DirectoryManifest) -> String {
    let mut tokens = Vec::with_capacity(1 + manifest.media.len() + manifest.subfolders.len());
    tokens.push(format!("root:{}", manifest.root_modified));
    for item in &manifest.media {
        tokens.push(format!(
            "m:{}:{}:{}:{}",
            item.path,
            media_kind_as_str(&item.kind),
            item.size,
            item.modified
        ));
    }
    for item in &manifest.subfolders {
        tokens.push(format!("d:{}:{}", item.relative_path, item.modified));
    }
    tokens.sort();
    sha1_hex(tokens.join("\0").as_bytes())
}

fn is_ignorable_entry_resolution_error(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("Path escapes media root")
        || message.contains("Unsupported media extension")
        || message.contains("Missing media file path")
        || message.contains("No such file")
        || message.contains("not found")
}

fn sha1_hex(bytes: &[u8]) -> String {
    let mut digest = Sha1::new();
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

fn now_ms_u64() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn thumbnail_job_error_if_recent(job: &PersistedThumbnailJobRecord) -> Option<String> {
    if job.status != "error" {
        return None;
    }

    let updated_at = u64::try_from(job.updated_at).ok()?;
    if now_ms_u64().saturating_sub(updated_at) > THUMBNAIL_FAILURE_TTL_MS {
        return None;
    }

    Some(
        job.error
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "Thumbnail generation failed".to_string()),
    )
}

fn thumbnail_worker_limit() -> usize {
    let available = thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(2);
    let base = available.saturating_div(2).max(2);

    #[cfg(target_os = "macos")]
    {
        base.min(3)
    }

    #[cfg(not(target_os = "macos"))]
    {
        base.min(4)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_system_usage_report, modified_ms, BackendConfig, BackendService, DiagnosticsWriter,
        FolderMediaFilter, FolderSortOrder, GetCategoryOptions, IndexStore, MediaKind,
    };
    use crate::thumbnail::{ThumbnailError, ThumbnailGenerator};
    use anyhow::Result;
    use std::{
        fs as stdfs,
        path::PathBuf,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };
    use tempfile::tempdir;
    use tokio::fs;
    use tokio::time::{sleep, Duration};

    fn test_backend_config(root: PathBuf, thumbs: PathBuf) -> BackendConfig {
        BackendConfig {
            media_root: root,
            preview_limit: 6,
            preview_batch_limit: 64,
            folder_page_limit: 120,
            max_folder_page_limit: 1000,
            max_items_per_folder: 20_000,
            stat_concurrency: 8,
            thumbnail_cache_dir: thumbs,
        }
    }

    #[test]
    fn system_usage_report_ranks_accounts_and_collects_top_files() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path();
        stdfs::create_dir_all(root.join("alpha/images"))?;
        stdfs::create_dir_all(root.join("alpha/videos"))?;
        stdfs::create_dir_all(root.join("alpha/other"))?;
        stdfs::create_dir_all(root.join("beta/images"))?;
        stdfs::create_dir_all(root.join(".hidden/videos"))?;

        stdfs::write(root.join("alpha/images/pic.jpg"), vec![0_u8; 10])?;
        stdfs::write(root.join("alpha/images/anim.gif"), vec![0_u8; 7])?;
        stdfs::write(root.join("alpha/videos/clip.mp4"), vec![0_u8; 30])?;
        stdfs::write(root.join("alpha/other/readme.txt"), vec![0_u8; 5])?;
        stdfs::write(root.join("beta/images/cover.png"), vec![0_u8; 12])?;
        stdfs::write(root.join(".hidden/videos/skip.mp4"), vec![0_u8; 200])?;

        let report = build_system_usage_report(root, 10)?;
        assert_eq!(
            report.items.len(),
            2,
            "hidden directories should be ignored"
        );
        assert_eq!(report.items[0].account, "alpha");
        assert_eq!(report.items[0].total_size, 52);
        assert_eq!(report.items[0].image_size, 10);
        assert_eq!(report.items[0].gif_size, 7);
        assert_eq!(report.items[0].video_size, 30);
        assert_eq!(report.items[0].other_size, 5);
        assert_eq!(
            report.items[0]
                .top_files
                .iter()
                .map(|item| item.path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "videos/clip.mp4",
                "images/pic.jpg",
                "images/anim.gif",
                "other/readme.txt",
            ]
        );

        assert_eq!(report.items[1].account, "beta");
        assert_eq!(report.items[1].total_size, 12);
        assert_eq!(report.items[1].image_size, 12);
        assert_eq!(report.items[1].video_size, 0);
        Ok(())
    }

    async fn create_thumbnail_test_service(
        root: std::path::PathBuf,
        index: std::path::PathBuf,
        thumbs: std::path::PathBuf,
        diag: std::path::PathBuf,
        thumbnail_generator: Arc<dyn ThumbnailGenerator>,
    ) -> Result<BackendService> {
        BackendService::new_for_tests(
            test_backend_config(root, thumbs),
            IndexStore::new(index).await?,
            DiagnosticsWriter::new(diag).await?,
            thumbnail_generator,
        )
        .await
    }

    struct CountingThumbnailGenerator {
        count: Arc<AtomicUsize>,
        delay_ms: u64,
        output: std::result::Result<Vec<u8>, ThumbnailError>,
    }

    impl ThumbnailGenerator for CountingThumbnailGenerator {
        fn generate_jpeg(
            &self,
            _source_path: PathBuf,
            _kind: MediaKind,
        ) -> std::result::Result<Vec<u8>, ThumbnailError> {
            self.count.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(self.delay_ms));
            self.output.clone()
        }
    }

    struct TrackingThumbnailGenerator {
        active: Arc<AtomicUsize>,
        max_seen: Arc<AtomicUsize>,
        delay_ms: u64,
        output: std::result::Result<Vec<u8>, ThumbnailError>,
    }

    impl ThumbnailGenerator for TrackingThumbnailGenerator {
        fn generate_jpeg(
            &self,
            _source_path: PathBuf,
            _kind: MediaKind,
        ) -> std::result::Result<Vec<u8>, ThumbnailError> {
            let current = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = self
                .max_seen
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |seen| {
                    (current > seen).then_some(current)
                });
            std::thread::sleep(std::time::Duration::from_millis(self.delay_ms));
            self.active.fetch_sub(1, Ordering::SeqCst);
            self.output.clone()
        }
    }

    #[tokio::test]
    async fn scans_light_and_full_folder() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path().join("root");
        let index = temp.path().join("index");
        let thumbs = temp.path().join("thumbs");
        let diag = temp.path().join("diag");
        fs::create_dir_all(root.join("alpha/images")).await?;
        fs::write(root.join("alpha/images/a.jpg"), b"abc").await?;
        fs::write(root.join("alpha/images/b.gif"), b"gif").await?;

        let service = BackendService::new(
            test_backend_config(root.clone(), thumbs),
            IndexStore::new(index).await?,
            DiagnosticsWriter::new(diag).await?,
        )
        .await?;

        let light = service.get_root_summary().await?;
        assert_eq!(light.subfolders.len(), 1);

        let full = service
            .get_category_page(
                "alpha",
                GetCategoryOptions {
                    media_filter: FolderMediaFilter::Image,
                    ..Default::default()
                },
            )
            .await?;
        assert_eq!(full.media.len(), 2);
        Ok(())
    }

    #[tokio::test]
    async fn refreshes_root_light_snapshot_without_restart() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path().join("root");
        let index = temp.path().join("index");
        let thumbs = temp.path().join("thumbs");
        let diag = temp.path().join("diag");
        fs::create_dir_all(root.join("alpha")).await?;
        fs::create_dir_all(root.join("beta")).await?;
        fs::write(root.join("alpha/a.jpg"), b"alpha").await?;
        sleep(Duration::from_millis(25)).await;
        fs::write(root.join("beta/b.jpg"), b"beta").await?;

        let service = BackendService::new(
            test_backend_config(root.clone(), thumbs),
            IndexStore::new(index).await?,
            DiagnosticsWriter::new(diag).await?,
        )
        .await?;

        let first = service.get_root_summary().await?;
        assert_eq!(first.subfolders[0].path, "beta");
        let first_alpha_modified = first
            .subfolders
            .iter()
            .find(|item| item.path == "alpha")
            .map(|item| item.modified)
            .expect("alpha should exist");

        sleep(Duration::from_millis(25)).await;
        fs::write(root.join("alpha/c.jpg"), b"alpha-fresh").await?;

        let second = service.get_root_summary().await?;
        let second_alpha_modified = second
            .subfolders
            .iter()
            .find(|item| item.path == "alpha")
            .map(|item| item.modified)
            .expect("alpha should exist");
        assert!(second_alpha_modified > first_alpha_modified);
        assert_eq!(second.subfolders[0].path, "alpha");

        Ok(())
    }

    #[tokio::test]
    async fn favorites_persist_into_root_light_snapshot() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path().join("root");
        let index = temp.path().join("index");
        let thumbs = temp.path().join("thumbs");
        let diag = temp.path().join("diag");
        fs::create_dir_all(root.join("alpha")).await?;
        fs::create_dir_all(root.join("beta")).await?;

        let service = BackendService::new(
            test_backend_config(root.clone(), thumbs),
            IndexStore::new(index).await?,
            DiagnosticsWriter::new(diag).await?,
        )
        .await?;

        let initial = service.get_root_summary().await?;
        assert!(
            initial.subfolders.iter().all(|item| !item.favorite),
            "new root snapshots should start without favorites"
        );

        service.set_folder_favorite("alpha", true).await?;
        let favorited = service.get_root_summary().await?;
        assert_eq!(
            favorited
                .subfolders
                .iter()
                .find(|item| item.path == "alpha")
                .map(|item| item.favorite),
            Some(true)
        );

        service.set_folder_favorite("alpha", false).await?;
        let cleared = service.get_root_summary().await?;
        assert_eq!(
            cleared
                .subfolders
                .iter()
                .find(|item| item.path == "alpha")
                .map(|item| item.favorite),
            Some(false)
        );

        Ok(())
    }

    #[tokio::test]
    async fn pages_category_media_by_filename_timestamp_desc() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path().join("root");
        let index = temp.path().join("index");
        let thumbs = temp.path().join("thumbs");
        let diag = temp.path().join("diag");
        fs::create_dir_all(root.join("alpha/images")).await?;
        fs::write(
            root.join("alpha/images/IMG_20260102_000000.jpg"),
            b"newest-by-name",
        )
        .await?;
        sleep(Duration::from_millis(25)).await;
        fs::write(
            root.join("alpha/images/IMG_20241231_000000.jpg"),
            b"oldest-by-name",
        )
        .await?;
        sleep(Duration::from_millis(25)).await;
        fs::write(
            root.join("alpha/images/IMG_20260101_000000.jpg"),
            b"second-newest-by-name",
        )
        .await?;
        sleep(Duration::from_millis(25)).await;
        fs::write(
            root.join("alpha/images/IMG_20250101_000000.jpg"),
            b"second-oldest-by-name",
        )
        .await?;

        let service = BackendService::new(
            test_backend_config(root.clone(), thumbs),
            IndexStore::new(index).await?,
            DiagnosticsWriter::new(diag).await?,
        )
        .await?;

        let first_page = service
            .get_category_page(
                "alpha",
                GetCategoryOptions {
                    limit: Some(2),
                    media_filter: FolderMediaFilter::Image,
                    ..Default::default()
                },
            )
            .await?;
        let second_page = service
            .get_category_page(
                "alpha",
                GetCategoryOptions {
                    cursor: first_page.next_cursor.clone(),
                    limit: Some(2),
                    media_filter: FolderMediaFilter::Image,
                    sort_order: FolderSortOrder::Desc,
                },
            )
            .await?;
        let first_page_asc = service
            .get_category_page(
                "alpha",
                GetCategoryOptions {
                    limit: Some(2),
                    media_filter: FolderMediaFilter::Image,
                    sort_order: FolderSortOrder::Asc,
                    ..Default::default()
                },
            )
            .await?;
        let second_page_asc = service
            .get_category_page(
                "alpha",
                GetCategoryOptions {
                    cursor: first_page_asc.next_cursor.clone(),
                    limit: Some(2),
                    media_filter: FolderMediaFilter::Image,
                    sort_order: FolderSortOrder::Asc,
                },
            )
            .await?;

        assert_eq!(
            first_page
                .media
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["IMG_20260102_000000.jpg", "IMG_20260101_000000.jpg"]
        );
        assert_eq!(
            second_page
                .media
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["IMG_20250101_000000.jpg", "IMG_20241231_000000.jpg"]
        );
        assert_eq!(
            first_page_asc
                .media
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["IMG_20241231_000000.jpg", "IMG_20250101_000000.jpg"]
        );
        assert_eq!(
            second_page_asc
                .media
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["IMG_20260101_000000.jpg", "IMG_20260102_000000.jpg"]
        );

        Ok(())
    }

    #[tokio::test]
    async fn category_page_uses_index_paging_and_filtered_totals() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path().join("root");
        let index = temp.path().join("index");
        let thumbs = temp.path().join("thumbs");
        let diag = temp.path().join("diag");
        fs::create_dir_all(root.join("alpha/images")).await?;
        fs::create_dir_all(root.join("alpha/videos")).await?;
        fs::write(
            root.join("alpha/images/IMG_20260103_000000.jpg"),
            b"image-3",
        )
        .await?;
        fs::write(
            root.join("alpha/images/IMG_20260102_000000.jpg"),
            b"image-2",
        )
        .await?;
        fs::write(
            root.join("alpha/images/IMG_20260101_000000.jpg"),
            b"image-1",
        )
        .await?;
        fs::write(
            root.join("alpha/videos/VID_20260102_000000.mp4"),
            b"video-2",
        )
        .await?;
        fs::write(
            root.join("alpha/videos/VID_20260101_000000.mp4"),
            b"video-1",
        )
        .await?;

        let service = BackendService::new(
            test_backend_config(root.clone(), thumbs),
            IndexStore::new(index).await?,
            DiagnosticsWriter::new(diag).await?,
        )
        .await?;

        let first_page = service
            .get_category_page(
                "alpha",
                GetCategoryOptions {
                    limit: Some(2),
                    media_filter: FolderMediaFilter::Image,
                    sort_order: FolderSortOrder::Desc,
                    ..Default::default()
                },
            )
            .await?;
        let second_page = service
            .get_category_page(
                "alpha",
                GetCategoryOptions {
                    cursor: first_page.next_cursor.clone(),
                    limit: Some(2),
                    media_filter: FolderMediaFilter::Image,
                    sort_order: FolderSortOrder::Desc,
                },
            )
            .await?;
        let video_page = service
            .get_category_page(
                "alpha",
                GetCategoryOptions {
                    limit: Some(2),
                    media_filter: FolderMediaFilter::Video,
                    sort_order: FolderSortOrder::Asc,
                    ..Default::default()
                },
            )
            .await?;

        assert_eq!(first_page.counts.images, 3);
        assert_eq!(first_page.counts.videos, 2);
        assert_eq!(first_page.total_media, 5);
        assert_eq!(first_page.filtered_total, 3);
        assert_eq!(
            first_page
                .media
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["IMG_20260103_000000.jpg", "IMG_20260102_000000.jpg"]
        );
        assert_eq!(
            second_page
                .media
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["IMG_20260101_000000.jpg"]
        );
        assert_eq!(second_page.next_cursor, None);
        assert_eq!(video_page.filtered_total, 2);
        assert_eq!(
            video_page
                .media
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["VID_20260101_000000.mp4", "VID_20260102_000000.mp4"]
        );

        Ok(())
    }

    #[tokio::test]
    async fn category_page_backfills_missing_media_entries_from_legacy_manifest() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path().join("root");
        let index = temp.path().join("index");
        let thumbs = temp.path().join("thumbs");
        let diag = temp.path().join("diag");
        fs::create_dir_all(root.join("alpha/images")).await?;
        fs::write(
            root.join("alpha/images/IMG_20260101_000000.jpg"),
            b"image-1",
        )
        .await?;
        fs::write(
            root.join("alpha/images/IMG_20260102_000000.jpg"),
            b"image-2",
        )
        .await?;

        let service = BackendService::new(
            test_backend_config(root.clone(), thumbs),
            IndexStore::new(index).await?,
            DiagnosticsWriter::new(diag).await?,
        )
        .await?;

        let initial = service
            .get_category_page(
                "alpha",
                GetCategoryOptions {
                    media_filter: FolderMediaFilter::Image,
                    sort_order: FolderSortOrder::Desc,
                    ..Default::default()
                },
            )
            .await?;
        let legacy_media_json = serde_json::to_string(&initial.media)?;

        service
            .index
            .interact(move |conn| {
                conn.execute("DELETE FROM media_entry WHERE folder_path = 'alpha'", [])?;
                conn.execute(
                    "UPDATE folder_manifest SET media_json = ?1 WHERE path = 'alpha'",
                    [legacy_media_json],
                )?;
                Ok(())
            })
            .await?;
        service.invalidate_runtime_path("alpha");

        let restored = service
            .get_category_page(
                "alpha",
                GetCategoryOptions {
                    media_filter: FolderMediaFilter::Image,
                    sort_order: FolderSortOrder::Desc,
                    ..Default::default()
                },
            )
            .await?;

        assert_eq!(
            restored
                .media
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["IMG_20260102_000000.jpg", "IMG_20260101_000000.jpg"]
        );
        assert!(
            service.index.has_media_entries("alpha".to_string()).await?,
            "legacy manifest should repopulate media_entry rows"
        );

        Ok(())
    }

    #[tokio::test]
    async fn system_usage_cache_can_be_bypassed() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path().join("root");
        let index = temp.path().join("index");
        let thumbs = temp.path().join("thumbs");
        let diag = temp.path().join("diag");
        fs::create_dir_all(root.join("alpha/images")).await?;
        fs::write(root.join("alpha/images/pic.jpg"), vec![0_u8; 10]).await?;

        let service = BackendService::new(
            test_backend_config(root.clone(), thumbs),
            IndexStore::new(index).await?,
            DiagnosticsWriter::new(diag).await?,
        )
        .await?;

        let first = service.get_system_usage_report(10, false).await?;
        fs::create_dir_all(root.join("alpha/videos")).await?;
        fs::write(root.join("alpha/videos/clip.mp4"), vec![0_u8; 20]).await?;

        let cached = service.get_system_usage_report(10, false).await?;
        let refreshed = service.get_system_usage_report(10, true).await?;

        assert_eq!(cached.generated_at, first.generated_at);
        assert_eq!(cached.items[0].total_size, first.items[0].total_size);
        assert_eq!(
            refreshed.items[0].total_size,
            first.items[0].total_size + 20
        );
        assert!(refreshed.generated_at >= cached.generated_at);

        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn video_items_omit_thumbnail_urls_off_macos() {
        let item = super::build_media_item(
            "clip.mp4",
            "alpha/videos/clip.mp4",
            &MediaKind::Video,
            4_096,
            123.0,
        );

        assert_eq!(item.thumbnail_url, None);
    }

    #[cfg(not(target_os = "macos"))]
    #[tokio::test]
    async fn video_thumbnail_requests_fail_with_platform_error_off_macos() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path().join("root");
        let index = temp.path().join("index");
        let thumbs = temp.path().join("thumbs");
        let diag = temp.path().join("diag");
        fs::create_dir_all(root.join("alpha/videos")).await?;
        let media_path = root.join("alpha/videos/sample.mp4");
        fs::write(&media_path, b"not-a-real-video").await?;
        let service = BackendService::new(
            test_backend_config(root, thumbs),
            IndexStore::new(index).await?,
            DiagnosticsWriter::new(diag).await?,
        )
        .await?;
        let metadata = fs::metadata(&media_path).await?;

        let error = service
            .get_thumbnail_path(
                "alpha/videos/sample.mp4",
                &media_path,
                modified_ms(&metadata) as i64,
                MediaKind::Video,
            )
            .await
            .expect_err("video thumbnails should be unavailable off macOS");

        assert_eq!(error, ThumbnailError::UnsupportedVideoPlatform);
        assert_eq!(
            error.to_string(),
            "video thumbnails are only supported on macOS"
        );

        Ok(())
    }

    #[tokio::test]
    async fn deduplicates_concurrent_thumbnail_requests_for_the_same_asset() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path().join("root");
        let index = temp.path().join("index");
        let thumbs = temp.path().join("thumbs");
        let diag = temp.path().join("diag");
        let count = Arc::new(AtomicUsize::new(0));
        let generator = Arc::new(CountingThumbnailGenerator {
            count: count.clone(),
            delay_ms: 200,
            output: Ok(b"jpeg".to_vec()),
        });

        fs::create_dir_all(root.join("alpha/images")).await?;
        let media_path = root.join("alpha/images/sample.jpg");
        fs::write(&media_path, b"sample").await?;
        let metadata = fs::metadata(&media_path).await?;
        let modified_ms = modified_ms(&metadata) as i64;
        let service = create_thumbnail_test_service(root, index, thumbs, diag, generator).await?;

        let (first, second) = tokio::join!(
            service.get_thumbnail_path(
                "alpha/images/sample.jpg",
                &media_path,
                modified_ms,
                MediaKind::Image
            ),
            service.get_thumbnail_path(
                "alpha/images/sample.jpg",
                &media_path,
                modified_ms,
                MediaKind::Image
            )
        );

        let first = first?;
        let second = second?;

        assert_eq!(first, second);
        assert_eq!(count.load(Ordering::SeqCst), 1);

        Ok(())
    }

    #[tokio::test]
    async fn processes_multiple_distinct_thumbnail_requests_in_parallel() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path().join("root");
        let index = temp.path().join("index");
        let thumbs = temp.path().join("thumbs");
        let diag = temp.path().join("diag");
        let active = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let generator = Arc::new(TrackingThumbnailGenerator {
            active,
            max_seen: max_seen.clone(),
            delay_ms: 300,
            output: Ok(b"jpeg".to_vec()),
        });

        fs::create_dir_all(root.join("alpha/images")).await?;
        let first_media_path = root.join("alpha/images/one.jpg");
        let second_media_path = root.join("alpha/images/two.jpg");
        fs::write(&first_media_path, b"one").await?;
        fs::write(&second_media_path, b"two").await?;
        let first_modified_ms = modified_ms(&fs::metadata(&first_media_path).await?) as i64;
        let second_modified_ms = modified_ms(&fs::metadata(&second_media_path).await?) as i64;
        let service = create_thumbnail_test_service(root, index, thumbs, diag, generator).await?;

        let (first, second) = tokio::join!(
            service.get_thumbnail_path(
                "alpha/images/one.jpg",
                &first_media_path,
                first_modified_ms,
                MediaKind::Image
            ),
            service.get_thumbnail_path(
                "alpha/images/two.jpg",
                &second_media_path,
                second_modified_ms,
                MediaKind::Image
            )
        );

        first?;
        second?;

        assert!(
            max_seen.load(Ordering::SeqCst) >= 2,
            "thumbnail generation should use more than one worker"
        );

        Ok(())
    }

    #[tokio::test]
    async fn reuses_recent_thumbnail_failures_without_rerunning_thumbnail_generation() -> Result<()>
    {
        let temp = tempdir()?;
        let root = temp.path().join("root");
        let index = temp.path().join("index");
        let thumbs = temp.path().join("thumbs");
        let diag = temp.path().join("diag");
        let count = Arc::new(AtomicUsize::new(0));
        let generator = Arc::new(CountingThumbnailGenerator {
            count: count.clone(),
            delay_ms: 0,
            output: Err(ThumbnailError::GenerationFailed("boom".to_string())),
        });

        fs::create_dir_all(root.join("alpha/images")).await?;
        let media_path = root.join("alpha/images/broken.jpg");
        fs::write(&media_path, b"broken").await?;
        let modified_ms = modified_ms(&fs::metadata(&media_path).await?) as i64;

        let first_service = create_thumbnail_test_service(
            root.clone(),
            index.clone(),
            thumbs.clone(),
            diag.clone(),
            generator.clone(),
        )
        .await?;

        let first_error = first_service
            .get_thumbnail_path(
                "alpha/images/broken.jpg",
                &media_path,
                modified_ms,
                MediaKind::Image,
            )
            .await
            .expect_err("first generation should fail");
        assert!(first_error.to_string().contains("boom"));

        let second_service =
            create_thumbnail_test_service(root, index, thumbs, diag, generator).await?;
        let second_error = second_service
            .get_thumbnail_path(
                "alpha/images/broken.jpg",
                &media_path,
                modified_ms,
                MediaKind::Image,
            )
            .await
            .expect_err("recent failure should be reused");

        assert!(second_error.to_string().contains("boom"));
        assert_eq!(count.load(Ordering::SeqCst), 1);

        Ok(())
    }
}
