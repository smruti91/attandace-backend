//! wbob / `w600k_r50` recognition: build the aligned-crop blob, run it through
//! the model, and expose the 512-d embedding + the cosine distance formula that
//! is byte-for-byte the arithmetic in `face-service/app.py::verify`.

use anyhow::{bail, Result};
use image::RgbImage;

use crate::ortutil::ModelSession;

/// InsightFace `ArcFaceONNX.get_feat` builds the blob with
/// `blobFromImages(aligned_bgr, 1.0/127.5, 112, (127.5,127.5,127.5), swapRB=True)`:
/// the aligned crop is swapped to **R,G,B** and normalized to `(v-127.5)/127.5`.
/// We store the crop as RGB, so `false` (feed R,G,B) matches; both planes and
/// the mean/std below reproduce the reference exactly. Flip `REC_SWAP_RB` only
/// if `scripts/parity_check.py` shows the embedding disagrees.
const REC_SWAP_RB: bool = false;
const REC_MEAN: f32 = 127.5;
const REC_STD: f32 = 127.5;

/// Feed a 112×112 aligned crop and return the raw recognition output (512-d).
pub fn embed(session: &mut ModelSession, aligned: &RgbImage, size: usize) -> Result<Vec<f32>> {
    let plane = size * size;
    let mut blob = vec![0.0f32; 3 * plane];
    let norm = |v: f32| (v - REC_MEAN) / REC_STD;
    for y in 0..size {
        for x in 0..size {
            let p = aligned.get_pixel(x as u32, y as u32).0; // [R, G, B]
            let (r, g, b) = (p[0] as f32, p[1] as f32, p[2] as f32);
            let idx = y * size + x;
            if REC_SWAP_RB {
                blob[0 * plane + idx] = norm(b);
                blob[1 * plane + idx] = norm(g);
                blob[2 * plane + idx] = norm(r);
            } else {
                blob[0 * plane + idx] = norm(r);
                blob[1 * plane + idx] = norm(g);
                blob[2 * plane + idx] = norm(b);
            }
        }
    }

    let outs = session.run_f32(blob, vec![1, 3, size, size])?;
    let embedding = outs
        .into_iter()
        .next()
        .map(|o| o.data)
        .unwrap_or_default();
    if embedding.len() != 512 {
        bail!(
            "recognition model returned {}-dim embedding, expected 512",
            embedding.len()
        );
    }
    Ok(embedding)
}

/// Cosine distance `1 - a·b / (|a||b|)` computed exactly as app.py does:
/// L2-normalize each side with a `+1e-12` guard, then `1 - dot`.
pub fn cosine_distance(a: &[f32], b: &[f32]) -> f32 {
    let norm = |v: &[f32]| -> f32 {
        let s = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        s + 1e-12
    };
    let na = norm(a);
    let nb = norm(b);
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    1.0 - dot / (na * nb)
}
