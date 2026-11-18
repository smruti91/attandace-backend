import { Worker, type Job } from 'bullmq'
import Redis from 'ioredis'
import { db } from '../db'
import { visitLocationPoints } from '../db/schema'
import { VISIT_LOCATIONS_QUEUE, type VisitLocationsJobData } from '../services/visitLocationQueue'

/**
 * Consumes the visit-locations queue and bulk-writes GPS points to Postgres.
 *
 * Runs in-process with the API by default (startVisitLocationWorker). Both
 * inserts are idempotent — a retried job or two workers racing the same batch
 * can never double-store a point:
 *   - points attributed to a site visit dedupe on (visit_id, client_uuid);
 *   - travel points (no visit) dedupe on (tracking_session_id, client_uuid).
 * The split is required because Postgres treats NULLs as distinct in UNIQUE
 * indexes: a single upsert targeting (visit_id, client_uuid) would never match
 * two travel rows (both visit_id NULL) and retried travel batches would
 * double-insert. `inserted` is derived from the RETURNING counts for the logs.
 *
 * For larger fleets the same file can run standalone — the worker is the only
 * piece that touches the database on the hot path, so it scales horizontally
 * without touching the API.
 */

export function startVisitLocationWorker(concurrency = 20): Worker<VisitLocationsJobData> {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        maxRetriesPerRequest: null,
    })

    const worker = new Worker<VisitLocationsJobData>(
        VISIT_LOCATIONS_QUEUE,
        async (job: Job<VisitLocationsJobData>) => {
            const { visitId, fieldOfficerUserId, siteId, points } = job.data

            const rows = points.map((p) => ({
                trackingSessionId: p.trackingSessionId ?? null,
                // Per-point visit wins; the top-level one is the legacy manual
                // batch's visit. Travel points legitimately carry neither.
                visitId: p.visitId ?? visitId ?? null,
                fieldOfficerUserId,
                // Per-point site wins; top-level is the legacy fallback.
                // Travel points carry null — the column is nullable.
                siteId: p.siteId ?? siteId ?? null,
                latitude: p.latitude,
                longitude: p.longitude,
                accuracy: p.accuracy,
                speed: p.speed,
                batteryLevel: p.batteryLevel,
                heading: p.heading ?? null,
                recordedAt: new Date(p.recordedAt),
                clientUuid: p.uuid,
            }))

            // Split by grain so each half hits the UNIQUE index that can
            // actually see its duplicates (NULL visit_id rows never match each
            // other — see the header comment).
            const visitRows = rows.filter((r) => r.visitId != null)
            const travelRows = rows.filter(
                (r) => r.visitId == null && r.trackingSessionId != null
            )
            // Legacy batches with neither id (shouldn't happen — the endpoint
            // always stamps one) still get stored; they just can't dedupe.
            const orphanRows = rows.filter(
                (r) => r.visitId == null && r.trackingSessionId == null
            )

            let inserted = 0
            if (visitRows.length) {
                const done = await db
                    .insert(visitLocationPoints)
                    .values(visitRows)
                    .onConflictDoNothing({
                        target: [visitLocationPoints.visitId, visitLocationPoints.clientUuid],
                    })
                    .returning({ id: visitLocationPoints.id })
                inserted += done.length
            }
            if (travelRows.length) {
                const done = await db
                    .insert(visitLocationPoints)
                    .values(travelRows)
                    .onConflictDoNothing({
                        target: [
                            visitLocationPoints.trackingSessionId,
                            visitLocationPoints.clientUuid,
                        ],
                    })
                    .returning({ id: visitLocationPoints.id })
                inserted += done.length
            }
            if (orphanRows.length) {
                const done = await db
                    .insert(visitLocationPoints)
                    .values(orphanRows)
                    .returning({ id: visitLocationPoints.id })
                inserted += done.length
            }

            return { received: points.length, inserted }
        },
        {
            connection,
            concurrency,
        },
    )

    worker.on('completed', (job) => {
        // The job itself is removed from Redis on completion (removeOnComplete),
        // so this log is the only trace — counts, not per-point noise. Session
        // batches carry per-point visit ids, so the session (not the legacy
        // top-level visit id) is what identifies the work.
        const result = job.returnvalue as { received: number; inserted: number } | undefined
        const sessionShort = String(job.data.points[0]?.trackingSessionId ?? '').slice(0, 8) || '—'
        console.log(
            `[visit-location-worker] session ${sessionShort}: ` +
            `${result?.inserted ?? '?'} inserted / ${result?.received ?? '?'} received (${job.id})`
        )
    })

    worker.on('failed', (job, err) => {
        // Exhausted jobs are RETAINED (removeOnFail capped) as the
        // dead-letter queue — inspect via `queue.getFailed()` and re-queue
        // after fixing Postgres/Redis. This log is the alert, with visit +
        // window so the batch can be identified without opening Redis.
        // The phone already dropped these points on the 202, so this log
        // firing repeatedly means Redis/Postgres needs attention, not the app.
        const points = job?.data.points ?? []
        console.error(
            `[visit-location-worker] FAILED ${job?.id ?? '?'} attempt ${job?.attemptsMade ?? '?'}/${job?.opts.attempts ?? '?'}:`,
            err.message,
            `visit=${job?.data.visitId ?? '?'} points=${points.length}`,
            `window=${points[0]?.recordedAt ?? '?'}..${points[points.length - 1]?.recordedAt ?? '?'}`,
        )
    })

    worker.on('error', (err) => {
        console.error('[visit-location-worker] worker error:', err.message)
    })

    return worker
}
