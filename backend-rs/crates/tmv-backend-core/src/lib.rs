use anyhow::{anyhow, Context, Result};
use futures::{stream, StreamExt};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    fs::Metadata,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tmv_backend_index::{IndexStore, PersistedMediaRecord, SaveManifestInput};
use tmv_backend_watch::WatchRegistry;
use tokio::{
    fs,
    process::Command,
    sync::{mpsc, Semaphore},
};

const IMAGE_THUMBNAIL_MIN_BYTES: u64 = 512 * 1024;
const PREVIEW_RESTORE_LIMIT: usize = 64;
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
    pub ffmpeg_bin: String,
    pub preview_limit: usize,
    pub preview_batch_limit: usize,
    pub folder_page_limit: usize,
    pub max_folder_page_limit: usize,
    pub max_items_per_folder: usize,
    pub stat_concurrency: usize,
    pub thumbnail_cache_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Image,
    Gif,
    Video,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub name: String,
    pub path: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    pub kind: MediaKind,
    pub size: u64,
    pub modified: f64,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPreview {
    pub name: String,
    pub path: String,
    pub modified: f64,
    pub counts: FolderCounts,
    pub previews: Vec<MediaItem>,
    pub counts_ready: bool,
    pub preview_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approximate: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderCounts {
    pub images: usize,
    pub gifs: usize,
    pub videos: usize,
    pub subfolders: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPayload {
    pub folder: FolderIdentity,
    pub breadcrumb: Vec<FolderIdentity>,
    pub subfolders: Vec<FolderPreview>,
    pub media: Vec<MediaItem>,
    pub totals: FolderTotals,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderIdentity {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTotals {
    pub media: usize,
    pub subfolders: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPreviewBatchError {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone)]
pub struct FolderPreviewBatchResult {
    pub items: Vec<FolderPreview>,
    pub errors: Vec<FolderPreviewBatchError>,
    pub slowest_path: Option<String>,
    pub slowest_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderMode {
    Light,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderMediaFilter {
    Image,
    Video,
}

#[derive(Debug, Clone)]
pub struct GetFolderOptions {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub mode: FolderMode,
    pub media_filter: Option<FolderMediaFilter>,
}

impl Default for GetFolderOptions {
    fn default() -> Self {
        Self {
            cursor: None,
            limit: None,
            mode: FolderMode::Full,
            media_filter: None,
        }
    }
}

impl BackendService {
    pub fn default_folder_page_limit(&self) -> usize {
        self.config.folder_page_limit
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
    pub media: Vec<MediaItem>,
    pub totals: FolderTotals,
    pub default_page_media_json: Option<String>,
}

#[derive(Debug, Clone)]
pub enum MediaPage {
    BorrowedRange { start: usize, end: usize },
    Owned(Vec<MediaItem>),
}

impl MediaPage {
    pub fn as_cow<'a>(&'a self, media: &'a [MediaItem]) -> Cow<'a, [MediaItem]> {
        match self {
            Self::BorrowedRange { start, end } => Cow::Borrowed(&media[*start..*end]),
            Self::Owned(items) => Cow::Borrowed(items.as_slice()),
        }
    }

    fn into_owned(self, media: &[MediaItem]) -> Vec<MediaItem> {
        match self {
            Self::BorrowedRange { start, end } => media[start..end].to_vec(),
            Self::Owned(items) => items,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FolderPageResult {
    pub snapshot: Arc<FolderSnapshot>,
    pub media_page: MediaPage,
    pub next_cursor: Option<String>,
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
    default_page_media_json: String,
    subfolders: Vec<FolderEntryCandidate>,
    subfolder_count: usize,
    watched_directories: Vec<FolderEntryCandidate>,
}

#[derive(Default)]
struct ScannerCaches {
    snapshots: HashMap<String, (u64, Arc<FolderSnapshot>)>,
    previews: HashMap<String, (u64, FolderPreview)>,
    manifests: HashMap<String, (u64, DirectoryManifest)>,
    generations: HashMap<String, u64>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDiagEvent {
    pub ts: u64,
    pub phase: String,
    pub batch_size: usize,
    pub paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub err: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfDiagEvent {
    pub ts: u64,
    pub fps_estimate: f64,
    pub long_task_count10s: u32,
    pub visible_cards: u32,
    pub effects_mode: String,
    pub renderer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
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
}

impl BackendService {
    pub async fn new(
        config: BackendConfig,
        index: IndexStore,
        diagnostics: DiagnosticsWriter,
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
                    invalidate_path_and_ancestors(&mut caches.generations, &path);
                }
                caches.snapshots.clear();
                caches.previews.clear();
                caches.manifests.clear();
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
            thumbnail_semaphore: Arc::new(Semaphore::new(1)),
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

    pub async fn get_folder(
        &self,
        relative_path: &str,
        options: GetFolderOptions,
    ) -> Result<FolderPayload> {
        let page = self.get_folder_page(relative_path, options).await?;

        Ok(FolderPayload {
            folder: page.snapshot.folder.clone(),
            breadcrumb: page.snapshot.breadcrumb.clone(),
            subfolders: page.snapshot.subfolders.clone(),
            media: page.media_page.into_owned(&page.snapshot.media),
            totals: page.snapshot.totals.clone(),
            next_cursor: page.next_cursor,
        })
    }

    pub async fn get_folder_page(
        &self,
        relative_path: &str,
        options: GetFolderOptions,
    ) -> Result<FolderPageResult> {
        let snapshot = match options.mode {
            FolderMode::Light => self.get_light_snapshot(relative_path).await?,
            FolderMode::Full => self.get_full_snapshot(relative_path).await?,
        };
        let cursor = parse_cursor(options.cursor.as_deref())?;
        let limit = options
            .limit
            .unwrap_or(self.config.folder_page_limit)
            .clamp(1, self.config.max_folder_page_limit);
        let (media_page, next_cursor) =
            page_media_for_filter(&snapshot.media, cursor, limit, options.media_filter)?;

        Ok(FolderPageResult {
            snapshot,
            media_page,
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

    pub async fn get_thumbnail_path(
        &self,
        relative_path: &str,
        absolute_path: &Path,
        modified_ms: i64,
        kind: MediaKind,
    ) -> Result<PathBuf> {
        if let Some(cached) = self
            .index
            .load_thumbnail_asset(relative_path.to_string(), modified_ms)
            .await?
        {
            let cached_path = PathBuf::from(&cached);
            if fs::metadata(&cached_path).await.is_ok() {
                return Ok(cached_path);
            }
        }

        let _permit = self.thumbnail_semaphore.acquire().await?;
        fs::create_dir_all(&self.config.thumbnail_cache_dir).await?;
        let digest = sha1_hex(relative_path.as_bytes());
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
                relative_path.to_string(),
                modified_ms,
                "running".to_string(),
                None,
            )
            .await?;

        let mut cmd = Command::new(&self.config.ffmpeg_bin);
        cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-threads", "1"]);
        if matches!(kind, MediaKind::Video | MediaKind::Gif) {
            cmd.args(["-ss", "0.1"]);
        }
        cmd.arg("-i")
            .arg(absolute_path)
            .args([
                "-frames:v",
                "1",
                "-vf",
                "scale=640:-2:force_original_aspect_ratio=decrease",
                "-q:v",
                "4",
            ])
            .arg(&temp_path);

        let output = cmd.output().await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            self.index
                .save_thumbnail_job(
                    relative_path.to_string(),
                    modified_ms,
                    "error".to_string(),
                    Some(stderr.clone()),
                )
                .await?;
            return Err(anyhow!(if stderr.is_empty() {
                "Thumbnail generation failed".to_string()
            } else {
                stderr
            }));
        }

        fs::rename(&temp_path, &output_path).await?;
        self.index
            .save_thumbnail_asset(
                relative_path.to_string(),
                modified_ms,
                output_path.to_string_lossy().to_string(),
            )
            .await?;
        self.index
            .save_thumbnail_job(
                relative_path.to_string(),
                modified_ms,
                "ready".to_string(),
                None,
            )
            .await?;
        Ok(output_path)
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
        let cache_key = format!("light:{safe_relative_path}");
        if let Some(snapshot) = self.read_snapshot_cache(&cache_key, generation) {
            return Ok(snapshot);
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
                approximate: Some(true),
            });
        }
        subfolders.sort_by(|a, b| b.modified.total_cmp(&a.modified));

        let mut media = self.build_media_items(scan.media_candidates).await?;
        media.sort_by(|a, b| b.modified.total_cmp(&a.modified));

        let snapshot = Arc::new(FolderSnapshot {
            folder: folder_identity(&self.config.media_root, &safe_relative_path),
            breadcrumb: build_breadcrumb(&safe_relative_path),
            totals: FolderTotals {
                media: media.len(),
                subfolders: subfolders.len(),
            },
            subfolders,
            media,
            default_page_media_json: None,
        });
        self.write_snapshot_cache(cache_key, generation, snapshot.clone());
        Ok(snapshot)
    }

    async fn get_full_snapshot(&self, relative_path: &str) -> Result<Arc<FolderSnapshot>> {
        let (safe_relative_path, absolute_path) = self.resolve_paths(relative_path).await?;
        let generation = self.path_generation(&safe_relative_path);
        let cache_key = format!("full:{safe_relative_path}");
        if let Some(snapshot) = self.read_snapshot_cache(&cache_key, generation) {
            return Ok(snapshot);
        }

        let manifest = self
            .get_directory_manifest(&absolute_path, &safe_relative_path, true)
            .await?;
        let mut subfolders = Vec::with_capacity(manifest.subfolders.len());
        for child in &manifest.subfolders {
            subfolders.push(
                self.get_resolved_folder_preview(
                    &child.absolute_path,
                    &child.relative_path,
                    self.config.preview_limit,
                )
                .await?,
            );
        }
        subfolders.sort_by(|a, b| b.modified.total_cmp(&a.modified));

        let snapshot = Arc::new(FolderSnapshot {
            folder: folder_identity(&self.config.media_root, &safe_relative_path),
            breadcrumb: build_breadcrumb(&safe_relative_path),
            totals: FolderTotals {
                media: manifest.media.len(),
                subfolders: subfolders.len(),
            },
            subfolders,
            media: manifest.media.clone(),
            default_page_media_json: Some(manifest.default_page_media_json.clone()),
        });
        self.write_snapshot_cache(cache_key, generation, snapshot.clone());
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
        let cache_key = format!("preview:{safe_relative_path}:{preview_limit}");
        if let Some(preview) = self.read_preview_cache(&cache_key, generation) {
            return Ok(preview);
        }

        let manifest = self
            .get_directory_manifest(absolute_path, safe_relative_path, false)
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
            self.write_preview_cache(cache_key, generation, preview.clone());
            return Ok(preview);
        }

        let mut counts = FolderCounts {
            subfolders: manifest.subfolder_count,
            ..FolderCounts::default()
        };
        let mut modified = 0_f64;
        for item in &manifest.media {
            increment_counts(&mut counts, &item.kind);
            modified = modified.max(item.modified);
        }
        if modified == 0.0 {
            modified = dir_modified(absolute_path).await.unwrap_or(0.0);
        }

        let preview = FolderPreview {
            name: basename_or_root(safe_relative_path, &self.config.media_root),
            path: safe_relative_path.to_string(),
            modified,
            counts,
            previews: manifest
                .media
                .iter()
                .take(preview_limit.min(PREVIEW_RESTORE_LIMIT))
                .cloned()
                .collect(),
            counts_ready: true,
            preview_ready: true,
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
        Ok(preview)
    }

    async fn get_directory_manifest(
        &self,
        absolute_path: &Path,
        safe_relative_path: &str,
        allow_fast_restore: bool,
    ) -> Result<DirectoryManifest> {
        let generation = self.path_generation(safe_relative_path);
        let cache_key = format!("manifest:{safe_relative_path}");
        if let Some(manifest) = self.read_manifest_cache(&cache_key, generation) {
            return Ok(manifest);
        }

        let root_modified = dir_modified(absolute_path).await?;
        if let Some(record) = self
            .index
            .load_latest_manifest(safe_relative_path.to_string())
            .await?
        {
            let persisted = self.hydrate_manifest_record(record)?;
            if (persisted.root_modified - root_modified).abs() < f64::EPSILON {
                if allow_fast_restore {
                    self.install_manifest_watches(absolute_path, safe_relative_path, &persisted);
                    self.write_manifest_cache(cache_key.clone(), generation, persisted.clone());
                    self.schedule_manifest_validation(
                        cache_key,
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
                    self.write_manifest_cache(cache_key, generation, validated.clone());
                    return Ok(validated);
                }
            }
        }

        let manifest = self
            .build_directory_manifest(absolute_path, safe_relative_path, root_modified)
            .await?;
        self.persist_manifest(safe_relative_path, &manifest).await?;
        self.install_manifest_watches(absolute_path, safe_relative_path, &manifest);
        self.write_manifest_cache(cache_key, generation, manifest.clone());
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
        media.sort_by(|a, b| b.modified.total_cmp(&a.modified));
        let default_page_media_json =
            build_default_page_media_json(&media, self.config.folder_page_limit)?;

        let mut manifest = DirectoryManifest {
            root_modified,
            stamp: String::new(),
            media,
            default_page_media_json,
            subfolders: scan.subfolders,
            subfolder_count: scan.subfolder_count,
            watched_directories: scan.watched_directories,
        };
        manifest.stamp = build_manifest_stamp_from_manifest(&manifest);
        Ok(manifest)
    }

    async fn persist_manifest(
        &self,
        safe_relative_path: &str,
        manifest: &DirectoryManifest,
    ) -> Result<()> {
        let media_json = serde_json::to_string(&manifest.media)?;
        let media_bin = bincode::serialize(
            &manifest
                .media
                .iter()
                .map(PersistedMediaBlob::from)
                .collect::<Vec<_>>(),
        )?;
        let media_records = manifest
            .media
            .iter()
            .enumerate()
            .map(|(ordinal, item)| PersistedMediaRecord {
                ordinal: ordinal as i64,
                media_path: item.path.clone(),
                kind: media_kind_as_str(&item.kind).to_string(),
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
                subfolders_json: serde_json::to_string(&manifest.subfolders)?,
                watched_dirs_json: serde_json::to_string(&manifest.watched_directories)?,
                media_json,
                media_bin,
                default_page_media_json: manifest.default_page_media_json.clone(),
                media: media_records,
            })
            .await
    }

    fn hydrate_manifest_record(
        &self,
        record: tmv_backend_index::PersistedManifestRecord,
    ) -> Result<DirectoryManifest> {
        let subfolders =
            serde_json::from_str::<Vec<FolderEntryCandidate>>(&record.subfolders_json)?;
        let watched_directories =
            serde_json::from_str::<Vec<FolderEntryCandidate>>(&record.watched_dirs_json)?;
        let media = match record.media_bin {
            Some(media_bin) if !media_bin.is_empty() => {
                let persisted = bincode::deserialize::<Vec<PersistedMediaBlob>>(&media_bin)?;
                persisted.into_iter().map(MediaItem::from).collect()
            }
            _ => serde_json::from_str::<Vec<MediaItem>>(&record.media_json)?,
        };
        Ok(DirectoryManifest {
            root_modified: record.root_modified,
            stamp: record.stamp,
            subfolder_count: subfolders.len(),
            subfolders,
            watched_directories,
            media,
            default_page_media_json: record
                .default_page_media_json
                .unwrap_or_else(|| "[]".to_string()),
        })
    }

    fn schedule_manifest_validation(
        &self,
        cache_key: String,
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
            if !validations.insert(cache_key.clone()) {
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
                    service.write_manifest_cache(cache_key.clone(), generation, validated.clone());
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
                .remove(&cache_key);
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

        let mut subfolders = Vec::with_capacity(persisted.subfolders.len());
        for subfolder in &persisted.subfolders {
            let Some(refreshed) = refreshed_watch.by_path.get(&subfolder.relative_path) else {
                return Ok(None);
            };
            subfolders.push(refreshed.clone());
        }

        let changed_category_paths = refreshed_watch
            .changed_category_dirs
            .iter()
            .map(|entry| entry.relative_path.clone())
            .collect::<HashSet<_>>();

        let unchanged_media = persisted
            .media
            .iter()
            .filter(|item| {
                let parent = Path::new(&item.path)
                    .parent()
                    .map(|value| value.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                !changed_category_paths.contains(&parent)
            })
            .cloned()
            .collect::<Vec<_>>();
        let refreshed_media = stream::iter(
            unchanged_media
                .into_iter()
                .map(|item| async move { self.validate_persisted_media_item(item).await }),
        )
        .buffered(self.config.stat_concurrency.max(1))
        .collect::<Vec<Result<Option<MediaItem>>>>()
        .await;

        let mut media = Vec::new();
        for item in refreshed_media {
            let Some(item) = item? else {
                return Ok(None);
            };
            media.push(item);
        }

        let changed_category_dirs = refreshed_watch.changed_category_dirs.clone();
        let category_scan_service = self.clone();
        let refreshed_category_candidates =
            stream::iter(changed_category_dirs.into_iter().map(move |entry| {
                let service = category_scan_service.clone();
                async move {
                    service
                        .collect_direct_media_candidates(&entry.absolute_path, &entry.relative_path)
                        .await
                }
            }))
            .buffered(clamp(self.config.stat_concurrency / 2, 2, 8))
            .collect::<Vec<Result<Vec<MediaCandidate>>>>()
            .await;

        let mut category_candidates = Vec::new();
        for candidates in refreshed_category_candidates {
            category_candidates.extend(candidates?);
        }
        if !category_candidates.is_empty() {
            media.extend(self.build_media_items(category_candidates).await?);
        }
        media.sort_by(|a, b| b.modified.total_cmp(&a.modified));
        let default_page_media_json =
            build_default_page_media_json(&media, self.config.folder_page_limit)?;

        let mut manifest = DirectoryManifest {
            root_modified,
            stamp: String::new(),
            subfolder_count: subfolders.len(),
            subfolders,
            watched_directories: refreshed_watch.entries,
            media,
            default_page_media_json,
        };
        manifest.stamp = build_manifest_stamp_from_manifest(&manifest);

        let should_persist = !refreshed_watch.changed_category_dirs.is_empty()
            || !refreshed_watch.changed_subfolders.is_empty()
            || manifest.stamp != persisted.stamp;

        if safe_relative_path.is_empty() && manifest.media.is_empty() && persisted.media.is_empty()
        {
            return Ok(Some((manifest, should_persist)));
        }

        Ok(Some((manifest, should_persist)))
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

    async fn validate_persisted_media_item(&self, item: MediaItem) -> Result<Option<MediaItem>> {
        let resolved = match self.resolve_media_file(&item.path).await {
            Ok(resolved) => resolved,
            Err(error) if is_ignorable_entry_resolution_error(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let metadata = match fs::metadata(&resolved.absolute_path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file() {
            return Ok(None);
        }
        Ok(Some(build_media_item(
            &basename_or_root(&resolved.safe_relative_path, &self.config.media_root),
            &resolved.safe_relative_path,
            &resolved.kind,
            metadata.len(),
            modified_ms(&metadata),
        )))
    }

    fn invalidate_runtime_path(&self, path: &str) {
        let mut caches = self.caches.lock().expect("scanner caches poisoned");
        invalidate_path_and_ancestors(&mut caches.generations, path);
        caches.snapshots.clear();
        caches.previews.clear();
        caches.manifests.clear();
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

    fn read_snapshot_cache(&self, key: &str, generation: u64) -> Option<Arc<FolderSnapshot>> {
        self.caches
            .lock()
            .expect("scanner caches poisoned")
            .snapshots
            .get(key)
            .filter(|(stored_generation, _)| *stored_generation == generation)
            .map(|(_, snapshot)| Arc::clone(snapshot))
    }

    fn write_snapshot_cache(&self, key: String, generation: u64, snapshot: Arc<FolderSnapshot>) {
        self.caches
            .lock()
            .expect("scanner caches poisoned")
            .snapshots
            .insert(key, (generation, snapshot));
    }

    fn read_preview_cache(&self, key: &str, generation: u64) -> Option<FolderPreview> {
        self.caches
            .lock()
            .expect("scanner caches poisoned")
            .previews
            .get(key)
            .filter(|(stored_generation, _)| *stored_generation == generation)
            .map(|(_, preview)| preview.clone())
    }

    fn write_preview_cache(&self, key: String, generation: u64, preview: FolderPreview) {
        self.caches
            .lock()
            .expect("scanner caches poisoned")
            .previews
            .insert(key, (generation, preview));
    }

    fn read_manifest_cache(&self, key: &str, generation: u64) -> Option<DirectoryManifest> {
        self.caches
            .lock()
            .expect("scanner caches poisoned")
            .manifests
            .get(key)
            .filter(|(stored_generation, _)| *stored_generation == generation)
            .map(|(_, manifest)| manifest.clone())
    }

    fn write_manifest_cache(&self, key: String, generation: u64, manifest: DirectoryManifest) {
        self.caches
            .lock()
            .expect("scanner caches poisoned")
            .manifests
            .insert(key, (generation, manifest));
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

pub fn page_media_for_filter(
    media: &[MediaItem],
    cursor: usize,
    limit: usize,
    filter: Option<FolderMediaFilter>,
) -> Result<(MediaPage, Option<String>)> {
    if filter.is_none() {
        if cursor > media.len() {
            return Err(anyhow!("Cursor exceeds media item count"));
        }
        let end = (cursor + limit).min(media.len());
        let next_index = end;
        return Ok((
            MediaPage::BorrowedRange { start: cursor, end },
            (next_index < media.len()).then(|| next_index.to_string()),
        ));
    }

    let filter = filter.expect("checked is_some");
    let mut items = Vec::new();
    let mut matched_count = 0usize;
    let mut has_more = false;

    for item in media {
        if !matches_filter(item, filter) {
            continue;
        }
        if matched_count < cursor {
            matched_count += 1;
            continue;
        }
        if items.len() < limit {
            items.push(item.clone());
            matched_count += 1;
            continue;
        }
        has_more = true;
        break;
    }

    if cursor > matched_count {
        return Err(anyhow!("Cursor exceeds media item count"));
    }

    let next_cursor = has_more.then(|| (cursor + items.len()).to_string());
    Ok((MediaPage::Owned(items), next_cursor))
}

fn matches_filter(item: &MediaItem, filter: FolderMediaFilter) -> bool {
    match filter {
        FolderMediaFilter::Video => item.kind == MediaKind::Video,
        FolderMediaFilter::Image => matches!(item.kind, MediaKind::Image | MediaKind::Gif),
    }
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

fn build_media_item(
    name: &str,
    relative_path: &str,
    kind: &MediaKind,
    size: u64,
    modified: f64,
) -> MediaItem {
    let encoded = encode_path(relative_path);
    let should_use_thumbnail =
        matches!(kind, MediaKind::Video | MediaKind::Gif) || size >= IMAGE_THUMBNAIL_MIN_BYTES;
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

fn invalidate_path_and_ancestors(generations: &mut HashMap<String, u64>, path: &str) {
    let mut current = Some(path.to_string());
    while let Some(value) = current.take() {
        let next = generations.get(&value).copied().unwrap_or(0) + 1;
        generations.insert(value.clone(), next);
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

#[cfg(test)]
mod tests {
    use super::{
        BackendConfig, BackendService, DiagnosticsWriter, FolderMediaFilter, FolderMode,
        GetFolderOptions, IndexStore,
    };
    use anyhow::Result;
    use tempfile::tempdir;
    use tokio::fs;

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
            BackendConfig {
                media_root: root.clone(),
                ffmpeg_bin: "ffmpeg".to_string(),
                preview_limit: 6,
                preview_batch_limit: 64,
                folder_page_limit: 120,
                max_folder_page_limit: 1000,
                max_items_per_folder: 20_000,
                stat_concurrency: 8,
                thumbnail_cache_dir: thumbs,
            },
            IndexStore::new(index).await?,
            DiagnosticsWriter::new(diag).await?,
        )
        .await?;

        let light = service
            .get_folder(
                "",
                GetFolderOptions {
                    mode: FolderMode::Light,
                    ..Default::default()
                },
            )
            .await?;
        assert_eq!(light.subfolders.len(), 1);

        let full = service
            .get_folder(
                "alpha",
                GetFolderOptions {
                    mode: FolderMode::Full,
                    media_filter: Some(FolderMediaFilter::Image),
                    ..Default::default()
                },
            )
            .await?;
        assert_eq!(full.media.len(), 2);
        Ok(())
    }
}
