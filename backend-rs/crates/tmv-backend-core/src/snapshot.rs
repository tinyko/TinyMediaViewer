use super::{
    build_breadcrumb, clamp, dir_modified, folder_identity, join_relative, read_visible_entries,
    BackendService, EntryKind, FolderPreview, FolderScanResult, FolderSnapshot, MediaCandidate,
    RootSummaryPayload,
};
use anyhow::Result;
use futures::{stream, StreamExt};
use std::{path::Path, sync::Arc};

impl BackendService {
    pub async fn get_root_summary(&self) -> Result<RootSummaryPayload> {
        let snapshot = self.get_light_snapshot("").await?;
        Ok(RootSummaryPayload {
            folder: snapshot.folder.clone(),
            breadcrumb: snapshot.breadcrumb.clone(),
            subfolders: snapshot.subfolders.clone(),
            totals: snapshot.totals.clone(),
        })
    }

    pub(crate) async fn get_light_snapshot(
        &self,
        relative_path: &str,
    ) -> Result<Arc<FolderSnapshot>> {
        let (safe_relative_path, absolute_path) = self.resolve_paths(relative_path).await?;
        let generation = self.path_generation(&safe_relative_path);
        if let Some(snapshot) = self.read_light_snapshot_cache(&safe_relative_path, generation) {
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
                counts: Default::default(),
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
            totals: super::FolderTotals {
                media: scan.media_candidates.len(),
                subfolders: subfolders.len(),
            },
            subfolders,
        });
        self.write_light_snapshot_cache(safe_relative_path, generation, snapshot.clone());
        Ok(snapshot)
    }

    pub(crate) async fn scan_folder_entries(
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
        let directory_entries =
            stream::iter(directory_entries.into_iter().map(|entry| async move {
                match entry.kind {
                    EntryKind::Directory => {
                        let modified = dir_modified(&entry.absolute_path).await.unwrap_or(0.0);
                        (entry, Some(modified))
                    }
                    EntryKind::File(_) => (entry, None),
                }
            }))
            .buffered(clamp(self.config.stat_concurrency, 2, 16))
            .collect::<Vec<_>>()
            .await;

        for (entry, modified) in directory_entries {
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
                    let candidate = super::FolderEntryCandidate {
                        name: entry.name.clone(),
                        relative_path: entry_relative.clone(),
                        absolute_path: entry.absolute_path.clone(),
                        modified: modified.unwrap_or(0.0),
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
}
