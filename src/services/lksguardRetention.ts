import { and, eq, isNotNull, lt } from 'drizzle-orm'

import { db } from '../db'
import {
    appSettings,
    lksguardCallRecords,
    lksguardSmsRecords,
    lksguardContacts,
    lksguardAuditLogs,
} from '../db/schema'

// ── Configurable data retention (#30) ────────────────────────────────────────
// Retention is a policy, not a constant, so every window is read from the
// existing app_settings KV table (the same keys the admin panel edits) rather
// than baked into a deploy. Each sweep is idempotent — deleting rows past the
// cutoff — and safe to run from several instances (a second one simply finds
// zero eligible rows).
//
// SMS has two independent windows: the *content* (the AES blob) is purged on
// the shorter schedule while the *metadata* row (who/when/direction) survives
// on the longer one. Purging content nulls the cipher columns in place rather
// than dropping the row, so the metadata audit trail stays intact.

const KEYS = {
    callsDays: 'lksguard_retention_calls_days',
    smsMetaDays: 'lksguard_retention_sms_meta_days',
    smsContentDays: 'lksguard_retention_sms_content_days',
    contactsDays: 'lksguard_retention_contacts_days',
    auditDays: 'lksguard_retention_audit_days',
} as const

export const DEFAULT_RETENTION_DAYS = 365

/** Read one day-count setting (clamped to a positive integer, else default). */
async function loadDays(key: string, fallback: number): Promise<number> {
    try {
        const [row] = await db
            .select()
            .from(appSettings)
            .where(eq(appSettings.key, key))
        const parsed = row?.value ? Number(row.value) : NaN
        return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback
    } catch {
        return fallback
    }
}

export interface LksGuardRetentionResult {
    callsDeleted: number
    smsDeleted: number
    smsContentCleared: number
    contactsDeleted: number
    auditDeleted: number
}

function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

/**
 * Purge every LKSGuard store past its configured retention window. Reads the
 * current settings fresh each run so an admin change takes effect on the next
 * sweep without a restart. Returns per-store counts purely for the logs.
 */
export async function runLksGuardRetention(): Promise<LksGuardRetentionResult> {
    const [callsDays, smsMetaDays, smsContentDays, contactsDays, auditDays] =
        await Promise.all([
            loadDays(KEYS.callsDays, DEFAULT_RETENTION_DAYS),
            loadDays(KEYS.smsMetaDays, DEFAULT_RETENTION_DAYS),
            loadDays(KEYS.smsContentDays, DEFAULT_RETENTION_DAYS),
            loadDays(KEYS.contactsDays, DEFAULT_RETENTION_DAYS),
            loadDays(KEYS.auditDays, DEFAULT_RETENTION_DAYS),
        ])

    const result: LksGuardRetentionResult = {
        callsDeleted: 0,
        smsDeleted: 0,
        smsContentCleared: 0,
        contactsDeleted: 0,
        auditDeleted: 0,
    }

    // 1. SMS content first — null the cipher on rows still inside the metadata
    //    window but past the content window. Longer content windows than meta
    //    are handled naturally: rows already deleted carry no content anyway.
    const contentCutoff = daysAgo(smsContentDays)
    const cleared = await db
        .update(lksguardSmsRecords)
        .set({ contentCipher: null, contentIv: null, policy: 'SMS_METADATA_ONLY' })
        .where(
            and(
                lt(lksguardSmsRecords.createdAt, contentCutoff),
                isNotNull(lksguardSmsRecords.contentCipher)
            )
        )
        .returning({ id: lksguardSmsRecords.id })
    result.smsContentCleared = cleared.length

    // 2. Whole SMS rows past the metadata window.
    const smsMetaCutoff = daysAgo(smsMetaDays)
    const smsDeleted = await db
        .delete(lksguardSmsRecords)
        .where(lt(lksguardSmsRecords.createdAt, smsMetaCutoff))
        .returning({ id: lksguardSmsRecords.id })
    result.smsDeleted = smsDeleted.length

    // 3. Call records.
    const callsDeleted = await db
        .delete(lksguardCallRecords)
        .where(lt(lksguardCallRecords.createdAt, daysAgo(callsDays)))
        .returning({ id: lksguardCallRecords.id })
    result.callsDeleted = callsDeleted.length

    // 4. Contacts snapshots.
    const contactsDeleted = await db
        .delete(lksguardContacts)
        .where(lt(lksguardContacts.createdAt, daysAgo(contactsDays)))
        .returning({ id: lksguardContacts.id })
    result.contactsDeleted = contactsDeleted.length

    // 5. Audit logs (kept on their own window; the trail outlives the data it
    //    describes but not forever).
    const auditDeleted = await db
        .delete(lksguardAuditLogs)
        .where(lt(lksguardAuditLogs.createdAt, daysAgo(auditDays)))
        .returning({ id: lksguardAuditLogs.id })
    result.auditDeleted = auditDeleted.length

    return result
}

/** Hourly sweeper. Runs immediately on boot, then on the interval. */
export function startLksGuardRetentionScheduler(
    intervalMs = 60 * 60 * 1000
): NodeJS.Timeout {
    const tick = async () => {
        try {
            const r = await runLksGuardRetention()
            const touched =
                r.callsDeleted + r.smsDeleted + r.smsContentCleared + r.contactsDeleted + r.auditDeleted
            if (touched) {
                console.log(
                    `[lksguard/retention] purged calls=${r.callsDeleted} ` +
                    `sms=${r.smsDeleted} smsContentCleared=${r.smsContentCleared} ` +
                    `contacts=${r.contactsDeleted} audit=${r.auditDeleted}`
                )
            }
        } catch (err: any) {
            console.error('[lksguard/retention] sweep failed:', err?.message ?? err)
        }
    }
    void tick()
    return setInterval(() => void tick(), intervalMs)
}

