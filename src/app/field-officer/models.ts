import { z } from 'zod';

/**
 * Request models for the Field Officer visit flow. Every payload crossing the
 * network is parsed before it reaches the database so a malformed point or a
 * swapped lat/lng can't poison the tracking history the OH dashboard renders.
 */

// ── Mobile: check-in ─────────────────────────────────────────────────────────
export const checkInModel = z.object({
    siteId: z.string().uuid('siteId must be a uuid'),
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
});

// ── Mobile: check-out ────────────────────────────────────────────────────────
export const checkOutModel = z.object({
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
});

// ── Mobile: batched GPS points ───────────────────────────────────────────────
// One row per point. `uuid` is the client-generated idempotency key; a point
// whose upload timed out and was retried dedupes on it server-side.
export const locationPointModel = z.object({
    uuid: z.string().uuid(),
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
    accuracy: z.coerce.number().min(0).max(100000).nullish(),
    speed: z.coerce.number().min(-1).max(1000).nullish(),
    batteryLevel: z.coerce.number().min(0).max(100).nullish(),
    heading: z.coerce.number().min(0).max(360).nullish(),
    // Device clock at capture. ISO-8601 with timezone — new Date() must yield
    // a finite time or the point is rejected.
    recordedAt: z
        .string()
        .refine((v) => !Number.isNaN(new Date(v).getTime()), 'recordedAt must be an ISO date'),
});

export const uploadLocationsModel = z.object({
    points: z.array(locationPointModel).min(1).max(500),
});

// ── Admin (OH web): visit listing filters ────────────────────────────────────
export const visitListQueryModel = z.object({
    fieldOfficerUserId: z.string().uuid('fieldOfficerUserId must be a uuid'),
    // Plain calendar date; the range is derived server-side in IST so an
    // officer's 9pm visit never lands on the wrong day.
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
});

// ── Admin (OH web): per-officer day summary ──────────────────────────────────
// No officer filter — the overview table lists every field officer at once.
export const daySummaryQueryModel = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
});

// ── Admin (LKS): OH attendance grid ──────────────────────────────────────────
// The "OH Employee Attendance" page list: server-side date/location/site
// filters and pagination — the grid never ships unfiltered rows.
export const ohAttendanceQueryModel = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    locationId: z.string().uuid('locationId must be a uuid').optional(),
    siteId: z.string().uuid('siteId must be a uuid').optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().min(1).max(100).optional(),
});

// ── Admin (LKS): OH attendance detail (one employee, one day) ───────────────
// The employee id comes from the path; the date is required so the report is
// never an unscoped full-history dump.
export const ohAttendanceDetailQueryModel = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
});

// ── Admin (OH web): replace an officer's site assignments ────────────────────
// The LKS "Field Officers" page drives this with a checkbox list: the payload
// is the complete desired set, so checking/unchecking is one idempotent call.
export const replaceOfficerSitesModel = z.object({
    siteIds: z.array(z.string().uuid()).max(500),
});

// ── Mobile: tracking-session boundaries ──────────────────────────────────────
// Face Check-In opens the session, Face Check-Out closes it. The app verifies
// the face first (POST /auth/fo/verify-face) and then calls these with the
// High-accuracy fix captured at that moment.
export const sessionFixModel = z.object({
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
    accuracy: z.coerce.number().min(0).max(100000).nullish(),
});

// ── Mobile: face verification (check-in / check-out gate) ────────────────────
// Verify-only: unlike /auth/attendance/mark it writes no attendance row — it
// just answers whether the frame matches the officer's enrolled face.
export const foVerifyFaceModel = z.object({
    image: z.string().min(1, 'image is required'),
});

// ── Mobile: shift-attendance report (read-only) ──────────────────────────────
// Site and date are required so the backend never dumps history unscoped; the
// site is additionally checked against the viewer's authorized sites inside the
// handler. `shift` narrows to one of the site-level shift vocabulary values, and
// `foUserId` is a Circle Officer-only narrowing onto one of HIS Field Officers
// (a non-CO sending it is refused, and a foreign id never reads as empty data).
export const foShiftAttendanceQueryModel = z.object({
    siteId: z.string().uuid('siteId must be a uuid'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    shift: z.enum(['morning', 'day', 'night', 'general']).optional(),
    foUserId: z.string().uuid('foUserId must be a uuid').optional(),
});
