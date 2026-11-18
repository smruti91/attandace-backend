//! HTTP handlers. These reproduce the wire contract of `face-service/app.py`
//! so `pythonSidecar.ts` (which calls `/embedding`) and `faceService.ts`
//! (`/health`, `/verify`, `/embedding`, `/liveness`) work unchanged against
//! this host.

use std::sync::Arc;

use axum::extract::{Multipart, State};
use axum::Json;

use crate::pipeline::FacePipeline;
use crate::types::{EmbeddingResponse, Health, Liveness, VerifyResponse};

pub type AppState = Arc<FacePipeline>;

/// `GET /health` → `{ "status": "ok" }`.
pub async fn health() -> Json<Health> {
    Json(Health {
        status: "ok".to_string(),
    })
}

/// Lenient multipart-bool parse, matching what FastAPI accepts from
/// `FormData.append('require_liveness', String(bool))` — i.e. "true"/"false" —
/// while also tolerating 1/0/yes/no/on/off. Unknown values keep the default.
fn parse_bool(text: &str, default: bool) -> bool {
    match text.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => true,
        "false" | "0" | "no" | "off" => false,
        _ => default,
    }
}

/// `POST /liveness` (multipart/form-data) — mirrors `app.py::liveness_check`.
/// Fields: `file`, `threshold` (real-class probability, default 0.5).
pub async fn liveness(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Json<Liveness> {
    let mut image: Option<axum::body::Bytes> = None;
    let mut prob_threshold = 0.5_f32;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => image = field.bytes().await.ok(),
            "threshold" => {
                if let Some(t) = field.text().await.ok() {
                    prob_threshold = t.trim().parse::<f32>().unwrap_or(prob_threshold);
                }
            }
            _ => {
                let _ = field.text().await;
            }
        }
    }

    let image = match image {
        Some(b) => b,
        None => return Json(Liveness::error("missing file field")),
    };

    let resp = tokio::task::spawn_blocking(move || state.liveness(&image, prob_threshold))
        .await
        // A panicking blocking task must not lock someone in; fail closed.
        .unwrap_or_else(|e| Liveness::error(&format!("blocking task panicked: {e}")));

    Json(resp)
}

/// `POST /verify` (multipart/form-data) — mirrors `app.py::verify`.
///
/// Fields: `file`, `stored_embedding` (JSON 512-array), `threshold` (cosine
/// distance, default 0.40), `require_liveness` (default true),
/// `liveness_threshold` (real-class probability, default 0.5).
pub async fn verify(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Json<VerifyResponse> {
    let mut image: Option<axum::body::Bytes> = None;
    let mut stored_raw: Option<String> = None;
    let mut threshold = 0.40_f32;
    let mut require_liveness = true;
    let mut prob_threshold = 0.5_f32;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => image = field.bytes().await.ok(),
            "stored_embedding" => stored_raw = field.text().await.ok(),
            "threshold" => {
                if let Some(t) = field.text().await.ok() {
                    threshold = t.trim().parse::<f32>().unwrap_or(threshold);
                }
            }
            "require_liveness" => {
                if let Some(v) = field.text().await.ok() {
                    require_liveness = parse_bool(&v, require_liveness);
                }
            }
            "liveness_threshold" => {
                if let Some(t) = field.text().await.ok() {
                    prob_threshold = t.trim().parse::<f32>().unwrap_or(prob_threshold);
                }
            }
            _ => {
                let _ = field.text().await;
            }
        }
    }

    let image = match image {
        Some(b) => b,
        None => {
            return Json(VerifyResponse {
                message: "missing file field".to_string(),
                ..VerifyResponse::no_face(threshold)
            })
        }
    };

    let stored_json = match stored_raw {
        Some(s) => s,
        None => return Json(VerifyResponse::bad_embedding("missing stored_embedding")),
    };

    let stored: Vec<f32> = match serde_json::from_str::<Vec<f32>>(&stored_json) {
        Ok(v) if v.len() == 512 => v,
        Ok(_) => return Json(VerifyResponse::bad_embedding("expected 512 values")),
        Err(e) => return Json(VerifyResponse::bad_embedding(&e.to_string())),
    };

    let resp = tokio::task::spawn_blocking(move || {
        state.verify(&image, &stored, threshold, require_liveness, prob_threshold)
    })
    .await
    .unwrap_or_else(|e| VerifyResponse {
        message: format!("blocking task panicked: {e}"),
        ..VerifyResponse::no_face(threshold)
    });

    Json(resp)
}

/// `POST /embedding` (multipart/form-data) — mirrors `app.py::embedding`.
/// This is the endpoint `pythonSidecar.ts` actually calls.
///
/// Fields: `file`, `require_liveness` (default TRUE — spoofs are rejected at
/// enrolment unless explicitly skipped), `threshold` (real-class probability,
/// default 0.5; NOTE: on this endpoint it is a liveness probability, not a
/// match distance).
pub async fn embedding(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Json<EmbeddingResponse> {
    let mut image: Option<axum::body::Bytes> = None;
    let mut require_liveness = true;
    let mut prob_threshold = 0.5_f32;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => image = field.bytes().await.ok(),
            "require_liveness" => {
                if let Some(v) = field.text().await.ok() {
                    require_liveness = parse_bool(&v, require_liveness);
                }
            }
            "threshold" => {
                if let Some(t) = field.text().await.ok() {
                    prob_threshold = t.trim().parse::<f32>().unwrap_or(prob_threshold);
                }
            }
            _ => {
                let _ = field.text().await;
            }
        }
    }

    let image = match image {
        Some(b) => b,
        None => {
            return Json(EmbeddingResponse {
                success: false,
                embedding: None,
                message: Some("missing file field".to_string()),
                liveness: Liveness::passthrough(),
            })
        }
    };

    let resp = tokio::task::spawn_blocking(move || {
        state.embedding(&image, require_liveness, prob_threshold)
    })
    .await
    .unwrap_or_else(|e| EmbeddingResponse {
        success: false,
        embedding: None,
        message: Some(format!("blocking task panicked: {e}")),
        liveness: Liveness::passthrough(),
    });

    Json(resp)
}
