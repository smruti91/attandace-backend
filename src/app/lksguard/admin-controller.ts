import type { Request, Response } from 'express'
import { createHmac } from 'node:crypto'
import { and, eq, desc, gte, lte, ilike, or, sql, count } from 'drizzle-orm'
import { db } from '../../db'
import {
    usersTable,
    employees,
    lksguardDevices,
    lksguardEmployeeDevices,
    lksguardCallRecords,
    lksguardSmsRecords,
    lksguardContacts,
    lksguardAuditLogs,
    appSettings,
} from '../../db/schema'
import type { UserTokenPayload } from '../auth/utils/token'
import { decryptSmsContent } from '../../services/lksguardCrypto'
import {
    lksguardAssignModel,
    lksguardDeviceStatusModel,
    lksguardCallQueryModel,
    lksguardSmsQueryModel,
    lksguardContactQueryModel,
    lksguardDeviceListQueryModel,
    lksguardAuditQueryModel,
    lksguardRetentionModel,
} from './models'

/**
 * LKSGuard admin controller — the existing LKS Web panel's management surface.
 * Mounted behind `restrictToAdmin()` so every handler already knows the caller
 * is an authenticated admin; granular LKSGuard permissions (#25) are layered on
 * top for the most sensitive read (SMS content). Reuses the LKS admin session —
 * no second login system (#25/#39).
 */

// Retention settings live in the existing app_settings KV table under these keys
// (#30) so a change is a data edit, not a deploy.
const RETENTION_KEYS = {
    callsDays: 'lksguard_retention_calls_days',
    smsMetaDays: 'lksguard_retention_sms_meta_days',
    smsContentDays: 'lksguard_retention_sms_content_days',
    contactsDays: 'lksguard_retention_contacts_days',
    auditDays: 'lksguard_retention_audit_days',
} as const

const DEFAULT_RETENTION_DAYS = 365

function adminId(req: Request): string {
    // @ts-ignore — set by authenticationMiddleware + restrictToAdmin
    return (req.user as UserTokenPayload | undefined)?.id ?? ''
}

function clientIp(req: Request): string {
    const fwd = req.headers['x-forwarded-for']
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0]?.trim() ?? ''
    return req.ip ?? req.socket?.remoteAddress ?? ''
}

function hashPassword(password: string, salt: string) {
    return createHmac('sha256', salt).update(password).digest('hex')
}

class LksGuardAdminController {
    // Append a sensitive-action audit row (#23). Never rejects the parent request
    // over a failed audit write, but logs it loudly — an unaudited SMS-content
    // view is worse than a slow one.
    private async audit(
        req: Request,
        action: string,
        opts: {
            resourceType?: string | undefined
            resourceId?: string | undefined
            employeeId?: string | undefined
            deviceId?: string | undefined
        } = {}
    ) {
        try {
            await db.insert(lksguardAuditLogs).values({
                adminUserId: adminId(req),
                action,
                resourceType: opts.resourceType ?? null,
                resourceId: opts.resourceId ?? null,
                employeeId: opts.employeeId ?? null,
                deviceId: opts.deviceId ?? null,
                ipAddress: clientIp(req) || null,
            })
        } catch (err: any) {
            console.error('[lksguard/audit] write failed:', err.message)
        }
    }

    // Load the caller's LKS roles so granular perms can be checked. Admin bypasses
    // the granular gate (they already hold the master admin role).
    private async callerIsSuperAdmin(req: Request): Promise<boolean> {
        const [u] = await db
            .select({ role: usersTable.role, roles: usersTable.roles })
            .from(usersTable)
            .where(eq(usersTable.id, adminId(req)))
            .limit(1)
        if (!u) return false
        if (u.role === 'admin') return true
        return (u.roles ?? []).includes('admin')
    }

    private async hasPerm(req: Request, perm: string): Promise<boolean> {
        if (await this.callerIsSuperAdmin(req)) return true
        const [u] = await db
            .select({ roles: usersTable.roles })
            .from(usersTable)
            .where(eq(usersTable.id, adminId(req)))
            .limit(1)
        return (u?.roles ?? []).includes(perm)
    }

    // ── Employee picker for the assignment screen ────────────────────────────────
    public async handleListEmployees(req: Request, res: Response) {
        try {
            const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
            const rows = await db
                .select({
                    id: employees.id,
                    firstName: employees.firstName,
                    lastName: employees.lastName,
                    phone: employees.phone,
                    designation: employees.designation,
                    isActive: employees.isActive,
                })
                .from(employees)
                .where(
                    search
                        ? or(
                              ilike(employees.firstName, `%${search}%`),
                              ilike(employees.lastName, `%${search}%`),
                              ilike(employees.phone, `%${search}%`)
                          )
                        : undefined
                )
                .orderBy(desc(employees.createdAt))
                .limit(100)

            return res.json({ success: true, data: { employees: rows } })
        } catch (err: any) {
            console.error('[lksguard/admin/employees]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    // ── Assign / reassign an employee to a company device (#4/#5/#22) ─────────────
    public async handleAssign(req: Request, res: Response) {
        try {
            const parsed = await lksguardAssignModel.safeParseAsync(req.body)
            if (parsed.error) {
                return res.status(400).json({ success: false, message: 'body validation failed', error: parsed.error.issues })
            }
            const { employeeId, deviceId, deviceName, manufacturer, model } = parsed.data

            const [emp] = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1)
            if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' })

            // Resolve/create the device row when the admin names a specific
            // handset; otherwise authorise the employee to bind their own.
            let deviceRowId: string | null = null
            if (deviceId) {
                const [existing] = await db
                    .select()
                    .from(lksguardDevices)
                    .where(eq(lksguardDevices.deviceId, deviceId))
                    .limit(1)
                if (existing) {
                    await db
                        .update(lksguardDevices)
                        .set({
                            employeeId,
                            phone: emp.phone,
                            deviceName: deviceName ?? existing.deviceName,
                            manufacturer: manufacturer ?? existing.manufacturer,
                            model: model ?? existing.model,
                            updatedAt: new Date(),
                        })
                        .where(eq(lksguardDevices.id, existing.id))
                    deviceRowId = existing.id
                } else {
                    const [created] = await db
                        .insert(lksguardDevices)
                        .values({
                            deviceId,
                            employeeId,
                            phone: emp.phone,
                            deviceName: deviceName ?? null,
                            manufacturer: manufacturer ?? null,
                            model: model ?? null,
                            status: 'ACTIVE',
                        })
                        .returning()
                    deviceRowId = created!.id
                }
            }

            await db.transaction(async (tx) => {
                // Close this employee's previous open assignment so history is
                // preserved and only one is live (#22).
                await tx
                    .update(lksguardEmployeeDevices)
                    .set({ unassignedAt: new Date() })
                    .where(
                        and(
                            eq(lksguardEmployeeDevices.employeeId, employeeId),
                            sql`${lksguardEmployeeDevices.unassignedAt} is null`
                        )
                    )
                await tx.insert(lksguardEmployeeDevices).values({
                    employeeId,
                    deviceRowId,
                    assignedBy: adminId(req),
                })
            })

            // Force a password change on first LKSGuard login IF the account is
            // still on the shared default password (#6). We can verify the default
            // by recomputing its hash — never by storing plaintext.
            const [acct] = await db
                .select({ salt: usersTable.salt, password: usersTable.password })
                .from(usersTable)
                .where(eq(usersTable.employeeId, employeeId))
                .limit(1)
            if (acct?.salt && acct.password && hashPassword('12345', acct.salt) === acct.password) {
                await db
                    .update(usersTable)
                    .set({ mustChangePassword: true })
                    .where(eq(usersTable.employeeId, employeeId))
            }

            await this.audit(req, 'ASSIGN_DEVICE', {
                resourceType: 'employee_device',
                employeeId,
                deviceId,
            })

            return res.status(201).json({ success: true, message: 'Device assigned', data: { employeeId, deviceRowId } })
        } catch (err: any) {
            console.error('[lksguard/admin/assign]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    // ── Current assignments (employee ↔ device) for the assignment screen ─────────
    public async handleListAssignments(_req: Request, res: Response) {
        try {
            const rows = await db
                .select({
                    assignmentId: lksguardEmployeeDevices.id,
                    employeeId: employees.id,
                    employeeName: sql<string>`(concat(${employees.firstName}, ' ', ${employees.lastName}))`,
                    employeePhone: employees.phone,
                    deviceId: lksguardDevices.deviceId,
                    deviceName: lksguardDevices.deviceName,
                    model: lksguardDevices.model,
                    status: lksguardDevices.status,
                    assignedAt: lksguardEmployeeDevices.assignedAt,
                })
                .from(lksguardEmployeeDevices)
                .innerJoin(employees, eq(employees.id, lksguardEmployeeDevices.employeeId))
                .leftJoin(lksguardDevices, eq(lksguardDevices.id, lksguardEmployeeDevices.deviceRowId))
                .where(sql`${lksguardEmployeeDevices.unassignedAt} is null`)
                .orderBy(desc(lksguardEmployeeDevices.assignedAt))

            return res.json({ success: true, data: { assignments: rows } })
        } catch (err: any) {
            console.error('[lksguard/admin/assignments]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    // ── Devices (#21) ─────────────────────────────────────────────────────────────
    public async handleListDevices(req: Request, res: Response) {
        try {
            const parsed = await lksguardDeviceListQueryModel.safeParseAsync(req.query)
            if (parsed.error) {
                return res.status(400).json({ success: false, message: 'query validation failed', error: parsed.error.issues })
            }
            const { employeeId, status, page, limit } = parsed.data
            const where = and(
                employeeId ? eq(lksguardDevices.employeeId, employeeId) : undefined,
                status ? eq(lksguardDevices.status, status) : undefined
            )

            const [totalRow] = await db
                .select({ total: count() })
                .from(lksguardDevices)
                .where(where)

            const rows = await db
                .select({
                    id: lksguardDevices.id,
                    deviceId: lksguardDevices.deviceId,
                    employeeId: lksguardDevices.employeeId,
                    employeeName: sql<string>`(concat(${employees.firstName}, ' ', ${employees.lastName}))`,
                    phone: lksguardDevices.phone,
                    deviceName: lksguardDevices.deviceName,
                    manufacturer: lksguardDevices.manufacturer,
                    model: lksguardDevices.model,
                    androidVersion: lksguardDevices.androidVersion,
                    appVersion: lksguardDevices.appVersion,
                    status: lksguardDevices.status,
                    lastSeenAt: lksguardDevices.lastSeenAt,
                    lastSyncAt: lksguardDevices.lastSyncAt,
                    registeredAt: lksguardDevices.registeredAt,
                })
                .from(lksguardDevices)
                .leftJoin(employees, eq(employees.id, lksguardDevices.employeeId))
                .where(where)
                .orderBy(desc(lksguardDevices.lastSeenAt))
                .limit(limit)
                .offset((page - 1) * limit)

            return res.json({
                success: true,
                data: { devices: rows, page, limit, total: Number(totalRow?.total ?? 0) },
            })
        } catch (err: any) {
            console.error('[lksguard/admin/devices]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    public async handleSetDeviceStatus(req: Request, res: Response) {
        try {
            const id = req.params.id as string
            const parsed = await lksguardDeviceStatusModel.safeParseAsync(req.body)
            if (parsed.error) {
                return res.status(400).json({ success: false, message: 'body validation failed', error: parsed.error.issues })
            }
            const [dev] = await db.select().from(lksguardDevices).where(eq(lksguardDevices.id, id)).limit(1)
            if (!dev) return res.status(404).json({ success: false, message: 'Device not found' })

            await db
                .update(lksguardDevices)
                .set({ status: parsed.data.status, updatedAt: new Date() })
                .where(eq(lksguardDevices.id, id))

            await this.audit(req, `DEVICE_${parsed.data.status}`, {
                resourceType: 'device',
                resourceId: dev.deviceId,
                deviceId: dev.deviceId,
                employeeId: dev.employeeId ?? undefined,
            })

            return res.json({ success: true, message: 'Device updated' })
        } catch (err: any) {
            console.error('[lksguard/admin/device-status]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    // ── Paged, server-filtered record listings (#13/#14/#33) ───────────────────────
    private dateRange(from?: string, to?: string) {
        const gte_ = from ? gte : undefined
        void gte_
        return {
            from: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
            to: to ? new Date(`${to}T23:59:59.999Z`) : undefined,
        }
    }

    public async handleListCalls(req: Request, res: Response) {
        try {
            if (!(await this.hasPerm(req, 'lksguard_view'))) {
                return res.status(403).json({ success: false, message: 'Missing LKSGuard view permission' })
            }
            const parsed = await lksguardCallQueryModel.safeParseAsync(req.query)
            if (parsed.error) {
                return res.status(400).json({ success: false, message: 'query validation failed', error: parsed.error.issues })
            }
            const q = parsed.data
            const { from, to } = this.dateRange(q.dateFrom, q.dateTo)
            const where = and(
                q.employeeId ? eq(lksguardCallRecords.employeeId, q.employeeId) : undefined,
                q.deviceId ? eq(lksguardCallRecords.deviceId, q.deviceId) : undefined,
                q.callType ? eq(lksguardCallRecords.callType, q.callType) : undefined,
                q.phoneNumber ? ilike(lksguardCallRecords.phoneNumber, `%${q.phoneNumber}%`) : undefined,
                from ? gte(lksguardCallRecords.eventTime, from) : undefined,
                to ? lte(lksguardCallRecords.eventTime, to) : undefined
            )

            const [totalRow] = await db.select({ total: count() }).from(lksguardCallRecords).where(where)
            const rows = await db
                .select({
                    id: lksguardCallRecords.id,
                    employeeId: lksguardCallRecords.employeeId,
                    employeeName: sql<string>`(concat(${employees.firstName}, ' ', ${employees.lastName}))`,
                    deviceId: lksguardCallRecords.deviceId,
                    phoneNumber: lksguardCallRecords.phoneNumber,
                    callType: lksguardCallRecords.callType,
                    durationSeconds: lksguardCallRecords.durationSeconds,
                    eventTime: lksguardCallRecords.eventTime,
                })
                .from(lksguardCallRecords)
                .leftJoin(employees, eq(employees.id, lksguardCallRecords.employeeId))
                .where(where)
                .orderBy(desc(lksguardCallRecords.eventTime))
                .limit(q.limit)
                .offset((q.page - 1) * q.limit)

            await this.audit(req, 'VIEW_CALLS', { resourceType: 'call', employeeId: q.employeeId })

            return res.json({ success: true, data: { calls: rows, page: q.page, limit: q.limit, total: Number(totalRow?.total ?? 0) } })
        } catch (err: any) {
            console.error('[lksguard/admin/calls]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    public async handleListSms(req: Request, res: Response) {
        try {
            if (!(await this.hasPerm(req, 'lksguard_view'))) {
                return res.status(403).json({ success: false, message: 'Missing LKSGuard view permission' })
            }
            const parsed = await lksguardSmsQueryModel.safeParseAsync(req.query)
            if (parsed.error) {
                return res.status(400).json({ success: false, message: 'query validation failed', error: parsed.error.issues })
            }
            const q = parsed.data
            const { from, to } = this.dateRange(q.dateFrom, q.dateTo)
            const where = and(
                q.employeeId ? eq(lksguardSmsRecords.employeeId, q.employeeId) : undefined,
                q.deviceId ? eq(lksguardSmsRecords.deviceId, q.deviceId) : undefined,
                q.direction ? eq(lksguardSmsRecords.direction, q.direction) : undefined,
                q.phoneNumber ? ilike(lksguardSmsRecords.phoneNumber, `%${q.phoneNumber}%`) : undefined,
                from ? gte(lksguardSmsRecords.messageTime, from) : undefined,
                to ? lte(lksguardSmsRecords.messageTime, to) : undefined
            )

            const [totalRow] = await db.select({ total: count() }).from(lksguardSmsRecords).where(where)
            // Content is deliberately NOT selected — the grid never shows it
            // (#14). Only the audited /sms/:id/content endpoint decrypts it.
            const rows = await db
                .select({
                    id: lksguardSmsRecords.id,
                    employeeId: lksguardSmsRecords.employeeId,
                    employeeName: sql<string>`(concat(${employees.firstName}, ' ', ${employees.lastName}))`,
                    deviceId: lksguardSmsRecords.deviceId,
                    phoneNumber: lksguardSmsRecords.phoneNumber,
                    direction: lksguardSmsRecords.direction,
                    policy: lksguardSmsRecords.policy,
                    hasContent: sql<boolean>`${lksguardSmsRecords.contentCipher} is not null`,
                    messageTime: lksguardSmsRecords.messageTime,
                })
                .from(lksguardSmsRecords)
                .leftJoin(employees, eq(employees.id, lksguardSmsRecords.employeeId))
                .where(where)
                .orderBy(desc(lksguardSmsRecords.messageTime))
                .limit(q.limit)
                .offset((q.page - 1) * q.limit)

            await this.audit(req, 'VIEW_SMS', { resourceType: 'sms', employeeId: q.employeeId })

            return res.json({ success: true, data: { sms: rows, page: q.page, limit: q.limit, total: Number(totalRow?.total ?? 0) } })
        } catch (err: any) {
            console.error('[lksguard/admin/sms]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    // ── SMS content reveal — decrypt + audit every access (#14/#23/#24) ────────────
    public async handleViewSmsContent(req: Request, res: Response) {
        try {
            if (!(await this.hasPerm(req, 'lksguard_sms_content'))) {
                return res.status(403).json({ success: false, message: 'Missing SMS content permission' })
            }
            const id = req.params.id as string
            const [row] = await db.select().from(lksguardSmsRecords).where(eq(lksguardSmsRecords.id, id)).limit(1)
            if (!row) return res.status(404).json({ success: false, message: 'SMS record not found' })

            if (!row.contentCipher || !row.contentIv) {
                // Metadata-only policy: there is no stored content to reveal.
                return res.json({ success: true, data: { available: false, content: null } })
            }

            let content: string | null = null
            try {
                content = decryptSmsContent(row.contentCipher, row.contentIv)
            } catch (err: any) {
                console.error('[lksguard/admin/sms-content] decrypt failed:', err.message)
                return res.status(500).json({ success: false, message: 'Unable to decrypt stored content' })
            }

            await this.audit(req, 'VIEW_SMS_CONTENT', {
                resourceType: 'sms',
                resourceId: id,
                employeeId: row.employeeId,
                deviceId: row.deviceId,
            })

            return res.json({ success: true, data: { available: true, content } })
        } catch (err: any) {
            console.error('[lksguard/admin/sms-content]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    public async handleListContacts(req: Request, res: Response) {
        try {
            if (!(await this.hasPerm(req, 'lksguard_view'))) {
                return res.status(403).json({ success: false, message: 'Missing LKSGuard view permission' })
            }
            const parsed = await lksguardContactQueryModel.safeParseAsync(req.query)
            if (parsed.error) {
                return res.status(400).json({ success: false, message: 'query validation failed', error: parsed.error.issues })
            }
            const q = parsed.data
            const where = and(
                q.employeeId ? eq(lksguardContacts.employeeId, q.employeeId) : undefined,
                q.deviceId ? eq(lksguardContacts.deviceId, q.deviceId) : undefined,
                q.contactName ? ilike(lksguardContacts.contactName, `%${q.contactName}%`) : undefined,
                q.phoneNumber ? ilike(lksguardContacts.phoneNumber, `%${q.phoneNumber}%`) : undefined,
                q.search
                    ? or(
                          ilike(lksguardContacts.contactName, `%${q.search}%`),
                          ilike(lksguardContacts.phoneNumber, `%${q.search}%`)
                      )
                    : undefined
            )

            const [totalRow] = await db.select({ total: count() }).from(lksguardContacts).where(where)
            const rows = await db
                .select({
                    id: lksguardContacts.id,
                    employeeId: lksguardContacts.employeeId,
                    employeeName: sql<string>`(concat(${employees.firstName}, ' ', ${employees.lastName}))`,
                    deviceId: lksguardContacts.deviceId,
                    contactName: lksguardContacts.contactName,
                    phoneNumber: lksguardContacts.phoneNumber,
                    email: lksguardContacts.email,
                    updatedAt: lksguardContacts.updatedAt,
                })
                .from(lksguardContacts)
                .leftJoin(employees, eq(employees.id, lksguardContacts.employeeId))
                .where(where)
                .orderBy(desc(lksguardContacts.updatedAt))
                .limit(q.limit)
                .offset((q.page - 1) * q.limit)

            await this.audit(req, 'VIEW_CONTACTS', { resourceType: 'contact', employeeId: q.employeeId })

            return res.json({ success: true, data: { contacts: rows, page: q.page, limit: q.limit, total: Number(totalRow?.total ?? 0) } })
        } catch (err: any) {
            console.error('[lksguard/admin/contacts]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    // ── Employee detail aggregate (#16) — one employee's device + record counts ──────
    public async handleEmployeeDetail(req: Request, res: Response) {
        try {
            if (!(await this.hasPerm(req, 'lksguard_view'))) {
                return res.status(403).json({ success: false, message: 'Missing LKSGuard view permission' })
            }
            const employeeId = req.params.employeeId as string

            const [emp] = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1)
            if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' })

            const [device] = await db
                .select()
                .from(lksguardDevices)
                .where(eq(lksguardDevices.employeeId, employeeId))
                .orderBy(desc(lksguardDevices.lastSeenAt))
                .limit(1)

            const [calls] = await db
                .select({ total: count() })
                .from(lksguardCallRecords)
                .where(eq(lksguardCallRecords.employeeId, employeeId))
            const [sms] = await db
                .select({ total: count() })
                .from(lksguardSmsRecords)
                .where(eq(lksguardSmsRecords.employeeId, employeeId))
            const [contacts] = await db
                .select({ total: count() })
                .from(lksguardContacts)
                .where(eq(lksguardContacts.employeeId, employeeId))

            await this.audit(req, 'VIEW_EMPLOYEE_DETAIL', { resourceType: 'employee', employeeId })

            return res.json({
                success: true,
                data: {
                    employee: {
                        id: emp.id,
                        firstName: emp.firstName,
                        lastName: emp.lastName,
                        phone: emp.phone,
                        designation: emp.designation,
                    },
                    device: device
                        ? {
                              deviceId: device.deviceId,
                              status: device.status,
                              model: device.model,
                              manufacturer: device.manufacturer,
                              lastSeenAt: device.lastSeenAt,
                              lastSyncAt: device.lastSyncAt,
                          }
                        : null,
                    counts: {
                        calls: Number(calls?.total ?? 0),
                        sms: Number(sms?.total ?? 0),
                        contacts: Number(contacts?.total ?? 0),
                    },
                },
            })
        } catch (err: any) {
            console.error('[lksguard/admin/employee-detail]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    // ── Audit logs (#23) ────────────────────────────────────────────────────────────
    public async handleListAuditLogs(req: Request, res: Response) {
        try {
            const parsed = await lksguardAuditQueryModel.safeParseAsync(req.query)
            if (parsed.error) {
                return res.status(400).json({ success: false, message: 'query validation failed', error: parsed.error.issues })
            }
            const q = parsed.data
            const where = and(
                q.adminUserId ? eq(lksguardAuditLogs.adminUserId, q.adminUserId) : undefined,
                q.action ? eq(lksguardAuditLogs.action, q.action) : undefined,
                q.employeeId ? eq(lksguardAuditLogs.employeeId, q.employeeId) : undefined
            )

            const [totalRow] = await db.select({ total: count() }).from(lksguardAuditLogs).where(where)
            const rows = await db
                .select({
                    id: lksguardAuditLogs.id,
                    adminUserId: lksguardAuditLogs.adminUserId,
                    adminPhone: usersTable.phone,
                    action: lksguardAuditLogs.action,
                    resourceType: lksguardAuditLogs.resourceType,
                    resourceId: lksguardAuditLogs.resourceId,
                    employeeId: lksguardAuditLogs.employeeId,
                    deviceId: lksguardAuditLogs.deviceId,
                    ipAddress: lksguardAuditLogs.ipAddress,
                    createdAt: lksguardAuditLogs.createdAt,
                })
                .from(lksguardAuditLogs)
                .leftJoin(usersTable, eq(usersTable.id, lksguardAuditLogs.adminUserId))
                .where(where)
                .orderBy(desc(lksguardAuditLogs.createdAt))
                .limit(q.limit)
                .offset((q.page - 1) * q.limit)

            return res.json({ success: true, data: { logs: rows, page: q.page, limit: q.limit, total: Number(totalRow?.total ?? 0) } })
        } catch (err: any) {
            console.error('[lksguard/admin/audit-logs]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    // ── Retention settings (#30) — read/write the app_settings KV rows ──────────────
    public async handleGetRetention(_req: Request, res: Response) {
        try {
            const rows = await db
                .select({ key: appSettings.key, value: appSettings.value })
                .from(appSettings)
                .where(
                    sql`${appSettings.key} in (${sql.join(Object.values(RETENTION_KEYS), sql`,`)})`
                )
            const byKey = new Map(rows.map((r) => [r.key, r.value]))
            const num = (k: string) => Number(byKey.get(k) ?? DEFAULT_RETENTION_DAYS)

            return res.json({
                success: true,
                data: {
                    retention: {
                        callsDays: num(RETENTION_KEYS.callsDays),
                        smsMetaDays: num(RETENTION_KEYS.smsMetaDays),
                        smsContentDays: num(RETENTION_KEYS.smsContentDays),
                        contactsDays: num(RETENTION_KEYS.contactsDays),
                        auditDays: num(RETENTION_KEYS.auditDays),
                    },
                },
            })
        } catch (err: any) {
            console.error('[lksguard/admin/retention-get]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    public async handlePutRetention(req: Request, res: Response) {
        try {
            const parsed = await lksguardRetentionModel.safeParseAsync(req.body)
            if (parsed.error) {
                return res.status(400).json({ success: false, message: 'body validation failed', error: parsed.error.issues })
            }
            const map: Record<string, number | undefined> = {
                [RETENTION_KEYS.callsDays]: parsed.data.callsDays,
                [RETENTION_KEYS.smsMetaDays]: parsed.data.smsMetaDays,
                [RETENTION_KEYS.smsContentDays]: parsed.data.smsContentDays,
                [RETENTION_KEYS.contactsDays]: parsed.data.contactsDays,
                [RETENTION_KEYS.auditDays]: parsed.data.auditDays,
            }
            for (const [key, value] of Object.entries(map)) {
                if (value === undefined) continue
                await db
                    .insert(appSettings)
                    .values({ key, value: String(value), updatedAt: new Date() })
                    .onConflictDoUpdate({ target: appSettings.key, set: { value: String(value), updatedAt: new Date() } })
            }
            await this.audit(req, 'UPDATE_RETENTION', { resourceType: 'settings' })
            return res.json({ success: true, message: 'Retention updated' })
        } catch (err: any) {
            console.error('[lksguard/admin/retention-put]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }
}

export default LksGuardAdminController
