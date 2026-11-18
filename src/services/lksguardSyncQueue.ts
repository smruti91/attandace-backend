import { Queue } from 'bullmq'
import Redis from 'ioredis'

/**
 * BullMQ queue decoupling LKSGuard event ACCEPTANCE from event PERSISTENCE
 * (#20). The sync endpoint validates the batch (device bound + ACTIVE, employee
 * matches the assignment) and answers 202 as soon as Redis holds it; the worker
 * does the idempotent Postgres writes in the background. An offline handset's
 * reconnect burst becomes N fast validations plus a trickle of inserts, never a
 * stampede of concurrent writes.
 *
 * Delivery guarantee mirrors visit-locations: the app drops a queued batch only
 * on HTTP 2xx, and 2xx here means "durably in Redis with 10 persisted attempts".
 * If Redis is down the endpoint answers 503 and the app keeps its events.
 */

// ── JSON-safe event shapes (no Date objects; ISO strings) ──────────────────────
export interface QueuedCallEvent {
    eventUuid: string
    phoneNumber: string | null
    callType: 'INCOMING' | 'OUTGOING' | 'MISSED'
    startedAt: string | null
    endedAt: string | null
    durationSeconds: number
    eventTime: string
}

export interface QueuedSmsEvent {
    eventUuid: string
    phoneNumber: string | null
    direction: 'SENT' | 'RECEIVED'
    messageTimestamp: string | null
    policy: 'SMS_METADATA_ONLY' | 'SMS_CONTENT'
    // Already AES-GCM encrypted by the API before enqueue — the worker never
    // sees plaintext, so it can't leak into a job payload stored in Redis.
    contentCipher: string | null
    contentIv: string | null
    messageTime: string
}

export interface QueuedContactEvent {
    contactUuid: string
    contactName: string | null
    phoneNumber: string | null
    email: string | null
}

export interface LksGuardSyncJobData {
    // Server-derived (never trusted from the client) — the worker writes these
    // straight to the rows so a spoofed body field can't re-attribute a record.
    employeeId: string
    deviceId: string
    calls: QueuedCallEvent[]
    sms: QueuedSmsEvent[]
    contacts: QueuedContactEvent[]
}

export const LKSGUARD_SYNC_QUEUE = 'lksguard-sync'

const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
})

export const lksguardSyncQueue = new Queue<LksGuardSyncJobData>(LKSGUARD_SYNC_QUEUE, {
    connection,
    streams: { events: { maxLen: 1_000 } },
    defaultJobOptions: {
        attempts: 10,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1_000,
        // Failed batches are retained as a dead-letter queue for operator
        // recovery — the app already dropped them on the 202, so losing them
        // silently would break the "server is the source of truth" promise.
        removeOnFail: 5_000,
    },
})

/** Enqueue one validated batch. Resolves once Redis has accepted it. */
export async function enqueueLksGuardSync(data: LksGuardSyncJobData): Promise<void> {
    await lksguardSyncQueue.add('store', data)
}

export async function closeLksGuardQueue(): Promise<void> {
    try {
        await lksguardSyncQueue.close()
    } catch (err: any) {
        console.error('[lksguard queue] close failed:', err.message)
    }
}
