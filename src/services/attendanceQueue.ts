import { Queue } from 'bullmq'
import Redis from 'ioredis'

/**
 * BullMQ queue that decouples punch ACCEPTANCE from punch PERSISTENCE.
 *
 * The API verifies the face, reserves the employee's punch slot in Redis,
 * enqueues the row insert and answers the phone immediately — a 500-employee
 * shift-change spike becomes N fast verifications plus a background trickle
 * of inserts instead of 500 simultaneous Postgres writes.
 */

export const ATTENDANCE_QUEUE = 'attendance'

export interface AttendanceJobData {
    employeeId: string
    action: 'check-in' | 'check-out'
    /** Cosine distance from the face verify step, stored with the row. */
    faceDistance?: string | null
    /** Who initiated it — for audit in the logs. */
    source?: 'self' | 'supervisor'
    /** Supervisor user id when source === 'supervisor'. */
    supervisorId?: string | null
    /** Site the punch is attributed to (must be one of supervisor's sites). */
    siteId?: string | null
    /** Capture method for supervisor flows: biometric (face-verified) | manual (camera photo). */
    attendanceMethod?: 'biometric' | 'manual' | null
    /** DB-relative manual photo path, e.g. "attendance-images/....jpg". */
    imagePath?: string | null
    /** Logical attendance day YYYY-MM-DD (day filter). Defaults to CURRENT_DATE. */
    attendanceDate?: string | null
    /** One-line handset signature from the app's `device` body field. */
    deviceInfo?: string | null
    /**
     * Fix recorded at the punch, as a string so the (10,7) numeric column is
     * fed without a float round trip. Audit only — the geofence verdict is
     * made in the API before the job is enqueued.
     */
    geoLat?: string | null
    geoLng?: string | null
}

// BullMQ requires its own connection(s) with maxRetriesPerRequest disabled.
const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
})

export const attendanceQueue = new Queue<AttendanceJobData>(ATTENDANCE_QUEUE, {
    connection,
    // Cap the per-queue event stream — without this it grows unbounded and
    // quietly becomes the biggest Redis consumer over thousands of punches.
    streams: { events: { maxLen: 1_000 } },
    defaultJobOptions: {
        // Retries ride through transient Postgres hiccups; exponential backoff
        // spreads a recovered database's catch-up load.
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        // Zero retention: a job is deleted from Redis the instant it finishes,
        // whether it completed or exhausted its retries — no completed/failed
        // sets accumulate, so Redis holds only live work. Failed punches are
        // not lost silently: the worker logs the full payload before removal.
        removeOnComplete: true,
        removeOnFail: true,
    },
})

/** Enqueue one attendance row. Resolves as soon as Redis has accepted it. */
export async function enqueueAttendance(data: AttendanceJobData): Promise<void> {
    await attendanceQueue.add('mark', data)
}

/** Close the queue + its connection (graceful shutdown). */
export async function closeAttendanceQueue(): Promise<void> {
    try {
        await attendanceQueue.close()
    } catch (err: any) {
        console.error('[queue] close failed:', err.message)
    }
}
