import { Queue } from 'bullmq'
import Redis from 'ioredis'

/**
 * BullMQ queue that decouples GPS-point ACCEPTANCE from GPS-point PERSISTENCE.
 *
 * The upload endpoint validates the batch (visit exists, belongs to the
 * caller, every point inside the visit window) and answers immediately —
 * a reconnect spike of hundreds of queued batches becomes N fast validations
 * plus a background trickle of bulk inserts instead of hundreds of
 * simultaneous Postgres writes. At 5k officers × 1 point / 5 min the steady
 * state is only ~17 inserts/sec, but offline catch-ups arrive in bursts, and
 * bursts are what this queue absorbs.
 *
 * Delivery guarantee: the phone drops a batch only on HTTP 2xx, and 2xx here
 * means "durably in Redis with 10 persisted attempts". If Redis itself is
 * unreachable the endpoint answers 503 and the phone keeps the points.
 */

// One point as it travels through Redis — JSON-safe only (no Date objects;
// numerics already formatted to the column precision by the endpoint).
export interface QueuedLocationPoint {
    /** The tracking session, if the point came from the session flow. Null
     * for legacy manual-visit batches. */
    trackingSessionId: string | null
    /** The site visit active at capture, if the fix fell inside one. Null
     * while travelling between sites (or for legacy batches, the visit id
     * from the URL). */
    visitId: string | null
    /** The entered site at capture. Null while travelling — the column is
     * nullable for exactly these session points. */
    siteId: string | null
    uuid: string
    latitude: string
    longitude: string
    accuracy: string | null
    speed: string | null
    batteryLevel: string | null
    heading: string | null
    /** ISO-8601 device clock at capture. */
    recordedAt: string
}

export const VISIT_LOCATIONS_QUEUE = 'visit-locations'

export interface VisitLocationsJobData {
    /** Legacy top-level visit (manual-visit batches). Session batches carry
     * per-point visit ids instead and leave these null. */
    visitId: string | null
    fieldOfficerUserId: string
    /** Legacy top-level site. Session points carry their own (or none while
     * travelling). */
    siteId: string | null
    points: QueuedLocationPoint[]
}

// BullMQ requires its own connection(s) with maxRetriesPerRequest disabled.
const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
})

export const visitLocationsQueue = new Queue<VisitLocationsJobData>(VISIT_LOCATIONS_QUEUE, {
    connection,
    // Cap the per-queue event stream — without this it grows unbounded and
    // quietly becomes the biggest Redis consumer over millions of points.
    streams: { events: { maxLen: 1_000 } },
    defaultJobOptions: {
        // Retries ride through transient Postgres hiccups; exponential backoff
        // spreads a recovered database's catch-up load. 10 attempts x 5s base
        // covers ~several minutes of outage; exhausted jobs are RETAINED
        // (removeOnFail capped) as the dead-letter queue for admin recovery —
        // never silently dropped.
        attempts: 10,
        backoff: { type: 'exponential', delay: 5_000 },
        // Keep the last 1000 completed jobs trimmed automatically; keep the
        // last 5000 failed jobs as the dead-letter queue so an operator can
        // inspect and re-queue them (BullMQ Dashboard / `queue.getFailed()`).
        // Failed batches are also logged by the worker with visit + window.
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
    },
})

/** Enqueue one validated batch. Resolves as soon as Redis has accepted it. */
export async function enqueueVisitLocations(data: VisitLocationsJobData): Promise<void> {
    await visitLocationsQueue.add('store', data)
}

/** Close the queue + its connection (graceful shutdown). */
export async function closeVisitLocationQueue(): Promise<void> {
    try {
        await visitLocationsQueue.close()
    } catch (err: any) {
        console.error('[queue] close failed:', err.message)
    }
}
