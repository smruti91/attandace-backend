//! The ONLY module in the crate that touches the `ort` API.
//!
//! Isolating it here means an `ort` version bump only risks breaking this file,
//! not the detection / alignment / recognition math. Every model call goes
//! through [`ModelSession::run_f32`], which takes a flat NCHW `f32` buffer +
//! shape and returns each output tensor as `(shape, data)` — the rest of the
//! crate never learns that ONNX Runtime exists.

use anyhow::{Context, Result};
use ort::{environment::Environment, inputs, session::Session, value::Tensor};

/// A single output tensor pulled back to CPU as `f32`.
#[allow(dead_code)] // `name`/`shape` are read by name-based exports & parity tooling
pub struct Output {
    /// Model-declared output name (used to map SCRFD score/bbox/kps tensors
    /// when the export uses semantic names instead of positional order).
    pub name: String,
    pub shape: Vec<usize>,
    pub data: Vec<f32>,
}

/// Wraps an ORT `Session`. `run` needs `&mut self`, so the pipeline keeps a
/// pool of these (see `pool.rs`) to run several inferences concurrently.
pub struct ModelSession {
    session: Session,
}

impl ModelSession {
    pub fn new(env: &Environment, path: &str) -> Result<Self> {
        let session = Session::builder(env)
            .context("failed to build ONNX session")?
            .commit_from_file(path)
            .with_context(|| format!("failed to load ONNX model: {path}"))?;
        Ok(ModelSession { session })
    }

    /// Feed one NCHW float input (single-input models: SCRFD det, wbob rec) and
    /// return every output in the model's declared output order.
    pub fn run_f32(&mut self, data: Vec<f32>, shape: Vec<usize>) -> Result<Vec<Output>> {
        let shape_i64: Vec<i64> = shape.iter().map(|&d| d as i64).collect();
        let tensor = Tensor::from_array((shape_i64, data))
            .context("failed to create input tensor")?;

        // Capture output names *before* `run` (which mutably borrows the
        // session) so SCRFD can map score/bbox/kps tensors by name.
        let output_names: Vec<String> = self
            .session
            .outputs()
            .iter()
            .map(|o| o.name().to_string())
            .collect();

        let outputs = self
            .session
            .run(inputs![&tensor])
            .context("ONNX inference failed")?;

        let mut result = Vec::with_capacity(outputs.len());
        for i in 0..outputs.len() {
            let (s, buf) = outputs[i]
                .try_extract_tensor::<f32>()
                .with_context(|| format!("failed to extract output #{i} as f32"))?;
            result.push(Output {
                name: output_names.get(i).cloned().unwrap_or_default(),
                shape: s.iter().map(|&d| d as usize).collect(),
                data: buf.to_vec(),
            });
        }
        Ok(result)
    }
}
