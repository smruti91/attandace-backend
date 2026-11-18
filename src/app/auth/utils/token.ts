import JWT from 'jsonwebtoken'
import type jwt from 'jsonwebtoken'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../../../db'
import { refreshTokens, usersTable } from '../../../db/schema'
import { redis } from '../../../services/cache'

export interface UserTokenPayload {
    id: string
    /** 'admin' for admin-panel access tokens; absent on legacy mobile tokens. */
    role?: string
    /**
     * Standard JWT claim, set by `JWT.sign` itself. Declared here because the
     * revocation guard compares it against the account's password-change epoch.
     */
    iat?: number
}

const JWT_SECRET = process.env.JWT_SECRET ?? 'myjwtsecret'

/**
 * Admin access tokens are deliberately short-lived — the refresh cookie renews them.
 * Overridable so the refresh path can be exercised without waiting 15 minutes:
 * `ADMIN_ACCESS_TTL=10s npm run dev`.
 */
// Cast because jsonwebtoken types `expiresIn` as a template-literal union
// (`${number}m` | `${number}s` | …), which a plain env string cannot satisfy.
const ADMIN_ACCESS_TTL = (process.env.ADMIN_ACCESS_TTL ?? '15m') as NonNullable<
    jwt.SignOptions['expiresIn']
>
/** Refresh-token lifetime. Rotation issues a fresh one on every use. */
const REFRESH_TTL_DAYS = 7

/**
 * Mobile app token. Intentionally left non-expiring.
 *
 * Adding `expiresIn` here would start expiring every employee's session, and the
 * mobile app has no refresh flow to recover — it would simply stop working mid-shift.
 * Giving mobile real expiry means building refresh on that client too.
 */
export function createUserToken(payload: UserTokenPayload) {
    const token = JWT.sign(payload, JWT_SECRET)
    return token
}

export function verifyUserToken(token: string) {
    try {
        const payload = JWT.verify(token, JWT_SECRET) as UserTokenPayload
        return payload
    } catch (error) {
        return null
    }
}

// ── Admin access tokens ──────────────────────────────────────────────────────

export function createAdminAccessToken(payload: { id: string }) {
    return JWT.sign({ id: payload.id, role: 'admin' }, JWT_SECRET, {
        expiresIn: ADMIN_ACCESS_TTL,
    })
}

// ── Refresh tokens ───────────────────────────────────────────────────────────
// The raw token only ever exists in the httpOnly cookie. The database stores its
// sha256, so reading the table does not hand an attacker a usable token. sha256
// with no salt is the right choice here (unlike for passwords): the input is 256
// bits of entropy, so there is nothing to brute-force, and lookup must be by
// exact hash.

function hashToken(raw: string) {
    return createHash('sha256').update(raw).digest('hex')
}

function expiryFromNow() {
    return new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000)
}

/** Mint a refresh token for a user and persist its hash. Returns the raw token. */
export async function issueRefreshToken(userId: string): Promise<string> {
    const raw = randomBytes(32).toString('hex')

    await db.insert(refreshTokens).values({
        userId,
        tokenHash: hashToken(raw),
        expiresAt: expiryFromNow(),
    })

    return raw
}

/**
 * Consume a refresh token and issue its replacement (rotation).
 *
 * Returns null when the token is unknown, already revoked, or expired — all of
 * which the caller should treat identically: clear the cookie and force a login.
 * Revoking before inserting means a replayed token fails on the second use, which
 * is the entire point of rotation.
 */
export async function rotateRefreshToken(
    raw: string
): Promise<{ raw: string; userId: string } | null> {
    if (!raw) return null

    const tokenHash = hashToken(raw)

    const [row] = await db
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
        .limit(1)

    if (!row) return null
    if (row.expiresAt.getTime() <= Date.now()) return null

    await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.id, row.id))

    const replacement = await issueRefreshToken(row.userId)
    return { raw: replacement, userId: row.userId }
}

/** Revoke a single refresh token (sign-out). Unknown tokens are a no-op. */
export async function revokeRefreshToken(raw: string): Promise<void> {
    if (!raw) return

    await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.tokenHash, hashToken(raw)), isNull(refreshTokens.revokedAt)))
}

// ── Password-change revocation ───────────────────────────────────────────────
// A signed token is valid until its expiry says otherwise, and the mobile token
// has none (see createUserToken). So "the password changed, the old sessions are
// dead" needs server state: the account row stores the instant its password last
// changed, and the auth guard refuses any token minted before it.
//
// Postgres owns that instant; the Redis key below is a mirror so the check on
// every authenticated request costs a GET rather than a table read. A cold key
// falls through to Postgres and re-primes itself, and a password change writes
// both — so no path can keep serving "no change yet" for an account that has
// just changed its password.

const pwEpochKey = (userId: string) => `auth:pwchg:${userId}`
/** Same lifetime as the session cache these keys sit beside. */
const PW_EPOCH_TTL_SECONDS = 7 * 24 * 60 * 60
/**
 * The shared connection runs with `enableOfflineQueue`, which buffers commands
 * while Redis is unreachable — an unguarded GET would stall this (and every
 * authenticated request behind it) instead of failing. The race turns that stall
 * into a read of Postgres. Nothing is cancelled: the queued GET may resolve much
 * later, which is harmless because its value is only ever passed back, never
 * written anywhere.
 */
const REDIS_READ_TIMEOUT_MS = 1_200

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('redis read timed out')), ms)
        promise.then(
            (value) => {
                clearTimeout(timer)
                resolve(value)
            },
            (err) => {
                clearTimeout(timer)
                reject(err)
            },
        )
    })
}

/**
 * Epoch milliseconds of this account's last password change, or 0 when it has
 * never changed one — the value every stored token predates, so 0 revokes
 * nothing. Reads go Redis-first, Postgres on a miss.
 */
export async function getPasswordChangedAtMs(userId: string): Promise<number> {
    try {
        const cached = await raceTimeout(redis.get(pwEpochKey(userId)), REDIS_READ_TIMEOUT_MS)
        if (cached !== null) {
            const parsed = Number(cached)
            // A garbage value must not be trusted as "no change" — fall through.
            if (Number.isFinite(parsed) && parsed >= 0) return parsed
        }
    } catch (err: any) {
        console.error('[auth] password-epoch cache read failed:', err?.message ?? err)
    }

    const [row] = await db
        .select({ at: usersTable.passwordChangedAt })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1)

    const ms = row?.at ? row.at.getTime() : 0
    // Prime the mirror either way — including the 0, so an account that has never
    // changed its password does not cost a Postgres read on every request.
    await primePasswordEpochCache(userId, ms)
    return ms
}

/** Write the mirror. Swallowed: Redis being down must not fail a request whose
 *  source of truth (Postgres) answered. */
async function primePasswordEpochCache(userId: string, ms: number): Promise<void> {
    try {
        await redis.set(pwEpochKey(userId), String(ms), 'EX', PW_EPOCH_TTL_SECONDS)
    } catch (err: any) {
        console.error('[auth] password-epoch cache prime failed:', err?.message ?? err)
    }
}

/**
 * Publish a password change that has already been committed to Postgres: refresh
 * the mirror so the very next request is refused, and revoke every refresh token
 * so the web panel's rotating cookie cannot mint a new access token either.
 */
export async function invalidateSessionsForPasswordChange(
    userId: string,
    changedAt: Date
): Promise<void> {
    await primePasswordEpochCache(userId, changedAt.getTime())

    await db
        .update(refreshTokens)
        .set({ revokedAt: changedAt })
        .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
}

/**
 * Whether a verified token is stale: minted before the account's password last
 * changed.
 *
 * `iat` counts whole seconds while the epoch is exact, so the epoch is floored to
 * its second rather than the token being read at full precision. Comparing the
 * raw values would reject a token minted in the SAME second the password changed
 * — which is exactly what a sign-in performed immediately after a change produces,
 * so the user would be handed a token the server refuses a moment later and read
 * that as a broken login. The cost of flooring is a window of at most one second
 * in which a token from before the change is still honoured: the client clears its
 * own token at the same time, so nothing real is left open.
 *
 * An account with no epoch (0) revokes nothing, which is what leaves every
 * pre-feature session working the moment this code ships.
 */
export function isTokenStale(payload: UserTokenPayload, changedAtMs: number): boolean {
    if (!changedAtMs) return false
    if (typeof payload.iat !== 'number') return false
    return payload.iat < Math.floor(changedAtMs / 1000)
}
