//! SCRFD (`det_10g.onnx`) decoding: anchor generation, box/landmark decode,
//! and greedy NMS. This mirrors the post-processing in InsightFace's `scrfd.py`
//! (anchor-based variant used by the buffalo_l detector).
//!
//! ── Parity note ─────────────────────────────────────────────────────────────
//! The 9 SCRFD outputs are grouped by TENSOR SHAPE, not by position: each
//! level's score/bbox/kps tensor is identified by its trailing channel dim
//! (1 / 4 / 10) and matched across levels by its anchor-position count (which
//! fixes the stride). This makes decoding independent of the ONNX export's
//! output ordering, so a differently-exported `det_10g.onnx` still lines up.
//! The recognition path only needs the 5 landmarks to be roughly right, so the
//! remaining fragile piece is the anchor sizes (`ANCHOR_SIZE_MULTS`) below.
//! Always run `scripts/parity_check.py` against a reference before production.

use std::collections::BTreeMap;

use anyhow::{bail, Result};

use crate::ortutil::Output;

/// Anchors per location for the buffalo_l detector (`scrfd_10g_bnkps` uses 2).
/// SCRFD is anchor-`free`: both anchors share the same grid center and differ
/// only in the regression head, so this only fixes the output index layout
/// (index = position * ANCHORS_PER_LOC + anchor), matching InsightFace.
const ANCHORS_PER_LOC: usize = 2;

/// A detected face in ORIGINAL image pixel coordinates.
#[derive(Debug, Clone, Copy)]
pub struct Face {
    pub bbox: [f32; 4], // x1, y1, x2, y2
    pub kps: [[f32; 2]; 5], // 2 eyes, nose, 2 mouth corners
    pub score: f32,
}

fn iou(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let x1 = a[0].max(b[0]);
    let y1 = a[1].max(b[1]);
    let x2 = a[2].min(b[2]);
    let y2 = a[3].min(b[3]);
    let iw = (x2 - x1).max(0.0);
    let ih = (y2 - y1).max(0.0);
    let inter = iw * ih;
    let area_a = (a[2] - a[0]).max(0.0) * (a[3] - a[1]).max(0.0);
    let area_b = (b[2] - b[0]).max(0.0) * (b[3] - b[1]).max(0.0);
    let union = area_a + area_b - inter;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

/// Decode the SCRFD output tensors for one stride and append candidates.
fn decode_level(
    score: &Output,
    bbox: &Output,
    kps: &Output,
    stride: usize,
    input_size: usize,
    out: &mut Vec<Face>,
    det_scale: f32,
    threshold: f32,
) {
    let feat = input_size / stride;
    let num_positions = feat * feat;
    let n = (num_positions * ANCHORS_PER_LOC).min(score.data.len());

    for i in 0..n {
        let s = score.data[i];
        if s <= threshold {
            continue;
        }
        let pos = i / ANCHORS_PER_LOC;
        let gy = pos / feat;
        let gx = pos % feat;
        // SCRFD anchor-free: the anchor center is the raw grid point * stride
        // (InsightFace uses integer grid coords, NOT cell centers + 0.5).
        let cx = gx as f32 * stride as f32;
        let cy = gy as f32 * stride as f32;

        // bbox head = (left, top, right, bottom) distances from the center,
        // scaled by stride; box = center -/+. (distance2bbox).
        let d = |k: usize| bbox.data[i * 4 + k] * stride as f32;
        let x1 = cx - d(0);
        let y1 = cy - d(1);
        let x2 = cx + d(2);
        let y2 = cy + d(3);

        // kps head = per-point offsets from the center, scaled by stride
        // (distance2kps).
        let mut kp = [[0.0f32; 2]; 5];
        for p in 0..5 {
            let dx = kps.data[i * 10 + p * 2] * stride as f32;
            let dy = kps.data[i * 10 + p * 2 + 1] * stride as f32;
            kp[p] = [cx + dx, cy + dy];
        }

        out.push(Face {
            bbox: [x1 / det_scale, y1 / det_scale, x2 / det_scale, y2 / det_scale],
            kps: kp.map(|[x, y]| [x / det_scale, y / det_scale]),
            score: s,
        });
    }
}

/// Full detect: expects the 9 SCRFD outputs (3 strides × {score,bbox,kps}).
///
/// Outputs are matched by SHAPE, not position: the trailing dim says the role
/// (1=score, 4=bbox, 10=kps) and the anchor-position count fixes the stride, so
/// the mapping is robust to any export ordering.
pub fn detect(
    outs: &[Output],
    input_size: usize,
    det_scale: f32,
    threshold: f32,
    nms_threshold: f32,
) -> Result<Vec<Face>> {
    if outs.len() != 9 {
        bail!("SCRFD expected 9 outputs, got {}", outs.len());
    }

    #[derive(Default)]
    struct Level {
        score: Option<usize>,
        bbox: Option<usize>,
        kps: Option<usize>,
    }
    // key = stride, derived from each tensor's anchor-position count.
    let mut levels: BTreeMap<usize, Level> = BTreeMap::new();
    let anchors = ANCHORS_PER_LOC;

    for (idx, o) in outs.iter().enumerate() {
        let ch = *o.shape.last().unwrap_or(&0);
        if ch == 0 || o.data.len() % ch != 0 {
            bail!(
                "SCRFD output #{idx}: unusable shape {:?} (len {})",
                o.shape,
                o.data.len()
            );
        }
        let positions = o.data.len() / ch; // feat*feat*anchors
        if positions % anchors != 0 {
            bail!("SCRFD output #{idx}: positions {positions} not divisible by anchors {anchors}");
        }
        let feat = ((positions / anchors) as f64).sqrt().round() as usize;
        if feat == 0 || input_size % feat != 0 {
            bail!(
                "SCRFD output #{idx}: cannot derive stride (feat={feat}, input={input_size})"
            );
        }
        let stride = input_size / feat;
        let lvl = levels.entry(stride).or_default();
        match ch {
            1 => lvl.score = Some(idx),
            4 => lvl.bbox = Some(idx),
            10 => lvl.kps = Some(idx),
            _ => bail!(
                "SCRFD output #{idx}: unexpected channel dim {ch} (shape {:?})",
                o.shape
            ),
        }
    }

    let mut candidates: Vec<Face> = Vec::new();
    for (&stride, lvl) in &levels {
        let (si, bi, ki) = match (lvl.score, lvl.bbox, lvl.kps) {
            (Some(s), Some(b), Some(k)) => (s, b, k),
            _ => bail!("SCRFD stride {stride}: missing one of score/bbox/kps tensors"),
        };
        decode_level(
            &outs[si],
            &outs[bi],
            &outs[ki],
            stride,
            input_size,
            &mut candidates,
            det_scale,
            threshold,
        );
    }

    // greedy NMS, score descending
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut keep: Vec<Face> = Vec::new();
    let mut suppressed = vec![false; candidates.len()];
    for i in 0..candidates.len() {
        if suppressed[i] {
            continue;
        }
        keep.push(candidates[i]);
        for j in (i + 1)..candidates.len() {
            if !suppressed[j] && iou(&candidates[i].bbox, &candidates[j].bbox) > nms_threshold {
                suppressed[j] = true;
            }
        }
    }
    Ok(keep)
}
