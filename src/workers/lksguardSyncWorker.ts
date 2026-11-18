import { Worker, type Job } from 'bullmq'
import Redis from 'ioredis'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db'
import {
    lksguardCallRecords,
    lksguardSmsRecords,
    lksguardContacts,
    lksguardDevices,
} from '../db/schema'
import { LKSGUARD_SYNC_QUEUE, type LksGuardSyncJobData } from '../services/lksguardSyncQueue'

/**
 * Consumes the lksguard-sync queue and writes events to Postgres idempotently
 * (#17/#19). A retried job or two workers racing the same batch can never
 * double-store:
 *   - call/SMS rows dedupe on the UNIQUE (device_id, event_uuid) via
 *     onConflictDoNothing — a duplicate simply inserts nothing;
 *   - contact rows UPSERT on (device_id, contact_uuid) so a re-sync refreshes
 *     name/phone/email instead of creating a duplicate (#12).
 *
 * Runs in-process with the API by default; for bigger fleets this file can run
 * standalone (its own process) and scale horizontally without touching the API.
 */
export function startLksGuardWorker(concurrency = 10): Worker<LksGuardSyncJobData> {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        maxRetriesPerRequest: null,
    })

    const worker = new Worker<LksGuardSyncJobData>(
        LKSGUARD_SYNC_QUEUE,
        async (job: Job<LksGuardSyncJobData>) => {
            const { employeeId, deviceId, calls, sms, contacts } = job.data

            let inserted = 0

            if (calls.length) {
                const done = await db
                    .insert(lksguardCallRecords)
                    .values(
                        calls.map((c) => ({
                            eventUuid: c.eventUuid,
                            deviceId,
                            employeeId,
                            phoneNumber: c.phoneNumber,
                            callType: c.callType,
                            startedAt: c.startedAt ? new Date(c.startedAt) : null,
                            endedAt: c.endedAt ? new Date(c.endedAt) : null,
                            durationSeconds: c.durationSeconds,
                            eventTime: new Date(c.eventTime),
                        }))
                    )
                    .onConflictDoNothing({
                        target: [lksguardCallRecords.deviceId, lksguardCallRecords.eventUuid],
                    })
                    .returning({ id: lksguardCallRecords.id })
                inserted += done.length
            }

            if (sms.length) {
                const done = await db
                    .insert(lksguardSmsRecords)
                    .values(
                        sms.map((s) => ({
                            eventUuid: s.eventUuid,
                            deviceId,
                            employeeId,
                            phoneNumber: s.phoneNumber,
                            direction: s.direction,
                            messageTimestamp: s.messageTimestamp ? new Date(s.messageTimestamp) : null,
                            policy: s.policy,
                            contentCipher: s.contentCipher,
                            contentIv: s.contentIv,
                            messageTime: new Date(s.messageTime),
                        }))
                    )
                    .onConflictDoNothing({
                        target: [lksguardSmsRecords.deviceId, lksguardSmsRecords.eventUuid],
                    })
                    .returning({ id: lksguardSmsRecords.id })
                inserted += done.length
            }

            if (contacts.length) {
                const done = await db
                    .insert(lksguardContacts)
                    .values(
                        contacts.map((c) => ({
                            contactUuid: c.contactUuid,
                            deviceId,
                            employeeId,
                            contactName: c.contactName,
                            phoneNumber: c.phoneNumber,
                            email: c.email,
                            syncedAt: new Date(),
                        }))
                    )
                    // Contacts are refreshable, not append-only: update the
                    // mutable fields on conflict so a re-sync never duplicates.
                    .onConflictDoUpdate({
                        target: [lksguardContacts.deviceId, lksguardContacts.contactUuid],
                        set: {
                            contactName: sqlContactName(),
                            phoneNumber: sqlContactPhone(),
                            email: sqlContactEmail(),
                            syncedAt: new Date(),
                            updatedAt: new Date(),
                        },
                    })
                    .returning({ id: lksguardContacts.id })
                inserted += done.length
            }

            // Best-effort lastSyncAt bump — never fails the job over a bookkeeping
            // column, so a device-row update error is logged, not thrown.
            try {
                await db
                    .update(lksguardDevices)
                    .set({ lastSyncAt: new Date(), lastSeenAt: new Date() })
                    .where(eq(lksguardDevices.deviceId, deviceId))
            } catch (err: any) {
                console.error('[lksguard-worker] lastSyncAt update failed:', err.message)
            }

            return { inserted }
        },
        { connection, concurrency }
    )

    worker.on('completed', (job) => {
        const result = job.returnvalue as { inserted: number } | undefined
        console.log(
            `[lksguard-worker] device ${job.data.deviceId.slice(0, 8)}: ` +
                `${result?.inserted ?? 0} rows written (${job.id})`
        )
    })

    worker.on('failed', (job, err) => {
        console.error(
            `[lksguard-worker] FAILED ${job?.id ?? '?'} attempt ${job?.attemptsMade ?? '?'}/${
                job?.opts.attempts ?? '?'
            }:`,
            err.message,
            `device=${job?.data.deviceId ?? '?'} calls=${job?.data.calls.length ?? 0} ` +
                `sms=${job?.data.sms.length ?? 0} contacts=${job?.data.contacts.length ?? 0}`
        )
    })

    worker.on('error', (err) => {
        console.error('[lksguard-worker] worker error:', err.message)
    })

    return worker
}

// Contact-update SET values reference the proposed row via Postgres' EXCLUDED
// pseudo-record — "last sync wins" for the mutable fields.
function sqlContactName() {
    return sql`EXCLUDED.contact_name`
}
function sqlContactPhone() {
    return sql`EXCLUDED.phone_number`
}
function sqlContactEmail() {
    return sql`EXCLUDED.email`
}
