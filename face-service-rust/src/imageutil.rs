//! Image decode + the two geometric ops InsightFace performs with OpenCV/PIL,
//! reimplemented here with the `image` crate (no cv2 dependency).
//!
//! Channel-order note (critical for embedding parity with InsightFace): we
//! decode to RGB internally. InsightFace builds BOTH the detection blob
//! (`blobFromImage(bgr, swapRB=True)`) and the recognition blob
//! (`blobFromImages(bgr_crop, swapRB=True)`) with `swapRB=True`, so both models
//! receive R,G,B planes. We already hold RGB, so `det_blob` feeds R,G,B and
//! embed.rs feeds R,G,B too. `scripts/parity_check.py` verifies against an
//! onnxruntime+cv2 InsightFace reference.

use anyhow::{Context, Result};
use image::RgbImage;

/// Detection letterbox normalization constants (insightface SCRFD).
pub const DET_MEAN: [f32; 3] = [127.5, 127.5, 127.5];
pub const DET_STD: [f32; 3] = [128.0, 128.0, 128.0];

/// Decode JPEG/PNG/WebP bytes to an 8-bit RGB image (replaces `PIL.open().convert("RGB")`).
pub fn decode(bytes: &[u8]) -> Result<RgbImage> {
    let img = image::load_from_memory(bytes).context("failed to decode image bytes")?;
    Ok(img.into_rgb8())
}

/// Letterbox an RGB image into a square `size x size` detection blob.
///
/// Returns `(blob, det_scale)`. The geometry reproduces InsightFace
/// `scrfd._detect_candidates` exactly: derive the resized dims from the
/// aspect ratio with `int()` truncation, `det_scale = new_height / orig_height`
/// (the SAME scale used to map both bbox and kps back to original pixels),
/// resize with OpenCV-`INTER_LINEAR` semantics (see [`resize_linear`]) and
/// top-left paste into a zero-filled `size x size` canvas.
pub fn det_blob(img: &RgbImage, size: usize) -> (Vec<f32>, f32) {
    let (ow, oh) = (img.width(), img.height());
    // im_ratio = height / width (OpenCV img.shape[0]/img.shape[1]).
    let im_ratio = oh as f32 / ow as f32;
    let model_ratio = 1.0_f32; // square detection input
    // InsightFace truncates the derived axis with int(), not round().
    let (new_w, new_h) = if im_ratio > model_ratio {
        let nh = size;
        let nw = (nh as f32 / im_ratio) as usize;
        (nw.max(1), nh)
    } else {
        let nw = size;
        let nh = (nw as f32 * im_ratio) as usize;
        (nw, nh.max(1))
    };
    let det_scale = new_h as f32 / oh as f32;

    let mut blob = vec![0.0f32; 3 * size * size];
    resize_linear(img, new_w, new_h, size, &mut blob);
    (blob, det_scale)
}

/// `cv2.resize(.., INTER_LINEAR)` reproduced without OpenCV: a 2-tap bilinear
/// with the half-pixel-center mapping `fx = (dst + 0.5) * scale - 0.5` (verified
/// against OpenCV: a 8->4 downscale samples src at 0.5, 2.5, 4.5, 6.5).
///
/// Crucially this does NOT anti-alias on downscale (unlike the `image` crate's
/// `FilterType::Triangle`, which averages a widening window). Matching OpenCV
/// here keeps the detected landmarks — and therefore the recognition crop —
/// aligned with the InsightFace reference.
fn resize_linear(img: &RgbImage, dst_w: usize, dst_h: usize, size: usize, blob: &mut [f32]) {
    let (sw, sh) = (img.width() as f32, img.height() as f32);
    let scale_x = sw / dst_w as f32;
    let scale_y = sh / dst_h as f32;
    let last_x = img.width().saturating_sub(1);
    let last_y = img.height().saturating_sub(1);

    let columns: Vec<_> = (0..dst_w).map(|dx| {
        let fx = ((dx as f32 + 0.5) * scale_x - 0.5).clamp(0.0, sw - 1.0);
        let x0 = fx as u32;
        (x0, (x0 + 1).min(last_x), fx - x0 as f32)
    }).collect();
    for dy in 0..dst_h {
        let fy = ((dy as f32 + 0.5) * scale_y - 0.5).clamp(0.0, sh - 1.0);
        let y0 = fy as u32;
        let y1 = (y0 + 1).min(last_y);
        let ay = fy - y0 as f32;
        for (dx, &(x0, x1, ax)) in columns.iter().enumerate() {

            let p00 = img.get_pixel(x0, y0).0;
            let p10 = img.get_pixel(x1, y0).0;
            let p01 = img.get_pixel(x0, y1).0;
            let p11 = img.get_pixel(x1, y1).0;

            for c in 0..3 {
                let top = p00[c] as f32 * (1.0 - ax) + p10[c] as f32 * ax;
                let bot = p01[c] as f32 * (1.0 - ax) + p11[c] as f32 * ax;
                let v = (top * (1.0 - ay) + bot * ay).round().clamp(0.0, 255.0);
                blob[c * size * size + dy * size + dx] = (v - DET_MEAN[c]) / DET_STD[c];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_blob_preserves_rounding_channels_and_padding() {
        let img = RgbImage::from_fn(4, 2, |x, y| {
            image::Rgb([(2 * x + y) as u8, 100, 255])
        });
        let (blob, scale) = det_blob(&img, 2);
        let norm = |v: f32| (v - 127.5) / 128.0;
        assert_eq!(scale, 0.5);
        assert_eq!(blob, [norm(2.0), norm(6.0), 0.0, 0.0,
                          norm(100.0), norm(100.0), 0.0, 0.0,
                          norm(255.0), norm(255.0), 0.0, 0.0]);
    }
}

/// 2x3 affine matrix mapping source coords -> destination coords.
#[derive(Clone, Copy, Debug)]
pub struct Affine2x3 {
    pub m: [[f64; 3]; 2],
}

impl Affine2x3 {
    fn invert(&self) -> Option<Affine2x3> {
        let a = self.m[0][0];
        let b = self.m[0][1];
        let tx = self.m[0][2];
        let c = self.m[1][0];
        let d = self.m[1][1];
        let ty = self.m[1][2];
        let det = a * d - b * c;
        if det.abs() < 1e-12 {
            return None;
        }
        let idet = 1.0 / det;
        Some(Affine2x3 {
            m: [
                [d * idet, -b * idet, (b * ty - d * tx) * idet],
                [-c * idet, a * idet, (c * tx - a * ty) * idet],
            ],
        })
    }
}

/// `cv2.warpAffine(img, M, (size, size), borderValue=0.0)` — bilinear, inverse
/// mapping. Produces the 112x112 aligned face crop for recognition.
pub fn warp_affine(img: &RgbImage, m: &Affine2x3, size: usize) -> RgbImage {
    let inv = match m.invert() {
        Some(i) => i,
        None => return RgbImage::new(size as u32, size as u32),
    };
    let (w, h) = (img.width() as f64, img.height() as f64);
    let mut out = image::ImageBuffer::<image::Rgb<u8>, Vec<u8>>::new(size as u32, size as u32);
    for oy in 0..size {
        for ox in 0..size {
            let sx = inv.m[0][0] * ox as f64 + inv.m[0][1] * oy as f64 + inv.m[0][2];
            let sy = inv.m[1][0] * ox as f64 + inv.m[1][1] * oy as f64 + inv.m[1][2];
            if sx < 0.0 || sy < 0.0 || sx > w - 1.001 || sy > h - 1.001 {
                continue; // borderValue 0
            }
            let x0 = sx.floor() as usize;
            let y0 = sy.floor() as usize;
            let x1 = (x0 + 1).min(img.width() as usize - 1);
            let y1 = (y0 + 1).min(img.height() as usize - 1);
            let fx = sx - x0 as f64;
            let fy = sy - y0 as f64;
            let p00 = img.get_pixel(x0 as u32, y0 as u32).0;
            let p10 = img.get_pixel(x1 as u32, y0 as u32).0;
            let p01 = img.get_pixel(x0 as u32, y1 as u32).0;
            let p11 = img.get_pixel(x1 as u32, y1 as u32).0;
            let px = out.get_pixel_mut(ox as u32, oy as u32);
            for c in 0..3 {
                let top = p00[c] as f64 * (1.0 - fx) + p10[c] as f64 * fx;
                let bot = p01[c] as f64 * (1.0 - fx) + p11[c] as f64 * fx;
                let v = (top * (1.0 - fy) + bot * fy).round().clamp(0.0, 255.0) as u8;
                px.0[c] = v;
            }
        }
    }
    out
}
