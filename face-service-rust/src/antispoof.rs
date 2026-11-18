//! MiniFAS face anti-spoofing (real vs spoof) — a faithful Rust port of the
//! retired `face-service/antispoof.py` (facenox/face-antispoof-onnx pipeline).
//!
//! Model: `best_model_quantized.onnx`
//!   input : (1, 3, 128, 128) float32 RGB normalized to [0, 1]
//!   output: (1, 2) float32 logits -> [real_logit, spoof_logit]
//!
//! Detection is intentionally NOT done here: like the Python module, we reuse
//! the SCRFD bbox already produced by the main pipeline, expand it into a
//! square crop, classify that crop, and return a [`Liveness`] verdict.
//!
//! ── Fidelity notes ──────────────────────────────────────────────────────────
//! * The crop geometry, `BBOX_EXPANSION_FACTOR = 1.5`, `int()` truncations,
//!   `BORDER_REFLECT_101` padding and the probability→logit-threshold mapping
//!   (`ln(p/(1-p))`) are reproduced exactly from the Python.
//! * The 128×128 resize uses the `image` crate's `Lanczos3` (upscale) /
//!   `Triangle` (downscale) in place of OpenCV's `INTER_LANCZOS4` /
//!   `INTER_AREA`. Because `crop_face` always returns a SQUARE crop, the
//!   letterbox padding in `preprocess` is a no-op. These resamplers differ from
//!   OpenCV by a few LSBs, which can nudge `logit_diff` slightly — but never
//!   enough to flip a clearly-real or clearly-spoof verdict.

use anyhow::{bail, Result};
use image::{imageops::FilterType, RgbImage};

use crate::ortutil::ModelSession;
use crate::types::Liveness;

/// Side of the liveness model input (matches `MODEL_IMG_SIZE`).
const MODEL_IMG_SIZE: usize = 128;
/// BBox expansion around the face center (matches `BBOX_EXPANSION_FACTOR`).
const BBOX_EXPANSION_FACTOR: f32 = 1.5;

/// Map a desired real-class probability to the logit-difference threshold.
/// `logit_diff = real_logit - spoof_logit`; p = 0.5 maps to 0.0.
pub fn probability_to_logit_threshold(p: f32) -> f32 {
    let p = p.clamp(1e-6, 1.0 - 1e-6);
    (p / (1.0 - p)).ln()
}

/// `cv2.BORDER_REFLECT_101` (Guillaud) index map for one axis of length `n`:
/// reflect around the edges WITHOUT duplicating the boundary pixel.
fn reflect_101(i: isize, n: usize) -> usize {
    let n = n as isize;
    if n <= 1 {
        return 0;
    }
    let period = 2 * (n - 1);
    let mut i = i.abs();
    i %= period;
    if i >= n {
        i = period - i;
    }
    i as usize
}

/// `cv2.copyMakeBorder(..., BORDER_REFLECT_101)`: pad `face` by the given
/// margins, filling the border by reflecting the face edges.
fn pad_reflect_101(face: &RgbImage, top: usize, bottom: usize, left: usize, right: usize) -> RgbImage {
    let (fw, fh) = (face.width() as usize, face.height() as usize);
    let ow = fw + left + right;
    let oh = fh + top + bottom;
    let mut out = RgbImage::new(ow as u32, oh as u32);
    for oy in 0..oh {
        let sy = oy as isize - top as isize;
        let ry = if (0..fh as isize).contains(&sy) {
            sy as usize
        } else {
            reflect_101(sy, fh)
        };
        for ox in 0..ow {
            let sx = ox as isize - left as isize;
            let rx = if (0..fw as isize).contains(&sx) {
                sx as usize
            } else {
                reflect_101(sx, fw)
            };
            out.put_pixel(ox as u32, oy as u32, *face.get_pixel(rx as u32, ry as u32));
        }
    }
    out
}

/// Extract a square face crop from a detection bbox `[x1, y1, x2, y2]`
/// (`crop_face` in the Python): expand around the center, reflect-pad the
/// parts that fall off the image edge, return a `size × size` RGB crop.
pub fn crop_face(img: &RgbImage, bbox: [f32; 4], expansion: f32) -> Result<RgbImage> {
    let (w, h) = (img.width() as i64, img.height() as i64);
    let (x1, y1, x2, y2) = (
        bbox[0] as i64, // int() truncates toward zero, like Python
        bbox[1] as i64,
        bbox[2] as i64,
        bbox[3] as i64,
    );
    let bw = x2 - x1;
    let bh = y2 - y1;
    if bw <= 0 || bh <= 0 {
        bail!("invalid bbox dimensions");
    }
    let max_dim = bw.max(bh) as f32;
    let cx = x1 as f32 + bw as f32 / 2.0;
    let cy = y1 as f32 + bh as f32 / 2.0;
    let size = (max_dim * expansion) as i64; // int()

    let x = (cx - size as f32 / 2.0) as i64; // int()
    let y = (cy - size as f32 / 2.0) as i64;

    let top_pad = (-(y)).max(0) as usize;
    let left_pad = (-(x)).max(0) as usize;
    let bottom_pad = ((y + size) - h).max(0) as usize;
    let right_pad = ((x + size) - w).max(0) as usize;

    let x1c = x.max(0) as usize;
    let y1c = y.max(0) as usize;
    let x2c = (x + size).min(w) as usize;
    let y2c = (y + size).min(h) as usize;

    if x2c <= x1c || y2c <= y1c {
        // Crop landed entirely off-image; fall back to a black square.
        return Ok(RgbImage::new(size.max(1) as u32, size.max(1) as u32));
    }

    let face = image::imageops::crop_imm(img, x1c as u32, y1c as u32, (x2c - x1c) as u32, (y2c - y1c) as u32).to_image();
    Ok(pad_reflect_101(&face, top_pad, bottom_pad, left_pad, right_pad))
}

/// Letterbox-resize the crop to `128 × 128`, reflect-pad, and emit an NCHW
/// `f32` blob normalized to `[0, 1]` (the `preprocess` step).
pub fn preprocess(face: &RgbImage, model_size: usize) -> Vec<f32> {
    let (old_w, old_h) = (face.width() as usize, face.height() as usize);
    let ratio = model_size as f32 / (old_h.max(old_w) as f32);
    let mut scaled_w = (old_w as f32 * ratio) as usize; // int()
    let mut scaled_h = (old_h as f32 * ratio) as usize;
    scaled_w = scaled_w.max(1);
    scaled_h = scaled_h.max(1);

    // Upscale → Lanczos3 (≈ INTER_LANCZOS4); downscale → Triangle (≈ INTER_AREA).
    let filter = if ratio > 1.0 { FilterType::Lanczos3 } else { FilterType::Triangle };
    let resized = image::imageops::resize(face, scaled_w as u32, scaled_h as u32, filter);

    let dw = model_size.saturating_sub(scaled_w);
    let dh = model_size.saturating_sub(scaled_h);
    let top = dh / 2;
    let bottom = dh - top;
    let left = dw / 2;
    let right = dw - left;

    let padded = pad_reflect_101(&resized, top, bottom, left, right);

    let plane = model_size * model_size;
    let mut blob = vec![0.0f32; 3 * plane];
    for y in 0..model_size {
        for x in 0..model_size {
            let p = padded.get_pixel(x as u32, y as u32).0; // [R, G, B]
            for c in 0..3 {
                blob[c * plane + y * model_size + x] = p[c] as f32 / 255.0;
            }
        }
    }
    blob
}

/// Run the whole liveness pass: crop the face at `bbox`, classify, and turn the
/// two logits into a [`Liveness`] verdict against `probability_threshold`.
pub fn predict(
    session: &mut ModelSession,
    img: &RgbImage,
    bbox: [f32; 4],
    probability_threshold: f32,
) -> Result<Liveness> {
    let face = crop_face(img, bbox, BBOX_EXPANSION_FACTOR)?;
    let blob = preprocess(&face, MODEL_IMG_SIZE);
    let outs = session.run_f32(blob, vec![1, 3, MODEL_IMG_SIZE, MODEL_IMG_SIZE])?;
    let logits = outs
        .into_iter()
        .next()
        .map(|o| o.data)
        .unwrap_or_default();
    if logits.len() < 2 {
        bail!("liveness model returned {} logits, expected 2", logits.len());
    }
    let real_logit = logits[0];
    let spoof_logit = logits[1];
    let logit_diff = real_logit - spoof_logit;
    let threshold = probability_to_logit_threshold(probability_threshold);
    let is_real = logit_diff >= threshold;
    Ok(Liveness {
        success: true,
        is_real,
        status: if is_real { "real" } else { "spoof" }.to_string(),
        confidence: logit_diff.abs(),
        logit_diff,
        real_logit,
        spoof_logit,
        message: None,
    })
}
