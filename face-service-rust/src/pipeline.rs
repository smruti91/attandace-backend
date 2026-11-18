//! Inference pipeline + a fixed pool of (detector, recognizer, liveness)
//! session triples.
//!
//! Each ONNX `run` takes `&mut self`, so parallelism comes from having several
//! loaded sessions — the Rust equivalent of "one uvicorn worker per core". The
//! pool blocks when every slot is busy, so a punch spike degrades into queued
//! work rather than oversubscribing the cores (matching the sidecar's
//! `FACE_INFER_CONCURRENCY` intent, but with true multi-core parallelism).

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};

use anyhow::{Context, Result};
use image::RgbImage;
use ort::environment::Environment;

use crate::align::norm_crop;
use crate::antispoof;
use crate::config::Config;
use crate::embed::{self, cosine_distance};
use crate::imageutil;
use crate::ortutil::ModelSession;
use crate::scrfd::{self, Face};
use crate::types::{EmbeddingResponse, Liveness, VerifyResponse};

/// One loaded copy of each model, leased together as a unit.
type Sessions = (ModelSession, ModelSession, ModelSession);

struct Slots {
    queue: Mutex<VecDeque<Sessions>>,
    available: Condvar,
}

/// A leased (detector, recognizer, liveness) triple; returns to the pool on drop.
pub struct Lease {
    slots: Arc<Slots>,
    triple: Option<Sessions>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(triple) = self.triple.take() {
            let mut q = self.slots.queue.lock().unwrap();
            q.push_back(triple);
            self.slots.available.notify_one();
        }
    }
}

pub struct FacePipeline {
    slots: Arc<Slots>,
    cfg: Config,
}

impl FacePipeline {
    /// Load `cfg.session_slots` copies of all three models.
    pub fn new(env: &Environment, cfg: Config) -> Result<Self> {
        let mut queue = VecDeque::new();
        for _ in 0..cfg.session_slots {
            let det = ModelSession::new(env, &cfg.det_model)
                .context("loading SCRFD detector model")?;
            let rec = ModelSession::new(env, &cfg.rec_model)
                .context("loading wbob recognition model")?;
            let liv = ModelSession::new(env, &cfg.liv_model)
                .context("loading MiniFAS liveness model")?;
            queue.push_back((det, rec, liv));
        }
        Ok(FacePipeline {
            slots: Arc::new(Slots {
                queue: Mutex::new(queue),
                available: Condvar::new(),
            }),
            cfg,
        })
    }

    /// Block until a session triple is free, then hand out a lease.
    fn acquire(&self) -> Lease {
        let mut q = self.slots.queue.lock().unwrap();
        loop {
            if let Some(triple) = q.pop_front() {
                return Lease {
                    slots: self.slots.clone(),
                    triple: Some(triple),
                };
            }
            q = self.slots.available.wait(q).unwrap();
        }
    }

    /// Full `POST /verify` path: decode → detect → liveness → (gate) → align →
    /// embed → cosine distance. Runs synchronously (callers wrap it in
    /// `spawn_blocking`). `prob_threshold` is the real-class probability used
    /// by MiniFAS; `require_liveness` rejects spoofs before recognition runs.
    pub fn verify(
        &self,
        bytes: &[u8],
        stored: &[f32],
        threshold: f32,
        require_liveness: bool,
        prob_threshold: f32,
    ) -> VerifyResponse {
        match self.verify_inner(bytes, stored, threshold, require_liveness, prob_threshold) {
            Ok(resp) => resp,
            // Any hard internal failure surfaces as a non-verified result with a
            // readable message (the Python service raises; callers default the
            // missing fields, so we return the same shape instead).
            Err(err) => {
                tracing::error!(?err, "verify pipeline failed");
                VerifyResponse {
                    success: false,
                    verified: false,
                    distance: 1.0,
                    threshold,
                    message: format!("internal error: {err:#}"),
                    liveness: Liveness::passthrough(),
                }
            }
        }
    }

    fn verify_inner(
        &self,
        bytes: &[u8],
        stored: &[f32],
        threshold: f32,
        require_liveness: bool,
        prob_threshold: f32,
    ) -> Result<VerifyResponse> {
        let Some(analysis) = self.analyze(bytes, prob_threshold, true)? else {
            return Ok(VerifyResponse::no_face(threshold));
        };
        if require_liveness && !analysis.liveness.is_real {
            return Ok(VerifyResponse::spoof(analysis.liveness, threshold));
        }
        let live = analysis
            .embedding
            .expect("analyze computed an embedding because need_embedding=true");
        if live.len() != stored.len() {
            anyhow::bail!(
                "embedding length mismatch: live={} stored={}",
                live.len(),
                stored.len()
            );
        }
        let distance = cosine_distance(&live, stored);
        let verified = distance <= threshold;
        Ok(VerifyResponse {
            success: true,
            verified,
            distance,
            threshold,
            message: if verified { "match" } else { "no match" }.to_string(),
            liveness: analysis.liveness,
        })
    }

    /// `POST /embedding` path: decode → detect → liveness → (gate) → embed.
    /// "No face" is a business answer mirroring app.py's
    /// `{success:false, message:"No face detected"}`, which
    /// `pythonSidecar.ts` treats as final rather than retriable.
    pub fn embedding(
        &self,
        bytes: &[u8],
        require_liveness: bool,
        prob_threshold: f32,
    ) -> EmbeddingResponse {
        match self.embedding_inner(bytes, require_liveness, prob_threshold) {
            Ok(resp) => resp,
            Err(err) => {
                tracing::error!(?err, "embedding pipeline failed");
                EmbeddingResponse {
                    success: false,
                    embedding: None,
                    message: Some(format!("internal error: {err:#}")),
                    liveness: Liveness::passthrough(),
                }
            }
        }
    }

    fn embedding_inner(
        &self,
        bytes: &[u8],
        require_liveness: bool,
        prob_threshold: f32,
    ) -> Result<EmbeddingResponse> {
        let Some(analysis) = self.analyze(bytes, prob_threshold, true)? else {
            return Ok(EmbeddingResponse::no_face());
        };
        if require_liveness && !analysis.liveness.is_real {
            return Ok(EmbeddingResponse::spoof(analysis.liveness));
        }
        let live = analysis
            .embedding
            .expect("analyze computed an embedding because need_embedding=true");
        Ok(EmbeddingResponse::ok(live, analysis.liveness))
    }

    /// `POST /liveness` path: decode → detect → MiniFAS classify, with no
    /// recognition pass (mirrors `app.py::liveness_check`).
    pub fn liveness(&self, bytes: &[u8], prob_threshold: f32) -> Liveness {
        match self.analyze(bytes, prob_threshold, false) {
            Ok(Some(analysis)) => analysis.liveness,
            Ok(None) => Liveness::no_face(),
            Err(err) => {
                tracing::error!(?err, "liveness pipeline failed");
                Liveness::error(&err.to_string())
            }
        }
    }

    /// Shared hot path behind `/verify`, `/embedding` and `/liveness`: decode,
    /// detect the largest face, run MiniFAS on its bbox, and (when asked) align
    /// + recognize. Returns `Ok(None)` when no face is present.
    fn analyze(&self, bytes: &[u8], prob_threshold: f32, need_embedding: bool) -> Result<Option<Analysis>> {
        let img: RgbImage = imageutil::decode(bytes)?;

        let mut lease = self.acquire();
        let (det, rec, liv) = lease.triple.as_mut().expect("lease holds a triple");

        let faces = detect(det, &img, &self.cfg)?;
        let face = match faces.first() {
            Some(f) => *f,
            None => return Ok(None),
        };

        // A liveness-model failure must not kill the request outright: the
        // fail-closed `Liveness::error` verdict (is_real=false) blocks gated
        // callers, while ungated callers can still get their embedding.
        let liveness = antispoof::predict(liv, &img, face.bbox, prob_threshold).unwrap_or_else(|err| {
            tracing::error!(?err, "liveness inference failed");
            Liveness::error(&err.to_string())
        });

        let embedding = if need_embedding {
            let aligned = norm_crop(&img, &face.kps, self.cfg.rec_input)
                .context("face alignment failed")?;
            Some(embed::embed(rec, &aligned, self.cfg.rec_input)?)
        } else {
            None
        };

        Ok(Some(Analysis { liveness, embedding }))
    }
}

/// One detect + liveness (+ optional recognition) pass on a single image.
struct Analysis {
    liveness: Liveness,
    embedding: Option<Vec<f32>>,
}

/// Detect faces using the SCRFD model (exposed for the parity script to reuse).
pub fn detect(det: &mut ModelSession, img: &RgbImage, cfg: &Config) -> Result<Vec<Face>> {
    let (blob, det_scale) = imageutil::det_blob(img, cfg.det_input);
    let outs = det.run_f32(blob, vec![1, 3, cfg.det_input, cfg.det_input])?;
    scrfd::detect(
        &outs,
        cfg.det_input,
        det_scale,
        cfg.det_threshold,
        cfg.nms_threshold,
    )
}
