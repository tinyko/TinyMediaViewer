use super::{
    basename_or_root, clamp, dedupe_paths, dir_modified, now_ms_u64, preview_stamp, BackendService,
    FolderPreview, FolderPreviewBatchError, FolderPreviewBatchResult, FolderSortOrder,
    PreviewBatchSummary, PreviewCacheKey, PREVIEW_RESTORE_LIMIT,
};
use anyhow::Result;
use futures::{stream, StreamExt};
use std::{collections::HashSet, path::Path, sync::Arc, time::Instant};

impl BackendService {
    pub async fn get_folder_previews(
        &self,
        paths: Vec<String>,
        limit_per_folder: Option<usize>,
    ) -> FolderPreviewBatchResult {
        let started_at = Instant::now();
        let unique_paths = dedupe_paths(paths);
        let request_path_count = unique_paths.len();
        let favorite_paths = Arc::new(self.load_folder_favorite_paths().await.unwrap_or_default());
        let limit = clamp(
            limit_per_folder.unwrap_or(self.config.preview_limit),
            1,
            self.config
                .preview_limit
                .max(self.config.preview_limit.saturating_mul(4)),
        );
        let concurrency = clamp(self.config.stat_concurrency / 2, 2, 8);
        let results = stream::iter(unique_paths.into_iter().map({
            let favorite_paths = Arc::clone(&favorite_paths);
            move |path| {
                let favorite_paths = Arc::clone(&favorite_paths);
                async move {
                    let started = Instant::now();
                    let outcome = self
                        .get_folder_preview_with_favorites(
                            &path,
                            limit,
                            Some(favorite_paths.as_ref()),
                        )
                        .await;
                    (
                        path,
                        started.elapsed().as_millis() as u64,
                        outcome.map_err(|error| error.to_string()),
                    )
                }
            }
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

    pub(crate) async fn get_folder_preview_with_favorites(
        &self,
        relative_path: &str,
        preview_limit: usize,
        favorite_paths: Option<&HashSet<String>>,
    ) -> Result<FolderPreview> {
        let (safe_relative_path, absolute_path) = self.resolve_paths(relative_path).await?;
        let preview = self
            .get_resolved_folder_preview(&absolute_path, &safe_relative_path, preview_limit)
            .await?;
        match favorite_paths {
            Some(paths) => Ok(Self::annotate_folder_preview_from_set(preview, paths)),
            None => self.annotate_folder_favorite(preview).await,
        }
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
            return Ok(preview);
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
            return Ok(preview);
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
        Ok(preview)
    }
}
