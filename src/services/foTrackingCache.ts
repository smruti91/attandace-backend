import { redis } from './cache'

/**
 * Redis state for the Field Officer tracking-session flow.
 *
 * Postgres stays the permanent source of truth; these keys exist so every
 * ~5-minute GPS batch can be geofenced without touching the database:
 *
 *   FO:{userId}:sites    — assigned sites with coordinates + radius (JSON)
 *   FO:{userId}:session  — the open tracking session, if any (JSON)
 *   FO:{userId}:site     — the currently-entered site + streak counters (JSON)
 *
 * Every key carries a TTL and every read rebuilds from Postgres on a miss, so
 * a Redis restart or eviction degrades to one slower batch, never to wrong
 * answers. Face Check-Out deletes all three.
 */

const TTL_SECONDS = 24 * 60 * 60

const sitesKey = (userId: string) => `FO:${userId}:sites`
const sessionKey = (userId: string) => `FO:${userId}:session`
const siteKey = (userId: string) => `FO:${userId}:site`

/** One assigned site, enough to geofence a fix with zero DB reads. */
export interface CachedSite {
    siteId: string
    siteName: string
    latitude: number
    longitude: number
    /** Entry radius, metres — the admin-set fence. */
    radius: number
}

export interface CachedSession {
    sessionId: string
    startedAt: string // ISO
}

export interface CachedActiveSite {
    siteId: string
    visitId: string
    enteredAt: string // ISO
    /** Consecutive outside-fence observations (exit debouncing). */
    outsideStreak: number
    lastInsideAt: string // ISO
    /** First outside-fence observation — the honest checkout moment. Null
     * until the officer is actually seen outside. Carries its own fix so the
     * checkout stamp uses a real observation, never an interpolated time. */
    firstOutside: {
        at: string // ISO
        latitude: number
        longitude: number
        accuracy: number | null
    } | null
}

async function read<T>(key: string): Promise<T | null> {
    try {
        const raw = await redis.get(key)
        if (!raw) return null
        return JSON.parse(raw) as T
    } catch {
        return null
    }
}

async function write(key: string, value: unknown): Promise<void> {
    await redis.set(key, JSON.stringify(value), 'EX', TTL_SECONDS)
}

export async function getCachedSites(userId: string): Promise<CachedSite[] | null> {
    const sites = await read<CachedSite[]>(sitesKey(userId))
    return sites && sites.length ? sites : null
}

export async function setCachedSites(userId: string, sites: CachedSite[]): Promise<void> {
    await write(sitesKey(userId), sites)
}

export async function getCachedSession(userId: string): Promise<CachedSession | null> {
    return read<CachedSession>(sessionKey(userId))
}

export async function setCachedSession(userId: string, session: CachedSession): Promise<void> {
    await write(sessionKey(userId), session)
}

/** Refresh the TTL without rewriting — called on every accepted batch. */
export async function touchSession(userId: string): Promise<void> {
    try {
        await redis.expire(sessionKey(userId), TTL_SECONDS)
        await redis.expire(siteKey(userId), TTL_SECONDS)
        await redis.expire(sitesKey(userId), TTL_SECONDS)
    } catch {
        // Best-effort: an expired key simply rebuilds from Postgres next time.
    }
}

export async function getCachedActiveSite(userId: string): Promise<CachedActiveSite | null> {
    return read<CachedActiveSite>(siteKey(userId))
}

export async function setCachedActiveSite(
    userId: string,
    active: CachedActiveSite | null
): Promise<void> {
    if (!active) {
        try {
            await redis.del(siteKey(userId))
        } catch {
            // Best-effort.
        }
        return
    }
    await write(siteKey(userId), active)
}

/** Face Check-Out: drop every tracking key for the officer. */
export async function clearTrackingCache(userId: string): Promise<void> {
    try {
        await redis.del(sitesKey(userId), sessionKey(userId), siteKey(userId))
    } catch (err: any) {
        console.error('[fo-cache] clear failed:', err.message)
    }
}

/**
 * Drop only the cached site list for an officer, leaving any live session/site
 * keys intact. Called when an admin approves new coordinates for a site: the
 * next GPS batch rebuilds `FO:{userId}:sites` from Postgres and geofences
 * against the freshly approved position, so stale coordinates never persist
 * past an approval.
 */
export async function clearSitesCacheOnly(userId: string): Promise<void> {
    try {
        await redis.del(sitesKey(userId))
    } catch (err: any) {
        console.error('[fo-cache] sites clear failed:', err.message)
    }
}
