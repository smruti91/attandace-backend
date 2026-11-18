import express from 'express'
import type { Express } from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'

import { authRouter } from './auth/routes'
import { empRouter } from './employees/routes'
import { foMobileRouter, foAdminRouter } from './field-officer/routes'
import { siteManagerMobileRouter, siteManagerAdminRouter } from './site-manager/routes'
import { officerAttendanceMobileRouter } from './officer-attendance/routes'
import { circleOfficerAdminRouter } from './circle-officer/routes'
import { lksGuardMobileRouter, lksGuardAdminRouter } from './lksguard/routes'
import { authenticationMiddleware } from './middleware/auth-middleware'
import { FACE_UPLOAD_ROOT } from '../services/faceImageStore'

// Origins allowed to send credentials (the admin panel's refresh cookie).
// A wildcard origin is not an option here: browsers refuse to attach credentials
// to `Access-Control-Allow-Origin: *`, so the cookie would silently never be sent.
const WEB_ORIGINS = ('http://localhost:5174, http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

export function createApplication(): Express {
    const app = express()

    // Middlewares
    app.use(
        cors({
            // The mobile app sends no Origin header, so `origin` is undefined there —
            // allow it through, since it authenticates with a bearer token and never
            // relies on cookies.
            origin(origin, callback) {
                if (!origin || WEB_ORIGINS.includes(origin)) return callback(null, true)
                // `false`, not an Error: throwing here reaches the express error
                // handler and answers with a 500, which reads like a server bug in
                // the logs. Omitting the header is the actual CORS mechanism — the
                // browser blocks the response on its own.
                return callback(null, false)
            },
            credentials: true,
        })
    )
    app.use(express.json(
        {
        limit: '50mb'
        }
    ))
    app.use(cookieParser())
    app.use(authenticationMiddleware())


    // Enrolment photos. Mounted before the auth middleware would matter anyway —
    // an <img src> cannot carry the bearer token the panel holds in memory, so a
    // guarded route would simply render as a broken image. The filenames carry a
    // random suffix instead (see services/faceImageStore), so a URL cannot be
    // guessed from an employee id. `immutable` is safe because a re-enrolment
    // writes a new filename rather than overwriting the old one.
    app.use(
        '/uploads',
        express.static(FACE_UPLOAD_ROOT, {
            maxAge: '30d',
            immutable: true,
            // Nothing here is meant to be browsable — a request for a directory
            // should 404 rather than list who is enrolled. Misses fall through to
            // the router and end as a plain 404; `fallthrough: false` would instead
            // push a NotFoundError through finalhandler, printing a stack trace for
            // every stale <img src> a cached page still asks for.
            index: false,
            redirect: false,
        })
    )

    // Routes
    app.get('/', (req, res) => {
        return res.json({ message: 'Welcome to ChaiCode Auth Service' })
    })

    app.use('/auth', authRouter) 
    app.use('/employee', empRouter)

    // Field Officer visit flow: the mobile app talks to /auth/fo/*, the OH
    // panel reads monitoring data from /employee/field-officer/*.
    app.use('/auth/fo', foMobileRouter)
    app.use('/employee/field-officer', foAdminRouter)

    // Site Manager location flow: the mobile app submits GPS for its assigned
    // sites via /auth/site-manager/*, the admin approval panel reads/acts on
    // submissions through /employee/site-manager/*.
    app.use('/auth/site-manager', siteManagerMobileRouter)
    app.use('/employee/site-manager', siteManagerAdminRouter)

    // Officer attendance: Circle Officers (and Field Officers / OH) read
    // per-employee and shift attendance for the sites they are posted to, via
    // the bearer-authenticated /auth/officer/* endpoints.
    app.use('/auth/officer', officerAttendanceMobileRouter)

    // Circle Officer management: the admin panel assigns which Field Officers a
    // Circle Officer supervises and reads the assignment history. A CO's own
    // attendance reads stay on the mobile endpoints above — this surface writes
    // the hierarchy, it does not expose attendance.
    app.use('/employee/circle-officer', circleOfficerAdminRouter)


    // LKSGuard (company-device communication audit): the mobile app signs in
    // and syncs via /auth/lksguard/*, the LKS admin panel manages assignments,
    // records, devices and audit through /employee/lksguard/*.
    app.use('/auth/lksguard', lksGuardMobileRouter)
    app.use('/employee/lksguard', lksGuardAdminRouter)

    return app
}
