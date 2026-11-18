import { redis } from './cache'

/**
 * Redis helpers for the officer-scoped Employee/Shift Attendance reports
 * (Circle Officer + Field Officer). Reuses the shared `redis` connection from
 * services/cache.ts — no new Redis setup.
 *
 * PostgreSQL is the source of truth; this is a 5-minute read-through only, and
 * every read/write degrades to PG on any Redis error so the report never fails
 * for cache reasons. The key ALWAYS includes the officer user id, so one
 * officer can never be served another officer's scope-filtered rows.
 *
 * Every other segment is one of the report's filters, because each filter
 * changes the answer: two requests differing only by Field Officer, status,
 * page or page size must never serve each other. Filters are passed as one
 * object rather than positional arguments so a future filter cannot be silently
 * inserted into the wrong slot of the key.
 *
 * The lag after a supervisor write is bounded by the TTL — acceptable for a
 * read-only report (same tolerance the supervisor team grid already has). A CO
 * assignment change is NOT left to the TTL; `clearOfficerAttCacheForUser` drops
 * that viewer's rows the moment an assignment is written.
 */

const TTL_SECONDS = 5 * 60

export interface OfficerAttCacheFilters {
  locationId?: string | null
  siteId?: string | null
  shift?: string | null
  foUserId?: string | null
  status?: string | null
  date: string
  page: number
  pageSize: string
}

const key = (userId: string, f: OfficerAttCacheFilters) =>
  `officer:att:${userId}:${f.locationId ?? 'all'}:${f.siteId ?? 'all'}:${f.shift ?? 'all'}` +
  `:${f.foUserId ?? 'all'}:${f.status ?? 'all'}:${f.date}:${f.page}:${f.pageSize}`

export async function getOfficerAttCached(
  userId: string,
  filters: OfficerAttCacheFilters,
): Promise<any | null> {
  try {
    const raw = await redis.get(key(userId, filters))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && Array.isArray(parsed.rows) ? parsed : null
  } catch (err: any) {
    console.error('[officer-att-cache] get failed, falling back to PG:', err?.message ?? err)
    return null
  }
}

export async function setOfficerAttCached(
  userId: string,
  filters: OfficerAttCacheFilters,
  payload: any,
): Promise<void> {
  try {
    await redis.set(key(userId, filters), JSON.stringify(payload), 'EX', TTL_SECONDS)
  } catch (err: any) {
    console.error('[officer-att-cache] set failed (PG remains truth):', err?.message ?? err)
  }
}

/**
 * Drop every cached report page of one viewer — whatever site, date, shift or
 * field-officer filter built it. Called after a CO↔FO assignment change, since
 * that list of officers IS the viewer's authorization boundary and a
 * reassignment has to show on the CO's next request instead of up to five
 * minutes later. Best-effort: a Redis failure leaves rows stale until the TTL
 * and never changes what PostgreSQL itself reports.
 */
export async function clearOfficerAttCacheForUser(userId: string): Promise<void> {
  try {
    const stream = redis.scanStream({ match: `officer:att:${userId}:*`, count: 100 })
    const keys: string[] = []
    await new Promise<void>((resolve) => {
      stream.on('data', (batch: string[]) => { keys.push(...batch) })
      stream.on('end', () => resolve())
      stream.on('error', () => resolve())
    })
    if (keys.length > 0) await redis.del(...keys)
  } catch (err: any) {
    console.error('[officer-att-cache] viewer clear failed:', err?.message ?? err)
  }
}
