import type { Request, Response } from 'express';
import { eq, sql } from 'drizzle-orm';

import { db } from '../../db';
import {
    usersTable,
} from '../../db/schema';
import { officerAttendanceQueryModel, type OfficerAttendanceQuery } from './models';
import {
    getOfficerAttCached,
    setOfficerAttCached,
    type OfficerAttCacheFilters,
} from '../../services/officerAttendanceCache';
import {
    VIEWER_ROLES,
    fieldOfficerSitesFor,
    isCircleOfficer,
    resolveViewerSiteScope,
    type ViewerSiteScope,
} from '../../services/circleOfficerScope';

// ── Roles allowed to read these reports ──────────────────────────────────────
// Circle Officer is the new one; Field Officer + Operational Head are folded in
// so the same officer-scoped reports serve them too. Authorization is per user
// account (their own postings, and for a CO the postings of the Field Officers
// assigned to him), so each viewer only ever sees the sites they reach. The role
// list comes from the scope service so the two can never disagree about who is a
// viewer.

interface ReportRow {
    [key: string]: unknown;
    employeeId: string;
    employeeName: string;
    phone: string | null;
    locationName: string | null;
    siteId: string;
    siteName: string;
    checkIn: string | null;
    checkOut: string | null;
    status: string;
    description: string | null;
}

/** Response metadata describing the request as authorized, including how the
 * viewer's scope was derived — that flag is what tells the client whether the
 * Field Officer column/filter applies, so no screen has to test a role name. */
interface ReportMeta {
    locationId: string | null;
    siteId: string | null;
    shift: string | null;
    foUserId: string | null;
    status: string | null;
    scope: ViewerSiteScope['scope'];
}

// DB-relative image path → a URL the app can load (mirrors the web report).
function normImage(p: string | null): string | null {
    if (!p) return null;
    if (p.startsWith('/uploads/')) return p;
    if (p.startsWith('/')) return `/uploads${p}`;
    return `/uploads/${p}`;
}

// The status the report displays, as one expression, so the displayed value and
// the status filter can never disagree. Reused in the select list and (because
// Postgres cannot reference a select alias in WHERE) in the filter itself.
const STATUS_EXPR = sql`case
    when d.incomplete_reason is not null then 'Incomplete'
    when d.check_out_at is not null then 'Completed'
    when d.check_in_at is not null then 'Present'
    else 'Absent'
end`;

function emptyPayload(q: OfficerAttendanceQuery, mode: 'employee' | 'shift', meta: ReportMeta) {
    return {
        date: q.date,
        rows: [] as ReportRow[],
        pagination: { page: q.page, pageSize: q.pageSize, total: 0, totalPages: 1 },
        summary: {
            date: q.date,
            totalEmployees: 0,
            present: 0,
            completed: 0,
            incomplete: 0,
            absent: 0,
            ...(mode === 'shift' ? { byShift: [] as { shift: string; presentEmployees: number; imageUrl: string | null }[] } : {}),
        },
        meta,
    };
}

export default class OfficerAttendanceController {
    // ── Guard ────────────────────────────────────────────────────────────────
    private async requireViewer(req: Request, res: Response) {
        // @ts-ignore — req.user set by authenticationMiddleware
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
        if (!user.roles?.some((r) => VIEWER_ROLES.includes(r))) {
            res.status(403).json({ success: false, message: 'Officer role required' });
            return null;
        }
        return user;
    }

    // ── GET /auth/officer/sites — dropdown source (authorized sites only) ─────
    public async handleSites(req: Request, res: Response) {
        try {
            const user = await this.requireViewer(req, res);
            if (!user) return;
            const viewer = await resolveViewerSiteScope(user);
            return res.json({
                success: true,
                data: {
                    sites: viewer.sites,
                    scope: viewer.scope,
                    fieldOfficers: viewer.officers,
                },
            });
        } catch (err: any) {
            console.error('[officer-sites]', err?.cause ?? err);
            return res.status(500).json({ success: false, message: err?.cause?.message ?? err.message });
        }
    }

    // ── GET /auth/officer/field-officers — the CO's Field Officer filter list ─
    // Circle Officer only: an FO or OH has nobody "under" them, and answering an
    // empty list there would read as a broken feature rather than as a refusal.
    public async handleFieldOfficers(req: Request, res: Response) {
        try {
            const user = await this.requireViewer(req, res);
            if (!user) return;
            if (!isCircleOfficer(user.roles)) {
                return res.status(403).json({
                    success: false,
                    message: 'Field Officer list is available to Circle Officers only.',
                });
            }

            const viewer = await resolveViewerSiteScope(user);
            const sitesByOfficer = new Map<string, { id: string; siteName: string; locationName: string }[]>();
            for (const site of viewer.sites) {
                for (const officer of site.officers) {
                    const list = sitesByOfficer.get(officer.id) ?? [];
                    if (!list.some((s) => s.id === site.id)) {
                        list.push({ id: site.id, siteName: site.siteName, locationName: site.locationName });
                        sitesByOfficer.set(officer.id, list);
                    }
                }
            }

            const fieldOfficers = viewer.officers.map((o) => {
                const list = (sitesByOfficer.get(o.id) ?? []).sort((a, b) =>
                    a.locationName.localeCompare(b.locationName) || a.siteName.localeCompare(b.siteName));
                return { ...o, siteCount: list.length, sites: list };
            });

            return res.json({
                success: true,
                data: { fieldOfficers, scope: viewer.scope, totalSites: viewer.sites.length },
            });
        } catch (err: any) {
            console.error('[officer-field-officers]', err?.cause ?? err);
            return res.status(500).json({ success: false, message: err?.cause?.message ?? err.message });
        }
    }

    // ── Reports ──────────────────────────────────────────────────────────────
    public async handleEmployeeAttendance(req: Request, res: Response) {
        return this.buildReport(req, res, 'employee');
    }

    public async handleShiftAttendance(req: Request, res: Response) {
        return this.buildReport(req, res, 'shift');
    }

    /**
     * Shared report builder. mode 'employee' → Employee Attendance (no shift
     * narrowing); mode 'shift' → Shift Attendance (optional shift filter +
     * byShift summary). Reuses the exact roster/duty/status definitions of the
     * admin shift-attendance report, scoped to the sites this viewer reaches.
     */
    private async buildReport(req: Request, res: Response, mode: 'employee' | 'shift') {
        try {
            const user = await this.requireViewer(req, res);
            if (!user) return;

            const parsed = officerAttendanceQueryModel.safeParse(req.query);
            if (!parsed.success) {
                return res.status(400).json({ success: false, message: 'query validation failed', error: parsed.error.issues });
            }
            const q: OfficerAttendanceQuery = parsed.data;

            // Historical viewing is allowed; the future has no records.
            const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
            if (q.date > today) {
                return res.status(400).json({ success: false, message: 'Invalid date. Not in the future.' });
            }
            // Shift narrowing only applies to the shift report; ignore it on the
            // employee report so a stray param can't silently empty that grid.
            const shift = mode === 'shift' ? q.shift ?? null : null;
            const locationId = q.locationId ?? null;
            const siteId = q.siteId ?? null;
            const status = q.status ?? null;
            const foUserId = q.foUserId ?? null;

            const metaBase: ReportMeta = {
                locationId, siteId, shift, foUserId, status,
                scope: isCircleOfficer(user.roles) ? 'circle-officer' : 'officer-sites',
            };
            const cacheFilters: OfficerAttCacheFilters = {
                locationId, siteId, shift, foUserId, status,
                date: q.date, page: q.page, pageSize: String(q.pageSize),
            };

            // Cache read-through keyed by viewer + filters, so a hit skips the
            // scope resolution + PG entirely. Key always carries the user id.
            const cached = await getOfficerAttCached(user.id, cacheFilters);
            if (cached) return res.json({ success: true, data: cached });

            // ── Authorization: the sites this viewer is allowed to read ───────
            const viewer = await resolveViewerSiteScope(user);
            const siteById = new Map(viewer.sites.map((s) => [s.id, s]));
            const assignedIds = viewer.sites.map((s) => s.id);

            let permitted = assignedIds;
            if (foUserId) {
                // Only a Circle Officer may narrow by Field Officer, and only to
                // an officer actively assigned to him. Both refusals answer 403
                // rather than an empty list, so a forged id reads as a refusal.
                if (!isCircleOfficer(user.roles)) {
                    return res.status(403).json({ success: false, message: 'Field Officer filter is available to Circle Officers only.' });
                }
                const officerSites = await fieldOfficerSitesFor(user.id, foUserId);
                if (!officerSites) {
                    return res.status(403).json({ success: false, message: 'You are not authorized to view attendance for this field officer.' });
                }
                // Intersected with the resolved scope, never used raw, so an
                // inactive or withdrawn posting can't slip through the filter.
                permitted = officerSites.filter((id) => assignedIds.includes(id));
            }

            let scoped: string[];
            if (siteId) {
                // Forged/foreign site → 403, never another officer's records.
                if (!permitted.includes(siteId)) {
                    return res.status(403).json({ success: false, message: 'You are not authorized to view attendance for this site.' });
                }
                scoped = [siteId];
            } else if (locationId) {
                scoped = permitted.filter((id) => siteById.get(id)?.locationId === locationId);
            } else {
                scoped = permitted;
            }

            // Shift filter → keep only sites that reported that shift this date.
            if (shift && scoped.length > 0) {
                const idList = sql.join(scoped.map((id) => sql`${id}::uuid`), sql`, `);
                const reported = await db.execute<{ site_id: string }>(sql`
                    select distinct sa.site_id
                    from shift_attendance sa
                    where sa.attendance_date = ${q.date}::date
                      and sa.shift = ${shift}
                      and sa.site_id in (${idList})
                `);
                const set = new Set(reported.rows.map((r) => r.site_id));
                scoped = scoped.filter((id) => set.has(id));
            }

            // Which Field Officer owns each site, for the report's FO column.
            // Built only for a Circle Officer scope — an FO/OH report has no FO
            // column, and its rows keep their existing shape.
            const officerBySite = new Map<string, string>();
            if (viewer.scope === 'circle-officer') {
                const chosen = foUserId ? viewer.officers.filter((o) => o.id === foUserId) : null;
                for (const site of viewer.sites) {
                    if (!scoped.includes(site.id)) continue;
                    const officers = chosen ?? site.officers;
                    if (officers.length > 0) officerBySite.set(site.id, officers.map((o) => o.name).join(', '));
                }
            }

            // Nothing in scope → empty payload (still cache it, briefly).
            if (scoped.length === 0) {
                const empty = emptyPayload(q, mode, { ...metaBase, scope: viewer.scope });
                await setOfficerAttCached(user.id, cacheFilters, empty);
                return res.json({ success: true, data: empty });
            }

            const payload = await this.runReport(scoped, q, mode, {
                meta: { ...metaBase, scope: viewer.scope },
                officerBySite: viewer.scope === 'circle-officer' ? officerBySite : null,
            });
            await setOfficerAttCached(user.id, cacheFilters, payload);
            return res.json({ success: true, data: payload });
        } catch (err: any) {
            console.error('[officer-attendance]', err?.cause ?? err);
            return res.status(500).json({ success: false, message: err?.cause?.message ?? err.message });
        }
    }

    /** The paged per-employee rows + full-set status summary + shift context. */
    private async runReport(
        siteIds: string[],
        q: OfficerAttendanceQuery,
        mode: 'employee' | 'shift',
        options: { meta: ReportMeta; officerBySite: Map<string, string> | null },
    ) {
        const { date, page, pageSize } = q;
        const status = options.meta.status;
        const idList = sql.join(siteIds.map((id) => sql`${id}::uuid`), sql`, `);
        const offset = (page - 1) * pageSize;

        // One roster/duty definition for all three aggregations, so the grid,
        // the page count and the status summary can never describe different
        // sets of people.
        //
        // A duty belongs to the site it was punched at: a Field Officer working
        // two sites in one day is two duties, and the day-wide min/max the report
        // used to take would have copied site A's times onto every other site he
        // is listed at.
        const ctes = sql`
            roster as (
                select distinct e.id as employee_id, e.first_name, e.last_name, e.phone,
                       es.site_id, s.site_name, cl.location_name
                from employees e
                join employee_sites es on es.employee_id = e.id
                join sites s on s.id = es.site_id
                join client_locations cl on cl.id = s.location_id
                where e.is_active = true and es.site_id in (${idList})
                union
                -- Or at a site he is POSTED to rather than employed at: that punch
                -- is his attendance for the day, so the grid shows it where it
                -- happened. Only a day actually punched gains a row here, so
                -- nobody is newly listed as absent for working elsewhere.
                select distinct e.id, e.first_name, e.last_name, e.phone,
                       al.site_id, s.site_name, cl.location_name
                from attendance_logs al
                join employees e on e.id = al.employee_id
                join sites s on s.id = al.site_id
                join client_locations cl on cl.id = s.location_id
                where e.is_active = true
                  and al.site_id in (${idList})
                  and coalesce(al.attendance_date, (al.created_at at time zone 'Asia/Kolkata')::date) = ${date}::date
            ),
            punched as (
                select al.employee_id, al.site_id,
                    min(al.created_at) filter (where al.action = 'check-in')  as check_in_at,
                    max(al.created_at) filter (where al.action = 'check-out') as check_out_at,
                    max(al.incomplete_reason) filter (where al.action = 'check-in') as incomplete_reason
                from attendance_logs al
                where coalesce(al.attendance_date, (al.created_at at time zone 'Asia/Kolkata')::date) = ${date}::date
                  and exists (select 1 from roster r where r.employee_id = al.employee_id)
                group by al.employee_id, al.site_id
            ),
            duties as (
                -- The duty one roster row displays: what was punched AT that site,
                -- or — when nothing was — the day's site-less punches. Every
                -- account that has never chosen a site punches with site_id NULL,
                -- so those rows keep the times they always showed.
                select distinct on (r.employee_id, r.site_id)
                    r.employee_id, r.site_id,
                    p.check_in_at, p.check_out_at, p.incomplete_reason
                from roster r
                join punched p on p.employee_id = r.employee_id
                    and (p.site_id = r.site_id or p.site_id is null)
                -- Exact-site first: the NULL fallback must never shadow a duty
                -- actually recorded at this site.
                order by r.employee_id, r.site_id, (p.site_id = r.site_id) desc nulls last
            )`;
        // The status filter is applied inside every aggregation, so the summary
        // always describes the rows actually in scope.
        const statusWhere = status ? sql`where ${STATUS_EXPR} = ${status}` : sql``;
        const dutyJoin = sql`left join duties d on d.employee_id = r.employee_id and d.site_id = r.site_id`;

        // Pagination total = employee-site roster pairs in scope.
        const tally = await db.execute<{ count: number }>(sql`
            with ${ctes}
            select count(*)::int as count
            from roster r
            ${dutyJoin}
            ${statusWhere}
        `);
        const total = tally.rows[0]?.count ?? 0;

        const rows = await db.execute<ReportRow>(sql`
            with ${ctes}
            select
                r.employee_id as "employeeId",
                concat(r.first_name, ' ', r.last_name) as "employeeName",
                r.phone as "phone",
                r.location_name as "locationName",
                r.site_id as "siteId",
                r.site_name as "siteName",
                to_char(d.check_in_at, 'HH24:MI') as "checkIn",
                to_char(d.check_out_at, 'HH24:MI') as "checkOut",
                ${STATUS_EXPR} as "status",
                d.incomplete_reason as "description"
            from roster r
            ${dutyJoin}
            ${statusWhere}
            order by r.first_name, r.last_name, r.employee_id, r.site_id
            limit ${pageSize} offset ${offset}
        `);

        // Status summary over the FULL filtered set (distinct employees), never
        // just the page.
        const summaryRows = await db.execute<{ status: string; count: number }>(sql`
            with ${ctes}
            select
                ${STATUS_EXPR} as status,
                count(*)::int as count
            from roster r
            ${dutyJoin}
            ${statusWhere}
            group by 1
        `);
        const counts = { Present: 0, Completed: 0, Incomplete: 0, Absent: 0 };
        for (const row of summaryRows.rows) {
            if (row.status === 'Present' || row.status === 'Completed' || row.status === 'Incomplete' || row.status === 'Absent') {
                counts[row.status] = row.count;
            }
        }

        // Site-level shift context for these sites on this date (existing
        // morning/day/night/general vocabulary) — the row "shifts" column and,
        // for the shift report, the byShift totals + a representative photo.
        const shiftRows = await db.execute<{ site_id: string; shift: string; present: number; image_path: string | null }>(sql`
            select sa.site_id, sa.shift, sa.present_employees as present, sa.image_path
            from shift_attendance sa
            where sa.attendance_date = ${date}::date and sa.site_id in (${idList})
            order by sa.shift
        `);
        const shiftsForSite = new Map<string, string[]>();
        const byShift = new Map<string, { present: number; imagePath: string | null }>();
        for (const row of shiftRows.rows) {
            const arr = shiftsForSite.get(row.site_id) ?? [];
            if (!arr.includes(row.shift)) arr.push(row.shift);
            shiftsForSite.set(row.site_id, arr);
            const agg = byShift.get(row.shift) ?? { present: 0, imagePath: null };
            agg.present += row.present ?? 0;
            if (!agg.imagePath) agg.imagePath = row.image_path;
            byShift.set(row.shift, agg);
        }

        const enriched = rows.rows.map((row, i) => ({
            slNo: offset + i + 1,
            ...row,
            shifts: (shiftsForSite.get(row.siteId) ?? []).join(', ') || null,
            ...(options.officerBySite
                ? { fieldOfficerNames: options.officerBySite.get(row.siteId) ?? null }
                : {}),
        }));

        return {
            date,
            rows: enriched,
            pagination: {
                page,
                pageSize,
                total,
                totalPages: Math.max(1, Math.ceil(total / pageSize)),
            },
            summary: {
                date,
                totalEmployees: counts.Present + counts.Completed + counts.Incomplete + counts.Absent,
                present: counts.Present,
                completed: counts.Completed,
                incomplete: counts.Incomplete,
                absent: counts.Absent,
                ...(mode === 'shift'
                    ? {
                        byShift: [...byShift.entries()].map(([s, v]) => ({
                            shift: s,
                            presentEmployees: v.present,
                            imageUrl: normImage(v.imagePath),
                        })),
                    }
                    : {}),
            },
            meta: options.meta,
        };
    }
}
