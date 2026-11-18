import { redis } from './cache'

/**
 * Redis helpers for Shift Attendance — reuses the shared `redis` connection
 * from services/cache.ts (no new Redis setup).
 *
 * PostgreSQL is always the source of truth:
 * - List cache (`shift-attendance:list:{siteId}:{date|all}`, TTL 5 min) is a
 *   read-through convenience; every read falls back to PG on miss/error.
 * - Create lock (`shift-attendance:create:{siteId}:{date}:{shift}`, NX EX 30s)
 *   only de-dupes double-taps/retries; the PG UNIQUE(site, date, shift)
 *   constraint is the ultimate duplicate guard.
 * - Writes commit to PG first, then best-effort invalidate Redis. A Redis
 *   failure never turns a committed PG row into a reported failure.
 */

const LIST_TTL_SECONDS = 5 * 60
const CREATE_LOCK_SECONDS = 30

const listKey = (siteId: string, date: string) => `shift-attendance:list:${siteId}:${date}`
const createKey = (siteId: string, date: string, shift: string) =>
  `shift-attendance:create:${siteId}:${date}:${shift}`

export async function getShiftListCached(siteId: string, date: string): Promise<any[] | null> {
  try {
    const raw = await redis.get(listKey(siteId, date))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch (err: any) {
    console.error('[shift-cache] get failed:', err?.message ?? err)
    return null
  }
}

export async function setShiftListCached(siteId: string, date: string, rows: any[]): Promise<void> {
  try {
    await redis.set(listKey(siteId, date), JSON.stringify(rows), 'EX', LIST_TTL_SECONDS)
  } catch (err: any) {
    console.error('[shift-cache] set failed:', err?.message ?? err)
  }
}

export async function invalidateShiftList(siteId: string, date: string): Promise<void> {
  try {
    await redis.del(listKey(siteId, date))
  } catch (err: any) {
    console.error('[shift-cache] invalidate failed:', err?.message ?? err)
  }
}

/**
 * Short-lived idempotency guard for concurrent/double-tap creates.
 * Returns true when this caller owns the slot, false when another submit for
 * the same site/date/shift is already in flight.
 * Redis down → true (don't block; PG unique still guards).
 */
export async function acquireShiftCreateLock(siteId: string, date: string, shift: string): Promise<boolean> {
  try {
    const got = await redis.set(createKey(siteId, date, shift), '1', 'EX', CREATE_LOCK_SECONDS, 'NX')
    return got === 'OK'
  } catch (err: any) {
    console.error('[shift-cache] lock acquire failed (allowing):', err?.message ?? err)
    return true
  }
}

export async function releaseShiftCreateLock(siteId: string, date: string, shift: string): Promise<void> {
  try {
    await redis.del(createKey(siteId, date, shift))
  } catch {
    // Auto-expires via EX.
  }
}

// ── FO read-only report cache ──────────────────────────────────────────────
// Key includes the officer id so one FO can never read another's cached rows;
// the site+date suffix lets supervisor writes invalidate precisely. The shift is
// part of the key because a shift-filtered list is a different answer, and two
// requests that differ only by it must never serve each other. Same PG-truth /
// fallback rules as above.

const foListKey = (foId: string, siteId: string, date: string, shift = 'all') =>
  `shift-attendance:fo:${foId}:${siteId}:${date}:${shift}`

export async function getFoShiftListCached(
  foId: string, siteId: string, date: string, shift?: string | null,
): Promise<any[] | null> {
  try {
    const raw = await redis.get(foListKey(foId, siteId, date, shift ?? 'all'))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch (err: any) {
    console.error('[shift-cache] FO get failed, falling back to PG:', err?.message ?? err)
    return null
  }
}

export async function setFoShiftListCached(
  foId: string, siteId: string, date: string, rows: any[], shift?: string | null,
): Promise<void> {
  try {
    await redis.set(
      foListKey(foId, siteId, date, shift ?? 'all'),
      JSON.stringify(rows),
      'EX',
      LIST_TTL_SECONDS,
    )
  } catch (err: any) {
    console.error('[shift-cache] FO set failed (PG remains truth):', err?.message ?? err)
  }
}

/**
 * Admin web report cache: shift-attendance:report:{location}:{site}:{date}:{page}:{limit}
 * (5-min TTL, same PG-truth/fallback contract). Page+limit are part of the key
 * so paged reads never serve each other's slices; the summary is stored with
 * page 1... no — the summary covers the whole filtered set, so it is cached
 * alongside every page payload (small object, no extra round trip).
 */
const reportKey = (location: string, site: string, date: string, page: number, limit: string) =>
  `shift-attendance:report:${location}:${site}:${date}:${page}:${limit}`

export async function getShiftReportCached(
  location: string, site: string, date: string, page: number, limit: string,
): Promise<any | null> {
  try {
    const raw = await redis.get(reportKey(location, site, date, page, limit))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && Array.isArray(parsed.rows) ? parsed : null
  } catch (err: any) {
    console.error('[shift-cache] report get failed, falling back to PG:', err?.message ?? err)
    return null
  }
}

export async function setShiftReportCached(
  location: string, site: string, date: string, page: number, limit: string, payload: any,
): Promise<void> {
  try {
    await redis.set(reportKey(location, site, date, page, limit), JSON.stringify(payload), 'EX', LIST_TTL_SECONDS)
  } catch (err: any) {
    console.error('[shift-cache] report set failed (PG remains truth):', err?.message ?? err)
  }
}

/**
 * Drop all cached web-report pages. Called (best-effort) after any supervisor
 * attendance write — check-in, checkout, mark-incomplete, shift create/update.
 * Writes are rare next to report reads, so a scan is cheaper than tracking
 * which filter combos each writer could affect.
 */
export async function invalidateShiftReportCache(): Promise<void> {
  try {
    const stream = redis.scanStream({ match: 'shift-attendance:report:*', count: 100 })
    const keys: string[] = []
    await new Promise<void>((resolve) => {
      stream.on('data', (batch: string[]) => { keys.push(...batch) })
      stream.on('end', () => resolve())
      stream.on('error', () => resolve())
    })
    if (keys.length > 0) await redis.del(...keys)
  } catch (err: any) {
    console.error('[shift-cache] report invalidate failed:', err?.message ?? err)
  }
}

/**
 * Drop every FO-cached list for one site+date. Called (best-effort) after a
 * supervisor create/update commits — the writer doesn't know which officers
 * cache the site, hence the scan; writes are rare, reads are frequent. Every
 * shift variant of that site+date goes, which is why the pattern ends in `*`.
 */
export async function invalidateFoShiftCache(siteId: string, date: string): Promise<void> {
  await deleteByPattern(`shift-attendance:fo:*:${siteId}:${date}:*`, 'FO invalidate')
}

/**
 * Drop every cached shift list of one viewer, whatever site, date or shift.
 * Called after a CO↔FO assignment change: the CO's authorized site set is what
 * these keys were built from, so a reassignment must be visible on the CO's next
 * request instead of up to five minutes later (§7 asks for "immediately").
 */
export async function invalidateFoShiftCacheForViewer(userId: string): Promise<void> {
  await deleteByPattern(`shift-attendance:fo:${userId}:*`, 'FO viewer invalidate')
}

/** SCAN + DEL by glob. Best-effort: a Redis failure leaves the rows stale for
 * at most the TTL, and PostgreSQL remains the source of truth. */
async function deleteByPattern(match: string, label: string): Promise<void> {
  try {
    const stream = redis.scanStream({ match, count: 100 })
    const keys: string[] = []
    await new Promise<void>((resolve) => {
      stream.on('data', (batch: string[]) => { keys.push(...batch) })
      stream.on('end', () => resolve())
      stream.on('error', () => resolve())
    })
    if (keys.length > 0) await redis.del(...keys)
  } catch (err: any) {
    console.error(`[shift-cache] ${label} failed:`, err?.message ?? err)
  }
}
