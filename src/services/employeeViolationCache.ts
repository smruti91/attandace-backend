import { redis } from './cache'

/**
 * Redis helpers for Employee Violation reports — reuses the shared `redis`
 * connection from services/cache.ts (no new Redis setup).
 *
 * PostgreSQL is always the source of truth:
 * - `violations:report:{location}:{site}:{date}:{page}:{limit}` (TTL 5 min)
 *   caches admin web-report pages; every read falls back to PG on miss/error.
 * - `violation:create:{supervisorId}:{employeeId}` (NX EX 30s) de-dupes
 *   double-tap submits. There is deliberately no PG unique key (repeat
 *   violations against one employee are legitimate), so this lock plus the
 *   disabled Submit button is the double-submit protection — never the
 *   correctness layer for anything else.
 *
 * A Redis failure never loses a violation: writes commit to PG first, and
 * cache operations are best-effort around them.
 */

const REPORT_TTL_SECONDS = 5 * 60
const CREATE_LOCK_SECONDS = 30

const reportKey = (location: string, site: string, date: string, page: number, limit: string) =>
  `violations:report:${location}:${site}:${date}:${page}:${limit}`
const createKey = (supervisorId: string, employeeId: string) =>
  `violation:create:${supervisorId}:${employeeId}`

export async function getViolationReportCached(
  location: string, site: string, date: string, page: number, limit: string,
): Promise<any | null> {
  try {
    const raw = await redis.get(reportKey(location, site, date, page, limit))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && Array.isArray(parsed.rows) ? parsed : null
  } catch (err: any) {
    console.error('[violation-cache] report get failed, falling back to PG:', err?.message ?? err)
    return null
  }
}

export async function setViolationReportCached(
  location: string, site: string, date: string, page: number, limit: string, payload: any,
): Promise<void> {
  try {
    await redis.set(reportKey(location, site, date, page, limit), JSON.stringify(payload), 'EX', REPORT_TTL_SECONDS)
  } catch (err: any) {
    console.error('[violation-cache] report set failed (PG remains truth):', err?.message ?? err)
  }
}

/**
 * Drop all cached violation-report pages. Called (best-effort) after a
 * violation insert commits — writes are rare next to report reads.
 */
export async function invalidateViolationReportCache(): Promise<void> {
  try {
    const stream = redis.scanStream({ match: 'violations:report:*', count: 100 })
    const keys: string[] = []
    await new Promise<void>((resolve) => {
      stream.on('data', (batch: string[]) => { keys.push(...batch) })
      stream.on('end', () => resolve())
      stream.on('error', () => resolve())
    })
    if (keys.length > 0) await redis.del(...keys)
  } catch (err: any) {
    console.error('[violation-cache] report invalidate failed:', err?.message ?? err)
  }
}

export async function acquireViolationCreateLock(supervisorId: string, employeeId: string): Promise<boolean> {
  try {
    const got = await redis.set(createKey(supervisorId, employeeId), '1', 'EX', CREATE_LOCK_SECONDS, 'NX')
    return got === 'OK'
  } catch (err: any) {
    console.error('[violation-cache] create lock acquire failed (allowing):', err?.message ?? err)
    return true
  }
}

export async function releaseViolationCreateLock(supervisorId: string, employeeId: string): Promise<void> {
  try {
    await redis.del(createKey(supervisorId, employeeId))
  } catch {
    // Auto-expires via EX.
  }
}
