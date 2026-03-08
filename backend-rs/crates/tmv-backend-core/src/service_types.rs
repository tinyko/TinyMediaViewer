use crate::{
    thumbnail::ThumbnailError, FolderCounts, FolderIdentity, FolderPreview, FolderTotals,
    MediaItem, MediaKind,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

#[derive(Debug, Clone)]
pub struct ResolvedMedia {
    pub safe_relative_path: String,
    pub absolute_path: PathBuf,
    pub kind: MediaKind,
}

#[derive(Debug, Clone)]
pub(crate) struct FolderSnapshot {
    pub(crate) folder: FolderIdentity,
    pub(crate) breadcrumb: Vec<FolderIdentity>,
    pub(crate) subfolders: Vec<FolderPreview>,
    pub(crate) totals: FolderTotals,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct FolderEntryCandidate {
    pub(crate) name: String,
    pub(crate) relative_path: String,
    pub(crate) absolute_path: PathBuf,
    pub(crate) modified: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct MediaCandidate {
    pub(crate) name: String,
    pub(crate) relative_path: String,
    pub(crate) absolute_path: PathBuf,
    pub(crate) kind: MediaKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DirectoryManifest {
    pub(crate) root_modified: f64,
    pub(crate) stamp: String,
    pub(crate) media: Vec<MediaItem>,
    pub(crate) counts: FolderCounts,
    pub(crate) media_total: usize,
    pub(crate) subfolders: Vec<FolderEntryCandidate>,
    pub(crate) subfolder_count: usize,
    pub(crate) watched_directories: Vec<FolderEntryCandidate>,
}

#[derive(Debug)]
pub(crate) struct FolderScanResult {
    pub(crate) subfolders: Vec<FolderEntryCandidate>,
    pub(crate) subfolder_count: usize,
    pub(crate) media_candidates: Vec<MediaCandidate>,
    pub(crate) watched_directories: Vec<FolderEntryCandidate>,
}

#[derive(Debug)]
pub(crate) struct RefreshedWatchState {
    pub(crate) entries: Vec<FolderEntryCandidate>,
    pub(crate) by_path: HashMap<String, FolderEntryCandidate>,
    pub(crate) changed_category_dirs: Vec<FolderEntryCandidate>,
    pub(crate) changed_subfolders: Vec<FolderEntryCandidate>,
}

#[derive(Debug)]
pub(crate) struct VisibleEntry {
    pub(crate) name: String,
    pub(crate) absolute_path: PathBuf,
    pub(crate) kind: EntryKind,
}

#[derive(Debug, Clone)]
pub(crate) enum EntryKind {
    File(MediaKind),
    Directory,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub(crate) struct ThumbnailRequestKey {
    pub(crate) relative_path: String,
    pub(crate) modified_ms: i64,
}

impl ThumbnailRequestKey {
    pub(crate) fn new(relative_path: &str, modified_ms: i64) -> Self {
        Self {
            relative_path: relative_path.to_string(),
            modified_ms,
        }
    }
}

pub(crate) type ThumbnailTaskResult = std::result::Result<PathBuf, ThumbnailError>;

#[derive(Debug, Default)]
pub(crate) struct ThumbnailTaskState {
    pub(crate) notify: Notify,
    pub(crate) result: Mutex<Option<ThumbnailTaskResult>>,
}

#[derive(Debug, Clone)]
pub(crate) struct ThumbnailFailureEntry {
    pub(crate) error: ThumbnailError,
    pub(crate) failed_at_ms: u64,
}

pub(crate) enum ThumbnailTaskSlot {
    Leader(Arc<ThumbnailTaskState>),
    Follower(Arc<ThumbnailTaskState>),
}
