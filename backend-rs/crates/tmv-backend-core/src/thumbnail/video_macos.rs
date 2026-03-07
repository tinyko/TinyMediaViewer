use super::ThumbnailError;
use crate::thumbnail::video::VideoFrame;
use objc2::rc::autoreleasepool;
use objc2_av_foundation::{AVAssetImageGenerator, AVURLAsset};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextGetBytesPerRow, CGBitmapContextGetData, CGBitmapInfo,
    CGColorSpace, CGContext, CGImage, CGImageAlphaInfo, CGImageByteOrderInfo,
};
use objc2_core_media::CMTime;
use objc2_foundation::{NSError, NSString, NSURL};
use std::{ffi::c_void, path::Path, slice};

pub(super) fn extract_frame(
    source_path: &Path,
    seek_ms: u64,
    max_edge: u32,
) -> Result<VideoFrame, ThumbnailError> {
    autoreleasepool(|_| extract_frame_inner(source_path, seek_ms, max_edge))
}

fn extract_frame_inner(
    source_path: &Path,
    seek_ms: u64,
    max_edge: u32,
) -> Result<VideoFrame, ThumbnailError> {
    let source_path = source_path.to_str().ok_or_else(|| {
        ThumbnailError::Platform(format!(
            "video thumbnail path is not valid UTF-8: {}",
            source_path.display()
        ))
    })?;
    let ns_path = NSString::from_str(source_path);
    let url = NSURL::fileURLWithPath(&ns_path);

    let asset = unsafe {
        // SAFETY: `url` is a valid file URL and we don't pass any options.
        AVURLAsset::URLAssetWithURL_options(&url, None)
    };
    let generator = unsafe {
        // SAFETY: `AVURLAsset` is an `AVAsset` subclass and remains alive for the call.
        AVAssetImageGenerator::assetImageGeneratorWithAsset(&asset)
    };
    unsafe {
        // SAFETY: Property setters are synchronous and `generator` is a valid AVFoundation object.
        generator.setAppliesPreferredTrackTransform(true);
        generator.setMaximumSize(CGSize::new(f64::from(max_edge), f64::from(max_edge)));
    }

    let requested_time = unsafe {
        // SAFETY: Constructing a `CMTime` with a positive timescale is valid.
        CMTime::with_seconds(seek_ms as f64 / 1000.0, 600)
    };
    #[allow(deprecated)]
    let cg_image = unsafe {
        // SAFETY: We pass a valid `CMTime` and don't need the actual timestamp back.
        generator.copyCGImageAtTime_actualTime_error(requested_time, std::ptr::null_mut())
    }
    .map_err(|error| ns_error(&error))?;

    render_cg_image(&cg_image)
}

fn render_cg_image(image: &CGImage) -> Result<VideoFrame, ThumbnailError> {
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    if width == 0 || height == 0 {
        return Err(ThumbnailError::Platform("video frame is empty".to_string()));
    }

    let bytes_per_row = width
        .checked_mul(4)
        .ok_or_else(|| ThumbnailError::Platform("video frame stride overflow".to_string()))?;
    let buffer_len = height
        .checked_mul(bytes_per_row)
        .ok_or_else(|| ThumbnailError::Platform("video frame size overflow".to_string()))?;
    let mut rgba = vec![0_u8; buffer_len];

    let color_space = CGColorSpace::new_device_rgb().ok_or_else(|| {
        ThumbnailError::Platform("create RGB color space for thumbnail".to_string())
    })?;
    let bitmap_info =
        CGBitmapInfo(CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0);
    let context = unsafe {
        // SAFETY: The pixel buffer is allocated for `width * height * 4` bytes and lives
        // for the full lifetime of the CoreGraphics context. The remaining arguments are
        // consistent with an 8-bit RGBA bitmap context.
        CGBitmapContextCreate(
            rgba.as_mut_ptr().cast::<c_void>(),
            width,
            height,
            8,
            bytes_per_row,
            Some(&color_space),
            bitmap_info.0,
        )
    }
    .ok_or_else(|| ThumbnailError::Platform("create bitmap context for video frame".to_string()))?;
    let rect = CGRect::new(CGPoint::ZERO, CGSize::new(width as f64, height as f64));
    CGContext::draw_image(Some(&context), rect, Some(image));

    let data = CGBitmapContextGetData(Some(&context));
    if data.is_null() {
        return Err(ThumbnailError::Platform(
            "bitmap context did not expose pixel data".to_string(),
        ));
    }

    let rendered_bytes_per_row = CGBitmapContextGetBytesPerRow(Some(&context));
    let rendered_len = height
        .checked_mul(rendered_bytes_per_row)
        .ok_or_else(|| ThumbnailError::Platform("rendered frame size overflow".to_string()))?;
    let rendered = unsafe {
        // SAFETY: The CoreGraphics context owns a valid bitmap buffer of `rendered_len` bytes.
        slice::from_raw_parts(data.cast::<u8>(), rendered_len)
    };

    if rendered_bytes_per_row == bytes_per_row {
        rgba.copy_from_slice(rendered);
    } else {
        for (row_index, row) in rgba.chunks_exact_mut(bytes_per_row).enumerate() {
            let start = row_index
                .checked_mul(rendered_bytes_per_row)
                .ok_or_else(|| {
                    ThumbnailError::Platform("rendered frame row overflow".to_string())
                })?;
            let end = start.checked_add(bytes_per_row).ok_or_else(|| {
                ThumbnailError::Platform("rendered frame row end overflow".to_string())
            })?;
            row.copy_from_slice(&rendered[start..end]);
        }
    }

    Ok(VideoFrame {
        width: u32::try_from(width)
            .map_err(|_| ThumbnailError::Platform("video frame width exceeds u32".to_string()))?,
        height: u32::try_from(height)
            .map_err(|_| ThumbnailError::Platform("video frame height exceeds u32".to_string()))?,
        rgba,
    })
}

fn ns_error(error: &NSError) -> ThumbnailError {
    ThumbnailError::Platform(format!("extract video frame: {error}"))
}
