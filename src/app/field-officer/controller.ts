import type { Request, Response } from 'express';
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';

import { db } from '../../db';
import {
    usersTable,
    employees,
    sites,
    clientLocations,
    fieldOfficerSites,
    employeeSites,
    shiftAttendance,
    visits,
    visitLocationPoints,
    trackingSessions,
    appSettings,
    foVisitEvents,
} from '../../db/schema';
import {
    checkInModel,
    checkOutModel,
    daySummaryQueryModel,
    foShiftAttendanceQueryModel,
    foVerifyFaceModel,
    ohAttendanceDetailQueryModel,
    ohAttendanceQueryModel,
    replaceOfficerSitesModel,
    sessionFixModel,
    uploadLocationsModel,
    visitListQueryModel,
} from './models';
import {
    getFoShiftListCached,
    setFoShiftListCached,
} from '../../services/shiftAttendanceCache';
import {
    VIEWER_ROLES,
    fieldOfficerSitesFor,
    isCircleOfficer,
    resolveViewerSiteScope,
} from '../../services/circleOfficerScope';
import { verifyFace, MATCH_THRESHOLD } from '../../services/faceService.js';
import {
    enqueueVisitLocations,
    type QueuedLocationPoint,
} from '../../services/visitLocationQueue';
import { runAutoCheckout } from '../../services/autoCheckout.js';
import {
    clearSitesCacheOnly,
    clearTrackingCache,
    getCachedActiveSite,
    getCachedSession,
    getCachedSites,
    setCachedActiveSite,
    setCachedSession,
    setCachedSites,
    touchSession,
    type CachedActiveSite,
    type CachedSite,
} from '../../services/foTrackingCache';

// ── Constants ────────────────────────────────────────────────────────────────
// Role this whole module gates on. Kept beside the endpoints so a rename is
// one edit, not a hunt through string literals.
export const FIELD_OFFICER_ROLE = 'field_officer';

// Operational Head. Reuses the exact same face-verified check-in + GPS
// tracking + auto site-visit detection engine as the Field Officer (same
// tracking_sessions / visits / points tables), so the mobile guards below
// accept either role. The one difference lives in the sweeper: OH sessions are
// closed by the end-of-day (23:59) rule, not the 10-hour max-duty one.
export const OH_ROLE = 'oh';

// Circle Officer. Does NOT drive the tracking/visit engine (requireFieldOfficer
// stays FO|OH), but reuses the same field_officer_sites posting table and the
// officer-scoped attendance reports, so the admin posting endpoints below
// accept it alongside Field Officers and Operational Heads.
export const CO_ROLE = 'co';

// Settings key holding the tracking interval in minutes. The mobile app reads
// it from GET /auth/fo/config at sign-in / screen load; changing it here takes
// effect on the officer's next visit without an app release.
const TRACKING_INTERVAL_KEY = 'fo_tracking_interval_minutes';
const DEFAULT_TRACKING_INTERVAL_MINUTES = 5;

// Points may only be attached to a visit inside this tolerance around the
// check-in / check-out moments. Wide enough for offline queuing (a point
// captured at 17:58 can reach the server at 18:20 and still belong), tight
// enough that a stray batch can never fabricate history for another day.
const WINDOW_TOLERANCE_MS = 10 * 60 * 1000;

// Clock skew between server and phone. A point stamped slightly in the future
// is tolerated up to this much, then rejected outright.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

// The visit row with the joined site/location names — the shape both the
// mobile app and the OH dashboard consume.
const visitWithSiteSelect = {
    id: visits.id,
    fieldOfficerUserId: visits.fieldOfficerUserId,
    siteId: visits.siteId,
    trackingSessionId: visits.trackingSessionId,
    siteName: sites.siteName,
    siteCode: sites.siteCode,
    locationName: clientLocations.locationName,
    checkInAt: visits.checkInAt,
    checkInLatitude: visits.checkInLatitude,
    checkInLongitude: visits.checkInLongitude,
    checkOutAt: visits.checkOutAt,
    checkOutLatitude: visits.checkOutLatitude,
    checkOutLongitude: visits.checkOutLongitude,
    status: visits.status,
};

function joinSiteForVisits() {
    return db
        .select(visitWithSiteSelect)
        .from(visits)
        .innerJoin(sites, eq(visits.siteId, sites.id))
        .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id));
}

/** Calendar date (YYYY-MM-DD) → [start, end) instants, pinned to IST. The
 * connection pool sets TIME ZONE 'Asia/Kolkata' (db/index.ts), so the date
 * string resolves on the office clock, not the server's. */
function istDayRange(date: string): { from: Date; to: Date } {
    const from = new Date(`${date}T00:00:00+05:30`);
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
    return { from, to };
}

export default class FieldOfficerController {
    // ── Shared guards ────────────────────────────────────────────────────────

    /** Resolve the signed-in account from the verified token, answering 401 when
     * there is none. No role decision here — each guard adds its own, so the
     * read-only reporting surface and the write/tracking surface can never share
     * one accidental permission. */
    private async resolveAccount(
        req: Request,
        res: Response
    ): Promise<typeof usersTable.$inferSelect | null> {
        // @ts-ignore — req.user is set by authenticationMiddleware
        const userId = req.user?.id as string | undefined;
        if (!userId) {
            res.status(401).json({ success: false, message: 'Authentication required' });
            return null;
        }

        const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
        if (!user) {
            res.status(401).json({ success: false, message: 'Authentication required' });
            return null;
        }

        return user;
    }

    /**
     * Guard for the READ-ONLY shift-attendance viewing endpoints: Field Officer,
     * Operational Head, or Circle Officer. Deliberately separate from
     * requireFieldOfficer, which also gates check-in, check-out, session and
     * face-verification writes — widening THAT guard would have handed a Circle
     * Officer the tracking engine, which he must never have. Nothing here grants
     * a write; each handler still scopes its own query.
     */
    private async requireSiteViewer(
        req: Request,
        res: Response
    ): Promise<typeof usersTable.$inferSelect | null> {
        const user = await this.resolveAccount(req, res);
        if (!user) return null;
        if (!user.roles?.some((r) => VIEWER_ROLES.includes(r))) {
            res.status(403).json({ success: false, message: 'Officer role required' });
            return null;
        }
        return user;
    }

    /** Resolve the signed-in user and confirm the field_officer role. Returns
     * null after already sending the error response, or the user row. */
    private async requireFieldOfficer(
        req: Request,
        res: Response
    ): Promise<typeof usersTable.$inferSelect | null> {
        const user = await this.resolveAccount(req, res);
        if (!user) return null;

        // Both the Field Officer and the Operational Head drive the same
        // tracking engine, so either role may open/read/close a session here.
        // Widened additively — an existing field_officer still passes.
        if (!user.roles?.includes(FIELD_OFFICER_ROLE) && !user.roles?.includes(OH_ROLE)) {
            res.status(403).json({ success: false, message: 'Field Officer or Operational Head role required' });
            return null;
        }

        return user;
    }

    /**
     * The officer's assigned, still-active sites.
     *
     * `field_officer_sites` is the posting table: a Field Officer is put on
     * several client sites there, and that list is the hard authorization
     * boundary for every officer-scoped report — so for that role the answer is
     * exactly what the admin posted, never anything more.
     *
     * An Operational Head is different by design. He works from the ONE office
     * site on his own employee record (`employee_sites`, assigned there like
     * every other employee) and is normally not posted in the Officers & Sites
     * screen at all. Reading only the posting table made the tracking engine
     * answer "No sites are assigned to you yet" for an OH whose site was
     * visibly assigned in the panel. So: postings first, and when an account
     * carrying the `oh` role has none, fall back to his own assigned site.
     */
    private async loadAssignedSites(userId: string) {
        const posted = await db
            .select({
                id: sites.id,
                siteName: sites.siteName,
                siteCode: sites.siteCode,
                address: sites.address,
                latitude: sites.latitude,
                longitude: sites.longitude,
                // The app enforces the site geofence before face verification,
                // so the radius must travel with the site list.
                allowedRadiusMeters: sites.allowedRadiusMeters,
                parentLocationName: clientLocations.locationName,
            })
            .from(fieldOfficerSites)
            .innerJoin(sites, eq(fieldOfficerSites.siteId, sites.id))
            .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
            .where(and(eq(fieldOfficerSites.fieldOfficerUserId, userId), eq(sites.isActive, true)))
            .orderBy(asc(clientLocations.locationName), asc(sites.siteName));
        if (posted.length) return posted;

        // An empty posting list stays empty for every role except OH — a Field
        // Officer or Circle Officer the admin left unposted must not gain the
        // site on their own employee record.
        const [account] = await db
            .select({ roles: usersTable.roles, employeeId: usersTable.employeeId })
            .from(usersTable)
            .where(eq(usersTable.id, userId))
            .limit(1);
        if (!account?.employeeId || !account.roles?.includes(OH_ROLE)) return posted;

        return db
            .select({
                id: sites.id,
                siteName: sites.siteName,
                siteCode: sites.siteCode,
                address: sites.address,
                latitude: sites.latitude,
                longitude: sites.longitude,
                allowedRadiusMeters: sites.allowedRadiusMeters,
                parentLocationName: clientLocations.locationName,
            })
            .from(employeeSites)
            .innerJoin(sites, eq(employeeSites.siteId, sites.id))
            .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
            .where(and(eq(employeeSites.employeeId, account.employeeId), eq(sites.isActive, true)))
            .orderBy(asc(clientLocations.locationName), asc(sites.siteName));
    }

    // ── Mobile: config ───────────────────────────────────────────────────────

    /** GET /auth/fo/config — the tracking interval and friends, so the app
     * never hard-codes them. Unknown or out-of-range values fall back to the
     * built-in default rather than breaking the visit flow. */
    public async handleConfig(_req: Request, res: Response) {
        try {
            const [row] = await db
                .select()
                .from(appSettings)
                .where(eq(appSettings.key, TRACKING_INTERVAL_KEY));

            const parsed = row?.value ? Number(row.value) : NaN;
            const trackingIntervalMinutes = Number.isFinite(parsed) && parsed >= 1 && parsed <= 120
                ? parsed
                : DEFAULT_TRACKING_INTERVAL_MINUTES;

            // Max duty before the server auto-closes a session (hours).
            const [dutyRow] = await db
                .select()
                .from(appSettings)
                .where(eq(appSettings.key, 'fo_max_duty_hours'));
            const dutyParsed = dutyRow?.value ? Number(dutyRow.value) : NaN;
            const maxDutyHours =
                Number.isFinite(dutyParsed) && dutyParsed >= 1 && dutyParsed <= 24
                    ? dutyParsed
                    : 10;

            return res.json({
                success: true,
                data: {
                    trackingIntervalMinutes,
                    maxDutyHours,
                    // Server time, so the app can detect gross clock skew when
                    // stamping GPS points.
                    serverTime: new Date().toISOString(),
                },
            });
        } catch (err: any) {
            console.error('[fo-config]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Mobile: assigned sites ───────────────────────────────────────────────

    /** GET /auth/fo/my-sites — the dropdown contents. A Field Officer or OH gets
     * exactly the sites he is currently posted to, so the app never has to filter
     * client-side. A Circle Officer gets the sites of the Field Officers assigned
     * to him as well, each carrying those officers — the read-only Shift
     * Attendance screen then needs no role check of its own to show its Field
     * Officer filter. */
    public async handleMySites(req: Request, res: Response) {
        try {
            const user = await this.requireSiteViewer(req, res);
            if (!user) return;

            const posted = await this.loadAssignedSites(user.id);
            if (!isCircleOfficer(user.roles)) {
                return res.json({ success: true, data: { sites: posted, scope: 'officer-sites' as const } });
            }

            const viewer = await resolveViewerSiteScope(user);
            // Own postings first (they keep the OH single-office fallback this
            // helper already implements), then every site the CO reaches
            // through an assigned Field Officer, with its officers attached.
            const byId = new Map(posted.map((s) => [s.id, { ...s, officers: [] as typeof viewer.officers }]));
            for (const s of viewer.sites) {
                byId.set(s.id, {
                    id: s.id,
                    siteName: s.siteName,
                    siteCode: s.siteCode,
                    address: s.address,
                    latitude: s.latitude,
                    longitude: s.longitude,
                    allowedRadiusMeters: s.allowedRadiusMeters,
                    parentLocationName: s.locationName,
                    officers: s.officers,
                });
            }
            const sitesList = [...byId.values()].sort((a, b) =>
                String(a.parentLocationName).localeCompare(String(b.parentLocationName))
                || String(a.siteName).localeCompare(String(b.siteName)));

            return res.json({
                success: true,
                data: { sites: sitesList, scope: viewer.scope, fieldOfficers: viewer.officers },
            });
        } catch (err: any) {
            console.error('[fo-my-sites]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Mobile: shift-attendance report (read-only) ──────────────────────────
    /** GET /auth/fo/shift-attendance?siteId=<uuid>&date=YYYY-MM-DD[&shift=][&foUserId=]
     * — the Supervisor shift_attendance rows for one site this viewer is
     * authorized to read. Read-only by construction: no create/update/delete
     * lives on this path, the CO never acquires the `shift-attendance` page key
     * that the supervisor write guard requires, and the guard used here is the
     * viewer guard rather than the tracking guard.
     *
     * An FO/OH site list still comes from his own posting; a Circle Officer's
     * from the Field Officers assigned to him. Same record shape either way, so
     * the existing screen is reused instead of a second viewer being built.
     * PG is the truth; Redis (`shift-attendance:fo:*`) is a 5-min read-through
     * keyed per viewer, site, date and shift, degrading to PG on any error. */
    public async handleFoShiftAttendance(req: Request, res: Response) {
        try {
            const user = await this.requireSiteViewer(req, res);
            if (!user) return;

            const parsed = foShiftAttendanceQueryModel.safeParse(req.query);
            if (parsed.error) {
                return res.status(400).json({ success: false, message: 'body validation failed', error: parsed.error.issues });
            }
            const { siteId, date, shift, foUserId } = parsed.data;

            // Historical viewing is allowed; the future has no records.
            const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
            if (date > today) {
                return res.status(400).json({ success: false, message: 'Invalid date. Use YYYY-MM-DD, not in the future.' });
            }

            // ── Site authorization, and who covers this site ────────────────
            let siteName = '';
            let siteOfficers: { id: string; name: string }[] = [];
            let scope: 'officer-sites' | 'circle-officer' = 'officer-sites';

            if (isCircleOfficer(user.roles)) {
                scope = 'circle-officer';
                const viewer = await resolveViewerSiteScope(user);
                const site = viewer.sites.find((s) => s.id === siteId);
                if (!site) {
                    return res.status(403).json({ success: false, message: 'You are not authorized to view attendance for this site.' });
                }
                siteName = site.siteName;
                siteOfficers = site.officers;
                if (foUserId) {
                    // The officer must be actively assigned to this CO, and this
                    // site must be one of his. Both failures answer 403 rather
                    // than an empty list, so a forged id reads as a refusal.
                    const officerSites = await fieldOfficerSitesFor(user.id, foUserId);
                    if (!officerSites || !officerSites.includes(siteId)) {
                        return res.status(403).json({ success: false, message: 'You are not authorized to view attendance for this field officer.' });
                    }
                    siteOfficers = siteOfficers.filter((o) => o.id === foUserId);
                }
            } else {
                if (foUserId) {
                    return res.status(403).json({ success: false, message: 'Field Officer filter is available to Circle Officers only.' });
                }
                // Site authorization: the requested site must be one of this
                // officer's active postings — never trust the client id alone.
                const [posting] = await db
                    .select({ siteId: fieldOfficerSites.siteId, siteName: sites.siteName })
                    .from(fieldOfficerSites)
                    .innerJoin(sites, eq(fieldOfficerSites.siteId, sites.id))
                    .where(and(
                        eq(fieldOfficerSites.fieldOfficerUserId, user.id),
                        eq(fieldOfficerSites.siteId, siteId),
                        eq(sites.isActive, true),
                    ))
                    .limit(1);
                if (!posting) {
                    return res.status(403).json({ success: false, message: 'You are not authorized to view attendance for this site.' });
                }
                siteName = posting.siteName;
            }

            const payload = (records: unknown[]) => ({
                siteId,
                siteName,
                date,
                shift: shift ?? null,
                scope,
                fieldOfficers: siteOfficers,
                records,
            });

            const cached = await getFoShiftListCached(user.id, siteId, date, shift);
            if (cached) {
                return res.json({ success: true, data: payload(cached) });
            }

            const rows = await db
                .select()
                .from(shiftAttendance)
                .where(and(
                    eq(shiftAttendance.siteId, siteId),
                    eq(shiftAttendance.attendanceDate, date),
                    ...(shift ? [eq(shiftAttendance.shift, shift)] : []),
                ))
                .orderBy(asc(shiftAttendance.createdAt))
                .limit(100);

            const records = rows.map((row) => ({
                id: row.id,
                siteId: row.siteId,
                siteName,
                attendanceDate: row.attendanceDate,
                shift: row.shift,
                presentEmployees: row.presentEmployees,
                description: row.description ?? null,
                imagePath: row.imagePath,
                imageUrl: !row.imagePath
                    ? null
                    : row.imagePath.startsWith('/uploads/')
                        ? row.imagePath
                        : row.imagePath.startsWith('/')
                            ? `/uploads${row.imagePath}`
                            : `/uploads/${row.imagePath}`,
                createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
                updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
            }));

            await setFoShiftListCached(user.id, siteId, date, records, shift);
            return res.json({ success: true, data: payload(records) });
        } catch (err: any) {
            console.error('[fo-shift-attendance]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Mobile: visit lifecycle ──────────────────────────────────────────────

    /** POST /auth/fo/verify-face
     * Body: { image } — raw JPEG base64 (a `data:image/...;base64,` prefix is
     * tolerated and stripped).
     *
     * Verify-only gate for the check-in / check-out flow: answers whether the
     * frame matches the signed-in officer's enrolled face. Writes nothing —
     * visit rows are created exclusively by the check-in / check-out
     * endpoints, so a failed face attempt can never fabricate a visit.
     */
    public async handleVerifyFace(req: Request, res: Response) {
        try {
            const user = await this.requireFieldOfficer(req, res);
            if (!user) return;

            const parsed = foVerifyFaceModel.safeParse(req.body);
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: 'body validation failed',
                    error: parsed.error.issues,
                });
            }

            if (!user.employeeId) {
                return res.status(404).json({ success: false, message: 'Employee not linked' });
            }
            const [emp] = await db
                .select({
                    hasRegisteredFace: employees.hasRegisteredFace,
                    faceEmbedding: employees.faceEmbedding,
                })
                .from(employees)
                .where(eq(employees.id, user.employeeId));
            if (!emp?.hasRegisteredFace || !emp.faceEmbedding) {
                return res.status(400).json({
                    success: false,
                    verified: false,
                    message: 'Face not registered yet. Please register first.',
                });
            }

            const base64 = parsed.data.image.replace(
                /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
                ''
            );

            const { success, verified, distance, message, liveness } = await verifyFace(
                base64,
                emp.faceEmbedding as number[],
                MATCH_THRESHOLD
            );

            if (!success) {
                // Tell the officer WHY: "spoof" here almost always means a
                // dark frame confusing the anti-spoofing model, not a real
                // spoof attempt — an actionable retry beats a false accusation.
                const hint =
                    liveness?.success && !liveness.is_real
                        ? ' Lighting looks too low — move to a brighter spot and try again.'
                        : '';
                return res.status(400).json({
                    success: false,
                    verified: false,
                    message: `${message || 'No face detected. Please retry.'}${hint}`,
                });
            }
            if (!verified) {
                return res.status(401).json({
                    success: false,
                    verified: false,
                    message: `Face does not match (distance=${distance.toFixed(3)})`,
                    data: { distance, threshold: MATCH_THRESHOLD },
                });
            }

            return res.json({
                success: true,
                verified: true,
                data: { distance, threshold: MATCH_THRESHOLD },
            });
        } catch (err: any) {
            console.error('[fo-verify-face]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** GET /auth/fo/visits/active — the officer's open visit, if any. The app
     * calls this on launch so its buttons reflect the server, not whatever was
     * in component state when it was last closed. */
    public async handleActiveVisit(req: Request, res: Response) {
        try {
            const user = await this.requireFieldOfficer(req, res);
            if (!user) return;

            const [visit] = await joinSiteForVisits()
                .where(and(eq(visits.fieldOfficerUserId, user.id), eq(visits.status, 'active')))
                .orderBy(desc(visits.checkInAt))
                .limit(1);

            return res.json({ success: true, data: { visit: visit ?? null } });
        } catch (err: any) {
            console.error('[fo-active-visit]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** GET /auth/fo/visits/recent — the officer's last visits with point
     * counts, for the "today" list under the check-in card. */
    public async handleRecentVisits(req: Request, res: Response) {
        try {
            const user = await this.requireFieldOfficer(req, res);
            if (!user) return;

            const rows = await joinSiteForVisits()
                .where(eq(visits.fieldOfficerUserId, user.id))
                .orderBy(desc(visits.checkInAt))
                .limit(20);

            const counts = rows.length
                ? await db
                      .select({
                          visitId: visitLocationPoints.visitId,
                          count: sql<number>`count(*)::int`,
                      })
                      .from(visitLocationPoints)
                      .where(
                          sql`${visitLocationPoints.visitId} IN (${sql.join(
                              rows.map((r) => sql`${r.id}::uuid`),
                              sql`, `
                          )})`
                      )
                      .groupBy(visitLocationPoints.visitId)
                : [];
            const countByVisit = new Map(counts.map((c) => [c.visitId, c.count]));

            return res.json({
                success: true,
                data: {
                    visits: rows.map((v) => ({ ...v, pointCount: countByVisit.get(v.id) ?? 0 })),
                },
            });
        } catch (err: any) {
            console.error('[fo-recent-visits]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** POST /auth/fo/visits/check-in
     * Body: { siteId, latitude, longitude }
     *
     * Enforces, in order:
     *   1. the caller is a Field Officer;
     *   2. the site is assigned to them (rule 1 of the backend contract) —
     *      the app-side dropdown is a convenience, never the authority;
     *   3. they have no active visit (rule 2) — the partial unique index
     *      `visits_one_active_per_officer_idx` backs this up under races.
     */
    public async handleCheckIn(req: Request, res: Response) {
        try {
            const user = await this.requireFieldOfficer(req, res);
            if (!user) return;

            const parsed = checkInModel.safeParse(req.body);
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: 'body validation failed',
                    error: parsed.error.issues,
                });
            }
            const { siteId, latitude, longitude } = parsed.data;

            // Assignment check — the authority lives in field_officer_sites,
            // and a deactivated site stops authorising immediately.
            const [assignment] = await db
                .select({ id: fieldOfficerSites.id })
                .from(fieldOfficerSites)
                .innerJoin(sites, eq(fieldOfficerSites.siteId, sites.id))
                .where(
                    and(
                        eq(fieldOfficerSites.fieldOfficerUserId, user.id),
                        eq(fieldOfficerSites.siteId, siteId),
                        eq(sites.isActive, true)
                    )
                );
            if (!assignment) {
                return res.status(403).json({
                    success: false,
                    message: 'This client site is not assigned to you',
                });
            }

            // One active visit at a time — application check first for a
            // friendly 409; the index turns any race into a constraint error.
            const [active] = await db
                .select({ id: visits.id })
                .from(visits)
                .where(and(eq(visits.fieldOfficerUserId, user.id), eq(visits.status, 'active')))
                .limit(1);
            if (active) {
                return res.status(409).json({
                    success: false,
                    message: 'You already have an active visit. Check out first.',
                    data: { visitId: active.id },
                });
            }

            const [inserted] = await db
                .insert(visits)
                .values({
                    fieldOfficerUserId: user.id,
                    siteId,
                    checkInLatitude: latitude.toFixed(7),
                    checkInLongitude: longitude.toFixed(7),
                    status: 'active',
                })
                .returning({ id: visits.id });
            if (!inserted) {
                return res.status(500).json({ success: false, message: 'Check-in failed' });
            }

            const [withSite] = await joinSiteForVisits().where(eq(visits.id, inserted.id));

            return res.status(201).json({
                success: true,
                message: 'Checked in',
                data: { visit: withSite },
            });
        } catch (err: any) {
            // The unique partial index is the last line of defence against a
            // double check-in from two devices or a retried request.
            if (err?.code === '23505') {
                return res.status(409).json({
                    success: false,
                    message: 'You already have an active visit. Check out first.',
                });
            }
            console.error('[fo-check-in]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** POST /auth/fo/visits/:visitId/check-out
     * Body: { latitude, longitude }
     *
     * Marks the visit completed and stamps the final GPS position. Points the
     * officer still holds offline remain ingested afterwards (within the visit
     * window) by handleUploadLocations — checking out does not discard them.
     */
    public async handleCheckOut(req: Request, res: Response) {
        try {
            const user = await this.requireFieldOfficer(req, res);
            if (!user) return;

            const parsed = checkOutModel.safeParse(req.body);
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: 'body validation failed',
                    error: parsed.error.issues,
                });
            }
            const { latitude, longitude } = parsed.data;

            const visitId = String(req.params.visitId);

            const [visit] = await db
                .select()
                .from(visits)
                .where(eq(visits.id, visitId));
            if (!visit) {
                return res.status(404).json({ success: false, message: 'Visit not found' });
            }

            // Ownership: an officer can only end their own visit.
            if (visit.fieldOfficerUserId !== user.id) {
                return res.status(403).json({ success: false, message: 'Not your visit' });
            }
            if (visit.status !== 'active') {
                return res
                    .status(409)
                    .json({ success: false, message: 'Visit is already completed' });
            }

            const [updated] = await db
                .update(visits)
                .set({
                    checkOutAt: new Date(),
                    checkOutLatitude: latitude.toFixed(7),
                    checkOutLongitude: longitude.toFixed(7),
                    status: 'completed',
                })
                .where(eq(visits.id, visit.id))
                .returning();

            const [withSite] = await joinSiteForVisits().where(eq(visits.id, visit.id));

            return res.json({
                success: true,
                message: 'Checked out',
                data: { visit: withSite ?? updated },
            });
        } catch (err: any) {
            console.error('[fo-check-out]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Mobile: GPS point ingestion ──────────────────────────────────────────

    /** POST /auth/fo/visits/:visitId/locations
     * Body: { points: [{ uuid, latitude, longitude, accuracy?, speed?,
     *                    batteryLevel?, recordedAt }] }
     *
     * Rule 3 of the backend contract — points must belong to a valid visit of
     * the caller. Points are per-point decisioned so one bad row never sinks a
     * whole queued batch:
     *   - visit must belong to the caller;
     *   - active visit → accepted while within the visit window;
     *   - completed visit → accepted only for points captured before checkout
     *     + tolerance (the offline-queue catch-up case).
     *
     * Performance split, mirroring the attendance flow: validation (one
     * indexed SELECT + CPU) runs synchronously in the request, while the bulk
     * INSERT rides BullMQ (see services/visitLocationQueue). The endpoint
     * answers 202 the moment Redis holds the batch; the worker persists with
     * retries and (visit_id, client_uuid) dedup. If Redis is unreachable the
     * endpoint answers 503 and the phone keeps the points for its next retry —
     * a batch is never acknowledged before it is durable somewhere.
     */
    public async handleUploadLocations(req: Request, res: Response) {
        try {
            const user = await this.requireFieldOfficer(req, res);
            if (!user) return;

            const parsed = uploadLocationsModel.safeParse(req.body);
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: 'body validation failed',
                    error: parsed.error.issues,
                });
            }

            const [visit] = await db
                .select()
                .from(visits)
                .where(eq(visits.id, String(req.params.visitId)));
            if (!visit) {
                return res.status(404).json({ success: false, message: 'Visit not found' });
            }
            if (visit.fieldOfficerUserId !== user.id) {
                return res.status(403).json({ success: false, message: 'Not your visit' });
            }

            const now = Date.now();
            const lowerBound = new Date(visit.checkInAt.getTime() - WINDOW_TOLERANCE_MS);
            // While active, points may be captured any time after check-in;
            // once completed, only the offline catch-up window below checkout.
            const upperBound =
                visit.status === 'active'
                    ? new Date(now + FUTURE_SKEW_MS)
                    : visit.checkOutAt
                      ? new Date(visit.checkOutAt.getTime() + WINDOW_TOLERANCE_MS)
                      : lowerBound;

            const accepted: QueuedLocationPoint[] = [];
            let rejected = 0;

            for (const point of parsed.data.points) {
                const recordedAt = new Date(point.recordedAt);
                if (
                    recordedAt.getTime() < lowerBound.getTime() ||
                    recordedAt.getTime() > upperBound.getTime()
                ) {
                    rejected += 1;
                    continue;
                }

                // Legacy manual-visit batch: no session, the visit is known.
                accepted.push({
                    trackingSessionId: null,
                    visitId: visit.id,
                    siteId: visit.siteId,
                    uuid: point.uuid,
                    latitude: point.latitude.toFixed(7),
                    longitude: point.longitude.toFixed(7),
                    accuracy: point.accuracy != null ? point.accuracy.toFixed(2) : null,
                    speed: point.speed != null ? point.speed.toFixed(2) : null,
                    batteryLevel:
                        point.batteryLevel != null ? point.batteryLevel.toFixed(2) : null,
                    heading: point.heading != null ? point.heading.toFixed(2) : null,
                    recordedAt: recordedAt.toISOString(),
                });
            }

            if (!accepted.length) {
                return res.json({
                    success: true,
                    data: {
                        received: parsed.data.points.length,
                        accepted: 0,
                        rejected,
                        queued: true,
                    },
                });
            }

            try {
                await enqueueVisitLocations({
                    visitId: visit.id,
                    fieldOfficerUserId: user.id,
                    siteId: visit.siteId,
                    points: accepted,
                });
            } catch (err: any) {
                // Queue unreachable — refuse, don't swallow: the phone treats
                // non-2xx as "keep everything" and retries on the next fix or
                // reconnect, so no point is lost to a Redis outage.
                console.error('[fo-upload-locations] enqueue failed:', err.message);
                return res.status(503).json({
                    success: false,
                    message: 'Could not accept the batch right now. Points are kept on your device — please retry.',
                });
            }

            return res.status(202).json({
                success: true,
                data: {
                    received: parsed.data.points.length,
                    accepted: accepted.length,
                    rejected,
                    queued: true,
                },
            });
        } catch (err: any) {
            console.error('[fo-upload-locations]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Admin (OH web): monitoring ───────────────────────────────────────────

    /** GET /employee/field-officer/officers — the dropdown of Field Officers
     * for the OH "who to inspect" picker.
     *
     * Optional ?roles=csv widens the set for the admin site-posting page, which
     * also manages Circle Officers. Defaults to Field Officer + Operational Head
     * so the visits picker (calls with no param) is unchanged. Values are
     * restricted to the known officer roles before they touch SQL. */
    public async handleListOfficers(req: Request, res: Response) {
        try {
            const ALLOWED = new Set<string>([FIELD_OFFICER_ROLE, OH_ROLE, CO_ROLE]);
            const rolesParam = typeof req.query.roles === 'string' ? req.query.roles : '';
            const requested = rolesParam.split(',').map((r) => r.trim()).filter((r) => ALLOWED.has(r));
            const roles = requested.length > 0 ? requested : [FIELD_OFFICER_ROLE, OH_ROLE];

            const rows = await db
                .select({
                    userId: usersTable.id,
                    employeeId: employees.id,
                    phone: usersTable.phone,
                    firstName: employees.firstName,
                    lastName: employees.lastName,
                    designation: employees.designation,
                    isActive: usersTable.isActive,
                    // Returned so the admin panel can badge FO vs OH vs CO — all
                    // three roles drive the same posting table and appear here.
                    roles: usersTable.roles,
                })
                .from(usersTable)
                .leftJoin(employees, eq(usersTable.employeeId, employees.id))
                .where(
                    and(
                        sql`${usersTable.roles} && ARRAY[${sql.join(roles.map((r) => sql`${r}`), sql`, `)}]::text[]`,
                        eq(usersTable.isActive, true)
                    )
                )
                .orderBy(asc(employees.firstName), asc(employees.lastName));

            return res.json({ success: true, data: { officers: rows } });
        } catch (err: any) {
            console.error('[fo-list-officers]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** GET /employee/field-officer/visits?fieldOfficerUserId=&date=YYYY-MM-DD
     * Every visit that started on that calendar day, with the site names and
     * the number of GPS points collected — the OH table's data. */
    public async handleListVisits(req: Request, res: Response) {
        try {
            const parsed = visitListQueryModel.safeParse(req.query);
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: 'query validation failed',
                    error: parsed.error.issues,
                });
            }

            const { fieldOfficerUserId, date } = parsed.data;

            const [officer] = await db
                .select({ id: usersTable.id })
                .from(usersTable)
                .where(
                    and(
                        eq(usersTable.id, fieldOfficerUserId),
                        sql`${usersTable.roles} @> ARRAY[${FIELD_OFFICER_ROLE}]::text[]`
                    )
                );
            if (!officer) {
                return res
                    .status(404)
                    .json({ success: false, message: 'Field Officer not found' });
            }

            const { from, to } = istDayRange(date);

            const rows = await joinSiteForVisits()
                .where(
                    and(
                        eq(visits.fieldOfficerUserId, fieldOfficerUserId),
                        gte(visits.checkInAt, from),
                        lt(visits.checkInAt, to)
                    )
                )
                .orderBy(asc(visits.checkInAt));

            const counts = rows.length
                ? await db
                      .select({
                          visitId: visitLocationPoints.visitId,
                          count: sql<number>`count(*)::int`,
                      })
                      .from(visitLocationPoints)
                      .where(
                          sql`${visitLocationPoints.visitId} IN (${sql.join(
                              rows.map((r) => sql`${r.id}::uuid`),
                              sql`, `
                          )})`
                      )
                      .groupBy(visitLocationPoints.visitId)
                : [];
            const countByVisit = new Map(counts.map((c) => [c.visitId, c.count]));

            return res.json({
                success: true,
                data: {
                    visits: rows.map((v) => ({ ...v, pointCount: countByVisit.get(v.id) ?? 0 })),
                },
            });
        } catch (err: any) {
            console.error('[fo-list-visits]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** GET /employee/field-officer/visits/:visitId/locations — the full GPS
     * breadcrumb trail of one visit, chronological, with the visit metadata
     * (and site coordinates for the map markers). */
    public async handleVisitTrack(req: Request, res: Response) {
        try {
            const [visit] = await joinSiteForVisits().where(
                eq(visits.id, String(req.params.visitId))
            );
            if (!visit) {
                return res.status(404).json({ success: false, message: 'Visit not found' });
            }

            const [officer] = await db
                .select({
                    userId: usersTable.id,
                    firstName: employees.firstName,
                    lastName: employees.lastName,
                    phone: usersTable.phone,
                })
                .from(usersTable)
                .leftJoin(employees, eq(usersTable.employeeId, employees.id))
                .where(eq(usersTable.id, visit.fieldOfficerUserId));

            const [siteCoords] = await db
                .select({
                    latitude: sites.latitude,
                    longitude: sites.longitude,
                })
                .from(sites)
                .where(eq(sites.id, visit.siteId));

            const points = await db
                .select({
                    id: visitLocationPoints.id,
                    latitude: visitLocationPoints.latitude,
                    longitude: visitLocationPoints.longitude,
                    accuracy: visitLocationPoints.accuracy,
                    speed: visitLocationPoints.speed,
                    batteryLevel: visitLocationPoints.batteryLevel,
                    recordedAt: visitLocationPoints.recordedAt,
                    createdAt: visitLocationPoints.createdAt,
                })
                .from(visitLocationPoints)
                .where(eq(visitLocationPoints.visitId, visit.id))
                .orderBy(asc(visitLocationPoints.recordedAt), asc(visitLocationPoints.createdAt));

            return res.json({
                success: true,
                data: {
                    visit,
                    officer,
                    siteCoords,
                    points,
                },
            });
        } catch (err: any) {
            console.error('[fo-visit-track]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Admin (OH web): officer site assignments ─────────────────────────────
    // These replace the seed-field-officer.ts script: granting the role happens
    // through PATCH /employee/employees/:id/roles, and the site postings are
    // managed here from the LKS "Field Officers" page.

    /** Confirm the target user exists and is a site-postable officer account
     * (Field Officer, Operational Head, or Circle Officer — all three keep their
     * site postings in field_officer_sites, keyed by user, so their scopes never
     * overlap even if one account holds several of these roles). */
    private async requireOfficerAccount(userId: string) {
        const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
        if (!user) return { error: 'User not found' as const };
        if (!user.roles?.includes(FIELD_OFFICER_ROLE) && !user.roles?.includes(OH_ROLE) && !user.roles?.includes(CO_ROLE)) {
            return { error: 'User is not a Field, Operational Head, or Circle Officer' as const };
        }
        return { user };
    }

    /** GET /employee/field-officer/officers/:userId/sites — the officer's
     * current postings with site details for the assignment editor. */
    public async handleOfficerSites(req: Request, res: Response) {
        try {
            const userId = String(req.params.userId);
            const checked = await this.requireOfficerAccount(userId);
            if ('error' in checked) {
                return res.status(404).json({ success: false, message: checked.error });
            }

            const assigned = await db
                .select({
                    id: sites.id,
                    siteName: sites.siteName,
                    siteCode: sites.siteCode,
                    address: sites.address,
                    latitude: sites.latitude,
                    longitude: sites.longitude,
                    isActive: sites.isActive,
                    parentLocationName: clientLocations.locationName,
                })
                .from(fieldOfficerSites)
                .innerJoin(sites, eq(fieldOfficerSites.siteId, sites.id))
                .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
                .where(eq(fieldOfficerSites.fieldOfficerUserId, userId))
                .orderBy(asc(clientLocations.locationName), asc(sites.siteName));

            return res.json({ success: true, data: { sites: assigned } });
        } catch (err: any) {
            console.error('[fo-officer-sites]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** PUT /employee/field-officer/officers/:userId/sites
     * Body: { siteIds: [...] } — the complete desired posting set. Ids not in
     * the payload are unassigned, new ones assigned; unknown or inactive sites
     * are rejected with 400 before anything is written.
     */
    public async handleReplaceOfficerSites(req: Request, res: Response) {
        try {
            const userId = String(req.params.userId);
            const checked = await this.requireOfficerAccount(userId);
            if ('error' in checked) {
                return res.status(404).json({ success: false, message: checked.error });
            }

            const parsed = replaceOfficerSitesModel.safeParse(req.body);
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: 'body validation failed',
                    error: parsed.error.issues,
                });
            }
            const desired = [...new Set(parsed.data.siteIds)];

            if (desired.length) {
                const found = await db
                    .select({ id: sites.id, isActive: sites.isActive })
                    .from(sites)
                    .where(
                        sql`${sites.id} IN (${sql.join(
                            desired.map((id) => sql`${id}::uuid`),
                            sql`, `
                        )})`
                    );
                const byId = new Map(found.map((s) => [s.id, s]));
                const unknown = desired.filter((id) => !byId.has(id));
                if (unknown.length) {
                    return res.status(400).json({
                        success: false,
                        message: `Unknown site(s): ${unknown.join(', ')}`,
                    });
                }
                const inactive = desired.filter((id) => !byId.get(id)?.isActive);
                if (inactive.length) {
                    return res.status(400).json({
                        success: false,
                        message: 'Inactive sites cannot be assigned. Reactivate them first.',
                    });
                }
            }

            const current = await db
                .select({ siteId: fieldOfficerSites.siteId })
                .from(fieldOfficerSites)
                .where(eq(fieldOfficerSites.fieldOfficerUserId, userId));
            const currentIds = new Set(current.map((r) => r.siteId));

            const toAdd = desired.filter((id) => !currentIds.has(id));
            const toRemove = [...currentIds].filter((id) => !desired.includes(id));

            // Delete-then-insert keeps the unique pair index happy and leaves
            // no window where a concurrent check-in sees a half-written set.
            if (toRemove.length) {
                await db.delete(fieldOfficerSites).where(
                    and(
                        eq(fieldOfficerSites.fieldOfficerUserId, userId),
                        sql`${fieldOfficerSites.siteId} IN (${sql.join(
                            toRemove.map((id) => sql`${id}::uuid`),
                            sql`, `
                        )})`
                    )
                );
            }
            if (toAdd.length) {
                await db
                    .insert(fieldOfficerSites)
                    .values(toAdd.map((siteId) => ({ fieldOfficerUserId: userId, siteId })))
                    .onConflictDoNothing();
            }

            // The posting IS the geofence list, so the cached copy must go with
            // it. `FO:{userId}:sites` lives a day and is only rebuilt on a miss,
            // so without this a site assigned this morning stays invisible to the
            // tracking engine until the key expires: fixes inside it are stored
            // with visit_id NULL and no visit row is ever opened — while the
            // sites already in the cache keep detecting normally, which makes the
            // gap look like a GPS problem rather than a stale list. Deliberately
            // sites-only: the session and entered-site keys describe a duty in
            // progress, and a mid-session re-posting is already handled by the
            // engine (an entered site that vanished from the list gets closed and
            // re-evaluated on the next fix).
            if (toAdd.length || toRemove.length) {
                await clearSitesCacheOnly(userId);
            }

            return res.json({
                success: true,
                message: 'Site assignments updated',
                data: { assigned: toAdd.length, unassigned: toRemove.length, total: desired.length },
            });
        } catch (err: any) {
            console.error('[fo-replace-officer-sites]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Tracking sessions: automatic site-visit detection ────────────────────
    // The officer face-checks in ONCE (at an assigned site) and face-checks
    // out ONCE. In between, every ~5-minute GPS batch is geofenced here
    // against the Redis-cached site list: entries open `visits` rows and exits
    // close them, all with source='gps'. No face step per site.

    /** Great-circle distance in metres. Duplicated from the app's geofenceMath
     * so the server never depends on mobile code. */
    private distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371000;
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLon = ((lon2 - lon1) * Math.PI) / 180;
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos((lat1 * Math.PI) / 180) *
                Math.cos((lat2 * Math.PI) / 180) *
                Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /**
     * Geofence tuning, read live from app_settings so field testing can adjust
     * without a deploy. Unknown/missing/garbage values fall back to the
     * built-in defaults rather than breaking detection.
     */
    private async loadGeoConfig(): Promise<{
        maxAccuracyM: number;
        exitBufferM: number;
        exitConfirms: number;
    }> {
        const fallback = { maxAccuracyM: 100, exitBufferM: 20, exitConfirms: 2 };
        try {
            const rows = await db
                .select({ key: appSettings.key, value: appSettings.value })
                .from(appSettings)
                .where(
                    inArray(appSettings.key, [
                        'fo_max_gps_accuracy_m',
                        'fo_exit_buffer_m',
                        'fo_exit_confirm_count',
                    ])
                );
            const get = (key: string) => {
                const raw = rows.find((r) => r.key === key)?.value;
                const n = raw != null ? Number(raw) : NaN;
                return Number.isFinite(n) ? n : NaN;
            };
            const maxAccuracyM = get('fo_max_gps_accuracy_m');
            const exitBufferM = get('fo_exit_buffer_m');
            const exitConfirms = get('fo_exit_confirm_count');
            return {
                maxAccuracyM:
                    Number.isFinite(maxAccuracyM) && maxAccuracyM >= 10 && maxAccuracyM <= 1000
                        ? maxAccuracyM
                        : fallback.maxAccuracyM,
                exitBufferM:
                    Number.isFinite(exitBufferM) && exitBufferM >= 0 && exitBufferM <= 500
                        ? exitBufferM
                        : fallback.exitBufferM,
                exitConfirms:
                    Number.isFinite(exitConfirms) && exitConfirms >= 1 && exitConfirms <= 5
                        ? Math.round(exitConfirms)
                        : fallback.exitConfirms,
            };
        } catch {
            return fallback;
        }
    }

    /** The officer's open session, or null. Database is authoritative. */
    private async findActiveSession(userId: string) {
        const [session] = await db
            .select()
            .from(trackingSessions)
            .where(
                and(
                    eq(trackingSessions.fieldOfficerUserId, userId),
                    eq(trackingSessions.status, 'active')
                )
            )
            .orderBy(desc(trackingSessions.faceCheckInAt))
            .limit(1);
        return session ?? null;
    }

    /** Assigned sites for geofencing: Redis first, Postgres rebuild on miss.
     * Redis is acceleration here, never authority — a miss just costs one
     * indexed query and re-primes the key. */
    private async sitesFor(userId: string): Promise<CachedSite[]> {
        const cached = await getCachedSites(userId);
        if (cached) return cached;

        const rows = await this.loadAssignedSites(userId);
        const sites: CachedSite[] = [];
        for (const r of rows) {
            const latitude = Number(r.latitude);
            const longitude = Number(r.longitude);
            const radius = Number(r.allowedRadiusMeters);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
            sites.push({
                siteId: r.id,
                siteName: r.siteName,
                latitude,
                longitude,
                radius: Number.isFinite(radius) && radius > 0 ? radius : 100,
            });
        }
        if (sites.length) {
            try {
                await setCachedSites(userId, sites);
            } catch {
                // Best-effort.
            }
        }
        return sites;
    }

    /** Currently-entered site, if any: Redis first, rebuild from the open
     * visit row on a miss (streak counters safely restart at zero). */
    private async activeSiteFor(
        userId: string,
        sessionId: string
    ): Promise<CachedActiveSite | null> {
        const cached = await getCachedActiveSite(userId);
        if (cached) return cached;

        const [open] = await db
            .select({
                visitId: visits.id,
                siteId: visits.siteId,
                checkInAt: visits.checkInAt,
                lastInsideAt: visits.lastInsideAt,
            })
            .from(visits)
            .where(
                and(
                    eq(visits.trackingSessionId, sessionId),
                    eq(visits.status, 'active')
                )
            )
            .limit(1);
        if (!open) return null;

        const rebuilt: CachedActiveSite = {
            siteId: open.siteId,
            visitId: open.visitId,
            enteredAt: open.checkInAt.toISOString(),
            outsideStreak: 0,
            lastInsideAt: (open.lastInsideAt ?? open.checkInAt).toISOString(),
            firstOutside: null,
        };
        try {
            await setCachedActiveSite(userId, rebuilt);
        } catch {
            // Best-effort.
        }
        return rebuilt;
    }

    /** Open a GPS-detected site visit. check_in_at is the observation time,
     * not the insert time — the row describes when the officer was seen. */
    private async openSiteVisit(input: {
        userId: string;
        sessionId: string;
        siteId: string;
        at: Date;
        latitude: number;
        longitude: number;
        accuracy: number | null;
    }): Promise<string> {
        try {
            return await this.insertSiteVisit(input);
        } catch (err: any) {
            // The one-active-visit-per-officer index fired. Resolve whatever
            // is blocking (stale manual visit, visit of an ended session, or
            // a retried entry racing itself) and retry once.
            if (err?.code !== '23505') throw err;
            const reused = await this.resolveVisitConflict(input);
            if (reused) return reused;
            return await this.insertSiteVisit(input);
        }
    }

    private async insertSiteVisit(input: {
        userId: string;
        sessionId: string;
        siteId: string;
        at: Date;
        latitude: number;
        longitude: number;
        accuracy: number | null;
    }): Promise<string> {
        const [row] = await db
            .insert(visits)
            .values({
                fieldOfficerUserId: input.userId,
                siteId: input.siteId,
                trackingSessionId: input.sessionId,
                checkInAt: input.at,
                checkInLatitude: input.latitude.toFixed(7),
                checkInLongitude: input.longitude.toFixed(7),
                checkInAccuracy: input.accuracy != null ? input.accuracy.toFixed(2) : null,
                checkInSource: 'gps',
                lastInsideAt: input.at,
                status: 'active',
            })
            .returning({ id: visits.id });
        if (!row) throw new Error('Site visit insert failed');
        await this.logEvent({
            trackingSessionId: input.sessionId,
            visitId: row.id,
            userId: input.userId,
            eventType: 'SITE_ENTRY',
            latitude: input.latitude,
            longitude: input.longitude,
            at: input.at,
            metadata: { siteId: input.siteId, source: 'gps' },
        });
        return row.id;
    }

    /**
     * Resolve a one-active-visit conflict blocking a new entry. Returns the
     * id to use, or null when the caller should retry the insert.
     *
     *   - Same session + same site already open → reuse it. This is the
     *     idempotent replay: a retried start/entry whose first attempt
     *     already landed (response lost on a dead-zone network) must not
     *     create a twin visit.
     *   - Anything else still open is stale by definition and gets completed
     *     against the current fix, history preserved: manual-flow visits
     *     (retired flow, never closed), visits of already-ended sessions, or
     *     a same-session visit a previous step should have closed.
     */
    private async resolveVisitConflict(input: {
        userId: string;
        sessionId: string;
        siteId: string;
        at: Date;
        latitude: number;
        longitude: number;
        accuracy: number | null;
    }): Promise<string | null> {
        const actives = await db
            .select()
            .from(visits)
            .where(
                and(
                    eq(visits.fieldOfficerUserId, input.userId),
                    eq(visits.status, 'active')
                )
            );

        for (const v of actives) {
            if (v.trackingSessionId === input.sessionId && v.siteId === input.siteId) {
                console.log(`[fo-sessions] reusing already-open visit ${v.id} (idempotent entry)`);
                return v.id;
            }
        }

        for (const v of actives) {
            await this.closeSiteVisit({
                visitId: v.id,
                at: input.at,
                latitude: input.latitude,
                longitude: input.longitude,
                accuracy: input.accuracy,
                lastInsideAt: v.lastInsideAt,
                firstOutsideAt: v.firstOutsideAt,
                sessionId: input.sessionId,
                userId: input.userId,
            });
        }
        if (actives.length) {
            console.log(
                `[fo-sessions] closed ${actives.length} conflicting active visit(s) for officer ${input.userId}`
            );
        }
        return null;
    }

    /** Append one row to the audit trail. Best-effort by design: an audit
     * write must never fail the visit transition it describes. */
    private async logEvent(input: {
        trackingSessionId: string | null;
        visitId: string | null;
        userId: string;
        eventType: string;
        latitude: number | string | null;
        longitude: number | string | null;
        at: Date;
        metadata?: Record<string, unknown>;
    }): Promise<void> {
        try {
            await db.insert(foVisitEvents).values({
                trackingSessionId: input.trackingSessionId,
                visitId: input.visitId,
                fieldOfficerUserId: input.userId,
                eventType: input.eventType,
                latitude:
                    input.latitude == null ? null : String(input.latitude),
                longitude:
                    input.longitude == null ? null : String(input.longitude),
                eventTime: input.at,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                metadata: (input.metadata ?? null) as any,
            });
        } catch (err: any) {
            console.warn('[fo-events] audit write failed:', err?.message ?? err);
        }
    }

    /** Close a site visit. checkout.at is always a real GPS observation —
     * the first outside fix for auto-detect, the final fix for face checkout.
     * Never an interpolated midpoint. */
    private async closeSiteVisit(input: {
        visitId: string;
        at: Date;
        latitude: number;
        longitude: number;
        accuracy: number | null;
        lastInsideAt: Date | null;
        firstOutsideAt: Date | null;
        /** Who closed it: 'gps' (geofence exit), 'face' (Face Check-Out),
         * 'auto' (10-hour sweeper). Recorded in check_out_source. */
        source?: 'gps' | 'face' | 'auto';
        /** Session + officer for the SITE_EXIT audit row. */
        sessionId?: string;
        userId?: string;
    }): Promise<void> {
        await db
            .update(visits)
            .set({
                checkOutAt: input.at,
                checkOutLatitude: input.latitude.toFixed(7),
                checkOutLongitude: input.longitude.toFixed(7),
                checkOutAccuracy: input.accuracy != null ? input.accuracy.toFixed(2) : null,
                checkOutSource: input.source ?? 'gps',
                lastInsideAt: input.lastInsideAt,
                firstOutsideAt: input.firstOutsideAt,
                status: 'completed',
            })
            .where(eq(visits.id, input.visitId));
        if (input.sessionId && input.userId) {
            await this.logEvent({
                trackingSessionId: input.sessionId,
                visitId: input.visitId,
                userId: input.userId,
                eventType: 'SITE_EXIT',
                latitude: input.latitude,
                longitude: input.longitude,
                at: input.at,
                metadata: { source: input.source ?? 'gps' },
            });
        }
    }

    /**
     * One fix through the geofence engine. Returns the visit the fix belongs
     * to (null while travelling) and persists any entry/exit it triggers.
     *
     * Hysteresis: entry fires at `radius`, exit only past `radius + buffer`
     * AND after N consecutive outside observations — GPS wobble on the fence
     * can neither flap visits nor strand them. Fixes with worse-than-max
     * accuracy never change state (they still get stored, attributed to the
     * currently-entered visit if there is one).
     */
    private async evaluateFix(input: {
        userId: string;
        sessionId: string;
        sites: CachedSite[];
        state: CachedActiveSite | null;
        fix: { latitude: number; longitude: number; accuracy: number | null; at: Date };
        cfg: { maxAccuracyM: number; exitBufferM: number; exitConfirms: number };
    }): Promise<{ visitId: string | null; siteId: string | null; state: CachedActiveSite | null }> {
        const { userId, sessionId, sites, fix, cfg } = input;
        let state = input.state;
        const atIso = fix.at.toISOString();

        const reliable = fix.accuracy == null || fix.accuracy <= cfg.maxAccuracyM;
        if (!reliable) {
            return { visitId: state?.visitId ?? null, siteId: state?.siteId ?? null, state };
        }

        // Nearest site whose entry fence contains the fix.
        let entry: CachedSite | null = null;
        let entryDist = Infinity;
        for (const s of sites) {
            const d = this.distanceM(fix.latitude, fix.longitude, s.latitude, s.longitude);
            if (d <= s.radius && d < entryDist) {
                entry = s;
                entryDist = d;
            }
        }

        // Outside every fence: maybe an entry elsewhere, else travelling.
        if (!state) {
            if (!entry) return { visitId: null, siteId: null, state: null };
            const visitId = await this.openSiteVisit({
                userId,
                sessionId,
                siteId: entry.siteId,
                at: fix.at,
                latitude: fix.latitude,
                longitude: fix.longitude,
                accuracy: fix.accuracy,
            });
            const next: CachedActiveSite = {
                siteId: entry.siteId,
                visitId,
                enteredAt: atIso,
                outsideStreak: 0,
                lastInsideAt: atIso,
                firstOutside: null,
            };
            await setCachedActiveSite(userId, next);
            return { visitId, siteId: entry.siteId, state: next };
        }

        const siteA = sites.find((s) => s.siteId === state!.siteId);
        if (!siteA) {
            // Posting changed mid-visit (site deactivated/unassigned): close
            // against the current fix and re-evaluate it as a fresh arrival.
            await this.closeSiteVisit({
                visitId: state.visitId,
                at: fix.at,
                latitude: fix.latitude,
                longitude: fix.longitude,
                accuracy: fix.accuracy,
                lastInsideAt: new Date(state.lastInsideAt),
                firstOutsideAt: state.firstOutside ? new Date(state.firstOutside.at) : fix.at,
                sessionId,
                userId,
            });
            await setCachedActiveSite(userId, null);
            return this.evaluateFix({ ...input, state: null });
        }

        // Dwelling: inside the exit fence (entry radius + buffer). The band
        // between the two thresholds absorbs boundary wobble.
        const dA = this.distanceM(fix.latitude, fix.longitude, siteA.latitude, siteA.longitude);
        if (dA <= siteA.radius + cfg.exitBufferM) {
            state.outsideStreak = 0;
            state.lastInsideAt = atIso;
            state.firstOutside = null;
            await setCachedActiveSite(userId, state);
            await db
                .update(visits)
                .set({ lastInsideAt: fix.at })
                .where(eq(visits.id, state.visitId));
            return { visitId: state.visitId, siteId: state.siteId, state };
        }

        // Direct hop into a different site's fence: close A, open B, one fix.
        if (entry && entry.siteId !== state.siteId) {
            await this.closeSiteVisit({
                visitId: state.visitId,
                at: fix.at,
                latitude: fix.latitude,
                longitude: fix.longitude,
                accuracy: fix.accuracy,
                lastInsideAt: new Date(state.lastInsideAt),
                firstOutsideAt: fix.at,
                sessionId,
                userId,
            });
            const visitId = await this.openSiteVisit({
                userId,
                sessionId,
                siteId: entry.siteId,
                at: fix.at,
                latitude: fix.latitude,
                longitude: fix.longitude,
                accuracy: fix.accuracy,
            });
            const next: CachedActiveSite = {
                siteId: entry.siteId,
                visitId,
                enteredAt: atIso,
                outsideStreak: 0,
                lastInsideAt: atIso,
                firstOutside: null,
            };
            await setCachedActiveSite(userId, next);
            return { visitId, siteId: entry.siteId, state: next };
        }

        // Outside everything: count consecutive outsiders before confirming.
        const firstOutside = state.firstOutside ?? {
            at: atIso,
            latitude: fix.latitude,
            longitude: fix.longitude,
            accuracy: fix.accuracy,
        };
        const streak = state.outsideStreak + 1;
        state.outsideStreak = streak;
        state.firstOutside = firstOutside;
        await setCachedActiveSite(userId, state);
        if (streak === 1) {
            await db
                .update(visits)
                .set({ firstOutsideAt: fix.at })
                .where(eq(visits.id, state.visitId));
        }
        if (streak >= cfg.exitConfirms) {
            // Confirmed exit: checkout is stamped with the FIRST outside
            // observation, not the confirming one — the honest detected time.
            await this.closeSiteVisit({
                visitId: state.visitId,
                at: new Date(firstOutside.at),
                latitude: firstOutside.latitude,
                longitude: firstOutside.longitude,
                accuracy: firstOutside.accuracy,
                lastInsideAt: new Date(state.lastInsideAt),
                firstOutsideAt: new Date(firstOutside.at),
                sessionId,
                userId,
            });
            await setCachedActiveSite(userId, null);
            return { visitId: null, siteId: null, state: null };
        }
        // Unconfirmed: still attributed to the visit, no flapping.
        return { visitId: state.visitId, siteId: state.siteId, state };
    }

    /** POST /auth/fo/sessions/start — Face Check-In opens the working session.
     * Body: { latitude, longitude, accuracy? } — the High-accuracy fix taken
     * at face-verification time. The user must be inside their assigned site
     * (a client site for Field Officers, the office for Operational Heads);
     * the entry visit opens immediately.
     */
    public async handleStartSession(req: Request, res: Response) {
        try {
            const user = await this.requireFieldOfficer(req, res);
            if (!user) return;

            const parsed = sessionFixModel.safeParse(req.body);
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: 'body validation failed',
                    error: parsed.error.issues,
                });
            }
            const { latitude, longitude, accuracy } = parsed.data;

            const existing = await this.findActiveSession(user.id);
            if (existing) {
                return res.status(409).json({
                    success: false,
                    message: 'A tracking session is already active. Face check-out first.',
                    data: { sessionId: existing.id },
                });
            }

            const sites = await this.sitesFor(user.id);
            if (!sites.length) {
                return res.status(403).json({
                    success: false,
                    message: 'No sites are assigned to you yet',
                });
            }

            // Strict entry fence for the session start.
            let entry: CachedSite | null = null;
            let entryDist = Infinity;
            let nearest: { site: CachedSite; distance: number } | null = null;
            for (const s of sites) {
                const d = this.distanceM(latitude, longitude, s.latitude, s.longitude);
                if (!nearest || d < nearest.distance) nearest = { site: s, distance: d };
                if (d <= s.radius && d < entryDist) {
                    entry = s;
                    entryDist = d;
                }
            }
            if (!entry || !nearest) {
                return res.status(403).json({
                    success: false,
                    message: nearest
                        ? `You are ${Math.round(nearest.distance)}m away from ${nearest.site.siteName} (allowed ${Math.round(nearest.site.radius)}m). Start the session inside your assigned site.`
                        : 'Your assigned sites have no usable coordinates',
                });
            }

            let sessionId: string;
            try {
                const [session] = await db
                    .insert(trackingSessions)
                    .values({
                        fieldOfficerUserId: user.id,
                        faceCheckInLatitude: latitude.toFixed(7),
                        faceCheckInLongitude: longitude.toFixed(7),
                        faceCheckInAccuracy:
                            accuracy != null ? accuracy.toFixed(2) : null,
                        status: 'active',
                    })
                    .returning({ id: trackingSessions.id, faceCheckInAt: trackingSessions.faceCheckInAt });
                if (!session) throw new Error('Session insert failed');
                sessionId = session.id;
            } catch (err: any) {
                if (err?.code === '23505') {
                    const current = await this.findActiveSession(user.id);
                    return res.status(409).json({
                        success: false,
                        message: 'A tracking session is already active. Face check-out first.',
                        data: { sessionId: current?.id ?? null },
                    });
                }
                throw err;
            }

            try {
                await setCachedSession(user.id, {
                    sessionId,
                    startedAt: new Date().toISOString(),
                });
            } catch {
                // Best-effort: a miss rebuilds from the database.
            }

            // Starting inside the assigned site counts as an entry — the first
            // visit opens now, so the day records every later exit and return.
            const now = new Date();
            const visitId = await this.openSiteVisit({
                userId: user.id,
                sessionId,
                siteId: entry.siteId,
                at: now,
                latitude,
                longitude,
                accuracy: accuracy ?? null,
            });
            await setCachedActiveSite(user.id, {
                siteId: entry.siteId,
                visitId,
                enteredAt: now.toISOString(),
                outsideStreak: 0,
                lastInsideAt: now.toISOString(),
                firstOutside: null,
            });

            const [session] = await db
                .select()
                .from(trackingSessions)
                .where(eq(trackingSessions.id, sessionId));

            await this.logEvent({
                trackingSessionId: sessionId,
                visitId,
                userId: user.id,
                eventType: 'CHECK_IN',
                latitude,
                longitude,
                at: now,
                metadata: { siteId: entry.siteId, siteName: entry.siteName, source: 'face' },
            });

            return res.status(201).json({
                success: true,
                message: 'Tracking session started',
                data: {
                    session,
                    currentSite: { siteId: entry.siteId, siteName: entry.siteName },
                },
            });
        } catch (err: any) {
            console.error('[fo-start-session]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** GET /auth/fo/sessions/active — the open session with its site visits
     * and current site, so the app reflects the server after any restart. */
    public async handleActiveSession(req: Request, res: Response) {
        try {
            const user = await this.requireFieldOfficer(req, res);
            if (!user) return;

            const session = await this.findActiveSession(user.id);
            if (!session) {
                return res.json({ success: true, data: { session: null } });
            }

            const siteVisits = await joinSiteForVisits()
                .where(eq(visits.trackingSessionId, session.id))
                .orderBy(asc(visits.checkInAt));

            const state = await this.activeSiteFor(user.id, session.id);
            let currentSite: { siteId: string; siteName: string } | null = null;
            if (state) {
                const sites = await this.sitesFor(user.id);
                const hit = sites.find((s) => s.siteId === state.siteId);
                currentSite = {
                    siteId: state.siteId,
                    siteName: hit?.siteName ?? 'Client site',
                };
            }

            return res.json({
                success: true,
                data: { session, siteVisits, currentSite },
            });
        } catch (err: any) {
            console.error('[fo-active-session]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** Upper bound on one track read. A full day at the OH 1-minute cadence is
     * ~1440 fixes, so the cap only bites on a misconfigured (sub-minute) device
     * or a multi-session query — and it keeps the mobile payload bounded. */
    private static readonly TRACK_POINT_LIMIT = 2000;

    /**
     * Query `date` → the IST day to read, as [from, to).
     *
     * Shared by the two mobile own-day reads (the GPS track and the site-visit
     * list) so the rules can never drift between them: absent means today,
     * `YYYY-MM-DD` or nothing else, and the future has no records. Returns
     * `{ error }` WITHOUT responding — the caller sends the 400, so the message
     * stays phrased for its own screen.
     */
    private static resolveIstDay(
        req: Request
    ): { date: string; from: Date; to: Date } | { error: string } {
        const requested =
            typeof req.query.date === 'string' ? req.query.date : '';
        if (requested && !/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
            return { error: 'Invalid date. Use YYYY-MM-DD.' };
        }
        const today = new Date().toLocaleDateString('en-CA', {
            timeZone: 'Asia/Kolkata',
        });
        const date = requested || today;
        if (date > today) {
            return { error: 'Invalid date. Use YYYY-MM-DD, not in the future.' };
        }
        const { from, to } = istDayRange(date);
        return { date, from, to };
    }

    /** GET /auth/fo/sessions/site-visits?date=YYYY-MM-DD — the caller's OWN
     * auto-detected site visits for one IST day, in visit order.
     *
     * /sessions/active only ever answers for the session that is open RIGHT
     * NOW, so a Field Officer who finished his duty and checked out could not
     * re-read his own day from the Field Visits screen. This is the same rows,
     * read by calendar day: requireFieldOfficer (FO or OH) pins the query to the
     * authenticated user id, so there is no userId parameter to tamper with and
     * one account can never read another's route.
     *
     * Day membership is the visit's own checkInAt (not its session's), which is
     * what the officer recognises on screen and what the path plot uses, so the
     * two views agree on which day a visit belongs to.
     */
    public async handleMySiteVisits(req: Request, res: Response) {
        try {
            const user = await this.requireFieldOfficer(req, res);
            if (!user) return;

            const resolved = FieldOfficerController.resolveIstDay(req);
            if ('error' in resolved) {
                return res.status(400).json({ success: false, message: resolved.error });
            }
            const { date, from, to } = resolved;

            const siteVisits = await joinSiteForVisits()
                .where(
                    and(
                        eq(visits.fieldOfficerUserId, user.id),
                        gte(visits.checkInAt, from),
                        lt(visits.checkInAt, to)
                    )
                )
                .orderBy(asc(visits.checkInAt));

            return res.json({ success: true, data: { date, siteVisits } });
        } catch (err: any) {
            console.error('[fo-my-site-visits]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** GET /auth/fo/sessions/track?date=YYYY-MM-DD — the caller's OWN GPS track
     * for one IST day, for the mobile path plot.
     *
     * The two admin equivalents (handleSessionTrack, handleOhAttendanceDetail)
     * sit behind restrictToAdmin(), so an officer on his own phone cannot read
     * his path through them. This route reuses requireFieldOfficer (FO or OH)
     * and pins every query to the authenticated user's id — there is no userId
     * parameter to tamper with, so one account can never plot another's day.
     *
     * Only the columns the plot needs are sent: a lighter payload than the
     * admin track (which the web panel uses for tables and audit events too).
     * Path continuity is the client's job — it breaks the line per session
     * using trackingSessionId, so travel is never bridged across a gap.
     */
    public async handleMyTrack(req: Request, res: Response) {
        try {
            const user = await this.requireFieldOfficer(req, res);
            if (!user) return;

            // Same day rules as the site-visit list, from one helper.
            const resolved = FieldOfficerController.resolveIstDay(req);
            if ('error' in resolved) {
                return res.status(400).json({
                    success: false,
                    message: resolved.error,
                });
            }
            const { date, from, to } = resolved;
            const sessions = await db
                .select({
                    id: trackingSessions.id,
                    status: trackingSessions.status,
                    checkoutType: trackingSessions.checkoutType,
                    faceCheckInAt: trackingSessions.faceCheckInAt,
                    faceCheckOutAt: trackingSessions.faceCheckOutAt,
                    faceCheckInLatitude: trackingSessions.faceCheckInLatitude,
                    faceCheckInLongitude: trackingSessions.faceCheckInLongitude,
                    faceCheckOutLatitude: trackingSessions.faceCheckOutLatitude,
                    faceCheckOutLongitude: trackingSessions.faceCheckOutLongitude,
                })
                .from(trackingSessions)
                .where(
                    and(
                        eq(trackingSessions.fieldOfficerUserId, user.id),
                        // That day's sessions, plus a still-active one that
                        // began earlier: if the end-of-day sweep ever failed to
                        // close a session, its track must still render rather
                        // than silently vanish from today's plot.
                        or(
                            eq(trackingSessions.status, 'active'),
                            and(
                                gte(trackingSessions.faceCheckInAt, from),
                                lt(trackingSessions.faceCheckInAt, to)
                            )
                        )
                    )
                )
                .orderBy(asc(trackingSessions.faceCheckInAt));

            if (!sessions.length) {
                return res.json({
                    success: true,
                    data: { date, sessions: [], points: [], truncated: false },
                });
            }

            const limit = FieldOfficerController.TRACK_POINT_LIMIT;
            const points = await db
                .select({
                    trackingSessionId: visitLocationPoints.trackingSessionId,
                    latitude: visitLocationPoints.latitude,
                    longitude: visitLocationPoints.longitude,
                    accuracy: visitLocationPoints.accuracy,
                    recordedAt: visitLocationPoints.recordedAt,
                })
                .from(visitLocationPoints)
                .where(
                    inArray(
                        visitLocationPoints.trackingSessionId,
                        sessions.map((s) => s.id)
                    )
                )
                // recordedAt (device observation order) first, never createdAt:
                // offline catch-ups arrive in a burst and would otherwise draw
                // the path backwards. createdAt only breaks true ties.
                .orderBy(
                    asc(visitLocationPoints.recordedAt),
                    asc(visitLocationPoints.createdAt)
                )
                .limit(limit + 1);

            const truncated = points.length > limit;

            return res.json({
                success: true,
                data: {
                    date,
                    sessions,
                    points: truncated ? points.slice(0, limit) : points,
                    truncated,
                },
            });
        } catch (err: any) {
            console.error('[fo-my-track]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** POST /auth/fo/sessions/:sessionId/locations
     * Body: { points: [{ uuid, latitude, longitude, accuracy?, speed?,
     *                    batteryLevel?, heading?, recordedAt }] }
     *
     * The hot path, designed for it: Redis supplies the session, the sites
     * and the entered-site state, so the request costs one auth lookup plus
     * arithmetic. Database writes happen only on entry/exit transitions
     * (single rows, rare); every point itself rides BullMQ. Answers 202 once
     * Redis holds the batch, 503 when the queue is unreachable so the phone
     * keeps the points.
     */
    public async handleSessionLocations(req: Request, res: Response) {
        try {
            const user = await this.requireFieldOfficer(req, res);
            if (!user) return;

            const sessionId = String(req.params.sessionId);
            const [session] = await db
                .select()
                .from(trackingSessions)
                .where(eq(trackingSessions.id, sessionId));
            if (!session) {
                return res.status(404).json({ success: false, message: 'Session not found' });
            }
            if (session.fieldOfficerUserId !== user.id) {
                return res.status(403).json({ success: false, message: 'Not your session' });
            }
            // No 409 for completed sessions: points still queued on the phone
            // at Face Check-Out (offline checkout, dead zone right after) must
            // still land. In-window late points are attributed to their visit
            // below; out-of-window ones are rejected per-point as usual.

            const parsed = uploadLocationsModel.safeParse(req.body);
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: 'body validation failed',
                    error: parsed.error.issues,
                });
            }

            const cfg = await this.loadGeoConfig();
            const sites = await this.sitesFor(user.id);
            let state = await this.activeSiteFor(user.id, session.id);

            const sessionActive = session.status === 'active';
            const now = Date.now();
            const lowerBound = new Date(session.faceCheckInAt.getTime() - WINDOW_TOLERANCE_MS);
            // Active sessions accept up to now (+skew); completed ones only
            // the offline catch-up window below face check-out.
            const upperBound = sessionActive
                ? new Date(now + FUTURE_SKEW_MS)
                : session.faceCheckOutAt
                  ? new Date(session.faceCheckOutAt.getTime() + WINDOW_TOLERANCE_MS)
                  : lowerBound;

            // Completed sessions never change visit state — each late point is
            // matched to the visit open at its observation time, in memory.
            // (Sessions hold tens of visits at most; no per-point queries.)
            const pastVisits = sessionActive
                ? []
                : await db
                      .select({
                          id: visits.id,
                          siteId: visits.siteId,
                          checkInAt: visits.checkInAt,
                          checkOutAt: visits.checkOutAt,
                      })
                      .from(visits)
                      .where(eq(visits.trackingSessionId, session.id));

            const ordered = [...parsed.data.points].sort(
                (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime()
            );

            const accepted: QueuedLocationPoint[] = [];
            let rejected = 0;

            for (const point of ordered) {
                const recordedAt = new Date(point.recordedAt);
                if (
                    recordedAt.getTime() < lowerBound.getTime() ||
                    recordedAt.getTime() > upperBound.getTime()
                ) {
                    rejected += 1;
                    continue;
                }

                if (!sessionActive) {
                    const open = pastVisits.find(
                        (v) =>
                            v.checkInAt.getTime() <= recordedAt.getTime() &&
                            (v.checkOutAt == null ||
                                recordedAt.getTime() <= v.checkOutAt.getTime())
                    );
                    accepted.push({
                        trackingSessionId: session.id,
                        visitId: open?.id ?? null,
                        siteId: open?.siteId ?? null,
                        uuid: point.uuid,
                        latitude: point.latitude.toFixed(7),
                        longitude: point.longitude.toFixed(7),
                        accuracy: point.accuracy != null ? point.accuracy.toFixed(2) : null,
                        speed: point.speed != null ? point.speed.toFixed(2) : null,
                        batteryLevel:
                            point.batteryLevel != null ? point.batteryLevel.toFixed(2) : null,
                        heading: point.heading != null ? point.heading.toFixed(2) : null,
                        recordedAt: recordedAt.toISOString(),
                    });
                    continue;
                }

                const outcome = await this.evaluateFix({
                    userId: user.id,
                    sessionId: session.id,
                    sites,
                    state,
                    fix: {
                        latitude: point.latitude,
                        longitude: point.longitude,
                        accuracy: point.accuracy ?? null,
                        at: recordedAt,
                    },
                    cfg,
                });
                state = outcome.state;

                accepted.push({
                    trackingSessionId: session.id,
                    visitId: outcome.visitId,
                    siteId: outcome.siteId,
                    uuid: point.uuid,
                    latitude: point.latitude.toFixed(7),
                    longitude: point.longitude.toFixed(7),
                    accuracy: point.accuracy != null ? point.accuracy.toFixed(2) : null,
                    speed: point.speed != null ? point.speed.toFixed(2) : null,
                    batteryLevel:
                        point.batteryLevel != null ? point.batteryLevel.toFixed(2) : null,
                    heading: point.heading != null ? point.heading.toFixed(2) : null,
                    recordedAt: recordedAt.toISOString(),
                });
            }

            if (accepted.length) {
                try {
                    await enqueueVisitLocations({
                        visitId: null,
                        fieldOfficerUserId: user.id,
                        siteId: null,
                        points: accepted,
                    });
                } catch (err: any) {
                    console.error('[fo-session-locations] enqueue failed:', err.message);
                    return res.status(503).json({
                        success: false,
                        message: 'Could not accept the batch right now. Points are kept on your device — please retry.',
                    });
                }
            }

            try {
                await touchSession(user.id);
            } catch {
                // Best-effort.
            }

            let currentSite: { siteId: string; siteName: string } | null = null;
            if (state) {
                const hit = sites.find((s) => s.siteId === state!.siteId);
                currentSite = {
                    siteId: state.siteId,
                    siteName: hit?.siteName ?? 'Client site',
                };
            }

            return res.status(202).json({
                success: true,
                data: {
                    received: parsed.data.points.length,
                    accepted: accepted.length,
                    rejected,
                    queued: true,
                    currentSite,
                },
            });
        } catch (err: any) {
            console.error('[fo-session-locations]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** POST /auth/fo/sessions/:sessionId/end — Face Check-Out ends everything.
     * Body: { latitude, longitude, accuracy? } — the final fix. Closes the
     * entered site visit if the officer is still inside one, completes the
     * session, stops tracking client-side, and clears the Redis state.
     */
    public async handleEndSession(req: Request, res: Response) {
        try {
            const user = await this.requireFieldOfficer(req, res);
            if (!user) return;

            const parsed = sessionFixModel.safeParse(req.body);
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: 'body validation failed',
                    error: parsed.error.issues,
                });
            }

            const sessionId = String(req.params.sessionId);
            const [session] = await db
                .select()
                .from(trackingSessions)
                .where(eq(trackingSessions.id, sessionId));
            if (!session) {
                return res.status(404).json({ success: false, message: 'Session not found' });
            }
            if (session.fieldOfficerUserId !== user.id) {
                return res.status(403).json({ success: false, message: 'Not your session' });
            }
            if (session.status !== 'active') {
                return res.status(409).json({
                    success: false,
                    message: 'This tracking session has already ended',
                });
            }

            const { latitude, longitude, accuracy } = parsed.data;
            const now = new Date();

            // Inside a site at checkout: close it against the final fix.
            const state = await this.activeSiteFor(user.id, session.id);
            if (state) {
                await this.closeSiteVisit({
                    visitId: state.visitId,
                    at: now,
                    latitude,
                    longitude,
                    accuracy: accuracy ?? null,
                    lastInsideAt: new Date(state.lastInsideAt),
                    firstOutsideAt: state.firstOutside
                        ? new Date(state.firstOutside.at)
                        : null,
                    source: 'face',
                    sessionId: session.id,
                    userId: user.id,
                });
            }

            const [ended] = await db
                .update(trackingSessions)
                .set({
                    faceCheckOutAt: now,
                    faceCheckOutLatitude: latitude.toFixed(7),
                    faceCheckOutLongitude: longitude.toFixed(7),
                    faceCheckOutAccuracy:
                        accuracy != null ? accuracy.toFixed(2) : null,
                    status: 'completed',
                    checkoutType: 'face',
                })
                .where(eq(trackingSessions.id, session.id))
                .returning();

            await clearTrackingCache(user.id);

            await this.logEvent({
                trackingSessionId: session.id,
                visitId: null,
                userId: user.id,
                eventType: 'CHECK_OUT',
                latitude,
                longitude,
                at: now,
                metadata: { source: 'face' },
            });

            const visitRows = await db
                .select({ id: visits.id })
                .from(visits)
                .where(eq(visits.trackingSessionId, session.id));
            const pointRows = await db
                .select({ id: visitLocationPoints.id })
                .from(visitLocationPoints)
                .where(eq(visitLocationPoints.trackingSessionId, session.id));

            return res.json({
                success: true,
                message: 'Tracking session ended',
                data: {
                    session: ended ?? session,
                    summary: {
                        siteVisits: visitRows.length,
                        points: pointRows.length,
                    },
                },
            });
        } catch (err: any) {
            console.error('[fo-end-session]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Admin (OH web): session timeline ─────────────────────────────────────

    /** POST /employee/field-officer/sessions/auto-checkout — manually trigger
     * the 10-hour max-duty sweep (same function the scheduler runs). Useful
     * after an outage or for ops verification; idempotent. */
    public async handleTriggerAutoCheckout(_req: Request, res: Response) {
        try {
            const result = await runAutoCheckout();
            return res.json({ success: true, data: result });
        } catch (err: any) {
            console.error('[fo-auto-checkout]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** GET /employee/field-officer/sessions?fieldOfficerUserId=&date=YYYY-MM-DD
     * Every session started that day, each with its site visits and point
     * count — the OH timeline's data. */
    public async handleListSessions(req: Request, res: Response) {
        try {
            const parsed = visitListQueryModel.safeParse(req.query);
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: 'query validation failed',
                    error: parsed.error.issues,
                });
            }

            const { fieldOfficerUserId, date } = parsed.data;

            const [officer] = await db
                .select({ id: usersTable.id })
                .from(usersTable)
                .where(
                    and(
                        eq(usersTable.id, fieldOfficerUserId),
                        sql`${usersTable.roles} @> ARRAY[${FIELD_OFFICER_ROLE}]::text[]`
                    )
                );
            if (!officer) {
                return res
                    .status(404)
                    .json({ success: false, message: 'Field Officer not found' });
            }

            const { from, to } = istDayRange(date);

            const sessions = await db
                .select()
                .from(trackingSessions)
                .where(
                    and(
                        eq(trackingSessions.fieldOfficerUserId, fieldOfficerUserId),
                        gte(trackingSessions.faceCheckInAt, from),
                        lt(trackingSessions.faceCheckInAt, to)
                    )
                )
                .orderBy(asc(trackingSessions.faceCheckInAt));

            const sessionIds = sessions.map((s) => s.id);
            const siteVisits = sessionIds.length
                ? await joinSiteForVisits()
                      .where(
                          sql`${visits.trackingSessionId} IN (${sql.join(
                              sessionIds.map((id) => sql`${id}::uuid`),
                              sql`, `
                          )})`
                      )
                      .orderBy(asc(visits.checkInAt))
                : [];
            const counts = sessionIds.length
                ? await db
                      .select({
                          sessionId: visitLocationPoints.trackingSessionId,
                          count: sql<number>`count(*)::int`,
                      })
                      .from(visitLocationPoints)
                      .where(
                          sql`${visitLocationPoints.trackingSessionId} IN (${sql.join(
                              sessionIds.map((id) => sql`${id}::uuid`),
                              sql`, `
                          )})`
                      )
                      .groupBy(visitLocationPoints.trackingSessionId)
                : [];
            const countBySession = new Map(
                counts.map((c) => [c.sessionId, c.count])
            );
            const visitsBySession = new Map<string, typeof siteVisits>();
            for (const v of siteVisits) {
                const list = visitsBySession.get(v.trackingSessionId!) ?? [];
                list.push(v);
                visitsBySession.set(v.trackingSessionId!, list);
            }

            return res.json({
                success: true,
                data: {
                    sessions: sessions.map((s) => ({
                        ...s,
                        siteVisits: visitsBySession.get(s.id) ?? [],
                        pointCount: countBySession.get(s.id) ?? 0,
                    })),
                },
            });
        } catch (err: any) {
            console.error('[fo-list-sessions]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** GET /employee/field-officer/sessions/:sessionId/track — one session's
     * full story: session boundaries, every site visit, and every GPS point
     * in order for the map polyline. */
    public async handleSessionTrack(req: Request, res: Response) {
        try {
            const [session] = await db
                .select()
                .from(trackingSessions)
                .where(eq(trackingSessions.id, String(req.params.sessionId)));
            if (!session) {
                return res.status(404).json({ success: false, message: 'Session not found' });
            }

            const [officer] = await db
                .select({
                    userId: usersTable.id,
                    firstName: employees.firstName,
                    lastName: employees.lastName,
                    phone: usersTable.phone,
                })
                .from(usersTable)
                .leftJoin(employees, eq(usersTable.employeeId, employees.id))
                .where(eq(usersTable.id, session.fieldOfficerUserId));

            const siteVisits = await db
                .select({
                    id: visits.id,
                    siteId: visits.siteId,
                    siteName: sites.siteName,
                    siteCode: sites.siteCode,
                    locationName: clientLocations.locationName,
                    siteLatitude: sites.latitude,
                    siteLongitude: sites.longitude,
                    checkInAt: visits.checkInAt,
                    checkInLatitude: visits.checkInLatitude,
                    checkInLongitude: visits.checkInLongitude,
                    checkInAccuracy: visits.checkInAccuracy,
                    checkOutAt: visits.checkOutAt,
                    checkOutLatitude: visits.checkOutLatitude,
                    checkOutLongitude: visits.checkOutLongitude,
                    checkOutAccuracy: visits.checkOutAccuracy,
                    lastInsideAt: visits.lastInsideAt,
                    firstOutsideAt: visits.firstOutsideAt,
                    status: visits.status,
                })
                .from(visits)
                .innerJoin(sites, eq(visits.siteId, sites.id))
                .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
                .where(eq(visits.trackingSessionId, session.id))
                .orderBy(asc(visits.checkInAt));

            const points = await db
                .select({
                    id: visitLocationPoints.id,
                    visitId: visitLocationPoints.visitId,
                    latitude: visitLocationPoints.latitude,
                    longitude: visitLocationPoints.longitude,
                    accuracy: visitLocationPoints.accuracy,
                    speed: visitLocationPoints.speed,
                    heading: visitLocationPoints.heading,
                    batteryLevel: visitLocationPoints.batteryLevel,
                    recordedAt: visitLocationPoints.recordedAt,
                    createdAt: visitLocationPoints.createdAt,
                })
                .from(visitLocationPoints)
                .where(eq(visitLocationPoints.trackingSessionId, session.id))
                .orderBy(asc(visitLocationPoints.recordedAt), asc(visitLocationPoints.createdAt));

            // Audit trail for the timeline (check-in, site entries/exits,
            // check-out / auto-checkout) — the OH panel renders these as
            // labelled events instead of inferring them.
            const events = await db
                .select()
                .from(foVisitEvents)
                .where(eq(foVisitEvents.trackingSessionId, session.id))
                .orderBy(asc(foVisitEvents.eventTime), asc(foVisitEvents.createdAt));

            return res.json({
                success: true,
                data: { session, officer, siteVisits, points, events },
            });
        } catch (err: any) {
            console.error('[fo-session-track]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** GET /employee/field-officer/day-summary?date=YYYY-MM-DD — every active
     * field officer with, for that IST day: session count, auto-detected site
     * visit count and total duty (sum of face check-in → check-out spans).
     * Feeds the OH overview table; "View detail" then drills into the
     * per-officer session view with fieldOfficerUserId. */
    public async handleDaySummary(req: Request, res: Response) {
        try {
            const parsed = daySummaryQueryModel.safeParse(req.query);
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: 'query validation failed',
                    error: parsed.error.issues,
                });
            }
            const { from, to } = istDayRange(parsed.data.date);

            const officers = await db
                .select({
                    userId: usersTable.id,
                    phone: usersTable.phone,
                    firstName: employees.firstName,
                    lastName: employees.lastName,
                    designation: employees.designation,
                })
                .from(usersTable)
                .leftJoin(employees, eq(usersTable.employeeId, employees.id))
                .where(
                    and(
                        sql`${usersTable.roles} @> ARRAY[${FIELD_OFFICER_ROLE}]::text[]`,
                        eq(usersTable.isActive, true)
                    )
                )
                .orderBy(asc(employees.firstName), asc(employees.lastName));

            const sessionRows = await db
                .select({
                    id: trackingSessions.id,
                    fieldOfficerUserId: trackingSessions.fieldOfficerUserId,
                    faceCheckInAt: trackingSessions.faceCheckInAt,
                    faceCheckOutAt: trackingSessions.faceCheckOutAt,
                })
                .from(trackingSessions)
                .where(
                    and(
                        gte(trackingSessions.faceCheckInAt, from),
                        lt(trackingSessions.faceCheckInAt, to)
                    )
                );

            const sessionIds = sessionRows.map((s) => s.id);
            const visitCounts = sessionIds.length
                ? await db
                      .select({
                          sessionId: visits.trackingSessionId,
                          count: sql<number>`count(*)::int`,
                      })
                      .from(visits)
                      .where(
                          sql`${visits.trackingSessionId} IN (${sql.join(
                              sessionIds.map((id) => sql`${id}::uuid`),
                              sql`, `
                          )})`
                      )
                      .groupBy(visits.trackingSessionId)
                : [];
            const visitsBySession = new Map(
                visitCounts.map((c) => [c.sessionId, c.count])
            );

            const perOfficer = new Map<
                string,
                { sessions: number; visits: number; dutyMs: number }
            >();
            const bump = (userId: string, fn: (row: { sessions: number; visits: number; dutyMs: number }) => void) => {
                let row = perOfficer.get(userId);
                if (!row) {
                    row = { sessions: 0, visits: 0, dutyMs: 0 };
                    perOfficer.set(userId, row);
                }
                fn(row);
            };
            for (const s of sessionRows) {
                bump(s.fieldOfficerUserId, (row) => {
                    row.sessions += 1;
                    row.visits += visitsBySession.get(s.id) ?? 0;
                    if (s.faceCheckOutAt) {
                        row.dutyMs += Math.max(
                            0,
                            s.faceCheckOutAt.getTime() - s.faceCheckInAt.getTime()
                        );
                    }
                });
            }

            return res.json({
                success: true,
                data: {
                    officers: officers.map((o) => {
                        const agg = perOfficer.get(o.userId);
                        return {
                            ...o,
                            sessionCount: agg?.sessions ?? 0,
                            visitCount: agg?.visits ?? 0,
                            dutyMs: agg?.dutyMs ?? 0,
                        };
                    }),
                },
            });
        } catch (err: any) {
            console.error('[fo-day-summary]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /**
     * Roll one OH's tracking sessions for a day into the attendance state the
     * LKS grid shows. An OH's face check-in/out sessions ARE his attendance
     * record — no separate attendance row exists — so status derives from
     * them: any open session means he is in, an 'auto_*' checkout means the
     * 23:59 sweeper closed his day, anything else was checked out on the
     * phone. Expects sessions sorted by faceCheckInAt ascending.
     */
    private summarizeOhDay(
        sessions: {
            faceCheckInAt: Date;
            faceCheckOutAt: Date | null;
            checkoutType: string | null;
            status: string;
        }[]
    ) {
        if (!sessions.length) {
            return {
                status: 'absent',
                checkInAt: null,
                checkOutAt: null,
                checkoutType: null,
                durationMinutes: 0,
                currentlyActive: false,
            };
        }
        const currentlyActive = sessions.some((s) => s.status === 'active');
        const completed = sessions.filter((s) => s.faceCheckOutAt);
        const last = completed.length ? completed[completed.length - 1] : null;
        const outs = completed.map((s) => s.faceCheckOutAt!.getTime());
        const now = Date.now();
        let durationMs = 0;
        for (const s of sessions) {
            // An open session counts up to "now"; the day is still running.
            durationMs += Math.max(
                0,
                (s.faceCheckOutAt ? s.faceCheckOutAt.getTime() : now) -
                    s.faceCheckInAt.getTime()
            );
        }
        return {
            status: currentlyActive
                ? 'active'
                : last?.checkoutType === 'auto_checkout' ||
                    last?.checkoutType === 'auto_max_duty'
                  ? 'auto'
                  : 'checked_out',
            checkInAt: sessions[0]?.faceCheckInAt.toISOString() ?? null,
            checkOutAt: outs.length ? new Date(Math.max(...outs)).toISOString() : null,
            // While still in, no checkout type applies yet.
            checkoutType: currentlyActive ? null : last?.checkoutType ?? null,
            durationMinutes: Math.round(durationMs / 60000),
            currentlyActive,
        };
    }

    /** GET /employee/field-officer/oh-attendance?date&locationId&siteId&page&limit&search
     * The LKS "OH Employee Attendance" grid: one row per active 'oh' user
     * with assigned sites and the day's attendance state. Filtering and
     * pagination happen in SQL; the whole page costs a fixed handful of
     * grouped queries regardless of row count (no N+1). */
    public async handleOhAttendanceList(req: Request, res: Response) {
        try {
            const parsed = ohAttendanceQueryModel.safeParse(req.query);
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: 'query validation failed',
                    error: parsed.error.issues,
                });
            }
            const { date, locationId, siteId, page, limit, search } = parsed.data;
            const { from, to } = istDayRange(date);

            const needle = search ? `%${search}%` : null;
            const rows = await db
                .select({
                    userId: usersTable.id,
                    phone: usersTable.phone,
                    firstName: employees.firstName,
                    lastName: employees.lastName,
                    designation: employees.designation,
                    // Window count rides the same query — a second roundtrip
                    // just to paginate would be pure waste.
                    total: sql<number>`count(*) over ()::int`,
                })
                .from(usersTable)
                .leftJoin(employees, eq(usersTable.employeeId, employees.id))
                .where(
                    and(
                        sql`${usersTable.roles} && ARRAY[${OH_ROLE}]::text[]`,
                        eq(usersTable.isActive, true),
                        locationId
                            ? sql`EXISTS (SELECT 1 FROM field_officer_sites fos JOIN sites s ON s.id = fos.site_id WHERE fos.field_officer_user_id = ${usersTable.id} AND s.location_id = ${locationId})`
                            : undefined,
                        siteId
                            ? sql`EXISTS (SELECT 1 FROM field_officer_sites fos WHERE fos.field_officer_user_id = ${usersTable.id} AND fos.site_id = ${siteId})`
                            : undefined,
                        needle
                            ? sql`(coalesce(${employees.firstName}, '') || ' ' || coalesce(${employees.lastName}, '') ILIKE ${needle} OR ${usersTable.phone} ILIKE ${needle})`
                            : undefined
                    )
                )
                .orderBy(asc(employees.firstName), asc(employees.lastName))
                .limit(limit)
                .offset((page - 1) * limit);

            const userIds = rows.map((r) => r.userId);

            // Assigned sites for the displayed page only — one grouped query.
            const siteRows = userIds.length
                ? await db
                      .select({
                          userId: fieldOfficerSites.fieldOfficerUserId,
                          sites: sql<{ siteId: string; siteName: string; locationName: string }[]>`json_agg(json_build_object('siteId', ${sites.id}, 'siteName', ${sites.siteName}, 'locationName', ${clientLocations.locationName}) order by ${sites.siteName})`,
                      })
                      .from(fieldOfficerSites)
                      .innerJoin(sites, eq(fieldOfficerSites.siteId, sites.id))
                      .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
                      .where(inArray(fieldOfficerSites.fieldOfficerUserId, userIds))
                      .groupBy(fieldOfficerSites.fieldOfficerUserId)
                : [];
            const sitesByUser = new Map(siteRows.map((r) => [r.userId, r.sites ?? []]));

            const sessionRows = userIds.length
                ? await db
                      .select({
                          id: trackingSessions.id,
                          userId: trackingSessions.fieldOfficerUserId,
                          faceCheckInAt: trackingSessions.faceCheckInAt,
                          faceCheckOutAt: trackingSessions.faceCheckOutAt,
                          checkoutType: trackingSessions.checkoutType,
                          status: trackingSessions.status,
                      })
                      .from(trackingSessions)
                      .where(
                          and(
                              inArray(trackingSessions.fieldOfficerUserId, userIds),
                              gte(trackingSessions.faceCheckInAt, from),
                              lt(trackingSessions.faceCheckInAt, to)
                          )
                      )
                      .orderBy(asc(trackingSessions.faceCheckInAt))
                : [];
            const sessionsByUser = new Map<string, typeof sessionRows>();
            for (const s of sessionRows) {
                const list = sessionsByUser.get(s.userId) ?? [];
                list.push(s);
                sessionsByUser.set(s.userId, list);
            }

            const sessionIds = sessionRows.map((s) => s.id);
            const pointCounts = sessionIds.length
                ? await db
                      .select({
                          sessionId: visitLocationPoints.trackingSessionId,
                          count: sql<number>`count(*)::int`,
                      })
                      .from(visitLocationPoints)
                      .where(inArray(visitLocationPoints.trackingSessionId, sessionIds))
                      .groupBy(visitLocationPoints.trackingSessionId)
                : [];
            const pointsBySession = new Map(
                pointCounts
                    .filter((c) => c.sessionId)
                    .map((c) => [c.sessionId as string, c.count])
            );

            return res.json({
                success: true,
                data: {
                    employees: rows.map((r) => {
                        const userSessions = sessionsByUser.get(r.userId) ?? [];
                        return {
                            userId: r.userId,
                            name:
                                [r.firstName, r.lastName].filter(Boolean).join(' ') ||
                                r.phone ||
                                'Unknown',
                            phone: r.phone,
                            designation: r.designation,
                            assignedSites: sitesByUser.get(r.userId) ?? [],
                            sessionCount: userSessions.length,
                            totalPoints: userSessions.reduce(
                                (n, s) => n + (pointsBySession.get(s.id) ?? 0),
                                0
                            ),
                            ...this.summarizeOhDay(userSessions),
                        };
                    }),
                    page,
                    limit,
                    total: Number(rows[0]?.total ?? 0),
                },
            });
        } catch (err: any) {
            console.error('[oh-attendance-list]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** GET /employee/field-officer/oh-attendance/:userId?date=YYYY-MM-DD
     * One OH employee's full day: attendance summary, every tracking session,
     * the auto-detected site visits (in/out events) and every GPS point in
     * chronological order for the travel map. Distance is summed between
     * consecutive fixes WITHIN a session — travel is never bridged across a
     * session gap, and the raw persisted points are read as-is. */
    public async handleOhAttendanceDetail(req: Request, res: Response) {
        try {
            const userId = String(req.params.userId);
            const parsed = ohAttendanceDetailQueryModel.safeParse(req.query);
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: 'query validation failed',
                    error: parsed.error.issues,
                });
            }
            const { date } = parsed.data;
            const { from, to } = istDayRange(date);

            // Hard role gate: an id typed into the URL must belong to an OH.
            const [employee] = await db
                .select({
                    userId: usersTable.id,
                    phone: usersTable.phone,
                    firstName: employees.firstName,
                    lastName: employees.lastName,
                    designation: employees.designation,
                })
                .from(usersTable)
                .leftJoin(employees, eq(usersTable.employeeId, employees.id))
                .where(
                    and(
                        eq(usersTable.id, userId),
                        sql`${usersTable.roles} && ARRAY[${OH_ROLE}]::text[]`
                    )
                );
            if (!employee) {
                return res
                    .status(404)
                    .json({ success: false, message: 'OH employee not found' });
            }

            const sessions = await db
                .select()
                .from(trackingSessions)
                .where(
                    and(
                        eq(trackingSessions.fieldOfficerUserId, userId),
                        gte(trackingSessions.faceCheckInAt, from),
                        lt(trackingSessions.faceCheckInAt, to)
                    )
                )
                .orderBy(asc(trackingSessions.faceCheckInAt));
            const sessionIds = sessions.map((s) => s.id);

            const siteVisits = sessionIds.length
                ? await db
                      .select({
                          id: visits.id,
                          trackingSessionId: visits.trackingSessionId,
                          siteId: visits.siteId,
                          siteName: sites.siteName,
                          siteCode: sites.siteCode,
                          locationName: clientLocations.locationName,
                          siteLatitude: sites.latitude,
                          siteLongitude: sites.longitude,
                          checkInAt: visits.checkInAt,
                          checkInLatitude: visits.checkInLatitude,
                          checkInLongitude: visits.checkInLongitude,
                          checkOutAt: visits.checkOutAt,
                          checkOutLatitude: visits.checkOutLatitude,
                          checkOutLongitude: visits.checkOutLongitude,
                          status: visits.status,
                      })
                      .from(visits)
                      .innerJoin(sites, eq(visits.siteId, sites.id))
                      .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
                      .where(inArray(visits.trackingSessionId, sessionIds))
                      .orderBy(asc(visits.checkInAt))
                : [];

            const points = sessionIds.length
                ? await db
                      .select({
                          id: visitLocationPoints.id,
                          trackingSessionId: visitLocationPoints.trackingSessionId,
                          visitId: visitLocationPoints.visitId,
                          siteId: visitLocationPoints.siteId,
                          latitude: visitLocationPoints.latitude,
                          longitude: visitLocationPoints.longitude,
                          accuracy: visitLocationPoints.accuracy,
                          speed: visitLocationPoints.speed,
                          recordedAt: visitLocationPoints.recordedAt,
                      })
                      .from(visitLocationPoints)
                      .where(inArray(visitLocationPoints.trackingSessionId, sessionIds))
                      .orderBy(
                          asc(visitLocationPoints.recordedAt),
                          asc(visitLocationPoints.createdAt)
                      )
                : [];

            const events = sessionIds.length
                ? await db
                      .select()
                      .from(foVisitEvents)
                      .where(inArray(foVisitEvents.trackingSessionId, sessionIds))
                      .orderBy(asc(foVisitEvents.eventTime), asc(foVisitEvents.createdAt))
                : [];

            const assignedSites = await db
                .select({
                    siteId: sites.id,
                    siteName: sites.siteName,
                    locationName: clientLocations.locationName,
                })
                .from(fieldOfficerSites)
                .innerJoin(sites, eq(fieldOfficerSites.siteId, sites.id))
                .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
                .where(eq(fieldOfficerSites.fieldOfficerUserId, userId))
                .orderBy(asc(sites.siteName));

            // Consecutive-fix distance, never bridging between sessions.
            let distanceM = 0;
            let prev: { sessionId: string; lat: number; lng: number } | null = null;
            for (const p of points) {
                const lat = Number(p.latitude);
                const lng = Number(p.longitude);
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
                const sessionId = String(p.trackingSessionId ?? '');
                if (prev && prev.sessionId === sessionId) {
                    distanceM += this.distanceM(prev.lat, prev.lng, lat, lng);
                }
                prev = { sessionId, lat, lng };
            }

            return res.json({
                success: true,
                data: {
                    employee: {
                        userId: employee.userId,
                        name:
                            [employee.firstName, employee.lastName]
                                .filter(Boolean)
                                .join(' ') || employee.phone || 'Unknown',
                        phone: employee.phone,
                        designation: employee.designation,
                        role: 'Operational Head',
                    },
                    assignedSites,
                    sessions,
                    siteVisits,
                    points,
                    events,
                    summary: {
                        ...this.summarizeOhDay(sessions),
                        totalTrackingPoints: points.length,
                        totalDistanceKm: Math.round((distanceM / 1000) * 10) / 10,
                    },
                },
            });
        } catch (err: any) {
            console.error('[oh-attendance-detail]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }
}
