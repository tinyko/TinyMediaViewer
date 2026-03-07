use super::{
    encode_rgb_to_jpeg, image_is_within_limits, max_image_alloc_bytes, max_image_pixels,
    thumbnail_target_size, ThumbnailError,
};
use ::image::{imageops::FilterType, DynamicImage, ImageDecoder, ImageReader, Limits};
use std::{fs::File, io::BufReader, path::Path};

pub(super) fn generate_thumbnail_jpeg(source_path: &Path) -> Result<Vec<u8>, ThumbnailError> {
    let file = File::open(source_path).map_err(|error| {
        ThumbnailError::Io(format!("open image {}: {error}", source_path.display()))
    })?;
    let mut reader = ImageReader::new(BufReader::new(file));
    reader = reader.with_guessed_format().map_err(|error| {
        ThumbnailError::Io(format!(
            "guess image format {}: {error}",
            source_path.display()
        ))
    })?;

    let mut limits = Limits::default();
    limits.max_alloc = Some(max_image_alloc_bytes());
    reader.limits(limits);

    let mut decoder = reader.into_decoder().map_err(|error| {
        ThumbnailError::Decode(format!("decode image {}: {error}", source_path.display()))
    })?;
    let (width, height) = decoder.dimensions();
    let total_bytes = decoder.total_bytes();
    if !image_is_within_limits(width, height, total_bytes) {
        return Err(ThumbnailError::Decode(format!(
            "thumbnail source exceeds limits: {} ({}x{}, {} bytes, max {} pixels / {} bytes)",
            source_path.display(),
            width,
            height,
            total_bytes,
            max_image_pixels(),
            max_image_alloc_bytes()
        )));
    }

    let orientation = decoder.orientation().map_err(|error| {
        ThumbnailError::Decode(format!(
            "read image orientation {}: {error}",
            source_path.display()
        ))
    })?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|error| {
        ThumbnailError::Decode(format!(
            "decode image pixels {}: {error}",
            source_path.display()
        ))
    })?;
    image.apply_orientation(orientation);

    let image = resize_for_thumbnail(image);
    let rgb = image.to_rgb8();
    encode_rgb_to_jpeg(rgb.width(), rgb.height(), rgb.as_raw())
}

fn resize_for_thumbnail(image: DynamicImage) -> DynamicImage {
    if image.width() <= thumbnail_target_size() && image.height() <= thumbnail_target_size() {
        return image;
    }
    image.resize(
        thumbnail_target_size(),
        thumbnail_target_size(),
        FilterType::Lanczos3,
    )
}

#[cfg(test)]
mod tests {
    use super::generate_thumbnail_jpeg;
    use ::image::{
        codecs::gif::{GifEncoder, Repeat},
        Delay, DynamicImage, Frame, GenericImageView, GrayImage, ImageFormat, Rgb, RgbImage, Rgba,
        RgbaImage,
    };
    use std::{fs, path::Path};
    use tempfile::tempdir;

    const EXIF_ORIENTATION_FIXTURE: &[u8] =
        include_bytes!("../../tests/fixtures/orientation_rotate_90.jpg");

    fn write_animated_gif(path: &Path) -> image::ImageResult<()> {
        let mut encoder = GifEncoder::new(fs::File::create(path)?);
        encoder.set_repeat(Repeat::Infinite)?;
        let first = RgbaImage::from_pixel(2, 1, Rgba([255, 0, 0, 255]));
        let second = RgbaImage::from_pixel(2, 1, Rgba([0, 0, 255, 255]));
        encoder.encode_frames([
            Frame::from_parts(first, 0, 0, Delay::from_numer_denom_ms(10, 1)),
            Frame::from_parts(second, 0, 0, Delay::from_numer_denom_ms(10, 1)),
        ])?;
        Ok(())
    }

    #[test]
    fn generates_jpeg_thumbnails_for_supported_still_formats() {
        let temp = tempdir().expect("tempdir");
        for (name, format) in [
            ("sample.jpg", ImageFormat::Jpeg),
            ("sample.png", ImageFormat::Png),
            ("sample.webp", ImageFormat::WebP),
            ("sample.bmp", ImageFormat::Bmp),
            ("sample.tiff", ImageFormat::Tiff),
        ] {
            let path = temp.path().join(name);
            let image = DynamicImage::ImageRgb8(RgbImage::from_fn(1200, 900, |x, y| {
                Rgb([x as u8, y as u8, 128])
            }));
            image
                .save_with_format(&path, format)
                .unwrap_or_else(|error| panic!("save {name}: {error}"));

            let bytes = generate_thumbnail_jpeg(&path)
                .unwrap_or_else(|error| panic!("generate {name}: {error}"));
            let thumb = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg)
                .unwrap_or_else(|error| panic!("decode {name}: {error}"));
            assert!(thumb.width() <= 640, "{name} width should be <= 640");
            assert!(thumb.height() <= 640, "{name} height should be <= 640");
        }
    }

    #[test]
    fn applies_exif_orientation_before_resizing() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("orientation_rotate_90.jpg");
        fs::write(&path, EXIF_ORIENTATION_FIXTURE).expect("write exif fixture");

        let bytes = generate_thumbnail_jpeg(&path).expect("generate exif thumbnail");
        let thumb = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg)
            .expect("decode exif thumbnail");

        assert_eq!(thumb.width(), 1);
        assert_eq!(thumb.height(), 3);
        let top = thumb.get_pixel(0, 0).0;
        let bottom = thumb.get_pixel(0, 2).0;
        assert!(
            top[0] > top[2],
            "top pixel should remain red-dominant after EXIF orientation is applied"
        );
        assert!(
            bottom[2] > bottom[0],
            "bottom pixel should remain blue-dominant after EXIF orientation is applied"
        );
    }

    #[test]
    fn gif_thumbnail_uses_the_first_frame() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("sample.gif");
        write_animated_gif(&path).expect("write gif fixture");

        let bytes = generate_thumbnail_jpeg(&path).expect("generate gif thumbnail");
        let thumb = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg)
            .expect("decode gif thumbnail");
        let pixel = thumb.to_rgb8().get_pixel(0, 0).0;
        assert!(pixel[0] > pixel[2], "first frame should stay red-dominant");
    }

    #[test]
    fn rejects_images_that_exceed_decode_limits() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("huge.png");
        DynamicImage::ImageLuma8(GrayImage::new(10_001, 10_000))
            .save_with_format(&path, ImageFormat::Png)
            .expect("write large png");

        let error = generate_thumbnail_jpeg(&path).expect_err("oversized image should fail");
        assert!(error.to_string().contains("exceeds limits"));
    }
}
