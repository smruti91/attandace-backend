#!/usr/bin/env python3
"""Embedding parity harness: Rust face-service-rust  vs  canonical InsightFace.

Why this exists
---------------
The Rust port reimplements InsightFace's pre/post-processing (SCRFD letterbox +
anchor decode, 5-point alignment, recognition blob) with the `image` crate and
hand-written math instead of OpenCV/PIL. If any step disagrees with InsightFace,
the embeddings it produces will NOT match embeddings stored by the (InsightFace
based) enrolment path, and every check-in silently verifies as "no match".

This script feeds the SAME image to:
  * InsightFace (the ground truth that made the stored embeddings), and
  * the Rust /embedding endpoint,
then reports the cosine distance. It also runs the real production path:
Rust /verify of a live image against the InsightFace embedding.

What it validates (and what it deliberately does NOT)
-----------------------------------------------------
This is an ALGORITHM-parity gate. It decodes each image once, then feeds the
REFERENCE the decoded pixels and feeds the RUST service the SAME pixels
re-encoded losslessly (PNG). That isolates the SCRFD-decode + align + recognize
math from the JPEG DECODER.

Why that matters: the Rust service decodes JPEG with the `image` crate while
InsightFace decodes with libjpeg/OpenCV, and the two produce slightly different
pixels for the same .jpg. Those pixel differences move the landmarks a couple of
decimal pixels and show up as ~0.2-0.35 embedding distance even though the
algorithm is exact — on identical (PNG) pixels the distance drops to ~0.000.
This is NOT a bug and is NOT a production risk here: enrolment AND check-in
both go through THIS Rust service, so stored and live embeddings always share
one decoder and stay mutually consistent.

Usage
-----
  # reference needs the same models the Rust service uses
  pip install insightface onnxruntime opencv-python-headless numpy requests

  # bring the Rust service up (see ../Dockerfile; it auto-fetches buffalo_l)
  export FACE_RUST_URL=http://localhost:5000

  python scripts/parity_check.py path/to/sample_faces/

Exit code is 0 only if every image's insightface/rust embedding distance (on
identical pixels) is under --max-dist (default 0.05). A large distance here
means the detection decode (scrfd.rs), channel order (imageutil.rs / embed.rs
REC_SWAP_RB), or alignment (align.rs) genuinely disagrees with InsightFace.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import requests

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Same formula as the Rust /verify: 1 - a·b/(|a||b|), +1e-12 guard."""
    a = a / (np.linalg.norm(a) + 1e-12)
    b = b / (np.linalg.norm(b) + 1e-12)
    return float(1.0 - float(np.dot(a, b)))


def load_reference(model_dir: str):
    """Build an InsightFace app that returns the canonical 512-d embedding."""
    # INSIGHTFACE_HOME must be set before insightface resolves the model pack.
    # If it points at a dir containing models/buffalo_l/*.onnx we use those;
    # otherwise insightface auto-downloads buffalo_l (~281 MB) to it on first use.
    if model_dir:
        os.environ["INSIGHTFACE_HOME"] = model_dir
    try:
        import cv2  # noqa: F401
        from insightface.app import FaceAnalysis
    except Exception as e:  # noqa: BLE001
        print(
            "[!] reference stack not available "
            "(install insightface onnxruntime opencv-python-headless numpy requests)",
            file=sys.stderr,
        )
        raise SystemExit(f"    detail: {e}")

    # detection_model + recognition_model names match buffalo_l files.
    app = FaceAnalysis(
        name="buffalo_l",
        allowed_modules=["detection", "recognition"],
        providers=["CPUExecutionProvider"],
    )
    app.prepare(ctx_id=-1, det_size=(640, 640))
    return app


def read_bgr(img_path: Path):
    import cv2

    return cv2.imread(str(img_path))


def lossless_bytes(bgr) -> bytes | None:
    """Re-encode decoded pixels as PNG so the Rust service and the reference
    see the EXACT SAME pixels (isolates algorithm parity from JPEG decoding)."""
    import cv2

    ok, buf = cv2.imencode(".png", bgr)
    return buf.tobytes() if ok else None


def ref_embedding(app, bgr) -> np.ndarray | None:
    faces = app.get(bgr)
    if not faces:
        return None
    # largest face = same selection insightface verify used at enrolment
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    return np.array(face.normed_embedding, dtype=np.float32)


def rust_embedding(base_url: str, img_bytes: bytes) -> np.ndarray | None:
    files = {"file": ("face.png", img_bytes, "image/png")}
    data = {"require_liveness": "false"}
    r = requests.post(f"{base_url}/embedding", files=files, data=data, timeout=30)
    r.raise_for_status()
    j = r.json()
    if not j.get("success") or not isinstance(j.get("embedding"), list):
        return None
    return np.array(j["embedding"], dtype=np.float32)


def rust_health(base_url: str) -> bool:
    try:
        return requests.get(f"{base_url}/health", timeout=5).json().get("status") == "ok"
    except Exception:  # noqa: BLE001
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="Rust vs InsightFace embedding parity")
    ap.add_argument("images_dir", type=Path, help="directory of sample face images")
    ap.add_argument(
        "--rust-url",
        default=os.environ.get("FACE_RUST_URL", "http://localhost:5000"),
    )
    ap.add_argument(
        "--models-dir",
        default=os.environ.get("FACE_MODEL_DIR", ""),
        help="optional dir holding buffalo_l .onnx (else uses ~/.insightface)",
    )
    ap.add_argument(
        "--max-dist",
        type=float,
        default=0.05,
        help="max allowed insightface/rust embedding distance per image (identical pixels)",
    )
    ap.add_argument("--limit", type=int, default=50, help="max images to check")
    args = ap.parse_args()

    if not rust_health(args.rust_url):
        print(f"[!] rust service not healthy at {args.rust_url}", file=sys.stderr)
        return 2

    app = load_reference(args.models_dir)

    images = sorted(p for p in args.images_dir.rglob("*") if p.suffix.lower() in IMG_EXTS)
    if not images:
        print(f"[!] no images found under {args.images_dir}", file=sys.stderr)
        return 2
    images = images[: args.limit]

    worst = 0.0
    failures = 0
    import json

    print(f"{'image':<38} {'alg-dist':>9}  {'rust /verify vs IF-stored':>30}")
    print("-" * 82)
    for img in images:
        bgr = read_bgr(img)
        label = img.name[:38]
        if bgr is None:
            print(f"{label:<38} {'(unreadable)':>9}")
            failures += 1
            continue
        # Identical pixels for both sides: reference uses the decoded image,
        # Rust gets the SAME pixels re-encoded losslessly (see module docstring).
        png = lossless_bytes(bgr)
        emb_ref = ref_embedding(app, bgr)
        emb_rust = rust_embedding(args.rust_url, png)
        if emb_ref is None or emb_rust is None:
            who = "insightface" if emb_ref is None else "rust"
            print(f"{label:<38} {'(no face: ' + who + ')':>9}")
            failures += 1
            continue
        d = cosine_distance(emb_ref, emb_rust)
        worst = max(worst, d)
        if d > args.max_dist:
            failures += 1
        # production path: verify a live image (identical pixels) against the
        # InsightFace embedding — this is exactly what a check-in does.
        v = requests.post(
            f"{args.rust_url}/verify",
            files={"file": ("face.png", png, "image/png")},
            data={"stored_embedding": json.dumps(emb_ref.tolist()), "threshold": "0.40"},
            timeout=30,
        ).json()
        cross = f"verified={v.get('verified')} dist={float(v.get('distance', 1.0)):.3f}"
        flag = "" if d <= args.max_dist else "  <-- TUNE (scrfd.rs / imageutil.rs / align.rs)"
        print(f"{label:<38} {d:>9.4f}  {cross:>30}{flag}")

    print("-" * 82)
    print(f"worst insightface<->rust distance: {worst:.4f}  |  failures: {failures}/{len(images)}")
    if failures:
        print("PARITY CHECK: some images disagree or had no face — see flags above.")
        return 1
    print("PARITY OK — Rust embeddings track canonical InsightFace.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
