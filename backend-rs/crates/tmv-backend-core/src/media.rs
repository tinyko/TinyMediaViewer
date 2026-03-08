use crate::paths::encode_path;
use crate::{
    DirectoryManifest, FolderCounts, FolderMediaFilter, MediaItem, MediaKind,
    IMAGE_THUMBNAIL_MIN_BYTES, THUMBNAIL_FAILURE_TTL_MS,
};
use anyhow::{anyhow, Result};
use sha1::{Digest, Sha1};
use std::time::{SystemTime, UNIX_EPOCH};
use tmv_backend_index::PersistedThumbnailJobRecord;

pub(crate) fn parse_cursor(cursor: Option<&str>) -> Result<usize> {
    match cursor {
        None => Ok(0),
        Some("") => Ok(0),
        Some(raw) => raw.parse::<usize>().map_err(|_| anyhow!("Invalid cursor")),
    }
}

pub(crate) fn clamp(value: usize, min: usize, max: usize) -> usize {
    value.max(min).min(max)
}

pub(crate) fn media_kind_as_str(kind: &MediaKind) -> &'static str {
    match kind {
        MediaKind::Image => "image",
        MediaKind::Gif => "gif",
        MediaKind::Video => "video",
    }
}

pub(crate) fn detect_media_kind_from_path(path: &std::path::Path) -> Option<MediaKind> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    match ext.as_str() {
        "gif" => Some(MediaKind::Gif),
        "jpg" | "jpeg" | "png" | "webp" | "bmp" | "tiff" => Some(MediaKind::Image),
        "mp4" | "mov" | "webm" | "mkv" | "avi" => Some(MediaKind::Video),
        _ => None,
    }
}

pub(crate) fn build_media_item(
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

pub(crate) fn normalize_media_item_capabilities(item: MediaItem) -> MediaItem {
    build_media_item(&item.name, &item.path, &item.kind, item.size, item.modified)
}

pub(crate) fn compare_media_items_by_time_desc(
    left: &MediaItem,
    right: &MediaItem,
) -> std::cmp::Ordering {
    media_sort_time_key(right)
        .cmp(&media_sort_time_key(left))
        .then_with(|| left.name.cmp(&right.name))
        .then_with(|| left.path.cmp(&right.path))
}

pub(crate) fn media_sort_time_key(item: &MediaItem) -> i64 {
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

pub(crate) fn increment_counts(counts: &mut FolderCounts, kind: &MediaKind) {
    match kind {
        MediaKind::Image => counts.images += 1,
        MediaKind::Gif => counts.gifs += 1,
        MediaKind::Video => counts.videos += 1,
    }
}

pub(crate) fn preview_stamp(manifest_stamp: &str, preview_limit: usize) -> String {
    format!("{manifest_stamp}:{preview_limit}")
}

pub(crate) fn deserialize_media_payloads(payloads: Vec<String>) -> Result<Vec<MediaItem>> {
    payloads
        .into_iter()
        .map(|payload| {
            serde_json::from_str::<MediaItem>(&payload)
                .map(normalize_media_item_capabilities)
                .map_err(Into::into)
        })
        .collect()
}

pub(crate) fn media_filter_group(filter: FolderMediaFilter) -> &'static str {
    match filter {
        FolderMediaFilter::Image => "image",
        FolderMediaFilter::Video => "video",
    }
}

pub(crate) fn media_filter_group_for_item(item: &MediaItem) -> &'static str {
    match item.kind {
        MediaKind::Video => "video",
        MediaKind::Image | MediaKind::Gif => "image",
    }
}

pub(crate) fn build_manifest_stamp_from_manifest(manifest: &DirectoryManifest) -> String {
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

pub(crate) fn is_ignorable_entry_resolution_error(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("Path escapes media root")
        || message.contains("Unsupported media extension")
        || message.contains("Missing media file path")
        || message.contains("No such file")
        || message.contains("not found")
}

pub(crate) fn sha1_hex(bytes: &[u8]) -> String {
    let mut digest = Sha1::new();
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

pub(crate) fn now_ms_u64() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn thumbnail_job_error_if_recent(job: &PersistedThumbnailJobRecord) -> Option<String> {
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

pub(crate) fn thumbnail_worker_limit() -> usize {
    let available = std::thread::available_parallelism()
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
