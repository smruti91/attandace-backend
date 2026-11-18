import type { Request, Response } from 'express'
import { randomBytes, createHmac } from 'node:crypto'
import { and, eq, isNull, desc, ne } from 'drizzle-orm'
import { db } from '../../db'
import {
    usersTable,
    employees,
    lksguardDevices,
    lksguardEmployeeDevices,
} from '../../db/schema'
import { createUserToken } from '../auth/utils/token'
import type { UserTokenPayload } from '../auth/utils/token'
import { redis } from '../../services/cache'
import { enqueueLksGuardSync, type LksGuardSyncJobData } from '../../services/lksguardSyncQueue'
import { encryptSmsContent } from '../../services/lksguardCrypto'
import {
    lksguardLoginModel,
    lksguardChangePasswordModel,
    lksguardRegisterDeviceModel,
    lksguardHeartbeatModel,
    lksguardSyncEnvelopeModel,
    callEventModel,
    smsEventModel,
    contactEventModel,
} from './models'

/**
 * LKSGuard mobile controller (bearer-authenticated, employee identity).
 *
 * Reuses the existing `users`/`employees` accounts (phone + default `12345`)
 * and the same HMAC-SHA256 password scheme as the attendance auth — LKSGuard
 * adds NO second credential table (#31). What it layers on top is a device
 * binding: an employee may only register a handset the server has assigned to
 * them (#5/#7), and every sync is attributed to that binding, never to a
 * client-supplied id (#24).
 */

const DEFAULT_PASSWORD = '12345'

function hashPassword(password: string, salt: string) {
    return createHmac('sha256', salt).update(password).digest('hex')
}

function userId(req: Request): string {
    // @ts-ignore — set by authenticationMiddleware
    return (req.user as UserTokenPayload | undefined)?.id ?? ''
}

class LksGuardController {
    // ── Auth ───────────────────────────────────────────────────────────────────
    public async handleLogin(req: Request, res: Response) {
        try {
            const parsed = await lksguardLoginModel.safeParseAsync(req.body)
            if (parsed.error) {
                return res.status(400).json({ success: false, message: 'body validation failed', error: parsed.error.issues })
            }
            const { phone, password } = parsed.data

            const [user] = await db.select().from(usersTable).where(eq(usersTable.phone, phone))

            // Identical response for "no such user" and "wrong password" so the
            // endpoint cannot enumerate which numbers hold accounts (as the admin
            // sign-in does).
            const invalid = () => res.status(401).json({ success: false, message: 'Invalid phone number or password' })
            if (!user || !user.salt || !user.password) return invalid()
            if (hashPassword(password, user.salt) !== user.password) return invalid()

            if (user.role === 'admin') {
                return res.status(403).json({ success: false, message: 'Admin accounts sign in through the web panel' })
            }
            if (!user.isActive) {
                return res.status(403).json({ success: false, message: 'This account is disabled' })
            }

            const token = createUserToken({ id: user.id })

            return res.json({
                success: true,
                message: 'Signed in',
                data: {
                    token,
                    mustChangePassword: user.mustChangePassword,
                },
            })
        } catch (err: any) {
            console.error('[lksguard/login]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    public async handleChangePassword(req: Request, res: Response) {
        try {
            const parsed = await lksguardChangePasswordModel.safeParseAsync(req.body)
            if (parsed.error) {
                return res.status(400).json({ success: false, message: 'body validation failed', error: parsed.error.issues })
            }
            const { newPassword } = parsed.data
            if (newPassword === DEFAULT_PASSWORD) {
                return res.status(400).json({ success: false, message: 'New password must differ from the default' })
            }

            const id = userId(req)
            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id))
            if (!user) return res.status(404).json({ success: false, message: 'Account not found' })

            const salt = randomBytes(32).toString('hex')
            await db
                .update(usersTable)
                .set({
                    salt,
                    password: hashPassword(newPassword, salt),
                    mustChangePassword: false,
                    updatedAt: new Date(),
                })
                .where(eq(usersTable.id, id))

            return res.json({ success: true, message: 'Password updated' })
        } catch (err: any) {
            console.error('[lksguard/change-password]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    // ── Session profile ──────────────────────────────────────────────────────────
    public async handleMe(req: Request, res: Response) {
        try {
            const id = userId(req)
            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id))
            if (!user) return res.status(404).json({ success: false, message: 'Account not found' })

            let employee: { id: string; firstName: string; lastName: string; phone: string; designation: string | null } | null = null
            if (user.employeeId) {
                const [emp] = await db.select().from(employees).where(eq(employees.id, user.employeeId))
                if (emp) {
                    employee = {
                        id: emp.id,
                        firstName: emp.firstName,
                        lastName: emp.lastName,
                        phone: emp.phone,
                        designation: emp.designation,
                    }
                }
            }

            // This employee's currently-bound device (if any) for the home status
            // screen (#26), plus whether an unbound assignment is waiting.
            let device = null
            let assignedPending = false
            if (user.employeeId) {
                const [dev] = await db
                    .select()
                    .from(lksguardDevices)
                    .where(eq(lksguardDevices.employeeId, user.employeeId))
                    .orderBy(desc(lksguardDevices.updatedAt))
                    .limit(1)
                if (dev) {
                    device = {
                        deviceId: dev.deviceId,
                        status: dev.status,
                        model: dev.model,
                        manufacturer: dev.manufacturer,
                        permCall: dev.permCall,
                        permSms: dev.permSms,
                        permContacts: dev.permContacts,
                        lastSeenAt: dev.lastSeenAt,
                        lastSyncAt: dev.lastSyncAt,
                    }
                } else {
                    const [open] = await db
                        .select({ id: lksguardEmployeeDevices.id })
                        .from(lksguardEmployeeDevices)
                        .where(
                            and(
                                eq(lksguardEmployeeDevices.employeeId, user.employeeId),
                                isNull(lksguardEmployeeDevices.unassignedAt)
                            )
                        )
                        .limit(1)
                    assignedPending = Boolean(open)
                }
            }

            return res.json({
                success: true,
                data: {
                    mustChangePassword: user.mustChangePassword,
                    user: { id: user.id, phone: user.phone },
                    employee,
                    device,
                    assignedPending,
                },
            })
        } catch (err: any) {
            console.error('[lksguard/me]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    // ── Device registration / binding ────────────────────────────────────────────
    public async handleRegisterDevice(req: Request, res: Response) {
        try {
            const id = userId(req)
            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id))
            if (!user) return res.status(404).json({ success: false, message: 'Account not found' })
            if (user.mustChangePassword) {
                return res.status(403).json({ success: false, message: 'Change your password before registering a device' })
            }
            if (!user.employeeId) {
                return res.status(403).json({ success: false, message: 'This account is not linked to an employee' })
            }

            const parsed = await lksguardRegisterDeviceModel.safeParseAsync(req.body)
            if (parsed.error) {
                return res.status(400).json({ success: false, message: 'body validation failed', error: parsed.error.issues })
            }
            const body = parsed.data

            // Authorization: the employee must have an open (unassignedAt null)
            // assignment. Without one, a personal phone cannot self-register (#5).
            const [assignment] = await db
                .select()
                .from(lksguardEmployeeDevices)
                .where(
                    and(
                        eq(lksguardEmployeeDevices.employeeId, user.employeeId),
                        isNull(lksguardEmployeeDevices.unassignedAt)
                    )
                )
                .orderBy(desc(lksguardEmployeeDevices.assignedAt))
                .limit(1)

            if (!assignment) {
                return res.status(403).json({
                    success: false,
                    message: 'No company device is assigned to you. Contact your administrator.',
                })
            }

            // If the assignment already names a specific device row, this handset's
            // deviceId must match it — the employee cannot bind an arbitrary phone.
            const [existing] = await db
                .select()
                .from(lksguardDevices)
                .where(eq(lksguardDevices.deviceId, body.deviceId))
                .limit(1)

            if (assignment.deviceRowId && existing && existing.id !== assignment.deviceRowId) {
                return res.status(403).json({ success: false, message: 'This device is not the one assigned to you' })
            }
            if (existing && existing.employeeId && existing.employeeId !== user.employeeId) {
                return res.status(403).json({ success: false, message: 'This device is assigned to another employee' })
            }
            if (existing && existing.status !== 'ACTIVE') {
                return res.status(403).json({ success: false, message: `Device is ${existing.status.toLowerCase()}` })
            }

            const now = new Date()
            let device: typeof lksguardDevices.$inferSelect
            if (existing) {
                const [updated] = await db
                    .update(lksguardDevices)
                    .set({
                        employeeId: user.employeeId,
                        phone: user.phone,
                        deviceName: body.deviceName ?? existing.deviceName,
                        manufacturer: body.manufacturer ?? existing.manufacturer,
                        model: body.model ?? existing.model,
                        androidVersion: body.androidVersion ?? existing.androidVersion,
                        appVersion: body.appVersion ?? existing.appVersion,
                        lastSeenAt: now,
                        updatedAt: now,
                    })
                    .where(eq(lksguardDevices.id, existing.id))
                    .returning()
                device = updated!
            } else {
                const [created] = await db
                    .insert(lksguardDevices)
                    .values({
                        deviceId: body.deviceId,
                        employeeId: user.employeeId,
                        phone: user.phone,
                        deviceName: body.deviceName ?? null,
                        manufacturer: body.manufacturer ?? null,
                        model: body.model ?? null,
                        androidVersion: body.androidVersion ?? null,
                        appVersion: body.appVersion ?? null,
                        status: 'ACTIVE',
                        lastSeenAt: now,
                    })
                    .returning()
                device = created!
            }

            // Bind the open assignment to the device row if it wasn't pre-created.
            if (!assignment.deviceRowId) {
                await db
                    .update(lksguardEmployeeDevices)
                    .set({ deviceRowId: device.id })
                    .where(eq(lksguardEmployeeDevices.id, assignment.id))
            }

            // Redis "device online" marker (#20) — advisory, 5-minute TTL.
            try {
                await redis.set(`lksguard:online:${device.deviceId}`, '1', 'EX', 300)
            } catch {
                /* non-fatal */
            }

            return res.status(201).json({
                success: true,
                message: 'Device registered',
                data: {
                    device: {
                        deviceId: device.deviceId,
                        status: device.status,
                        model: device.model,
                        lastSeenAt: device.lastSeenAt,
                    },
                },
            })
        } catch (err: any) {
            console.error('[lksguard/register-device]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    // ── Heartbeat (permission snapshot) ──────────────────────────────────────────
    public async handleHeartbeat(req: Request, res: Response) {
        try {
            const ctx = await this.requireBoundDevice(req)
            if (!ctx.ok) return res.status(ctx.status).json({ success: false, message: ctx.message })

            const parsed = await lksguardHeartbeatModel.safeParseAsync(req.body)
            if (parsed.error) {
                return res.status(400).json({ success: false, message: 'body validation failed', error: parsed.error.issues })
            }
            const b = parsed.data
            const now = new Date()

            await db
                .update(lksguardDevices)
                .set({
                    lastSeenAt: now,
                    permCall: b.permCall ?? ctx.device.permCall,
                    permSms: b.permSms ?? ctx.device.permSms,
                    permContacts: b.permContacts ?? ctx.device.permContacts,
                    appVersion: b.appVersion ?? ctx.device.appVersion,
                    updatedAt: now,
                })
                .where(eq(lksguardDevices.id, ctx.device.id))

            try {
                await redis.set(`lksguard:online:${ctx.device.deviceId}`, '1', 'EX', 300)
            } catch {
                /* non-fatal */
            }

            return res.json({ success: true, message: 'ok' })
        } catch (err: any) {
            console.error('[lksguard/heartbeat]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    // ── Sync (call / SMS / contact batches) ──────────────────────────────────────
    public async handleSync(req: Request, res: Response) {
        try {
            const ctx = await this.requireBoundDevice(req)
            if (!ctx.ok) return res.status(ctx.status).json({ success: false, message: ctx.message })

            const parsed = await lksguardSyncEnvelopeModel.safeParseAsync(req.body)
            if (parsed.error) {
                // Container-level failure (bad device id, batch too large, nothing
                // sent). Event-level problems are handled per row below, so they never
                // reach here — and the message names the field instead of being the
                // useless "body validation failed" the handset had no way to act on.
                const first = parsed.error.issues[0]
                const where = first && Array.isArray(first.path) ? first.path.join('.') : '?'
                return res.status(400).json({
                    success: false,
                    message: `batch rejected at ${where}: ${first?.message ?? 'invalid request body'}`,
                    error: parsed.error.issues,
                })
            }
            const b = parsed.data

            // employeeId/deviceId come from the binding, NOT the body (#24). The body's
            // deviceId is the handset's own install id, so a mismatch is normal and must
            // be REPAIRED rather than rejected: an admin can pre-create the row with a
            // provisioning code from the assignment form, and a reinstall regenerates the
            // id. Rejecting here silently wedges every future sync for that device, since
            // the app has no way to learn the id the server invented.
            let device = ctx.device
            if (b.deviceId !== device.deviceId) {
                const [claimant] = await db
                    .select()
                    .from(lksguardDevices)
                    .where(
                        and(
                            eq(lksguardDevices.deviceId, b.deviceId),
                            ne(lksguardDevices.id, device.id)
                        )
                    )
                    .limit(1)
                if (claimant) {
                    return res.status(403).json({ success: false, message: 'Batch deviceId belongs to another device' })
                }
                const [renamed] = await db
                    .update(lksguardDevices)
                    .set({ deviceId: b.deviceId, updatedAt: new Date() })
                    .where(eq(lksguardDevices.id, device.id))
                    .returning()
                device = renamed ?? device
            }

            // Per-event validation against the strict models. Accepted rows go into the
            // job; rejected rows are named (kind + index within this batch, which is how
            // the handset maps them back to its own queue rows) so exactly those can be
            // parked as FAILED with a reason — the rest of the batch still lands.
            const rejected: { kind: 'call' | 'sms' | 'contact'; index: number; reason: string }[] = []
            // A rejection has to be actionable from the handset alone. "too_big" tells
            // you nothing; naming the field AND showing the offending value (length +
            // a truncated preview) means one glance at the banner identifies the real
            // device data, with no server log spelunking.
            const why = (err: any, raw: unknown): string => {
                const i = err?.issues?.[0]
                if (!i) return 'invalid event'
                const path =
                    Array.isArray(i.path) && i.path.length ? String(i.path[0]) : '(root)'
                let detail = ''
                if (path !== '(root)' && raw && typeof raw === 'object') {
                    const value = (raw as Record<string, unknown>)[path]
                    if (value != null) {
                        const text = String(value)
                        detail = ` [${path} is ${text.length} chars: "${text.slice(0, 40)}"]`
                    }
                }
                return `${path}: ${i.message}${detail}`
            }

            const calls: LksGuardSyncJobData['calls'] = []
            b.calls.forEach((raw, index) => {
                const r = callEventModel.safeParse(raw)
                if (!r.success) {
                    rejected.push({ kind: 'call', index, reason: why(r.error, raw) })
                    return
                }
                const c = r.data
                calls.push({
                    eventUuid: c.eventUuid,
                    phoneNumber: c.phoneNumber ?? null,
                    callType: c.callType,
                    startedAt: c.startedAt ?? null,
                    endedAt: c.endedAt ?? null,
                    durationSeconds: c.durationSeconds,
                    eventTime: c.eventTime,
                })
            })

            // Encrypt SMS bodies server-side BEFORE enqueue so plaintext never
            // lands in the Redis job payload (#11/#24).
            const sms: LksGuardSyncJobData['sms'] = []
            b.sms.forEach((raw, index) => {
                const r = smsEventModel.safeParse(raw)
                if (!r.success) {
                    rejected.push({ kind: 'sms', index, reason: why(r.error, raw) })
                    return
                }
                const s = r.data
                const encrypted =
                    s.policy === 'SMS_CONTENT' && s.content ? encryptSmsContent(s.content) : null
                sms.push({
                    eventUuid: s.eventUuid,
                    phoneNumber: s.phoneNumber ?? null,
                    direction: s.direction,
                    messageTimestamp: s.messageTimestamp ?? null,
                    policy: s.policy,
                    contentCipher: encrypted?.cipher ?? null,
                    contentIv: encrypted?.iv ?? null,
                    messageTime: s.messageTime,
                })
            })

            const contacts: LksGuardSyncJobData['contacts'] = []
            b.contacts.forEach((raw, index) => {
                const r = contactEventModel.safeParse(raw)
                if (!r.success) {
                    rejected.push({ kind: 'contact', index, reason: why(r.error, raw) })
                    return
                }
                const c = r.data
                contacts.push({
                    contactUuid: c.contactUuid,
                    contactName: c.contactName ?? null,
                    phoneNumber: c.phoneNumber ?? null,
                    email: c.email ?? null,
                })
            })

            if (rejected.length) {
                // The handset shows the first of these; the log keeps the whole list so
                // a fleet-wide data problem is visible without phoning a device.
                console.warn(
                    `[lksguard/sync] ${device.deviceId} rejected ${rejected.length}/${
                        b.calls.length + b.sms.length + b.contacts.length
                    } row(s):`,
                    JSON.stringify(rejected.slice(0, 5))
                )
            }

            if (!calls.length && !sms.length && !contacts.length) {
                // Nothing survived. Still a 202 rather than a 4xx: the handset needs the
                // rejection list to park exactly these rows, and an error status would
                // make it resend the identical batch on every retry forever.
                return res.status(202).json({
                    success: true,
                    message: 'No event in this batch was accepted',
                    data: { received: { calls: 0, sms: 0, contacts: 0 }, rejected },
                })
            }

            const job: LksGuardSyncJobData = {
                employeeId: ctx.employeeId,
                deviceId: device.deviceId,
                calls,
                sms,
                contacts,
            }

            try {
                await enqueueLksGuardSync(job)
            } catch (err: any) {
                // Redis unavailable → the durable-store guarantee fails, so tell
                // the app to keep its queue (503) rather than drop events (#18).
                console.error('[lksguard/sync] enqueue failed:', err.message)
                return res.status(503).json({ success: false, message: 'Sync queue unavailable, retry later' })
            }

            return res.status(202).json({
                success: true,
                message: 'Accepted',
                data: {
                    received: {
                        calls: job.calls.length,
                        sms: job.sms.length,
                        contacts: job.contacts.length,
                    },
                    rejected,
                },
            })
        } catch (err: any) {
            console.error('[lksguard/sync]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    // ── Shared guard: authenticated employee owns an ACTIVE bound device ─────────
    // Returns a discriminated result: on failure the handler relays `status` +
    // `message` verbatim; on success it gets the resolved employee + device. The
    // device row is the caller's most-recently-seen binding — a sync/heartbeat can
    // only ever act on a device already bound to THIS employee (#24).
    private async requireBoundDevice(req: Request): Promise<
        | { ok: true; employeeId: string; device: typeof lksguardDevices.$inferSelect }
        | { ok: false; status: number; message: string }
    > {
        const id = userId(req)
        const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id))
        if (!user || !user.employeeId) {
            return { ok: false, status: 403, message: 'This account is not linked to an employee' }
        }
        if (user.mustChangePassword) {
            return { ok: false, status: 403, message: 'Change your password first' }
        }
        const [device] = await db
            .select()
            .from(lksguardDevices)
            .where(eq(lksguardDevices.employeeId, user.employeeId))
            .orderBy(desc(lksguardDevices.lastSeenAt))
            .limit(1)
        if (!device) {
            return { ok: false, status: 409, message: 'No registered device for this account' }
        }
        if (device.status !== 'ACTIVE') {
            return { ok: false, status: 403, message: `Device is ${device.status.toLowerCase()}` }
        }
        return { ok: true, employeeId: user.employeeId, device }
    }
}

export default LksGuardController
