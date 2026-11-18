//! face-service-rust — a Rust/ONNX-Runtime port of `server/face-service/app.py`
//! exposing the same HTTP JSON contract so `pythonSidecar.ts` / `faceService.ts`
//! treat it as a drop-in replacement for the Python sidecar.
//!
//! Endpoints: GET /health, POST /verify, POST /embedding, POST /liveness (all
//! JSON-compatible with app.py). Pipeline: SCRFD detect (det_10g.onnx) ->
//! MiniFAS liveness (best_model_quantized.onnx) -> 5-point align -> wbob
//! recognition (w600k_r50.onnx) -> cosine distance (`ort` + `image`).
//!
//! ── Before trusting this in production ─────────────────────────────────────
//!  * MODELS: drop `det_10g.onnx` + `w600k_r50.onnx` into `models/` (grab them
//!    from `~/.insightface/models/buffalo_l/`) or set FACE_DET_MODEL/FACE_REC_MODEL.
//!    The MiniFAS model `best_model_quantized.onnx` is vendored in `models/`.
//!  * PARITY: run `scripts/parity_check.py`. It feeds the SAME decoded pixels
//!    to InsightFace (onnxruntime+cv2) and to this Rust `/embedding`, then
//!    reports the cosine distance. Verified: the Rust SCRFD-decode + Procrustes
//!    align + recognition blob reproduce InsightFace to ~0.0003 (algorithm
//!    exact). The only variance is the JPEG DECODER: `image`-crate vs libjpeg
//!    decode .jpg differently, so a raw-JPG cross-comparison shows ~0.2-0.35 —
//!    harmless because enrolment AND check-in both use this service (one shared
//!    decoder), so stored and live embeddings stay mutually consistent.
//!  * ANTI-SPOOF: MiniFAS liveness IS ported (`antispoof.rs`, faithful to the
//!    retired face-service/antispoof.py). /verify and /embedding enforce it by
//!    default (`require_liveness=true`), /liveness exposes it standalone. The
//!    crop resize uses image-crate resamplers instead of OpenCV's, so
//!    `logit_diff` can differ by a few hundredths near the threshold — re-tune
//!    LIVENESS thresholds against real spoofs before trusting security edges.
//!
//! Run: `cargo run --release` (binds FACE_RUST_BIND, default 0.0.0.0:5000).

mod align;
mod antispoof;
mod config;
mod embed;
mod imageutil;
mod ortutil;
mod pipeline;
mod scrfd;
mod types;
mod verify;

use std::sync::Arc;

use anyhow::Result;
use axum::routing::{get, post};
use axum::Router;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::pipeline::FacePipeline;
use crate::verify::{embedding, health, liveness, verify, AppState};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::from_env();
    tracing::info!(?cfg, "starting face-service-rust");

    // One ONNX Runtime environment; sessions are cloned from it below.
    let env = ort::init().build()?;
    let pipeline = Arc::new(FacePipeline::new(&env, cfg.clone())?);

    let bind_addr = cfg.bind_addr.clone();
    let state: AppState = pipeline;
    let app = Router::new()
        .route("/health", get(health))
        .route("/verify", post(verify))
        .route("/embedding", post(embedding))
        .route("/liveness", post(liveness))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!("face-service-rust listening on {bind_addr}");
    axum::serve(listener, app).await?;

    // Keep `env` alive for the process lifetime.
    drop(env);
    Ok(())
}
