import { redis } from './cache'
import { db } from '../db'
import { employeeSites, usersTable } from '../db/schema'
import { eq } from 'drizzle-orm'

/**
 * Redis helpers for Supervisor → Employees Attendance — reuses the shared
 * `redis` connection from services/cache.ts (no new Redis setup, no duplicate
 * configuration).
 *
 * PostgreSQL is always the source of truth:
 * - `attendance:cache:{siteId}:{date}` (TTL 5 min) — read-through list cache
 *   for the team grid. Every read falls back to PG on miss/error; writes
 *   invalidate after the PG-affecting step succeeds (enqueue accepted).
 *   Countdown fields (minutesRemaining) can lag up to the TTL — the next
 *   refresh re-reads PG, and check-out gating is re-evaluated server-side.
 * - `supervisor:employees:{supervisorId}:{siteId}` (TTL 5 min) — roster slice
 *   (assignment, not attendance). Invalidated when assignments change; expiry
 *   bounds any staleness. Never cached indefinitely.
 * - `attendance:checkin:{employeeId}:{date}:{siteId}` /
 *   `attendance:checkout:{employeeId}:{date}:{siteId}` (NX EX 30s) —
 *   date-scoped idempotency against double-taps/retries/races. The PG partial
 *   unique indexes (one check-in / one check-out per employee+date+site) are
 *   the ultimate duplicate guard; Redis down → allow through (PG still guards).
 *
 * No auth secrets or face embeddings are stored under these keys.
 */

const LIST_TTL_SECONDS = 5 * 60
const ROSTER_TTL_SECONDS = 5 * 60
const LOCK_SECONDS = 30

// v2: enriched rows carry the 4-state status + incomplete audit fields.
const listKey = (siteId: string, date: string) => `attendance:cache:v2:${siteId}:${date}`
const rosterKey = (supervisorId: string, siteId: string) => `supervisor:employees:${supervisorId}:${siteId}`
const checkinKey = (employeeId: string, date: string, siteId: string) =>
  `attendance:checkin:${employeeId}:${date}:${siteId}`
const checkoutKey = (employeeId: string, date: string, siteId: string) =>
  `attendance:checkout:${employeeId}:${date}:${siteId}`

// ── Attendance list cache ─────────────────────────────────────────────────

export async function getAttendanceListCached(siteId: string, date: string): Promise<any[] | null> {
  try {
    const raw = await redis.get(listKey(siteId, date))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch (err: any) {
    console.error('[attendance-cache] get failed, falling back to PG:', err?.message ?? err)
    return null
  }
}

export async function setAttendanceListCached(siteId: string, date: string, rows: any[]): Promise<void> {
  try {
    await redis.set(listKey(siteId, date), JSON.stringify(rows), 'EX', LIST_TTL_SECONDS)
  } catch (err: any) {
    console.error('[attendance-cache] set failed (PG remains truth):', err?.message ?? err)
  }
}

/** Invalidate after check-in/checkout. Best-effort: never fails the request. */
export async function invalidateAttendanceCache(siteId: string, date: string): Promise<void> {
  try {
    await redis.del(listKey(siteId, date))
  } catch (err: any) {
    console.error('[attendance-cache] invalidate failed:', err?.message ?? err)
  }
}

// ── Employee-list (roster) cache ──────────────────────────────────────────

export async function getRosterCached(supervisorId: string, siteId: string): Promise<any[] | null> {
  try {
    const raw = await redis.get(rosterKey(supervisorId, siteId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch (err: any) {
    console.error('[attendance-cache] roster get failed, falling back to PG:', err?.message ?? err)
    return null
  }
}

export async function setRosterCached(supervisorId: string, siteId: string, rows: any[]): Promise<void> {
  try {
    await redis.set(rosterKey(supervisorId, siteId), JSON.stringify(rows), 'EX', ROSTER_TTL_SECONDS)
  } catch (err: any) {
    console.error('[attendance-cache] roster set failed (PG remains truth):', err?.message ?? err)
  }
}

/**
 * Called when employee↔site assignments change (assign/register/update).
 * Resolves the supervisors posted to `siteId` and drops their roster slices
 * plus the site's attendance list keys. Assignment edits are rare admin ops,
 * so a precise lookup + targeted dels beats a broad key scan.
 */
export async function invalidateRosterForSite(siteId: string): Promise<void> {
  try {
    const supUsers = await db
      .select({ userId: usersTable.id })
      .from(usersTable)
      .innerJoin(employeeSites, eq(employeeSites.employeeId, usersTable.employeeId))
      .where(eq(employeeSites.siteId, siteId))
    const keys = supUsers.map((u) => rosterKey(u.userId, siteId))
    if (keys.length > 0) await redis.del(...keys)
    // Attendance lists embed the roster — drop this site's cached days.
    const stream = redis.scanStream({ match: `attendance:cache:*:${siteId}:*`, count: 100 })
    const dayKeys: string[] = []
    await new Promise<void>((resolve) => {
      stream.on('data', (batch: string[]) => { dayKeys.push(...batch) })
      stream.on('end', () => resolve())
      stream.on('error', () => resolve())
    })
    if (dayKeys.length > 0) await redis.del(...dayKeys)
  } catch (err: any) {
    console.error('[attendance-cache] roster invalidate failed:', err?.message ?? err)
  }
}

// ── Incomplete-mark idempotency lock ────────────────────────────────────────
// Keyed by employee+date+site like the checkin/checkout locks (identifies the
// attendance as precisely as an attendanceId would). PG transaction is the
// final guard; Redis down → allow through.

const incompleteKey = (employeeId: string, date: string, siteId: string) =>
  `attendance:incomplete:${employeeId}:${date}:${siteId}`

export async function acquireIncompleteLock(employeeId: string, date: string, siteId: string): Promise<boolean> {
  try {
    const got = await redis.set(incompleteKey(employeeId, date, siteId), '1', 'EX', LOCK_SECONDS, 'NX')
    return got === 'OK'
  } catch (err: any) {
    console.error('[attendance-cache] incomplete lock acquire failed (allowing):', err?.message ?? err)
    return true
  }
}

export async function releaseIncompleteLock(employeeId: string, date: string, siteId: string): Promise<void> {
  try {
    await redis.del(incompleteKey(employeeId, date, siteId))
  } catch {
    // Auto-expires via EX.
  }
}

// ── Check-in / checkout idempotency locks ─────────────────────────────────
// Redis down → true (allow through; PG unique constraint still guards).

export async function acquireCheckinLock(employeeId: string, date: string, siteId: string): Promise<boolean> {
  try {
    const got = await redis.set(checkinKey(employeeId, date, siteId), '1', 'EX', LOCK_SECONDS, 'NX')
    return got === 'OK'
  } catch (err: any) {
    console.error('[attendance-cache] checkin lock acquire failed (allowing):', err?.message ?? err)
    return true
  }
}

export async function releaseCheckinLock(employeeId: string, date: string, siteId: string): Promise<void> {
  try {
    await redis.del(checkinKey(employeeId, date, siteId))
  } catch {
    // Auto-expires via EX.
  }
}

export async function acquireCheckoutLock(employeeId: string, date: string, siteId: string): Promise<boolean> {
  try {
    const got = await redis.set(checkoutKey(employeeId, date, siteId), '1', 'EX', LOCK_SECONDS, 'NX')
    return got === 'OK'
  } catch (err: any) {
    console.error('[attendance-cache] checkout lock acquire failed (allowing):', err?.message ?? err)
    return true
  }
}

export async function releaseCheckoutLock(employeeId: string, date: string, siteId: string): Promise<void> {
  try {
    await redis.del(checkoutKey(employeeId, date, siteId))
  } catch {
    // Auto-expires via EX.
  }
}
