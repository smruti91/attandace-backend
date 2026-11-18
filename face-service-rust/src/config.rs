use std::env;

/// Runtime configuration, read from the environment so the container/host can
/// point the service at wherever InsightFace's ONNX models live.
///
/// SCRFD (`det_10g.onnx`) and the wbob recognition model (`w600k_r50.onnx`) are
/// NOT vendored in this repo — InsightFace downloads them to `~/.insightface`
/// at first run. Copy them into `models/` (or set the env vars to their paths).
#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,

    pub det_model: String,
    pub rec_model: String,
    /// MiniFAS anti-spoof model (`best_model_quantized.onnx`), classified on the
    /// crop around the detected face. Loaded alongside det/rec per session slot.
    pub liv_model: String,

    /// Number of ONNX sessions (one per inference slot). Each `run` takes
    /// `&mut self`, so a pool of sessions is what buys real parallelism on a
    /// multi-core box — mirrors "one uvicorn worker per core" in the Python
    /// sidecar. Defaults to the logical CPU count, capped to `REC_MAX_SESSIONS`.
    pub session_slots: usize,

    /// Detection confidence + NMS thresholds (insightface SCRFD defaults).
    pub det_threshold: f32,
    pub nms_threshold: f32,
    pub det_input: usize,

    /// Recognition model normalization (see README parity note).
    pub rec_input: usize,
}

fn get_str(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn get_num<T: std::str::FromStr>(key: &str, default: T) -> T {
    env::var(key)
        .ok()
        .and_then(|v| v.parse::<T>().ok())
        .unwrap_or(default)
}

impl Config {
    pub fn from_env() -> Self {
        let model_dir = get_str("FACE_MODEL_DIR", "models");
        let default_det = format!("{model_dir}/det_10g.onnx");
        let default_rec = format!("{model_dir}/w600k_r50.onnx");
        let default_liv = format!("{model_dir}/best_model_quantized.onnx");

        let slots = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2)
            .clamp(1, 16);

        Config {
            bind_addr: get_str("FACE_RUST_BIND", "0.0.0.0:5000"),
            det_model: get_str("FACE_DET_MODEL", &default_det),
            rec_model: get_str("FACE_REC_MODEL", &default_rec),
            liv_model: get_str("FACE_LIV_MODEL", &default_liv),
            session_slots: get_num("FACE_RUST_SESSIONS", slots),
            det_threshold: get_num("FACE_DET_THRESHOLD", 0.5_f32),
            nms_threshold: get_num("FACE_NMS_THRESHOLD", 0.4_f32),
            det_input: get_num("FACE_DET_INPUT", 640_usize),
            rec_input: get_num("FACE_REC_INPUT", 112_usize),
        }
    }
}
