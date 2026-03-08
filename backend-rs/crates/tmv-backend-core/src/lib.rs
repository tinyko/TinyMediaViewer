use anyhow::{anyhow, Context, Result};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tmv_backend_index::IndexStore;
use tmv_backend_watch::WatchRegistry;
use tokio::{
    fs,
    sync::{mpsc, Semaphore},
};

mod contracts;
mod diagnostics;
mod favorites;
mod manifest;
mod media;
mod paths;
mod preview;
mod runtime;
mod scan;
mod service_types;
mod snapshot;
mod system_usage;
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
pub use diagnostics::DiagnosticsWriter;
use diagnostics::PreviewBatchSummary;
use media::{
    build_media_item, clamp, compare_media_items_by_time_desc, deserialize_media_payloads,
    detect_media_kind_from_path, increment_counts, is_ignorable_entry_resolution_error,
    media_filter_group, media_filter_group_for_item, media_kind_as_str, media_sort_time_key,
    now_ms_u64, parse_cursor, preview_stamp, sha1_hex, thumbnail_job_error_if_recent,
    thumbnail_worker_limit,
};
use paths::{
    basename_or_root, build_breadcrumb, collect_path_and_ancestors, dedupe_paths, folder_identity,
    join_relative, normalize_relative_path,
};
use runtime::{PreviewCacheKey, RuntimeState};
use scan::{dir_modified, modified_ms, read_visible_entries};
pub use service_types::ResolvedMedia;
use service_types::{
    DirectoryManifest, EntryKind, FolderEntryCandidate, FolderScanResult, FolderSnapshot,
    MediaCandidate, RefreshedWatchState, ThumbnailFailureEntry, ThumbnailRequestKey,
    ThumbnailTaskResult, ThumbnailTaskSlot, ThumbnailTaskState,
};
use system_usage::SystemUsageRuntime;
pub use thumbnail::ThumbnailError;
use thumbnail::{default_thumbnail_generator, ThumbnailGenerator};

const IMAGE_THUMBNAIL_MIN_BYTES: u64 = 512 * 1024;
const PREVIEW_RESTORE_LIMIT: usize = 64;
const THUMBNAIL_FAILURE_TTL_MS: u64 = 60_000;
const ENCODE_URI_COMPONENT_SET: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS
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

#[derive(Clone)]
pub struct BackendService {
    config: Arc<BackendConfig>,
    root_real: Arc<PathBuf>,
    category_dirs: Arc<HashSet<&'static str>>,
    index: IndexStore,
    diagnostics: DiagnosticsWriter,
    runtime: Arc<RuntimeState>,
    system_usage_runtime: Arc<SystemUsageRuntime>,
    manifest_validations: Arc<Mutex<HashSet<String>>>,
    watch_registry: Arc<WatchRegistry>,
    thumbnail_semaphore: Arc<Semaphore>,
    thumbnail_inflight: Arc<Mutex<HashMap<ThumbnailRequestKey, Arc<ThumbnailTaskState>>>>,
    thumbnail_failures: Arc<Mutex<HashMap<ThumbnailRequestKey, ThumbnailFailureEntry>>>,
    thumbnail_generator: Arc<dyn ThumbnailGenerator>,
    #[cfg(test)]
    favorite_set_loads: Arc<std::sync::atomic::AtomicUsize>,
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
        let runtime = Arc::new(RuntimeState::default());
        let system_usage_runtime = Arc::new(SystemUsageRuntime::default());
        let (invalidate_tx, mut invalidate_rx) = mpsc::unbounded_channel::<Vec<String>>();
        let runtime_for_task = runtime.clone();
        let system_usage_for_task = system_usage_runtime.clone();
        tokio::spawn(async move {
            while let Some(paths) = invalidate_rx.recv().await {
                for path in paths {
                    runtime_for_task.invalidate_path_and_ancestors(&path);
                    let root_generation = runtime_for_task.generation("");
                    let _ = system_usage_for_task
                        .request_refresh(root_generation, false)
                        .await;
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
            runtime,
            system_usage_runtime,
            manifest_validations: Arc::new(Mutex::new(HashSet::new())),
            watch_registry: Arc::new(watch_registry),
            thumbnail_semaphore: Arc::new(Semaphore::new(thumbnail_worker_limit())),
            thumbnail_inflight: Arc::new(Mutex::new(HashMap::new())),
            thumbnail_failures: Arc::new(Mutex::new(HashMap::new())),
            thumbnail_generator,
            #[cfg(test)]
            favorite_set_loads: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
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
        service
            .system_usage_runtime
            .clone()
            .spawn_worker(service.clone());
        let initial_root_generation = service.runtime.generation("");
        let _ = service
            .system_usage_runtime
            .request_refresh(initial_root_generation, false)
            .await;
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

    fn invalidate_runtime_path(&self, path: &str) {
        self.runtime.invalidate_path_and_ancestors(path);
        let system_usage_runtime = self.system_usage_runtime.clone();
        let root_generation = self.runtime.generation("");
        tokio::spawn(async move {
            let _ = system_usage_runtime
                .request_refresh(root_generation, false)
                .await;
        });
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
        self.runtime.generation(path)
    }

    fn read_light_snapshot_cache(
        &self,
        path: &str,
        generation: u64,
    ) -> Option<Arc<FolderSnapshot>> {
        self.runtime.read_light_snapshot_cache(path, generation)
    }

    fn write_light_snapshot_cache(
        &self,
        path: String,
        generation: u64,
        snapshot: Arc<FolderSnapshot>,
    ) {
        self.runtime
            .write_light_snapshot_cache(path, generation, snapshot);
    }

    fn read_preview_cache(&self, key: &PreviewCacheKey, generation: u64) -> Option<FolderPreview> {
        self.runtime.read_preview_cache(key, generation)
    }

    fn write_preview_cache(&self, key: PreviewCacheKey, generation: u64, preview: FolderPreview) {
        self.runtime.write_preview_cache(key, generation, preview);
    }

    fn read_manifest_cache(&self, path: &str, generation: u64) -> Option<DirectoryManifest> {
        self.runtime.read_manifest_cache(path, generation)
    }

    fn write_manifest_cache(&self, path: String, generation: u64, manifest: DirectoryManifest) {
        self.runtime
            .write_manifest_cache(path, generation, manifest);
    }

    #[cfg(test)]
    fn favorite_set_load_count(&self) -> usize {
        self.favorite_set_loads
            .load(std::sync::atomic::Ordering::SeqCst)
    }
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

#[cfg(test)]
mod tests {
    use super::system_usage::{build_full_system_usage_report, wait_for_system_usage_refresh};
    use super::{
        modified_ms, BackendConfig, BackendService, DiagnosticsWriter, FolderMediaFilter,
        FolderSortOrder, GetCategoryOptions, IndexStore, MediaKind,
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

        let report = build_full_system_usage_report(root)?;
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
    async fn refreshes_root_light_snapshot_after_invalidation_without_restart() -> Result<()> {
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
        service.invalidate_runtime_path("alpha");

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
    async fn reuses_cached_root_light_snapshot_until_invalidated() -> Result<()> {
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

        let first = service.get_light_snapshot("").await?;
        let second = service.get_light_snapshot("").await?;
        assert!(
            Arc::ptr_eq(&first, &second),
            "warm root reads should reuse the runtime light snapshot"
        );

        service.set_folder_favorite("alpha", true).await?;

        let after_favorite = service.get_light_snapshot("").await?;
        assert!(
            !Arc::ptr_eq(&second, &after_favorite),
            "favorite changes should invalidate the cached root snapshot"
        );

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
    async fn batch_folder_previews_load_favorites_once() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path().join("root");
        let index = temp.path().join("index");
        let thumbs = temp.path().join("thumbs");
        let diag = temp.path().join("diag");
        fs::create_dir_all(root.join("alpha/images")).await?;
        fs::create_dir_all(root.join("beta/images")).await?;
        fs::write(root.join("alpha/images/a.jpg"), b"alpha").await?;
        fs::write(root.join("beta/images/b.jpg"), b"beta").await?;

        let service = BackendService::new(
            test_backend_config(root.clone(), thumbs),
            IndexStore::new(index).await?,
            DiagnosticsWriter::new(diag).await?,
        )
        .await?;
        service.set_folder_favorite("beta", true).await?;
        #[cfg(test)]
        assert_eq!(service.favorite_set_load_count(), 0);

        #[cfg(test)]
        service.favorite_set_loads.store(0, Ordering::SeqCst);

        let result = service
            .get_folder_previews(vec!["alpha".to_string(), "beta".to_string()], Some(2))
            .await;

        assert_eq!(result.errors.len(), 0);
        assert_eq!(
            result
                .items
                .iter()
                .filter(|item| item.favorite)
                .map(|item| item.path.as_str())
                .collect::<Vec<_>>(),
            vec!["beta"]
        );
        #[cfg(test)]
        assert_eq!(service.favorite_set_load_count(), 1);

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
    async fn category_page_rescans_when_media_entries_are_missing() -> Result<()> {
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
        assert_eq!(initial.filtered_total, 2);

        service
            .index
            .interact(move |conn| {
                conn.execute("DELETE FROM media_entry WHERE folder_path = 'alpha'", [])?;
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
            "filesystem rescan should repopulate media_entry rows"
        );

        Ok(())
    }

    #[tokio::test]
    async fn system_usage_startup_prewarm_populates_hot_cache() -> Result<()> {
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

        wait_for_system_usage_refresh(&service, 1).await;
        let refresh_id_before = service.system_usage_runtime.current_refresh_id().await;
        let report = service.get_system_usage_report(1, false).await?;
        let refresh_id_after = service.system_usage_runtime.current_refresh_id().await;

        assert_eq!(refresh_id_before, 1);
        assert_eq!(refresh_id_after, refresh_id_before);
        assert_eq!(report.items.len(), 1);
        assert_eq!(report.items[0].account, "alpha");

        Ok(())
    }

    #[tokio::test]
    async fn system_usage_merges_multiple_invalidations_into_one_latest_refresh() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path().join("root");
        let index = temp.path().join("index");
        let thumbs = temp.path().join("thumbs");
        let diag = temp.path().join("diag");
        fs::create_dir_all(root.join("alpha/images")).await?;
        fs::create_dir_all(root.join("beta/images")).await?;
        fs::write(root.join("alpha/images/a.jpg"), vec![0_u8; 10]).await?;
        fs::write(root.join("beta/images/b.jpg"), vec![0_u8; 12]).await?;

        let service = BackendService::new(
            test_backend_config(root.clone(), thumbs),
            IndexStore::new(index).await?,
            DiagnosticsWriter::new(diag).await?,
        )
        .await?;

        wait_for_system_usage_refresh(&service, 1).await;
        assert_eq!(service.system_usage_runtime.current_refresh_id().await, 1);

        fs::write(root.join("alpha/images/new-a.jpg"), vec![0_u8; 5]).await?;
        fs::write(root.join("beta/images/new-b.jpg"), vec![0_u8; 7]).await?;
        service.invalidate_runtime_path("alpha");
        service.invalidate_runtime_path("beta");

        wait_for_system_usage_refresh(&service, 2).await;
        let refresh_id = service.system_usage_runtime.current_refresh_id().await;
        let refreshed = service.get_system_usage_report(10, false).await?;

        assert_eq!(refresh_id, 2);
        assert_eq!(
            refreshed
                .items
                .iter()
                .map(|item| (item.account.as_str(), item.total_size))
                .collect::<Vec<_>>(),
            vec![("beta", 19), ("alpha", 15)]
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

        wait_for_system_usage_refresh(&service, 1).await;
        let initial_refresh_id = service.system_usage_runtime.current_refresh_id().await;
        let first = service.get_system_usage_report(10, false).await?;
        fs::create_dir_all(root.join("alpha/videos")).await?;
        fs::write(root.join("alpha/videos/clip.mp4"), vec![0_u8; 20]).await?;

        let cached = service.get_system_usage_report(10, false).await?;
        let refreshed = service.get_system_usage_report(10, true).await?;
        let refreshed_id = service.system_usage_runtime.current_refresh_id().await;

        assert_eq!(cached.generated_at, first.generated_at);
        assert_eq!(cached.items[0].total_size, first.items[0].total_size);
        assert_eq!(
            refreshed.items[0].total_size,
            first.items[0].total_size + 20
        );
        assert!(refreshed.generated_at >= cached.generated_at);
        assert_eq!(refreshed_id, initial_refresh_id + 1);

        Ok(())
    }

    #[tokio::test]
    async fn system_usage_reuses_one_full_snapshot_for_different_limits() -> Result<()> {
        let temp = tempdir()?;
        let root = temp.path().join("root");
        let index = temp.path().join("index");
        let thumbs = temp.path().join("thumbs");
        let diag = temp.path().join("diag");
        fs::create_dir_all(root.join("alpha/images")).await?;
        fs::create_dir_all(root.join("beta/images")).await?;
        fs::write(root.join("alpha/images/a.jpg"), vec![0_u8; 10]).await?;
        fs::write(root.join("beta/images/b.jpg"), vec![0_u8; 20]).await?;

        let service = BackendService::new(
            test_backend_config(root.clone(), thumbs),
            IndexStore::new(index).await?,
            DiagnosticsWriter::new(diag).await?,
        )
        .await?;

        wait_for_system_usage_refresh(&service, 1).await;
        let refresh_id_before = service.system_usage_runtime.current_refresh_id().await;

        let top_one = service.get_system_usage_report(1, false).await?;
        let top_two = service.get_system_usage_report(2, false).await?;
        let refresh_id_after = service.system_usage_runtime.current_refresh_id().await;

        assert_eq!(refresh_id_after, refresh_id_before);
        assert_eq!(top_one.generated_at, top_two.generated_at);
        assert_eq!(top_one.items.len(), 1);
        assert_eq!(top_two.items.len(), 2);
        assert_eq!(top_one.items[0].account, top_two.items[0].account);
        assert_eq!(top_one.items[0].total_size, top_two.items[0].total_size);

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
