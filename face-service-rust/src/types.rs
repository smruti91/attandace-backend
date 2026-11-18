use serde::{Deserialize, Serialize};

/// Anti-spoofing verdict for the live image.
///
/// Produced by `antispoof::predict` (MiniFAS `best_model_quantized.onnx`) on the
/// crop around the detected face. `is_real` is `logit_diff >= ln(p/(1-p))` for
/// the requested real-class probability `p`; `confidence` is `|logit_diff|`
/// (larger = more confident), exactly as `faceService.ts` documents.
///
/// `passthrough()` remains only as the neutral fill for hard internal errors
/// (ONNX/decode failures) where no verdict could be computed; normal `/verify`
/// and `/embedding` responses now carry a real MiniFAS verdict.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Liveness {
    pub success: bool,
    pub is_real: bool,
    pub status: String,
    pub confidence: f32,
    pub logit_diff: f32,
    pub real_logit: f32,
    pub spoof_logit: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Liveness {
    /// Neutral "live" verdict used only when inference could not run.
    pub fn passthrough() -> Self {
        Liveness {
            success: true,
            is_real: true,
            status: "real".to_string(),
            confidence: 0.0,
            logit_diff: 0.0,
            real_logit: 0.0,
            spoof_logit: 0.0,
            message: None,
        }
    }

    /// No face was detected, so liveness could not be judged.
    pub fn no_face() -> Self {
        Liveness {
            success: false,
            is_real: false,
            status: "no_face".to_string(),
            confidence: 0.0,
            logit_diff: 0.0,
            real_logit: 0.0,
            spoof_logit: 0.0,
            message: Some("No face detected".to_string()),
        }
    }

    /// Liveness could not be computed (decode/inference error). `is_real: false`
    /// so callers that enforce `require_liveness` fail closed.
    pub fn error(detail: &str) -> Self {
        Liveness {
            success: false,
            is_real: false,
            status: "error".to_string(),
            confidence: 0.0,
            logit_diff: 0.0,
            real_logit: 0.0,
            spoof_logit: 0.0,
            message: Some(detail.to_string()),
        }
    }
}

/// Body of `POST /verify`. Mirrors the `verify()` response in app.py.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyResponse {
    pub success: bool,
    pub verified: bool,
    pub distance: f32,
    pub threshold: f32,
    pub message: String,
    pub liveness: Liveness,
}

impl VerifyResponse {
    pub fn no_face(threshold: f32) -> Self {
        VerifyResponse {
            success: false,
            verified: false,
            distance: 1.0,
            threshold,
            message: "No face detected".to_string(),
            liveness: Liveness::no_face(),
        }
    }

    /// require_liveness was on and MiniFAS classified the face as a spoof.
    pub fn spoof(liveness: Liveness, threshold: f32) -> Self {
        VerifyResponse {
            success: false,
            verified: false,
            distance: 1.0,
            threshold,
            message: format!("Spoofed face detected ({})", liveness.status),
            liveness,
        }
    }

    pub fn bad_embedding(detail: &str) -> Self {
        VerifyResponse {
            success: false,
            verified: false,
            distance: 1.0,
            threshold: 0.0,
            message: format!("bad stored_embedding: {detail}"),
            liveness: Liveness::passthrough(),
        }
    }
}

/// Body of `GET /health`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Health {
    pub status: String,
}

/// Body of `POST /embedding`. Mirrors `embedding()` in app.py — `embedding` is
/// present only on success, `message` only on failure. This is the exact shape
/// `pythonSidecar.ts` parses (`result.success` + `result.embedding`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub liveness: Liveness,
}

impl EmbeddingResponse {
    pub fn ok(embedding: Vec<f32>, liveness: Liveness) -> Self {
        EmbeddingResponse {
            success: true,
            embedding: Some(embedding),
            message: None,
            liveness,
        }
    }

    pub fn no_face() -> Self {
        EmbeddingResponse {
            success: false,
            embedding: None,
            message: Some("No face detected".to_string()),
            liveness: Liveness::no_face(),
        }
    }

    /// require_liveness was on and MiniFAS classified the face as a spoof, so
    /// no embedding is returned.
    pub fn spoof(liveness: Liveness) -> Self {
        EmbeddingResponse {
            success: false,
            embedding: None,
            message: Some(format!("Spoofed face detected ({})", liveness.status)),
            liveness,
        }
    }
}
