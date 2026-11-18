//! Face alignment: 5-point similarity transform → 112×112 crop, a port of
//! InsightFace's `face_align.norm_crop(img, landmark, mode='arcface')`.
//!
//! `estimate_similarity` is the closed-form least-squares uniform-scale+
//! rotation+translation solution (equivalent to `cv2.estimateAffinePartial2D`
//! on well-localized landmarks). It maps the detected 5 keypoints onto the
//! arcface reference template; the crop is then warped with bilinear sampling.

use image::RgbImage;

use crate::imageutil::{warp_affine, Affine2x3};

/// ArcFace 112×112 reference landmarks (eyes, nose, mouth corners) — byte-for-
/// byte the `arcface_dst` array in InsightFace's `utils/face_align.py`.
pub const ARCFACE_TEMPLATE: [[f64; 2]; 5] = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

/// Least-squares similarity transform (2×3) mapping `src` → `dst`.
fn estimate_similarity(src: &[[f32; 2]; 5], dst: &[[f64; 2]; 5]) -> Option<Affine2x3> {
    let n = src.len() as f64;

    let (mut spx, mut spy, mut sqx, mut sqy) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for i in 0..src.len() {
        spx += src[i][0] as f64;
        spy += src[i][1] as f64;
        sqx += dst[i][0];
        sqy += dst[i][1];
    }
    spx /= n;
    spy /= n;
    sqx /= n;
    sqy /= n;

    let mut c = 0.0f64; // sum(dp·dq)
    let mut d = 0.0f64; // sum(dp x dq)
    let mut var_p = 0.0f64;
    for i in 0..src.len() {
        let dpx = src[i][0] as f64 - spx;
        let dpy = src[i][1] as f64 - spy;
        let dqx = dst[i][0] - sqx;
        let dqy = dst[i][1] - sqy;
        c += dpx * dqx + dpy * dqy;
        d += dpx * dqy - dpy * dqx;
        var_p += dpx * dpx + dpy * dpy;
    }
    if var_p <= 1e-12 {
        return None;
    }
    let denom = (c * c + d * d).sqrt();
    if denom <= 1e-12 {
        return None;
    }
    let cos = c / denom;
    let sin = d / denom;
    let scale = denom / var_p;

    // dst = scale * R * src + t
    let r00 = scale * cos;
    let r01 = -scale * sin;
    let r10 = scale * sin;
    let r11 = scale * cos;
    let tx = sqx - (r00 * spx + r01 * spy);
    let ty = sqy - (r10 * spx + r11 * spy);

    Some(Affine2x3 {
        m: [[r00, r01, tx], [r10, r11, ty]],
    })
}

/// Warp the face defined by 5 landmarks into a `size × size` aligned crop.
pub fn norm_crop(img: &RgbImage, kps: &[[f32; 2]; 5], size: usize) -> Option<RgbImage> {
    let m = estimate_similarity(kps, &ARCFACE_TEMPLATE)?;
    Some(warp_affine(img, &m, size))
}
