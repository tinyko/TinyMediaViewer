use super::{
    build_breadcrumb, compare_media_items_by_time_desc, deserialize_media_payloads, dir_modified,
    folder_identity, increment_counts, media_filter_group, media_filter_group_for_item,
    media_kind_as_str, media_sort_time_key, parse_cursor, BackendService, CategoryPagePayload,
    DirectoryManifest, FolderCounts, FolderEntryCandidate, FolderMediaFilter, FolderSortOrder,
    GetCategoryOptions, MediaCandidate, MediaItem,
};
use crate::media::build_manifest_stamp_from_manifest;
use anyhow::{anyhow, Result};
use futures::{stream, StreamExt};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tmv_backend_index::PersistedMediaRecord;

impl BackendService {
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
        let filtered_total = match options.media_filter {
            FolderMediaFilter::Image => manifest.counts.images + manifest.counts.gifs,
            FolderMediaFilter::Video => manifest.counts.videos,
        };
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

    pub(crate) async fn get_directory_manifest(
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
            let media_entries_exist = self
                .index
                .has_media_entries(safe_relative_path.to_string())
                .await?;
            if !media_entries_exist {
                let rebuilt = self
                    .build_directory_manifest(absolute_path, safe_relative_path, root_modified)
                    .await?;
                self.persist_manifest(safe_relative_path, &rebuilt).await?;
                self.sync_manifest_watches(absolute_path, safe_relative_path, &rebuilt);
                self.write_manifest_cache(
                    safe_relative_path.to_string(),
                    generation,
                    rebuilt.clone(),
                );
                return Ok(rebuilt);
            }

            let persisted = self.hydrate_manifest_record(&record)?;
            if (persisted.root_modified - root_modified).abs() < f64::EPSILON {
                if allow_fast_restore {
                    self.sync_manifest_watches(absolute_path, safe_relative_path, &persisted);
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
                    self.sync_manifest_watches(absolute_path, safe_relative_path, &validated);
                    self.write_manifest_cache(
                        safe_relative_path.to_string(),
                        generation,
                        validated.clone(),
                    );
                    return Ok(validated);
                }

                self.watch_registry.clear_owner(safe_relative_path);
            }
        }

        let manifest = self
            .build_directory_manifest(absolute_path, safe_relative_path, root_modified)
            .await?;
        self.persist_manifest(safe_relative_path, &manifest).await?;
        self.sync_manifest_watches(absolute_path, safe_relative_path, &manifest);
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
            .save_manifest(tmv_backend_index::SaveManifestInput {
                path: safe_relative_path.to_string(),
                stamp: manifest.stamp.clone(),
                root_modified: manifest.root_modified,
                media_total: manifest.media_total as i64,
                image_total: manifest.counts.images as i64,
                gif_total: manifest.counts.gifs as i64,
                video_total: manifest.counts.videos as i64,
                subfolders_json: serde_json::to_string(&manifest.subfolders)?,
                watched_dirs_json: serde_json::to_string(&manifest.watched_directories)?,
                media: media_records,
            })
            .await
    }

    fn hydrate_manifest_record(
        &self,
        record: &tmv_backend_index::PersistedManifestRecord,
    ) -> Result<DirectoryManifest> {
        let subfolders =
            serde_json::from_str::<Vec<FolderEntryCandidate>>(&record.subfolders_json)?;
        let watched_directories =
            serde_json::from_str::<Vec<FolderEntryCandidate>>(&record.watched_dirs_json)?;
        let mut media: Vec<MediaItem> = Vec::new();
        media.sort_by(compare_media_items_by_time_desc);
        let counts = FolderCounts {
            images: usize::try_from(record.image_total).unwrap_or(0),
            gifs: usize::try_from(record.gif_total).unwrap_or(0),
            videos: usize::try_from(record.video_total).unwrap_or(0),
            subfolders: subfolders.len(),
        };
        let media_total = usize::try_from(record.media_total).unwrap_or(0);
        Ok(DirectoryManifest {
            root_modified: record.root_modified,
            stamp: record.stamp.clone(),
            subfolder_count: subfolders.len(),
            subfolders,
            watched_directories,
            media,
            counts,
            media_total,
        })
    }

    pub(crate) async fn ensure_media_entries_for_manifest(
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

    pub(crate) async fn load_media_items_from_index(
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
                    service.sync_manifest_watches(&absolute_path, &safe_relative_path, &validated);
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
    ) -> Result<Option<super::RefreshedWatchState>> {
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
        .buffered(super::clamp(self.config.stat_concurrency, 2, 16))
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

        Ok(Some(super::RefreshedWatchState {
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
            Err(error) if super::is_ignorable_entry_resolution_error(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let stats = match tokio::fs::metadata(&absolute_path).await {
            Ok(stats) => stats,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !stats.is_dir() {
            return Ok(None);
        }
        Ok(Some(FolderEntryCandidate {
            name: super::basename_or_root(&safe_relative_path, &self.config.media_root),
            absolute_path,
            relative_path: safe_relative_path,
            modified: super::modified_ms(&stats),
        }))
    }

    pub(crate) async fn build_media_items(
        &self,
        candidates: Vec<MediaCandidate>,
    ) -> Result<Vec<MediaItem>> {
        let concurrency = self.config.stat_concurrency.max(1);
        let items = stream::iter(candidates.into_iter().map(|candidate| async move {
            let metadata = match tokio::fs::metadata(&candidate.absolute_path).await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(anyhow!(error)),
            };
            if !metadata.is_file() {
                return Ok(None);
            }
            Ok(Some(super::build_media_item(
                &candidate.name,
                &candidate.relative_path,
                &candidate.kind,
                metadata.len(),
                super::modified_ms(&metadata),
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
}
