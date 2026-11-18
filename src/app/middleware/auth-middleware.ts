import type { Request, Response, NextFunction } from 'express'
import {
    verifyUserToken,
    getPasswordChangedAtMs,
    isTokenStale,
} from '../auth/utils/token'

export function authenticationMiddleware() {
    // Async now: revoking a token needs the account's password-change epoch, and
    // reading it is a promise. Express 5 forwards a rejected middleware promise
    // to the error handler, but nothing here is allowed to reject — every await
    // is wrapped, so a cache or database hiccup degrades instead of failing the
    // request. Requests with no bearer header still fall straight through, so
    // public routes never pay for the lookup.
    return async function (req: Request, res: Response, next: NextFunction) {
        const header = req.headers['authorization']

        // If no authorization header is present, treat request as unauthenticated
        if (!header) return next()

        if (!header?.startsWith('Bearer')) {
            return res.status(400).json({ error: 'authorization header must start with Bearer' })
        }

        const token = header.split(' ')[1]

        if (!token) return res.status(400).json({ error: 'authorization header must start with Bearer and followed by token' })

        let user
        try {
            user = verifyUserToken(token)
        } catch (err) {
            return res.status(401).json({ error: 'invalid or expired token' })
        }

        // A correctly signed token is not automatically a live one. Mobile tokens
        // carry no expiry, so the only way a password change can retire the old
        // one — on every handset and every device app that holds it — is this
        // comparison against the account's change epoch.
        if (user?.id) {
            try {
                const changedAtMs = await getPasswordChangedAtMs(user.id)
                if (isTokenStale(user, changedAtMs)) {
                    // Same wording as an invalid signature: the response must not
                    // hint that the account exists or that its password changed.
                    return res.status(401).json({ error: 'invalid or expired token' })
                }
            } catch (err: any) {
                // Fail open deliberately. Every route this guards reads Postgres
                // anyway, so an outage already fails them on its own — closing the
                // door here would add nothing and would lock the whole workforce
                // out of check-in if a cold cache read ever threw.
                console.error('[auth] revocation check failed (allowing):', err?.message ?? err)
            }
        }

        // @ts-ignore
        req.user = user

        next()
    }
}

export function restrictToAuthenticatedUser() {
    return function (req: Request, res: Response, next: NextFunction) {
        // @ts-ignore
        if (!req.user) return res.status(401).json({ error: 'Authentication Required' })
        return next()
    }
}

/**
 * Admin-only guard.
 *
 * The 401/403 split matters to the web client's axios interceptor: 401 means
 * "token missing or expired, try refreshing", while 403 means "this identity is
 * authenticated but is not an admin" — refreshing would never help, so the
 * interceptor must not retry. An expired access token lands here as
 * `req.user === null` (verifyUserToken returns null) and correctly yields 401.
 */
export function restrictToAdmin() {
    return function (req: Request, res: Response, next: NextFunction) {
        // @ts-ignore — req.user is set by authenticationMiddleware
        const user = req.user as { id: string; role?: string } | null | undefined

        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' })
        }
        if (user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Admin access required' })
        }
        return next()
    }
}