import Redis from 'ioredis'
import type { LastPunch } from './attendanceRules'

/**
 * Redis cache for the hot attendance path.
 *
 * At 10k employees / 500 concurrent punches, every check-in used to mean:
 * users table lookup → employees row (with a 512-float embedding) → last
 * punch query. All of that now comes from Redis; Postgres is only hit on a
 * cache miss (then the cache is re-primed) and by the BullMQ worker that
 * writes the punch rows.
 *
 * Keys:
 *   sess:emp:{employeeId}  — profile blob incl. faceEmbedding   (TTL 7 days)
 *   sess:uid:{userId}      — userId → employeeId mapping        (TTL 7 days)
 *   punch:last:{employeeId}- the employee's most recent punch
 *   punch:day:{employeeId}:{date} — what each site of that day already holds
 *
 * `punch:last` is written SYNCHRONOUSLY when a punch is accepted and queued.
 * The attendance row itself lands in Postgres moments later via the worker,
 * so the database cannot be the source of truth for "what was the last
 * punch" during that gap — without this key, a double-tap inside the gap
 * would pass rule evaluation against stale data and enqueue twice.
 */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

// Shared connection for plain GET/SET. BullMQ gets its own connections (it
// requires maxRetriesPerRequest: null on blocking ones).
export const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true, // buffer commands through brief disconnects
})

redis.on('error', (err) => console.error('[redis]', err.message))

const USER_TTL_SECONDS = 7 * 24 * 60 * 60

/** Everything a punch needs, cached at login and refreshed on face updates. */
export interface CachedUser {
    userId: string
    employeeId: string
    phone: string
    roles: string[]
    firstName: string
    lastName: string
    department: string | null
    designation: string | null
    hasRegisteredFace: boolean
    faceEmbedding: number[] | null
}

const empKey = (employeeId: string) => `sess:emp:${employeeId}`
const uidKey = (userId: string) => `sess:uid:${userId}`
const punchKey = (employeeId: string) => `punch:last:${employeeId}`

/** Prime both keys. Failures are swallowed — Redis being down must never block sign-in. */
export async function cacheUser(user: CachedUser): Promise<void> {
    try {
        await redis.set(uidKey(user.userId), user.employeeId, 'EX', USER_TTL_SECONDS)
        await redis.set(empKey(user.employeeId), JSON.stringify(user), 'EX', USER_TTL_SECONDS)
    } catch (err: any) {
        console.error('[cache] cacheUser failed:', err.message)
    }
}

/** userId → CachedUser | null. */
export async function getCachedUserByUserId(userId: string): Promise<CachedUser | null> {
    try {
        const employeeId = await redis.get(uidKey(userId))
        if (!employeeId) return null
        return getCachedUserByEmployeeId(employeeId)
    } catch {
        return null
    }
}

/** employeeId → CachedUser | null. */
export async function getCachedUserByEmployeeId(employeeId: string): Promise<CachedUser | null> {
    try {
        const raw = await redis.get(empKey(employeeId))
        return raw ? (JSON.parse(raw) as CachedUser) : null
    } catch {
        return null
    }
}

/**
 * Face embeddings change exactly once per enrolment — push the new one into
 * the cached blob immediately so verification never reads a stale face. If
 * no blob exists yet (the employee hasn't signed in since deploy), skip:
 * the next login primes it from Postgres anyway.
 */
export async function updateUserEmbedding(employeeId: string, embedding: number[]): Promise<void> {
    try {
        const raw = await redis.get(empKey(employeeId))
        if (!raw) return
        const user = JSON.parse(raw) as CachedUser
        user.faceEmbedding = embedding
        user.hasRegisteredFace = true
        await redis.set(empKey(employeeId), JSON.stringify(user), 'EX', USER_TTL_SECONDS)
    } catch (err: any) {
        console.error('[cache] updateUserEmbedding failed:', err.message)
    }
}

/** The employee's latest punch. Written synchronously at enqueue time. */
export async function getLastPunchCached(employeeId: string): Promise<LastPunch | null> {
    try {
        const raw = await redis.get(punchKey(employeeId))
        if (!raw) return null
        const parsed = JSON.parse(raw) as { action: string; createdAt: string; siteId?: string | null }
        return {
            action: parsed.action,
            createdAt: new Date(parsed.createdAt),
            // Absent on every blob written before a punch could carry a site.
            siteId: parsed.siteId ?? null,
        }
    } catch {
        return null
    }
}

export async function setLastPunchCached(employeeId: string, punch: LastPunch): Promise<void> {
    try {
        // No TTL: it is tiny, always current, and rules depend on it.
        // A null punch (rollback of a phantom) clears the key instead of
        // storing a literal "null" blob that would break readers.
        if (!punch) {
            await redis.del(punchKey(employeeId))
            return
        }
        await redis.set(punchKey(employeeId), JSON.stringify(punch))
    } catch (err: any) {
        console.error('[cache] setLastPunchCached failed:', err.message)
    }
}

/**
 * What each site already holds for one employee on one attendance day.
 *
 * `punch:last` answers the day-wide sequence (is a duty open?), but a Field
 * Officer now works a day as a sequence of duties at SEVERAL sites, and each of
 * those has its own one-check-in / one-check-out slot. The row itself lands in
 * Postgres through the queue a moment after the phone was answered, so — for
 * exactly the reason `punch:last` exists — the just-accepted punch is mirrored
 * here the instant it is accepted and read back before the next one is judged.
 *
 * Shape: `{ [siteId]: { checkInAt, checkOutAt } }`, with the empty-string key
 * standing for a punch recorded without choosing a site (every self punch until
 * this feature, and every legacy row). The caller holds the whole map (it is
 * built by a read-through of Postgres on a miss, then handed back complete),
 * which is why the write here is a plain SET: a partial map would silently
 * un-guard the sites it omits.
 *
 * The TTL is generous next to the queue lag it exists to cover (seconds) and
 * short enough that an admin's correction, or an eviction, costs one indexed
 * Postgres re-read rather than a day of wrong refusals. PostgreSQL's partial
 * unique indexes stay the real guarantee: this only decides how fast a double
 * tap is refused, and with what words.
 */
const DAY_SLOT_TTL_SECONDS = 6 * 60 * 60

export type DaySlot = { checkInAt: string | null; checkOutAt: string | null }
export type DaySlots = Record<string, DaySlot>

/** The map key for one site — '' is "a punch made without choosing a site". */
export const siteSlotKey = (siteId: string | null | undefined): string => siteId ?? ''

const daySlotsKey = (employeeId: string, day: string) => `punch:day:${employeeId}:${day}`

/** null means "not cached" — the caller reads Postgres and primes. */
export async function getDaySlotsCached(employeeId: string, day: string): Promise<DaySlots | null> {
    try {
        const raw = await redis.get(daySlotsKey(employeeId, day))
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? (parsed as DaySlots) : null
    } catch {
        return null
    }
}

export async function setDaySlotsCached(
    employeeId: string,
    day: string,
    slots: DaySlots
): Promise<void> {
    try {
        await redis.set(daySlotsKey(employeeId, day), JSON.stringify(slots), 'EX', DAY_SLOT_TTL_SECONDS)
    } catch (err: any) {
        console.error('[cache] setDaySlotsCached failed:', err.message)
    }
}

/**
 * Drop a day's slots after something wrote attendance outside the punch path
 * (the end-of-day sweep, a supervisor closure or correction). Best-effort: the
 * next read re-primes from Postgres, so a failure only costs an answer that
 * stays stale until the TTL.
 */
export async function invalidateDaySlots(employeeId: string, day: string): Promise<void> {
    try {
        await redis.del(daySlotsKey(employeeId, day))
    } catch {
        // Expires on its own via EX.
    }
}

/**
 * Short-lived mutual exclusion per employee while a punch is being verified.
 * Serialises double-taps and concurrent supervisor+self punches for the same
 * person; auto-expires if the process dies mid-flight.
 */
export async function acquirePunchLock(employeeId: string, ttlMs = 15_000): Promise<boolean> {
    try {
        const got = await redis.set(`punch:lock:${employeeId}`, '1', 'PX', ttlMs, 'NX')
        return got === 'OK'
    } catch {
        // If Redis is unreachable, don't hard-block punches — DB fallback still applies.
        return true
    }
}

export async function releasePunchLock(employeeId: string): Promise<void> {
    try {
        await redis.del(`punch:lock:${employeeId}`)
    } catch {
        // Lock expires on its own via PX.
    }
}

/**
 * One password change per account at a time. A double-tap, or two handsets on the
 * same account, would otherwise both clear the current-password check and race to
 * write different salt/hash pairs — the loser's hash lands on the row and the
 * password the user was just told works does not unlock it. Unlike the punch
 * lock this one is worth a refusal rather than a retry, so it is a distinct key.
 */
export async function acquirePasswordChangeLock(userId: string, ttlSeconds = 20): Promise<boolean> {
    try {
        const got = await redis.set(`auth:pwlock:${userId}`, '1', 'EX', ttlSeconds, 'NX')
        return got === 'OK'
    } catch {
        // Same rule as the punch lock: Redis being unreachable does not hard-block
        // the request. The write itself is a single UPDATE, so a lost race can
        // still only ever land one consistent salt/hash pair.
        return true
    }
}

export async function releasePasswordChangeLock(userId: string): Promise<void> {
    try {
        await redis.del(`auth:pwlock:${userId}`)
    } catch {
        // Expires on its own via EX.
    }
}

/**
 * Fixed-window rate limit for a public endpoint, counted in Redis.
 *
 * The key is only ever created with an EX, so a window can never become
 * permanent: `SET NX` stamps the deadline once and `INCR` only adds to a count
 * that already owns its expiry. Two windows are used by the caller — one per
 * account asked about, one per originating IP — because they stop different
 * attacks: the first is a nuisance limit, the second is what keeps one handset
 * from enumerating phone numbers against the whole roster.
 *
 * Fails open. Redis being down degrades the abuse protection, not the feature:
 * the forgot-password endpoint it guards cannot duplicate a request anyway (the
 * partial unique index refuses that in Postgres) and cannot leak a credential.
 */
export async function consumeRateBudget(
    bucket: string,
    limit: number,
    windowSeconds: number
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const key = `rl:${bucket}`
    try {
        await redis.set(key, '0', 'EX', windowSeconds, 'NX')
        const count = await redis.incr(key)
        if (count <= limit) return { allowed: true, retryAfterSeconds: 0 }

        const ttl = await redis.ttl(key)
        return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds }
    } catch (err: any) {
        console.error('[cache] rate budget check failed (allowing):', err?.message ?? err)
        return { allowed: true, retryAfterSeconds: 0 }
    }
}

/** Close the shared connection (graceful shutdown). */
export async function closeCache(): Promise<void> {
    try {
        await redis.quit()
    } catch {
        redis.disconnect()
    }
}
