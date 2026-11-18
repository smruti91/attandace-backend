/**
 * faceService.ts (HTTP client)
 *
 * This module does not run ML locally. It forwards every face image to the
 * Rust face service in `../face-service-rust` (ONNX Runtime via the `ort`
 * crate — SCRFD detection + wbob recognition — fast and accurate on CPU).
 * The old Python/InsightFace FastAPI sidecar has been removed.
 *
 * The service is exposed via docker-compose on:
 *   http://face-service:5000   (inside the docker network)
 *   http://localhost:5000      (from the host)
 *
 * Endpoints used:
 *   GET  /health            → { status: 'ok' }
 *   POST /liveness          → { success, is_real, status, confidence }   (anti-spoofing)
 *   POST /embedding         → { success, embedding: number[512], liveness }   (register)
 *   POST /verify            → { success, distance, verified, liveness }   (check-in/out)
 *
 * Anti-spoofing (MiniFAS):
 *   PORTED: the Rust service runs MiniFAS (`best_model_quantized.onnx`) on
 *   every /verify and /embedding and enforces `require_liveness` (default
 *   true) — spoofed faces are rejected server-side with a `spoof` verdict in
 *   the `liveness` field. /liveness also works standalone. Note the Rust port
 *   resamples the crop with image-crate filters instead of OpenCV's, so
 *   `logit_diff` can differ from the old Python service by a few hundredths
 *   near a threshold — re-check LIVENESS_THRESHOLD boundaries against real
 *   spoofs before trusting security edges.
 *
 * Why a separate service at all?
 *   - InsightFace's buffalo_l model is ~300MB and depends on onnxruntime.
 *   - The face service runs as its own docker container, scaling
 *     independently of the Node auth server.
 */

const FACE_API_URL = process.env.FACE_API_URL ?? 'http://localhost:5000';

/** Verify threshold: same person → distance ≤ threshold (InsightFace cosine).
 * Tuned on this deployment's real data (attendance_logs + enrolment cross-checks):
 *   genuine, room light:   0.31 median, up to 0.562 observed
 *   impostors (3 people):  0.72–0.90
 * 0.40 rejected legitimate officers at 0.455/0.562; 0.62 sits in the middle
 * of the 0.56–0.72 gap, giving both classes margin. Re-tune if the roster
 * grows: `SELECT max(face_distance) FROM attendance_logs` (genuine) should
 * stay well under impostor distances. */
export const MATCH_THRESHOLD = 0.62;

/** Liveness threshold: real-class probability ≥ 0.50 (MiniFAS) */
export const LIVENESS_THRESHOLD = 0.50;

/**
 * Second-pass liveness threshold for the low-light false positive. MiniFAS
 * frequently misclassifies an under-lit REAL face as "spoof" at the strict
 * threshold; a printed photo / screen stays spoof even when the threshold is
 * dropped this far. The retry therefore rescues genuine users without
 * meaningfully weakening anti-spoofing — and the face must still match the
 * stored embedding by distance to be accepted.
 */
const LIVENESS_LOWLIGHT_THRESHOLD = Number(
    process.env.FACE_LIVENESS_LOWLIGHT_THRESHOLD ?? '0.30'
);

/** Health check — useful at server boot */
export async function pingFaceService(): Promise<boolean> {
    try {
        const res = await fetch(`${FACE_API_URL}/health`);
        const data: any = await res.json();
        return data?.status === 'ok';
    } catch (err) {
        console.error('[face] ping failed:', err);
        return false;
    }
}

/**
 * Convert a base64-encoded image (with or without data:image/jpeg;base64, prefix)
 * into a Blob that the fetch multipart upload can stream.
 */
function base64ToBlob(base64: string): Blob {
    const cleaned = base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    const bin = Buffer.from(cleaned, 'base64');
    return new Blob([bin], { type: 'image/jpeg' });
}

export interface LivenessResult {
    /** false when the service could not classify the image (e.g. no face) */
    success: boolean;
    is_real: boolean;
    /** `error` is the service's fail-closed verdict when MiniFAS itself could
     * not run (decode/inference fault) — distinct from `no_face`, which means a
     * face simply was not there. */
    status: 'real' | 'spoof' | 'no_face' | 'error';
    /** |real_logit - spoof_logit|; larger = more confident */
    confidence: number;
    logit_diff: number;
    real_logit: number;
    spoof_logit: number;
    message?: string;
}

/**
 * Anti-spoofing check: does the face in this image look like a live person
 * rather than a printed photo or screen display?
 */
export async function checkLiveness(
    base64: string,
    threshold: number = LIVENESS_THRESHOLD
): Promise<LivenessResult> {
    const form = new FormData();
    form.append('file', base64ToBlob(base64), 'face.jpg');
    form.append('threshold', String(threshold));

    const res = await fetch(`${FACE_API_URL}/liveness`, {
        method: 'POST',
        body: form,
    });

    if (!res.ok) {
        throw new Error(`face-service /liveness ${res.status}`);
    }
    const data: any = await res.json();
    return {
        success: data.success === true,
        is_real: data.is_real === true,
        status: data.status ?? 'no_face',
        confidence: typeof data.confidence === 'number' ? data.confidence : 0,
        logit_diff: typeof data.logit_diff === 'number' ? data.logit_diff : 0,
        real_logit: typeof data.real_logit === 'number' ? data.real_logit : 0,
        spoof_logit: typeof data.spoof_logit === 'number' ? data.spoof_logit : 0,
        message: typeof data.message === 'string' ? data.message : undefined,
    };
}

/**
 * Outcome of an enrolment capture. Returned as a result rather than
 * `number[] | null` because "the service saw no face" and "the service saw a
 * face but judged it a photo/screen" need different answers from the UI: the
 * first asks the person to move the camera, the second asks them to re-shoot
 * the real face. Collapsing both into "no face detected" sends operators
 * chasing lighting when the capture was refused by anti-spoofing.
 */
export interface EmbeddingResult {
    success: boolean;
    /** null when no embedding could be taken (no face, spoof, or error) */
    embedding: number[] | null;
    message: string;
    /** anti-spoofing verdict for the enrolled image */
    liveness: LivenessResult;
}

/**
 * Extract a 512-dim embedding for a face image.
 * Anti-spoofing is enforced by default, so a printed photo or screen display
 * comes back with `embedding: null` and a `spoof` verdict rather than an
 * embedding built from a fake.
 */
export async function extractEmbedding(
    base64: string,
    requireLiveness: boolean = true,
    livenessThreshold: number = LIVENESS_THRESHOLD
): Promise<EmbeddingResult> {
    const form = new FormData();
    form.append('file', base64ToBlob(base64), 'face.jpg');
    form.append('require_liveness', String(requireLiveness));
    form.append('threshold', String(livenessThreshold));

    const res = await fetch(`${FACE_API_URL}/embedding`, {
        method: 'POST',
        body: form,
    });

    if (!res.ok) {
        throw new Error(`face-service /embedding ${res.status}`);
    }
    const data: any = await res.json();
    const liveness: LivenessResult = {
        success: data.liveness?.success === true,
        is_real: data.liveness?.is_real === true,
        status: data.liveness?.status ?? 'no_face',
        confidence: typeof data.liveness?.confidence === 'number' ? data.liveness.confidence : 0,
        logit_diff: typeof data.liveness?.logit_diff === 'number' ? data.liveness.logit_diff : 0,
        real_logit: typeof data.liveness?.real_logit === 'number' ? data.liveness.real_logit : 0,
        spoof_logit:
            typeof data.liveness?.spoof_logit === 'number' ? data.liveness.spoof_logit : 0,
        message: typeof data.liveness?.message === 'string' ? data.liveness.message : undefined,
    };
    const embedding =
        data.success === true && Array.isArray(data.embedding) ? (data.embedding as number[]) : null;
    if (embedding && embedding.length !== 512) {
        throw new Error(`face-service returned a ${embedding.length}-dim embedding, expected 512`);
    }
    return {
        success: embedding !== null,
        embedding,
        message: typeof data.message === 'string' ? data.message : 'face-service refused the image',
        liveness,
    };
}

/**
 * Turns a refused enrolment capture into the sentence the person should read.
 * Kept beside `extractEmbedding` so every enrolment entry point (self-service,
 * supervisor, admin panel) explains a refusal the same way.
 */
export function describeEnrolmentFailure(result: EmbeddingResult): string {
    if (result.liveness.status === 'spoof') {
        return (
            'Anti-spoofing refused that capture — it reads as a photo of a screen or a ' +
            'printed face, not a live person. Re-take it straight from the camera, facing ' +
            'the employee, in even light (no backlight, no flash glare).'
        );
    }
    if (result.liveness.status === 'error') {
        return 'The face service could not process that image. Please retry.';
    }
    return 'No face detected in the image. Please retry with good lighting.';
}

export interface VerifyResult {
    /** false when the service could not process the image at all (no face, bad input, or spoof) */
    success: boolean;
    verified: boolean;
    /** cosine distance; 1 (max) when no comparison could be made */
    distance: number;
    message: string;
    /** anti-spoofing verdict for the live image */
    liveness: LivenessResult;
}

/**
 * Server-side verify: ask the face service to compare a live image against
 * a stored embedding and return distance + threshold-based decision.
 *
 * This single call does detection, anti-spoofing *and* comparison, so callers
 * do NOT need to run extractEmbedding() or checkLiveness() first — doing so
 * would run InsightFace twice over the same image and roughly double the
 * request latency on CPU.
 *
 * Spoofed faces are rejected by default: when the image is a printed photo or
 * screen display, the service returns verified=false before any comparison.
 *
 * Low-light retry: MiniFAS misreads dim/under-lit real faces as "spoof" more
 * often than any other input class. When the first pass fails ONLY on
 * liveness, retry once at the lenient low-light threshold — a printed photo
 * still fails both passes, and a rescued frame still has to match the stored
 * embedding to verify. A pass whose failure was a distance miss is NOT
 * retried: the face was seen fine, it just wasn't the right person.
 */
export async function verifyFace(
    base64: string,
    storedEmbedding: number[],
    threshold: number = MATCH_THRESHOLD,
    requireLiveness: boolean = true,
    livenessThreshold: number = LIVENESS_THRESHOLD
): Promise<VerifyResult> {
    const parse = (data: any): VerifyResult => {
        const liveness: LivenessResult = {
            success: data.liveness?.success === true,
            is_real: data.liveness?.is_real === true,
            status: data.liveness?.status ?? 'no_face',
            confidence:
                typeof data.liveness?.confidence === 'number' ? data.liveness.confidence : 0,
            logit_diff: typeof data.liveness?.logit_diff === 'number' ? data.liveness.logit_diff : 0,
            real_logit: typeof data.liveness?.real_logit === 'number' ? data.liveness.real_logit : 0,
            spoof_logit:
                typeof data.liveness?.spoof_logit === 'number' ? data.liveness.spoof_logit : 0,
        };
        return {
            success: data.success === true,
            verified: data.verified === true,
            distance: typeof data.distance === 'number' ? data.distance : 1,
            message: typeof data.message === 'string' ? data.message : 'unknown face-service response',
            liveness,
        };
    };

    const call = async (livThreshold: number): Promise<VerifyResult> => {
        const form = new FormData();
        form.append('file', base64ToBlob(base64), 'face.jpg');
        form.append('stored_embedding', JSON.stringify(storedEmbedding));
        form.append('threshold', String(threshold));
        form.append('require_liveness', String(requireLiveness));
        form.append('liveness_threshold', String(livThreshold));

        const res = await fetch(`${FACE_API_URL}/verify`, {
            method: 'POST',
            body: form,
        });

        if (!res.ok) {
            throw new Error(`face-service /verify ${res.status}`);
        }
        return parse(await res.json());
    };

    const first = await call(livenessThreshold);
    const livenessOnlyFailure =
        !first.success &&
        requireLiveness &&
        first.liveness.success && // a face WAS seen and classified…
        !first.liveness.is_real;  // …as spoof — the dim-light signature
    if (!livenessOnlyFailure) return first;

    const retry = await call(LIVENESS_LOWLIGHT_THRESHOLD);
    // Surface whichever pass got further: a lenient-pass match is the answer;
    // otherwise keep the strict pass's result (its logs are the honest ones).
    if (retry.success && retry.verified) {
        return { ...retry, message: `match (low-light retry, distance=${retry.distance.toFixed(3)})` };
    }
    return first;
}

/** Kept for callers that want to compare locally instead of via /verify */
export function cosineDistance(a: number[], b: number[]): number {
    if (a.length !== b.length) throw new Error('embedding length mismatch');
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        const av = a[i]!;
        const bv = b[i]!;
        dot += av * bv;
        na  += av * av;
        nb  += bv * bv;
    }
    return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}
