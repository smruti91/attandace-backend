import { z } from 'zod'

/**
 * Request models for LKSGuard. Every payload crossing the network is parsed
 * before it reaches the queue or database — a malformed call/SMS row or a
 * spoofed employee/device id can never poison the audit history.
 *
 * Note what is NOT here: employeeId and deviceId are never taken from the
 * event bodies. The sync handler derives them from the authenticated user's
 * ACTIVE device binding, so a client cannot re-attribute a record (#22/#24).
 */

// ── Mobile auth ────────────────────────────────────────────────────────────────
export const lksguardLoginModel = z.object({
    phone: z.string().min(10).max(15),
    password: z.string().min(5),
})

export const lksguardChangePasswordModel = z.object({
    // 5 chars minimum matches the existing account scheme; the DEFAULT password
    // (12345) is exactly 5, so a new one must simply differ from it (checked in
    // the handler) rather than being longer.
    newPassword: z.string().min(5).max(72),
})

// ── Mobile device registration ───────────────────────────────────────────────
// The app generates `deviceId` once (a random install id kept in SecureStorage)
// and persists it. Everything else is descriptive device metadata.
export const lksguardRegisterDeviceModel = z.object({
    deviceId: z
        .string()
        .min(8)
        .max(64)
        .regex(/^[A-Za-z0-9_-]+$/, 'deviceId must be alphanumeric (with -/_) only'),
    deviceName: z.string().max(120).nullish(),
    manufacturer: z.string().max(60).nullish(),
    model: z.string().max(60).nullish(),
    androidVersion: z.string().max(30).nullish(),
    appVersion: z.string().max(30).nullish(),
})

// ── Mobile heartbeat (permission snapshot + last-seen) ─────────────────────────
export const lksguardHeartbeatModel = z.object({
    permCall: z.boolean().optional(),
    permSms: z.boolean().optional(),
    permContacts: z.boolean().optional(),
    appVersion: z.string().max(30).optional(),
})

// ── Mobile sync batch ──────────────────────────────────────────────────────────
const isoDate = (field: string) =>
    z
        .string()
        .refine((v) => !Number.isNaN(new Date(v).getTime()), `${field} must be an ISO date`)

export const callEventModel = z.object({
    eventUuid: z.string().uuid(),
    phoneNumber: z.string().max(20).nullish(),
    callType: z.enum(['INCOMING', 'OUTGOING', 'MISSED']),
    startedAt: isoDate('startedAt').nullish(),
    endedAt: isoDate('endedAt').nullish(),
    // Missed calls legitimately carry 0; cap the rest at a day (86400s).
    durationSeconds: z.coerce.number().int().min(0).max(86400),
    eventTime: isoDate('eventTime'),
})

export const smsEventModel = z.object({
    eventUuid: z.string().uuid(),
    phoneNumber: z.string().max(20).nullish(),
    direction: z.enum(['SENT', 'RECEIVED']),
    messageTimestamp: isoDate('messageTimestamp').nullish(),
    policy: z.enum(['SMS_METADATA_ONLY', 'SMS_CONTENT']).default('SMS_METADATA_ONLY'),
    // Raw plaintext (metadata-only batches omit it). The handler encrypts before
    // enqueueing, so plaintext never reaches Redis or the worker.
    content: z.string().max(4096).nullish(),
    messageTime: isoDate('messageTime'),
})

export const contactEventModel = z.object({
    contactUuid: z.string().min(1).max(64),
    contactName: z.string().max(200).nullish(),
    phoneNumber: z.string().max(20).nullish(),
    email: z.string().max(160).nullish(),
})

// Envelope for the sync handler: validates the batch CONTAINER (device id, the
// per-array ceilings, and that something was sent) while leaving each event body
// unchecked here. handleSync parses events one at a time against the strict
// models above, so a single row that exceeds a column limit is reported and
// skipped instead of failing `lksguardSyncModel` wholesale — which would reject
// the other 658 contacts in the batch on every retry, forever.
export const lksguardSyncEnvelopeModel = z
    .object({
        deviceId: z.string().min(8).max(64),
        calls: z.array(z.unknown()).max(500).default([]),
        sms: z.array(z.unknown()).max(500).default([]),
        contacts: z.array(z.unknown()).max(2000).default([]),
    })
    .refine(
        (d) => d.calls.length + d.sms.length + d.contacts.length > 0,
        { message: 'Batch must contain at least one event' }
    )

// One batch is capped so a runaway/huge offline backlog is split across calls
// rather than one oversized request; the app chunks to this ceiling.
export const lksguardSyncModel = z
    .object({
        deviceId: z.string().min(8).max(64),
        calls: z.array(callEventModel).max(500).default([]),
        sms: z.array(smsEventModel).max(500).default([]),
        contacts: z.array(contactEventModel).max(2000).default([]),
    })
    .refine(
        (d) => d.calls.length + d.sms.length + d.contacts.length > 0,
        { message: 'Batch must contain at least one event' }
    )

// ── Admin: employee–device assignment ──────────────────────────────────────────
// Admin picks an existing employee and a device (either an already-registered
// deviceId, or a fresh one being provisioned). The employee becomes authorised
// to bind that device.
export const lksguardAssignModel = z.object({
    employeeId: z.string().uuid(),
    // Optional deviceId so an admin can pre-register the assignment before the
    // handset has ever talked to the server; otherwise the open assignment is
    // matched by deviceId at device-register time.
    deviceId: z.string().min(8).max(64).optional(),
    deviceName: z.string().max(120).optional(),
    manufacturer: z.string().max(60).optional(),
    model: z.string().max(60).optional(),
})

// ── Admin: device status change (#21) ──────────────────────────────────────────
export const lksguardDeviceStatusModel = z.object({
    status: z.enum(['ACTIVE', 'BLOCKED', 'DEACTIVATED']),
})

// ── Admin: shared paginated filter for call/SMS/contact listings ───────────────
const baseListQuery = {
    employeeId: z.string().uuid().optional(),
    deviceId: z.string().min(1).optional(),
    // Inclusive date range, YYYY-MM-DD (calendar day); bounds widened to full
    // days server-side in the handler so a "to" day includes its 23:59 events.
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dateFrom must be YYYY-MM-DD').optional(),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dateTo must be YYYY-MM-DD').optional(),
    phoneNumber: z.string().max(20).optional(),
    search: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
}

export const lksguardCallQueryModel = z.object({
    ...baseListQuery,
    callType: z.enum(['INCOMING', 'OUTGOING', 'MISSED']).optional(),
})

export const lksguardSmsQueryModel = z.object({
    ...baseListQuery,
    direction: z.enum(['SENT', 'RECEIVED']).optional(),
})

export const lksguardContactQueryModel = z.object({
    employeeId: z.string().uuid().optional(),
    deviceId: z.string().min(1).optional(),
    contactName: z.string().max(200).optional(),
    phoneNumber: z.string().max(20).optional(),
    search: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const lksguardDeviceListQueryModel = z.object({
    employeeId: z.string().uuid().optional(),
    status: z.enum(['ACTIVE', 'BLOCKED', 'DEACTIVATED']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const lksguardAuditQueryModel = z.object({
    adminUserId: z.string().uuid().optional(),
    action: z.string().max(40).optional(),
    employeeId: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
})

// ── Admin: retention settings (#30) ────────────────────────────────────────────
// Days, 1–3650, applied only where a value is sent (partial PUT).
export const lksguardRetentionModel = z
    .object({
        callsDays: z.number().int().min(1).max(3650).optional(),
        smsMetaDays: z.number().int().min(1).max(3650).optional(),
        smsContentDays: z.number().int().min(1).max(3650).optional(),
        contactsDays: z.number().int().min(1).max(3650).optional(),
        auditDays: z.number().int().min(1).max(3650).optional(),
    })
    .refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one retention value' })
