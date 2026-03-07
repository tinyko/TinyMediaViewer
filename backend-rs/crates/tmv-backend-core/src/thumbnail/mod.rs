use crate::MediaKind;
use std::{path::PathBuf, sync::Arc};
use thiserror::Error;

mod image;
mod video;
#[cfg(target_os = "macos")]
mod video_macos;

pub(crate) const THUMBNAIL_MAX_EDGE: u32 = 640;
const IMAGE_MAX_PIXELS: u64 = 100_000_000;
const IMAGE_MAX_ALLOC_BYTES: u64 = 256 * 1024 * 1024;
const JPEG_QUALITY: u8 = 82;
pub(crate) const VIDEO_THUMBNAIL_UNSUPPORTED_MESSAGE: &str =
    "video thumbnails are only supported on macOS";

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ThumbnailError {
    #[error("video thumbnails are only supported on macOS")]
    UnsupportedVideoPlatform,
    #[error("{0}")]
    Decode(String),
    #[error("{0}")]
    Encode(String),
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Platform(String),
    #[error("{0}")]
    GenerationFailed(String),
}

impl ThumbnailError {
    pub(crate) fn from_persisted(message: impl Into<String>) -> Self {
        let message = message.into();
        if message == VIDEO_THUMBNAIL_UNSUPPORTED_MESSAGE {
            Self::UnsupportedVideoPlatform
        } else {
            Self::GenerationFailed(message)
        }
    }
}

pub(crate) trait ThumbnailGenerator: Send + Sync {
    fn generate_jpeg(
        &self,
        source_path: PathBuf,
        kind: MediaKind,
    ) -> Result<Vec<u8>, ThumbnailError>;
}

#[derive(Debug, Default)]
struct DefaultThumbnailGenerator;

impl ThumbnailGenerator for DefaultThumbnailGenerator {
    fn generate_jpeg(
        &self,
        source_path: PathBuf,
        kind: MediaKind,
    ) -> Result<Vec<u8>, ThumbnailError> {
        match kind {
            MediaKind::Image | MediaKind::Gif => image::generate_thumbnail_jpeg(&source_path),
            MediaKind::Video => video::generate_thumbnail_jpeg(&source_path),
        }
    }
}

pub(crate) fn default_thumbnail_generator() -> Arc<dyn ThumbnailGenerator> {
    Arc::new(DefaultThumbnailGenerator)
}

pub(crate) fn encode_rgb_to_jpeg(
    width: u32,
    height: u32,
    rgb: &[u8],
) -> Result<Vec<u8>, ThumbnailError> {
    use ::image::{codecs::jpeg::JpegEncoder, ExtendedColorType, ImageEncoder};

    let mut encoded = Vec::new();
    JpegEncoder::new_with_quality(&mut encoded, JPEG_QUALITY)
        .write_image(rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|error| ThumbnailError::Encode(format!("encode jpeg thumbnail: {error}")))?;
    Ok(encoded)
}

pub(crate) fn max_image_alloc_bytes() -> u64 {
    IMAGE_MAX_ALLOC_BYTES
}

pub(crate) fn max_image_pixels() -> u64 {
    IMAGE_MAX_PIXELS
}

pub(crate) fn image_is_within_limits(width: u32, height: u32, total_bytes: u64) -> bool {
    u64::from(width) * u64::from(height) <= IMAGE_MAX_PIXELS && total_bytes <= IMAGE_MAX_ALLOC_BYTES
}

pub(crate) fn thumbnail_target_size() -> u32 {
    THUMBNAIL_MAX_EDGE
}
