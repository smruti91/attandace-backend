# Build the Rust face-service and ship a self-contained runtime image.
# `ort`'s default `download-binaries` feature fetches ONNX Runtime at build and
# links it statically on x86_64-linux, so no libonnxruntime.so is needed at run.

FROM rust:1.99-slim AS builder
WORKDIR /app

# `ort`'s download-binaries feature pulls a native-TLS client; on Linux that
# transitively builds `openssl-sys`, which needs the system OpenSSL headers +
# pkg-config. Without these the build fails with "Could not find directory of
# OpenSSL installation" (it works on Windows/macOS, which use OS-native TLS).
# build-essential is needed too: ONNX Runtime is C++, so the final link requires
# libstdc++ (via g++), otherwise "unable to find library -lstdc++".
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

# Auto-fetch the InsightFace buffalo_l models so the image just works.
# This is the SAME pack the retired Python service used, so embeddings stay
# comparable. Override the URL with --build-arg BUFFALO_L_URL=... if needed.
# (Cached by Docker, so the ~281 MB download happens once per URL change.)
FROM debian:trixie-slim AS models
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
ARG BUFFALO_L_URL=https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip
# The pack stores files at top level OR under buffalo_l/; flatten both cases,
# drop the zip + unneeded files, and fail loudly if the two required models are
# not present so a broken fetch can't silently ship a non-working image.
RUN curl -fL "$BUFFALO_L_URL" -o /tmp/buffalo_l.zip \
    && mkdir -p /models \
    && unzip -o /tmp/buffalo_l.zip -d /models \
    && ( mv /models/buffalo_l/*.onnx /models/ 2>/dev/null || true ) \
    && rm -rf /tmp/buffalo_l.zip /models/buffalo_l \
    && test -f /models/det_10g.onnx && test -f /models/w600k_r50.onnx \
    && ls -l /models

# Runtime base MUST be >= the builder's glibc/libstdc++. rust:*-slim is Debian
# trixie, and the vendored ONNX Runtime needs GLIBC_2.38 + GLIBCXX_3.4.31, which
# bookworm (glibc 2.36 / GCC 12) does not provide — hence trixie here too.
FROM debian:trixie-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libstdc++6 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/face-service-rust /usr/local/bin/face-service-rust
# Only the two models the pipeline actually loads are baked in (detector +
# recognition); the other buffalo_l files (age/gender/landmarks) are skipped.
COPY --from=models /models/det_10g.onnx /models/w600k_r50.onnx /app/models/
# MiniFAS anti-spoof model is vendored in the repo (not part of buffalo_l).
COPY models/best_model_quantized.onnx /app/models/
ENV FACE_MODEL_DIR=/app/models \
    FACE_RUST_BIND=0.0.0.0:5000

EXPOSE 5000
CMD ["face-service-rust"]
