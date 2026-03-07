use super::{encode_rgb_to_jpeg, thumbnail_target_size, ThumbnailError};
use std::path::Path;

const VIDEO_THUMBNAIL_PROBE_MS: [u64; 4] = [100, 2_000, 5_000, 10_000];
const BLACK_FRAME_MEAN_LUMA_THRESHOLD: f64 = 6.0;
const BLACK_FRAME_DARK_PIXEL_RATIO_THRESHOLD: f64 = 0.90;
const BLACK_FRAME_DARK_PIXEL_LUMA_THRESHOLD: u16 = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VideoFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

trait VideoFrameExtractor: Send + Sync {
    fn extract_frame(
        &self,
        source_path: &Path,
        seek_ms: u64,
        max_edge: u32,
    ) -> Result<VideoFrame, ThumbnailError>;
}

#[derive(Debug, Default)]
struct DefaultVideoFrameExtractor;

impl VideoFrameExtractor for DefaultVideoFrameExtractor {
    fn extract_frame(
        &self,
        source_path: &Path,
        seek_ms: u64,
        max_edge: u32,
    ) -> Result<VideoFrame, ThumbnailError> {
        #[cfg(target_os = "macos")]
        {
            super::video_macos::extract_frame(source_path, seek_ms, max_edge)
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = (source_path, seek_ms, max_edge);
            Err(ThumbnailError::UnsupportedVideoPlatform)
        }
    }
}

pub(super) fn generate_thumbnail_jpeg(source_path: &Path) -> Result<Vec<u8>, ThumbnailError> {
    render_thumbnail_jpeg(source_path, &DefaultVideoFrameExtractor)
}

fn render_thumbnail_jpeg(
    source_path: &Path,
    extractor: &dyn VideoFrameExtractor,
) -> Result<Vec<u8>, ThumbnailError> {
    let mut best_dark_frame: Option<(FrameLightness, VideoFrame)> = None;
    let mut last_error = None;

    for seek_ms in VIDEO_THUMBNAIL_PROBE_MS {
        match extractor.extract_frame(source_path, seek_ms, thumbnail_target_size()) {
            Ok(frame) => {
                let lightness = analyze_frame_lightness(&frame);
                if !lightness.is_mostly_black() {
                    return encode_video_frame(&frame);
                }
                match &best_dark_frame {
                    Some((best, _)) if best.mean_luma >= lightness.mean_luma => {}
                    _ => best_dark_frame = Some((lightness, frame)),
                }
            }
            Err(ThumbnailError::UnsupportedVideoPlatform) => {
                return Err(ThumbnailError::UnsupportedVideoPlatform);
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }

    if let Some((_, frame)) = best_dark_frame {
        return encode_video_frame(&frame);
    }

    Err(last_error.unwrap_or_else(|| {
        ThumbnailError::GenerationFailed(
            "unable to extract a usable video thumbnail frame".to_string(),
        )
    }))
}

fn encode_video_frame(frame: &VideoFrame) -> Result<Vec<u8>, ThumbnailError> {
    let expected_len = usize::try_from(frame.width)
        .ok()
        .and_then(|width| {
            usize::try_from(frame.height)
                .ok()
                .map(|height| width * height * 4)
        })
        .ok_or_else(|| ThumbnailError::Encode("video frame dimensions overflow".to_string()))?;
    if frame.rgba.len() != expected_len {
        return Err(ThumbnailError::Encode(format!(
            "video frame buffer size mismatch: expected {} bytes, got {}",
            expected_len,
            frame.rgba.len()
        )));
    }

    let mut rgb = Vec::with_capacity(expected_len / 4 * 3);
    for pixel in frame.rgba.chunks_exact(4) {
        rgb.extend_from_slice(&pixel[..3]);
    }
    encode_rgb_to_jpeg(frame.width, frame.height, &rgb)
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct FrameLightness {
    mean_luma: f64,
    dark_ratio: f64,
}

impl FrameLightness {
    fn is_mostly_black(self) -> bool {
        self.mean_luma <= BLACK_FRAME_MEAN_LUMA_THRESHOLD
            && self.dark_ratio >= BLACK_FRAME_DARK_PIXEL_RATIO_THRESHOLD
    }
}

fn analyze_frame_lightness(frame: &VideoFrame) -> FrameLightness {
    let mut total_luma = 0_u64;
    let mut dark_pixels = 0_u64;
    let mut pixel_count = 0_u64;

    for pixel in frame.rgba.chunks_exact(4) {
        let red = u16::from(pixel[0]);
        let green = u16::from(pixel[1]);
        let blue = u16::from(pixel[2]);
        let luma = ((54 * red) + (183 * green) + (19 * blue)) >> 8;
        total_luma += u64::from(luma);
        if luma <= BLACK_FRAME_DARK_PIXEL_LUMA_THRESHOLD {
            dark_pixels += 1;
        }
        pixel_count += 1;
    }

    if pixel_count == 0 {
        return FrameLightness {
            mean_luma: 0.0,
            dark_ratio: 1.0,
        };
    }

    FrameLightness {
        mean_luma: total_luma as f64 / pixel_count as f64,
        dark_ratio: dark_pixels as f64 / pixel_count as f64,
    }
}

#[cfg(test)]
mod tests {
    use super::{analyze_frame_lightness, render_thumbnail_jpeg, VideoFrame, VideoFrameExtractor};
    use crate::thumbnail::ThumbnailError;
    use image::ImageFormat;
    use std::{
        collections::HashMap,
        path::Path,
        sync::{Arc, Mutex},
    };

    #[derive(Clone)]
    struct MockExtractor {
        calls: Arc<Mutex<Vec<(u64, u32)>>>,
        responses: Arc<HashMap<u64, Result<VideoFrame, ThumbnailError>>>,
    }

    impl MockExtractor {
        fn new(responses: HashMap<u64, Result<VideoFrame, ThumbnailError>>) -> Self {
            Self {
                calls: Arc::new(Mutex::new(Vec::new())),
                responses: Arc::new(responses),
            }
        }
    }

    impl VideoFrameExtractor for MockExtractor {
        fn extract_frame(
            &self,
            _source_path: &Path,
            seek_ms: u64,
            max_edge: u32,
        ) -> Result<VideoFrame, ThumbnailError> {
            self.calls
                .lock()
                .expect("calls poisoned")
                .push((seek_ms, max_edge));
            self.responses.get(&seek_ms).cloned().unwrap_or_else(|| {
                Err(ThumbnailError::Platform(
                    "missing test response".to_string(),
                ))
            })
        }
    }

    #[test]
    fn continues_probing_after_black_frames_until_it_finds_a_bright_frame() {
        let extractor = MockExtractor::new(HashMap::from([
            (100, Ok(black_frame())),
            (2_000, Ok(black_frame())),
            (5_000, Ok(red_frame())),
        ]));

        let bytes =
            render_thumbnail_jpeg(Path::new("/tmp/test.mp4"), &extractor).expect("thumbnail bytes");
        let calls = extractor.calls.lock().expect("calls poisoned").clone();
        let thumb = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg)
            .expect("decode generated jpeg");
        let pixel = thumb.to_rgb8().get_pixel(0, 0).0;

        assert_eq!(calls, vec![(100, 640), (2_000, 640), (5_000, 640)]);
        assert_eq!(thumb.width(), 2);
        assert_eq!(thumb.height(), 1);
        assert!(pixel[0] > 200);
        assert!(pixel[1] < 40);
        assert!(pixel[2] < 40);
    }

    #[test]
    fn returns_the_brightest_dark_frame_if_all_probes_remain_dark() {
        let extractor = MockExtractor::new(HashMap::from([
            (100, Ok(black_frame())),
            (2_000, Ok(dim_gray_frame(4))),
            (5_000, Ok(dim_gray_frame(2))),
            (10_000, Ok(dim_gray_frame(3))),
        ]));

        let bytes =
            render_thumbnail_jpeg(Path::new("/tmp/test.mp4"), &extractor).expect("thumbnail bytes");
        let thumb = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg)
            .expect("decode generated jpeg");
        let pixel = thumb.to_rgb8().get_pixel(0, 0).0;

        assert!(pixel[0] >= 3);
        assert!(pixel[1] >= 3);
        assert!(pixel[2] >= 3);
    }

    #[test]
    fn keeps_probings_later_offsets_after_initial_extract_errors() {
        let extractor = MockExtractor::new(HashMap::from([
            (
                100,
                Err(ThumbnailError::Platform("first seek failed".to_string())),
            ),
            (2_000, Ok(red_frame())),
        ]));

        let bytes =
            render_thumbnail_jpeg(Path::new("/tmp/test.mp4"), &extractor).expect("thumbnail bytes");
        let calls = extractor.calls.lock().expect("calls poisoned").clone();
        let thumb = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg)
            .expect("decode generated jpeg");

        assert_eq!(calls, vec![(100, 640), (2_000, 640)]);
        assert_eq!(thumb.width(), 2);
        assert_eq!(thumb.height(), 1);
    }

    #[test]
    fn does_not_retry_platform_unsupported_errors() {
        struct UnsupportedExtractor;

        impl VideoFrameExtractor for UnsupportedExtractor {
            fn extract_frame(
                &self,
                _source_path: &Path,
                _seek_ms: u64,
                _max_edge: u32,
            ) -> Result<VideoFrame, ThumbnailError> {
                Err(ThumbnailError::UnsupportedVideoPlatform)
            }
        }

        let error = render_thumbnail_jpeg(Path::new("/tmp/test.mp4"), &UnsupportedExtractor)
            .expect_err("unsupported platform should fail");
        assert_eq!(error, ThumbnailError::UnsupportedVideoPlatform);
    }

    #[test]
    fn black_frame_detection_requires_low_luma_and_high_dark_ratio() {
        let black = analyze_frame_lightness(&black_frame());
        let red = analyze_frame_lightness(&red_frame());
        let near_black = analyze_frame_lightness(&near_black_frame_with_sparse_highlights());

        assert!(black.is_mostly_black());
        assert!(near_black.is_mostly_black());
        assert!(!red.is_mostly_black());
    }

    fn black_frame() -> VideoFrame {
        dim_gray_frame(0)
    }

    fn dim_gray_frame(value: u8) -> VideoFrame {
        VideoFrame {
            width: 2,
            height: 1,
            rgba: vec![value, value, value, 255, value, value, value, 255],
        }
    }

    fn red_frame() -> VideoFrame {
        VideoFrame {
            width: 2,
            height: 1,
            rgba: vec![255, 0, 0, 255, 255, 0, 0, 255],
        }
    }

    fn near_black_frame_with_sparse_highlights() -> VideoFrame {
        let mut rgba = Vec::new();
        for _ in 0..30 {
            rgba.extend_from_slice(&[2, 2, 2, 255]);
        }
        rgba.extend_from_slice(&[8, 8, 8, 255]);
        rgba.extend_from_slice(&[24, 24, 24, 255]);
        VideoFrame {
            width: 32,
            height: 1,
            rgba,
        }
    }
}
