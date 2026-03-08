use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum MediaKind {
    Image,
    Gif,
    Video,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct MediaItem {
    pub name: String,
    pub path: String,
    pub url: String,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    pub kind: MediaKind,
    #[ts(type = "number")]
    pub size: u64,
    pub modified: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FolderCounts {
    pub images: usize,
    pub gifs: usize,
    pub videos: usize,
    pub subfolders: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FolderPreview {
    pub name: String,
    pub path: String,
    pub modified: f64,
    pub counts: FolderCounts,
    pub previews: Vec<MediaItem>,
    pub counts_ready: bool,
    pub preview_ready: bool,
    #[serde(default)]
    pub favorite: bool,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approximate: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FolderIdentity {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FolderTotals {
    pub media: usize,
    pub subfolders: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RootSummaryPayload {
    pub folder: FolderIdentity,
    pub breadcrumb: Vec<FolderIdentity>,
    pub subfolders: Vec<FolderPreview>,
    pub totals: FolderTotals,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct CategoryPagePayload {
    pub folder: FolderIdentity,
    pub breadcrumb: Vec<FolderIdentity>,
    pub media: Vec<MediaItem>,
    pub counts: FolderCounts,
    pub total_media: usize,
    pub filtered_total: usize,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FolderPreviewBatchInput {
    pub paths: Vec<String>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_per_folder: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FolderPreviewBatchError {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FolderPreviewBatchOutput {
    pub items: Vec<FolderPreview>,
    #[ts(optional)]
    pub errors: Option<Vec<FolderPreviewBatchError>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FolderFavoriteInput {
    pub path: String,
    pub favorite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FolderFavoriteOutput {
    pub path: String,
    pub favorite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SystemUsageFile {
    pub path: String,
    #[ts(type = "number")]
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SystemUsageAccount {
    pub account: String,
    #[ts(type = "number")]
    pub total_size: u64,
    #[ts(type = "number")]
    pub image_size: u64,
    #[ts(type = "number")]
    pub gif_size: u64,
    #[ts(type = "number")]
    pub video_size: u64,
    #[ts(type = "number")]
    pub other_size: u64,
    pub top_files: Vec<SystemUsageFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SystemUsageReport {
    pub root_path: String,
    #[ts(type = "number")]
    pub generated_at: u64,
    pub items: Vec<SystemUsageAccount>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum ViewerAccountSortMode {
    Time,
    Name,
    Favorite,
    Random,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum ViewerMediaSortMode {
    Asc,
    Desc,
    Random,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum ViewerTheme {
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ViewerPreferences {
    pub search: String,
    pub sort_mode: ViewerAccountSortMode,
    #[ts(type = "number")]
    pub random_seed: u64,
    pub media_sort: ViewerMediaSortMode,
    #[ts(type = "number")]
    pub media_random_seed: u64,
    pub media_filter: FolderMediaFilter,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_path: Option<String>,
    pub theme: ViewerTheme,
    pub manual_theme: bool,
    pub effects_mode: EffectsMode,
    pub effects_renderer: EffectsRenderer,
}

impl Default for ViewerPreferences {
    fn default() -> Self {
        Self {
            search: String::new(),
            sort_mode: ViewerAccountSortMode::Time,
            random_seed: 0,
            media_sort: ViewerMediaSortMode::Desc,
            media_random_seed: 0,
            media_filter: FolderMediaFilter::Image,
            category_path: None,
            theme: ViewerTheme::Light,
            manual_theme: false,
            effects_mode: EffectsMode::Auto,
            effects_renderer: EffectsRenderer::Webgpu,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum FolderMediaFilter {
    Image,
    Video,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum PreviewDiagPhase {
    Enqueue,
    Request,
    Response,
    Apply,
    Error,
    Timeout,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct PreviewDiagEvent {
    #[ts(type = "number")]
    pub ts: u64,
    pub phase: PreviewDiagPhase,
    pub batch_size: usize,
    pub paths: Vec<String>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub err: Option<String>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct PreviewDiagEventsInput {
    pub events: Vec<PreviewDiagEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum EffectsMode {
    Auto,
    Off,
    Full,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum EffectsRenderer {
    Canvas2d,
    Webgpu,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct PerfDiagEvent {
    #[ts(type = "number")]
    pub ts: u64,
    pub fps_estimate: f64,
    pub long_task_count10s: u32,
    pub visible_cards: u32,
    pub effects_mode: EffectsMode,
    pub renderer: EffectsRenderer,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct PerfDiagEventsInput {
    pub events: Vec<PerfDiagEvent>,
}
