use crate::service_types::VisibleEntry;
use crate::{detect_media_kind_from_path, EntryKind};
use anyhow::Result;
#[cfg(not(unix))]
use std::time::{SystemTime, UNIX_EPOCH};
use std::{fs::Metadata, path::Path};
use tokio::fs;

pub(crate) async fn read_visible_entries(directory: &Path) -> Result<Vec<VisibleEntry>> {
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

pub(crate) async fn dir_modified(path: &Path) -> Result<f64> {
    let metadata = fs::metadata(path).await?;
    Ok(modified_ms(&metadata))
}

pub(crate) fn modified_ms(metadata: &Metadata) -> f64 {
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
