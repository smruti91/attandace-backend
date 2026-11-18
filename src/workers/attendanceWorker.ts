import { Worker, type Job } from 'bullmq'
import Redis from 'ioredis'
import { db } from '../db'
import { attendanceLogs } from '../db/schema'
import { ATTENDANCE_QUEUE, type AttendanceJobData } from '../services/attendanceQueue'

/**
 * Consumes the attendance queue and writes punch rows to Postgres.
 *
 * Runs in-process with the API by default (startAttendanceWorker). For larger
 * fleets the same file can run standalone — the worker is the only piece that
 * touches the database on the hot path, so it scales horizontally without
 * touching the face-service or the API.
 */

export function startAttendanceWorker(concurrency = 10): Worker<AttendanceJobData> {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        maxRetriesPerRequest: null,
    })

    const worker = new Worker<AttendanceJobData>(
        ATTENDANCE_QUEUE,
        async (job: Job<AttendanceJobData>) => {
            const { employeeId, action, faceDistance, supervisorId, siteId, attendanceMethod, imagePath, attendanceDate, deviceInfo, geoLat, geoLng } = job.data

            // `created_at` keeps its DB default on purpose: the insert may run
            // moments after the employee was told "done", and the row must
            // carry the database's clock, not a timestamp relayed through the
            // job payload (which could be tampered with or skewed).
            // `attendance_date` is the logical day (supervisor day-filter);
            // when omitted the column default CURRENT_DATE applies.
            try {
                await db.insert(attendanceLogs).values({
                    employeeId,
                    action,
                    faceDistance: faceDistance ?? null,
                    ...(supervisorId ? { supervisorId } : {}),
                    ...(siteId ? { siteId } : {}),
                    ...(attendanceMethod ? { attendanceMethod } : {}),
                    ...(imagePath ? { imagePath } : {}),
                    ...(attendanceDate ? { attendanceDate } : {}),
                    ...(deviceInfo ? { deviceInfo } : {}),
                    // Coordinates of the fix the fence was measured with, when the
                    // app managed to read one. Stored as text so the numeric column
                    // sees the digits the phone reported rather than a float's.
                    ...(geoLat && geoLng ? { geoLat, geoLng } : {}),
                })
            } catch (err: any) {
                // A duplicate that raced past the API pre-checks (double-tap
                // across processes): the row already exists, so there is nothing
                // to retry — swallow instead of burning all 5 attempts. With
                // multi-site duties the index that fires is the employee + day +
                // SITE one, so an officer working two sites in a day is never
                // caught here; only a genuine second tap at the same site is.
                const code = err?.code ?? err?.cause?.code
                if (code === '23505') {
                    console.log(`[attendance-worker] duplicate punch ignored (${job.id})`)
                    return { inserted: false, duplicate: true }
                }
                throw err
            }

            return { inserted: true }
        },
        {
            connection,
            concurrency,
        },
    )

    worker.on('completed', (job) => {
        // The job itself is removed from Redis on completion (removeOnComplete),
        // so this log is the only trace — which is all a successful insert needs.
        console.log(`[attendance-worker] punch stored (${job.id})`)
    })

    worker.on('failed', (job, err) => {
        // Jobs are removed from Redis as soon as they exhaust their retries
        // (removeOnFail), so this log is the permanent record of a punch that
        // never landed — payload included, so it can be re-inserted manually.
        console.error(
            `[attendance-worker] FAILED ${job?.id ?? '?'} attempt ${job?.attemptsMade ?? '?'}/${job?.opts.attempts ?? '?'}:`,
            err.message,
            'payload:',
            JSON.stringify(job?.data ?? null),
        )
    })

    worker.on('error', (err) => {
        console.error('[attendance-worker] worker error:', err.message)
    })

    return worker
}
