import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm'

import { db } from '../db'
import {
    appSettings,
    attendanceLogs,
    foVisitEvents,
    trackingSessions,
    visitLocationPoints,
    visits,
} from '../db/schema'
import { clearTrackingCache } from './foTrackingCache'
import { setLastPunchCached, invalidateDaySlots } from './cache'
import { invalidateAttendanceCache } from './employeeAttendanceCache'
import { invalidateShiftReportCache } from './shiftAttendanceCache'
import { istDateKey, istDayEnd } from './attendanceRules'

// ── Server-side maximum duty enforcement ─────────────────────────────────────
// A Field Officer must never stay in an ACTIVE session indefinitely. This
// sweeper finds every session older than the configured max duty period
// (default 10 hours) and closes it — even when the phone is offline, dead,
// or the app was killed. The mobile app cannot be the enforcer: an offline
// phone can never close anything.
//
// Runs on a setInterval in src/index.ts (single instance) and is also safe to
// run from several instances: the UPDATE … WHERE status='active' is the
// atomic claim — the loser finds zero rows and moves on. The latest known GPS
// point becomes the checkout location when one exists.

export const MAX_DUTY_KEY = 'fo_max_duty_hours'
export const DEFAULT_MAX_DUTY_HOURS = 10

/** Configured max duty in hours (app_settings, clamped to 1–24, default 10). */
export async function loadMaxDutyHours(): Promise<number> {
    try {
        const [row] = await db
            .select()
            .from(appSettings)
            .where(eq(appSettings.key, MAX_DUTY_KEY))
        const parsed = row?.value ? Number(row.value) : NaN
        return Number.isFinite(parsed) && parsed >= 1 && parsed <= 24
            ? parsed
            : DEFAULT_MAX_DUTY_HOURS
    } catch {
        return DEFAULT_MAX_DUTY_HOURS
    }
}

export interface AutoCheckoutResult {
    sessionsClosed: number
    visitsClosed: number
    sessionIds: string[]
    /** Attendance days closed by the end-of-day sweep. Only the EOD sweep sets
     * it; the max-duty sweeper leaves it undefined. */
    attendanceDaysClosed?: number
}

/**
 * Close every ACTIVE session older than maxDutyHours. Idempotent: re-running
 * finds nothing to do. Returns what it closed for the logs.
 */
export async function runAutoCheckout(
    maxDutyHours?: number
): Promise<AutoCheckoutResult> {
    const hours = maxDutyHours ?? (await loadMaxDutyHours())
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)

    const stale = await db
        .select()
        .from(trackingSessions)
        .where(
            and(
                eq(trackingSessions.status, 'active'),
                lt(trackingSessions.faceCheckInAt, cutoff),
                // Only Field Officers are governed by the max-duty rule. An
                // Operational Head session is closed instead by the end-of-day
                // (23:59) sweep below, so it must be excluded here — otherwise
                // a long OH day would be auto_max_duty-closed before midnight.
                sql`${trackingSessions.fieldOfficerUserId} IN (SELECT id FROM users WHERE roles @> ARRAY['field_officer']::text[])`
            )
        )

    const result: AutoCheckoutResult = {
        sessionsClosed: 0,
        visitsClosed: 0,
        sessionIds: [],
    }

    for (const session of stale) {
        try {
            // Claim it first: a concurrent sweeper (or the officer's own Face
            // Check-Out racing us) loses here and we skip cleanly.
            const [claimed] = await db
                .update(trackingSessions)
                .set({ status: 'completed', checkoutType: 'auto_max_duty' })
                .where(
                    and(
                        eq(trackingSessions.id, session.id),
                        eq(trackingSessions.status, 'active')
                    )
                )
                .returning({ id: trackingSessions.id })
            if (!claimed) continue

            // Latest known position becomes the checkout location when one
            // exists; otherwise the check-in coordinates stand in.
            // recordedAt (device observation order) is the right key, not
            // createdAt (ingest order — offline catch-ups arrive late).
            const [fix] = await db
                .select({
                    latitude: visitLocationPoints.latitude,
                    longitude: visitLocationPoints.longitude,
                    recordedAt: visitLocationPoints.recordedAt,
                })
                .from(visitLocationPoints)
                .where(eq(visitLocationPoints.trackingSessionId, session.id))
                .orderBy(desc(visitLocationPoints.recordedAt))
                .limit(1)

            const now = new Date()
            const closeLat = fix?.latitude ?? session.faceCheckInLatitude
            const closeLng = fix?.longitude ?? session.faceCheckInLongitude

            await db
                .update(trackingSessions)
                .set({
                    faceCheckOutAt: now,
                    faceCheckOutLatitude: closeLat,
                    faceCheckOutLongitude: closeLng,
                    // No fresh accuracy figure — the point's own accuracy lives
                    // on the point row; NULL here means "not face-verified".
                    faceCheckOutAccuracy: null,
                })
                .where(eq(trackingSessions.id, session.id))

            // Close any still-open site visit of this session the same way.
            const openVisits = await db
                .select()
                .from(visits)
                .where(
                    and(
                        eq(visits.trackingSessionId, session.id),
                        eq(visits.status, 'active')
                    )
                )
            for (const v of openVisits) {
                await db
                    .update(visits)
                    .set({
                        checkOutAt: now,
                        checkOutLatitude: closeLat,
                        checkOutLongitude: closeLng,
                        checkOutSource: 'auto',
                        status: 'completed',
                    })
                    .where(eq(visits.id, v.id))
                result.visitsClosed += 1
            }

            await db.insert(foVisitEvents).values({
                trackingSessionId: session.id,
                visitId: null,
                fieldOfficerUserId: session.fieldOfficerUserId,
                eventType: 'AUTO_MAX_DUTY_CHECKOUT',
                latitude: closeLat,
                longitude: closeLng,
                eventTime: now,
                metadata: {
                    maxDutyHours: hours,
                    checkInAt: session.faceCheckInAt.toISOString(),
                    visitsClosed: openVisits.length,
                },
            })

            try {
                await clearTrackingCache(session.fieldOfficerUserId)
            } catch {
                // Best-effort: a stale cache entry just costs one DB rebuild.
            }

            result.sessionsClosed += 1
            result.sessionIds.push(session.id)
            console.log(
                `[auto-checkout] closed session ${session.id} ` +
                `(officer ${session.fieldOfficerUserId}, ` +
                `checked in ${session.faceCheckInAt.toISOString()}, ` +
                `${openVisits.length} open visit(s))`
            )
        } catch (err: any) {
            console.error(
                `[auto-checkout] failed for session ${session.id}:`,
                err?.message ?? err
            )
        }
    }

    return result
}

/**
 * Start the periodic sweeper. Returns the timer so tests / shutdown can clear
 * it. Runs immediately on boot (a restart must not wait a full interval to
 * close sessions that expired while the server was down) and then every
 * intervalMs.
 */
export function startAutoCheckoutScheduler(
    intervalMs = 15 * 60 * 1000
): NodeJS.Timeout {
    const tick = async () => {
        try {
            const r = await runAutoCheckout()
            if (r.sessionsClosed) {
                console.log(
                    `[auto-checkout] sweep closed ${r.sessionsClosed} session(s), ` +
                    `${r.visitsClosed} visit(s)`
                )
            }
        } catch (err: any) {
            console.error('[auto-checkout] sweep failed:', err?.message ?? err)
        }
    }
    void tick()
    return setInterval(() => void tick(), intervalMs)
}

// ── End-of-day auto check-out (23:59 IST, attendance + both tracking roles) ──
// A working day ends at 23:59 local (IST), and everything opened by the day's
// Face Check-In must end with it. Two things are closed here, in one sweep:
//
//   • the tracking session of a tracking user (Field Officer or Operational
//     Head) who never faced out — for the OH this is the only sweeper that acts
//     on him; for the officer it runs alongside the 10-hour max-duty rule above,
//     and the atomic status='active' claim means whichever fires first closes
//     the session exactly once;
//   • the attendance day of ANY employee who left a check-in as their last
//     punch, so a forgotten check-out stops holding the record open forever
//     (past the 12-hour window the employee cannot close it themselves, and an
//     open day reads as still-present in every report).
//
// Both are pinned to the same 23:59:00 IST instant of the check-in's calendar
// day regardless of when the sweep actually runs, so the 5-minute cadence (or
// server downtime) only delays the write — it never shifts the recorded
// end-of-day, and attendance and tracking of one day can never disagree.
//
// It is also what ties the two together in the first place: the attendance
// punch on Home is what opens and closes a tracking session, so the sweep that
// ends the day has to end both, or the phone would keep recording GPS into a
// finished duty and the payroll row would stay open beside it.

/** Calendar date and end-of-day arithmetic live in attendanceRules, next to the
 * rule that reads them, so the sweep and the punch path can never disagree about
 * when a day ends (`istDateKey`, `istDayEnd`). */

/** How long after a day's 23:59 it may still be closed automatically. A bound,
 * not a convenience: a server that was down for a week must not stampede back
 * through weeks of history writing check-outs nobody punched. Past this window
 * a stale duty is what the admin correction flow (and the closed 12-hour punch
 * window) is for. 48 hours is generous enough to survive an overnight restart
 * or a deploy without leaving a gap. */
const ATT_AUTO_CLOSE_LOOKBACK_MS = 48 * 60 * 60 * 1000

/** Written to attendance_logs.checkout_type — the same token the tracking
 * session gets, so both halves of one punch read alike. */
export const ATTENDANCE_AUTO_CHECKOUT_TYPE = 'auto_checkout'

/**
 * Close every attendance day its employee left open: a check-in that is still
 * the day's last punch, with no check-out and no incomplete mark on it.
 *
 * `onlyEmployeeId` narrows the scan to one employee. The punch path uses that:
 * an employee whose LAST duty belongs to an earlier day is auto-closed by the
 * same rule and the same write as the sweep, right before his new punch is
 * judged, so he never has to punch a check-out that belongs to yesterday.
 *
 * The row is written with the day's own 23:59 IST instant as created_at rather
 * than the sweep's running time, because that instant IS when the duty ended —
 * and it keeps the row inside the day the grouping reports read from (they work
 * off created_at / attendance_date, not off a metadata field).
 *
 * Deliberately NOT closed: a duty whose site already carries a check-out but
 * ends on a later check-in (a double punch at the same site on the same day).
 * The partial unique index att_logs_checkout_once_idx permits exactly one
 * check-out per employee + day + SITE, so a second one cannot be written — and
 * inventing a row by deleting or rewriting the real punch would falsify an
 * honest one. Those days are logged as skips so they surface for correction
 * instead of failing quietly.
 *
 * Because of that index the "is it already closed?" test has to be per SITE and
 * not per day: an officer who worked site A and then site B in one day has a
 * check-out on the day (at A), and a day-wide test would leave his duty at B
 * open forever — unread as closed in every report, and refused a fresh check-in
 * the next morning. The "is this the last punch?" test stays day-wide, which is
 * what makes a cross-site check-out (in at A, out at B) need no auto-close at A
 * at all: B's punch is later, so A is already faced out as far as the day goes.
 *
 * Returns how many days were closed.
 */
async function closeOpenAttendanceDays(now: Date, onlyEmployeeId?: string): Promise<number> {
    // Wider bound than the real window below: this only keeps the scan on the
    // employee/date index, and the exact IST arithmetic stays in one place.
    const scanFrom = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000)

    const candidates = await db
        .select({
            employeeId: attendanceLogs.employeeId,
            attendanceDate: attendanceLogs.attendanceDate,
            siteId: attendanceLogs.siteId,
            checkInAt: attendanceLogs.createdAt,
        })
        .from(attendanceLogs)
        .where(
            and(
                ...(onlyEmployeeId ? [eq(attendanceLogs.employeeId, onlyEmployeeId)] : []),
                eq(attendanceLogs.action, 'check-in'),
                // Rows without a logical day predate the column; reports already
                // fall back to DATE(created_at) for them, so leave them alone.
                isNotNull(attendanceLogs.attendanceDate),
                // A supervisor's INCOMPLETE closure is a decision about that day,
                // not a forgotten check-out — closing it would overwrite it.
                isNull(attendanceLogs.incompleteReason),
                gte(attendanceLogs.createdAt, scanFrom),
                // This check-in is the day's LAST punch of either kind: if the
                // employee did face out later, the day is genuinely closed.
                sql`NOT EXISTS (
                        SELECT 1 FROM attendance_logs newer
                        WHERE newer.employee_id = ${attendanceLogs.employeeId}
                          AND newer.attendance_date IS NOT DISTINCT FROM ${attendanceLogs.attendanceDate}
                          AND newer.created_at > ${attendanceLogs.createdAt}
                      )`,
                sql`NOT EXISTS (
                        SELECT 1 FROM attendance_logs co
                        WHERE co.employee_id = ${attendanceLogs.employeeId}
                          AND co.attendance_date IS NOT DISTINCT FROM ${attendanceLogs.attendanceDate}
                          AND co.action = 'check-out'
                          AND co.site_id IS NOT DISTINCT FROM ${attendanceLogs.siteId}
                      )`
            )
        )

    let closed = 0

    for (const row of candidates) {
        const checkoutAt = istDayEnd(istDateKey(row.checkInAt))
        if (now < checkoutAt) continue
        if (now.getTime() - checkoutAt.getTime() > ATT_AUTO_CLOSE_LOOKBACK_MS) {
            console.log(
                `[eod-checkout] attendance day ${row.attendanceDate} of employee ` +
                `${row.employeeId} is older than the auto-close window — left for correction`
            )
            continue
        }

        try {
            // ON CONFLICT DO NOTHING covers the partial unique index: a sweep
            // that races itself, a manual check-out landing between the read and
            // the write, or a re-run after a restart all become no-ops instead
            // of errors.
            const [inserted] = await db
                .insert(attendanceLogs)
                .values({
                    employeeId: row.employeeId,
                    action: 'check-out',
                    // Copied from the check-in so the pair belongs to the same
                    // day and the same site the employee punched at.
                    siteId: row.siteId,
                    attendanceDate: row.attendanceDate,
                    // The pinned end-of-day, not the DB clock default.
                    createdAt: checkoutAt,
                    checkoutType: ATTENDANCE_AUTO_CHECKOUT_TYPE,
                    // Nothing may be claimed about a punch that never happened:
                    // no face distance, no method, no handset, no fix.
                    faceDistance: null,
                    attendanceMethod: null,
                    deviceInfo: null,
                    supervisorId: null,
                    geoLat: null,
                    geoLng: null,
                })
                .onConflictDoNothing()
                .returning({ id: attendanceLogs.id })
            if (!inserted) continue

            closed += 1

            try {
                // Re-read from Postgres instead of assuming this row is newest:
                // the employee may already have checked in again for the next
                // day by the time the sweep runs, and caching a yesterday
                // check-out over that would show them checked-out while they are
                // on duty.
                const [latest] = await db
                    .select({
                        action: attendanceLogs.action,
                        createdAt: attendanceLogs.createdAt,
                        siteId: attendanceLogs.siteId,
                    })
                    .from(attendanceLogs)
                    .where(eq(attendanceLogs.employeeId, row.employeeId))
                    .orderBy(desc(attendanceLogs.createdAt))
                    .limit(1)
                if (latest) await setLastPunchCached(row.employeeId, latest)
                if (row.siteId && typeof row.attendanceDate === 'string') {
                    await invalidateAttendanceCache(row.siteId, row.attendanceDate)
                }
                if (typeof row.attendanceDate === 'string') {
                    // The auto-check-out filled that site's slot. Punch-path
                    // reservations are written optimistically, so drop the day's
                    // map and let the next read rebuild it from these rows. The
                    // key is the IST day the CHECK-IN belonged to, which is the
                    // day the officer's punch reserved its slot under.
                    await invalidateDaySlots(row.employeeId, istDateKey(row.checkInAt))
                }
            } catch {
                // Cache-only: Postgres is the truth and the next read re-primes.
            }

            console.log(
                `[eod-checkout] closed attendance day ${row.attendanceDate} of ` +
                `employee ${row.employeeId} (checked in ${row.checkInAt.toISOString()}, ` +
                `check-out pinned to ${checkoutAt.toISOString()})`
            )
        } catch (err: any) {
            console.error(
                `[eod-checkout] attendance close failed for employee ${row.employeeId} ` +
                `day ${row.attendanceDate}:`,
                err?.message ?? err
            )
        }
    }

    return closed
}

/**
 * Close THIS employee's open duties from earlier days, pinned to each day's own
 * 23:59 IST — the end-of-day sweep's rule and write, applied on demand from the
 * punch path so no employee action is needed. Idempotent for the same reasons
 * the sweep is (the NOT EXISTS read, plus ON CONFLICT on the one-check-out-per-
 * day index), and returns how many days it closed: 0 is a normal answer, either
 * because nothing was open or because the day already carries a check-out and
 * the index forbids a second one — in which case attendanceRules already treats
 * that duty as ended, and the punch goes through.
 */
export function autoCloseAttendanceDutiesForEmployee(
    employeeId: string,
    now: Date = new Date()
): Promise<number> {
    return closeOpenAttendanceDays(now, employeeId).then(async (closed) => {
        if (closed > 0) {
            // The web shift report embeds attendance state; the sweep drops it
            // on a close and so must this, or the grid shows a duty that has
            // just been closed as still open until the report cache expires.
            await invalidateShiftReportCache()
        }
        return closed
    })
}

/**
 * Run the end-of-day sweep: close every ACTIVE tracking session (Field Officer
 * or Operational Head) and every open attendance day whose check-in day has
 * already passed 23:59 IST. Idempotent — the status='active' claim on the
 * session, the NOT EXISTS read plus the one-check-out-per-day index on the
 * attendance row. Returns what it closed for the logs.
 */
export async function runEodCheckout(): Promise<AutoCheckoutResult> {
    const now = new Date()

    // Active sessions owned by a user carrying either tracking role — the same
    // pair the mobile engine gates on (TRACKING_ROLES). The small active set
    // makes the per-row day comparison cheap; no index needed.
    const active = await db
        .select()
        .from(trackingSessions)
        .where(
            and(
                eq(trackingSessions.status, 'active'),
                sql`${trackingSessions.fieldOfficerUserId} IN (SELECT id FROM users WHERE roles && ARRAY['oh','field_officer']::text[])`
            )
        )

    const result: AutoCheckoutResult = {
        sessionsClosed: 0,
        visitsClosed: 0,
        sessionIds: [],
        attendanceDaysClosed: 0,
    }

    for (const session of active) {
        // Only once that day's 23:59 IST has elapsed.
        const checkoutAt = istDayEnd(istDateKey(session.faceCheckInAt))
        if (now < checkoutAt) continue

        try {
            // Claim it: a concurrent sweeper or the officer's own Face
            // Check-Out racing us loses here and we skip cleanly.
            const [claimed] = await db
                .update(trackingSessions)
                .set({ status: 'completed', checkoutType: 'auto_checkout' })
                .where(
                    and(
                        eq(trackingSessions.id, session.id),
                        eq(trackingSessions.status, 'active')
                    )
                )
                .returning({ id: trackingSessions.id })
            if (!claimed) continue

            // Latest known position becomes the checkout location when one
            // exists (recordedAt = device observation order, not ingest order).
            const [fix] = await db
                .select({
                    latitude: visitLocationPoints.latitude,
                    longitude: visitLocationPoints.longitude,
                })
                .from(visitLocationPoints)
                .where(eq(visitLocationPoints.trackingSessionId, session.id))
                .orderBy(desc(visitLocationPoints.recordedAt))
                .limit(1)

            const closeLat = fix?.latitude ?? session.faceCheckInLatitude
            const closeLng = fix?.longitude ?? session.faceCheckInLongitude

            await db
                .update(trackingSessions)
                .set({
                    faceCheckOutAt: checkoutAt,
                    faceCheckOutLatitude: closeLat,
                    faceCheckOutLongitude: closeLng,
                    faceCheckOutAccuracy: null,
                })
                .where(eq(trackingSessions.id, session.id))

            const openVisits = await db
                .select()
                .from(visits)
                .where(
                    and(
                        eq(visits.trackingSessionId, session.id),
                        eq(visits.status, 'active')
                    )
                )
            for (const v of openVisits) {
                await db
                    .update(visits)
                    .set({
                        checkOutAt: checkoutAt,
                        checkOutLatitude: closeLat,
                        checkOutLongitude: closeLng,
                        checkOutSource: 'auto',
                        status: 'completed',
                    })
                    .where(eq(visits.id, v.id))
                result.visitsClosed += 1
            }

            await db.insert(foVisitEvents).values({
                trackingSessionId: session.id,
                visitId: null,
                fieldOfficerUserId: session.fieldOfficerUserId,
                eventType: 'AUTO_CHECKOUT',
                latitude: closeLat,
                longitude: closeLng,
                eventTime: checkoutAt,
                metadata: {
                    reason: 'end_of_day',
                    checkInAt: session.faceCheckInAt.toISOString(),
                    visitsClosed: openVisits.length,
                },
            })

            try {
                await clearTrackingCache(session.fieldOfficerUserId)
            } catch {
                // Best-effort: a stale cache entry just costs one DB rebuild.
            }

            result.sessionsClosed += 1
            result.sessionIds.push(session.id)
            console.log(
                `[eod-checkout] closed session ${session.id} ` +
                `(tracking user ${session.fieldOfficerUserId}, checked in ` +
                `${session.faceCheckInAt.toISOString()}, pinned to ` +
                `${checkoutAt.toISOString()}, ${openVisits.length} open visit(s))`
            )
        } catch (err: any) {
            console.error(
                `[eod-checkout] failed for session ${session.id}:`,
                err?.message ?? err
            )
        }
    }

    // Attendance half of the same day, after the sessions: an employee who
    // never faced out gets a check-out pinned to the very same 23:59 IST
    // instant, so the payroll row and the tracking of one day always end
    // together. Its own failures must not stop the session sweep above, and a
    // session sweep throwing must not skip this — hence its own try.
    try {
        result.attendanceDaysClosed = await closeOpenAttendanceDays(now)
        if (result.attendanceDaysClosed > 0) {
            // The web shift report embeds attendance state; the punch paths
            // drop it on every write, and so must this.
            await invalidateShiftReportCache()
        }
    } catch (err: any) {
        console.error('[eod-checkout] attendance sweep failed:', err?.message ?? err)
    }

    return result
}

/**
 * Start the periodic end-of-day sweeper. Runs immediately on boot (a
 * restart must not wait a full interval to close a session or an open
 * attendance day that crossed midnight while the server was down) and then
 * every intervalMs. A 5-minute cadence keeps the close timely; the stored
 * checkout time is pinned to 23:59:00 regardless, so cadence never shifts the
 * recorded end-of-day.
 */
export function startEodCheckoutScheduler(
    intervalMs = 5 * 60 * 1000
): NodeJS.Timeout {
    const tick = async () => {
        try {
            const r = await runEodCheckout()
            if (r.sessionsClosed || r.visitsClosed || r.attendanceDaysClosed) {
                console.log(
                    `[eod-checkout] sweep closed ${r.sessionsClosed} session(s), ` +
                    `${r.visitsClosed} visit(s), ${r.attendanceDaysClosed ?? 0} attendance day(s)`
                )
            }
        } catch (err: any) {
            console.error('[eod-checkout] sweep failed:', err?.message ?? err)
        }
    }
    void tick()
    return setInterval(() => void tick(), intervalMs)
}
