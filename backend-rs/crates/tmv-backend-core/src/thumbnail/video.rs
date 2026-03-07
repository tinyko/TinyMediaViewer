use super::{encode_rgb_to_jpeg, thumbnail_target_size, ThumbnailError};
use std::path::Path;

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
    let frame = match extractor.extract_frame(source_path, 100, thumbnail_target_size()) {
        Ok(frame) => frame,
        Err(ThumbnailError::UnsupportedVideoPlatform) => {
            return Err(ThumbnailError::UnsupportedVideoPlatform);
        }
        Err(_) => extractor.extract_frame(source_path, 0, thumbnail_target_size())?,
    };
    encode_video_frame(&frame)
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

#[cfg(test)]
mod tests {
    use super::{render_thumbnail_jpeg, VideoFrame, VideoFrameExtractor};
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
    fn retries_with_zero_offset_after_the_primary_seek_fails() {
        let extractor = MockExtractor::new(HashMap::from([
            (
                100,
                Err(ThumbnailError::Platform("first seek failed".to_string())),
            ),
            (0, Ok(red_frame())),
        ]));

        let bytes =
            render_thumbnail_jpeg(Path::new("/tmp/test.mp4"), &extractor).expect("thumbnail bytes");
        let calls = extractor.calls.lock().expect("calls poisoned").clone();
        let thumb = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg)
            .expect("decode generated jpeg");
        let pixel = thumb.to_rgb8().get_pixel(0, 0).0;

        assert_eq!(calls, vec![(100, 640), (0, 640)]);
        assert_eq!(thumb.width(), 2);
        assert_eq!(thumb.height(), 1);
        assert!(pixel[0] > 200);
        assert!(pixel[1] < 40);
        assert!(pixel[2] < 40);
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

    fn red_frame() -> VideoFrame {
        VideoFrame {
            width: 2,
            height: 1,
            rgba: vec![255, 0, 0, 255, 255, 0, 0, 255],
        }
    }
}
