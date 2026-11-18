import type { Request, Response } from 'express'
import { randomBytes, createHmac } from 'node:crypto'
import { db } from '../../db'
import { attendanceLogs, employees, clientLocations, sites, employeeSites, usersTable, reportSubmissions, employeeViolations  } from '../../db/schema'
import { eq, and, or, ilike, desc, sql } from 'drizzle-orm';

import path from 'path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { reportAbsolutePath } from '../../services/reportStore';

import {
    createEmployeeSchema,
    updateEmployeeModel,
    createClientLocationModel,
    updateClientLocationModel,
    createSiteModel,
    updateSiteModel,
    assignSiteModel,
    idParamModel,
    updateEmployeeRolesModel,
} from './models';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { getEmbeddingFromSidecar } from '../utils/pythonSidecar';
import { saveFaceImage, deleteFaceImage } from '../../services/faceImageStore';
import { invalidateRosterForSite } from '../../services/employeeAttendanceCache';
import { clearSitesCacheOnly } from '../../services/foTrackingCache';
import { invalidateSitesCacheForSite } from '../../services/siteCacheInvalidation';
import { MATCH_THRESHOLD } from '../../services/faceService.js';
 

class EmployeesController {
    public async handleRegisterFace(req: Request, res: Response){
        
          const { image } = req.body as { image: string };
          const {empId } = req.body

         console.log(empId);
         //return;
          if (!image) {
                return res.status(400).json({ message: 'image (base64) is required' });
        }
        try {
             const embedding = await getEmbeddingFromSidecar(image);
                //  console.log(embedding);

                // Same as the mobile enrolment path: keep the frame the embedding
                // was built from so the enrolment can be reviewed later.
                const [existing] = await db
                    .select({ imagePath: employees.imagePath })
                    .from(employees)
                    .where(eq(employees.id, empId));

                const imagePath = await saveFaceImage(empId, image);

                // Drizzle customType handles number[] → '[f1,...,f512]' serialisation
                await db
                .update(employees)
                .set({
                    ...(imagePath ? { imagePath } : {}),
                    faceEmbedding: embedding,
                    hasRegisteredFace: true,
                    faceRegisteredAt:  new Date(),
                })
                .where(eq(employees.id, empId));

                if (imagePath && existing?.imagePath) await deleteFaceImage(existing.imagePath);

                return res.status(200).json({
                message: 'Face registered successfully',
                data: { empId, embeddingDimensions: embedding.length, imagePath },
                });
        } catch (err: any) {
            // The anti-spoofing gate refusing an enrolment is a business answer
            // (re-shoot the real face), not a server fault — say so instead of
            // blaming lighting, which is what a no-face reply implies.
            if (err?.spoof) {
            return res.status(422).json({
                message: 'Anti-spoofing refused that capture — it reads as a photo of a screen or a printed face. Re-take it straight from the camera, facing the employee, in even light.',
            });
            }
            if (err?.noFace) {
            return res.status(422).json({
                message: 'No face detected. Ensure good lighting and a clear front-facing photo.',
            });
            }
            console.error('[register-face]', err);
            return res.status(500).json({ message: 'Internal server error', detail: err.message });
        }
       
    }

    public async handleattendanceMark(req: Request, res: Response){
        const {
        image,
        action,
        empId
        }: {
        image: string;
        action: 'check-in' | 'check-out';
        empId: string;
        } = req.body;
        console.log(empId);
        const MATCH_THRESHOLD = 0.50;
        if (!image || !action)
            return res.status(400).json({ message: 'image and action are required' });
        if (!['check-in', 'check-out'].includes(action))
            return res.status(400).json({ message: 'action must be check-in or check-out' });
        
        try {
            // 1. Get 512-d embedding from Python sidecar
            const embedding = await getEmbeddingFromSidecar(image);
            const queryVec   = `[${embedding.join(',')}]`;
        
            // 2. pgvector cosine distance — scoped to this user (single row = O(1))
            //    <=> operator = cosine distance. Drizzle doesn't have a native helper
            //    so we use sql`` tagged template.
            const rows = await db.execute<{ id: string; distance: number }>(sql`
            SELECT id,
                    face_embedding <=> ${sql.raw(`'${queryVec}'::vector`)} AS distance
                FROM employees
            WHERE id                 = ${empId}
                AND has_registered_face = true
            LIMIT 1
            `);
        
            const row = rows.rows[0]; 
            if (!row) {
            return res.status(404).json({ message: 'No registered face found. Please register first.' });
            }
        
            const distance = Number(row.distance);
        
            if (distance > MATCH_THRESHOLD) {
            return res.status(401).json({
                message: 'Face verification failed. Please try again in better lighting.',
                debug: { distance: distance.toFixed(4), threshold: MATCH_THRESHOLD },
            });
            }
        
            // 3. Duplicate prevention
            if (action === 'check-in') {
            const existing = await db
                .select({ id: attendanceLogs.id })
                .from(attendanceLogs)
                .where(and(
                eq(attendanceLogs.employeeId, empId),
                eq(attendanceLogs.action, 'check-in'),
                sql`DATE(${attendanceLogs.createdAt}) = CURRENT_DATE`
                ))
                .limit(1);
        
            if (existing.length)
                return res.status(409).json({ message: 'Already checked in today.' });
            }
        
            if (action === 'check-out') {
           // Night shifts cross midnight, so "checked in today" is the wrong
                // gate. A check-out closes the most recent open duty: an open
                // check-in exists exactly when the latest punch is a check-in
                // (any later check-out would have closed it).
                const latest = await db
                    .select({ action: attendanceLogs.action })
                    .from(attendanceLogs)
                    .where(eq(attendanceLogs.employeeId, empId))
                    .orderBy(desc(attendanceLogs.createdAt))
                    .limit(1)
 
                if (latest[0]?.action !== 'check-in')
                    return res.status(409).json({ message: 'Cannot check out without checking in first.' })
            }
        
            // 4. Log attendance
            const [log] = await db
            .insert(attendanceLogs)
            .values({
                employeeId:   empId,
                action,
                faceDistance: distance.toFixed(4),
            })
            .returning({ id: attendanceLogs.id, createdAt: attendanceLogs.createdAt });
        
            return res.status(200).json({
            message: action === 'check-in' ? 'Checked in successfully' : 'Checked out successfully',
            data: {
                logId:        log?.id,
                action,
                timestamp:    log?.createdAt,
                faceDistance: parseFloat(distance.toFixed(4)),
            },
            });
        
        } catch (err: any) {
            // Same split as the enrolment path above: a spoof refusal is not a
            // missing face, and telling the operator to "try again" hides that
            // anti-spoofing blocked the punch.
            if (err?.spoof) {
            return res.status(422).json({ message: 'Anti-spoofing refused this capture — it reads as a photo of a screen or a printed face. Re-take it straight from the camera.' });
            }
            if (err?.noFace) {
            return res.status(422).json({ message: 'No face detected. Please try again.' });
            }
            console.error('[mark-attendance]', err);
            return res.status(500).json({ message: 'Internal server error', detail: err.message });
        }
    }

     /**
     * Attendance report — one row per duty (a check-in paired with the next
     * check-out).
     *
     * Duties are paired chronologically per employee rather than by calendar
     * day, so a night shift — check-in 20:00, check-out 06:00 the next
     * morning — is one row dated by the check-in, with the full duty time.
     * A check-in with no check-out yet stays open (check-out '—').
     *
     * Paginated: the table requests fixed-size pages; omitting `pageSize`
     * (or sending <= 0) returns every matching row, which the Excel export
     * uses to dump the full filtered set rather than just the visible page.
     *
     * "Distance" is the geodesic distance in metres from the check-in's GPS
     * fix to its site's geofence centre, computed live rather than stored.
     * Check-ins recorded without a fix (geo_lat/geo_lng NULL) come back as
     * null and render as '—'.
     */
    public async attendanceReport(req: Request, res: Response){
        try {
            const from = (req.query.from as string | undefined)?.trim()
            const to = (req.query.to as string | undefined)?.trim()
            const siteId = (req.query.siteId as string | undefined)?.trim()
            const employeeId = (req.query.employeeId as string | undefined)?.trim()
 
            const pageRaw = Number(req.query.page)
            const sizeRaw = Number(req.query.pageSize)
            const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1
            const pageSize = Number.isInteger(sizeRaw) && sizeRaw > 0 ? Math.min(sizeRaw, 10000) : null
 
            // Filters shared by the count and the page/export queries. The CTE's
            // upper bound reaches one extra day past `to` so a night shift whose
            // check-out lands the next morning still finds its pair; only
            // check-ins strictly inside [from, to) become rows (emitFilter).
            // Time formatting and DATE() rely on the DB session's clock
            // (Asia/Kolkata), same as the punches.
            const conds = []
            if (from) conds.push(sql`al.created_at >= ${from}::date`)
            if (to) conds.push(sql`al.created_at < (${to}::date + interval '2 day')`)
            if (siteId && idParamModel.safeParse({ id: siteId }).success) conds.push(sql`al.site_id = ${siteId}`)
            if (employeeId && idParamModel.safeParse({ id: employeeId }).success) conds.push(sql`al.employee_id = ${employeeId}`)
 
            const whereSql = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``
 
            // A row is emitted for a check-in strictly inside the requested
            // window; check-ins that slipped into the CTE's widened range are
            // dropped (their check-outs are still available for pairing).
            const emitFilter = to ? sql`p.created_at < (${to}::date + interval '1 day')` : sql`true`
 
            // Every matching punch in time order per employee; `rn` lets each
            // check-in look at its immediate successor (see rows query below).
            const punchesCte = sql`
                select
                    al.id,
                    al.employee_id,
                    al.site_id,
                    al.action,
                    al.created_at,
                    al.geo_lat,
                    al.geo_lng,
                    al.device_info,
                    row_number() over (
                        partition by al.employee_id
                        order by al.created_at
                    ) as rn
                from attendance_logs al
                ${whereSql}
            `
 
            // Only the paged view needs the total; the export path skips the
            // extra round trip and reports the rows it actually got.
            let total = 0
            if (pageSize) {
                const tally = await db.execute<{ count: number }>(sql`
                    with punches as (${punchesCte})
                    select count(*)::int as count
                    from punches p
                    where p.action = 'check-in' and ${emitFilter}
                `)
                total = tally.rows[0]?.count ?? 0
            }
 
            const rows = await db.execute<DailyReportRow>(sql`
                with punches as (${punchesCte})
                select
                    ci.id,
                    concat(e.first_name, ' ', e.last_name) as "employeeName",
                    s.site_name as "siteName",
                    to_char(ci.check_in_at, 'YYYY-MM-DD') as "createdAtDateOnly",
                    to_char(ci.check_in_at, 'HH24:MI:SS') as "checkIn",
                    to_char(ci.check_out_at, 'HH24:MI:SS') as "checkOut",
                    -- Duty time = check-out minus check-in, spanning midnight for
                    -- night shifts. Interval, so the gap between 20:00 and 06:00
                    -- is correctly 10 hours, not -14.
                    to_char(ci.check_out_at - ci.check_in_at, 'HH24:MI:SS') as "dutyTime",
                    round(
                        6371000 * 2 * asin(sqrt(
                            power(sin((radians(s.latitude) - radians(ci.geo_lat)) / 2), 2)
                            + cos(radians(ci.geo_lat)) * cos(radians(s.latitude))
                            * power(sin((radians(s.longitude) - radians(ci.geo_lng)) / 2), 2)
                        ))
                    )::double precision as "distanceM",
                    -- The handset the CHECK-IN was recorded on — "from which
                    -- mobile did this attendance come". Check-out device stays
                    -- on its own punch row; the report pairs onto the check-in.
                    ci.device_info as "deviceInfo"
                from (
                    -- Pair each check-in with the very next punch; the join keeps
                    -- it only when that next punch is a check-out, so consecutive
                    -- check-ins (an anomaly) leave the earlier one open.
                    select
                        p.id,
                        p.employee_id,
                        p.site_id,
                        p.created_at as check_in_at,
                        p.geo_lat,
                        p.geo_lng,
                        p.device_info,
                        co.created_at as check_out_at
                    from punches p
                    left join punches co
                        on co.employee_id = p.employee_id
                        and co.rn = p.rn + 1
                        and co.action = 'check-out'
                    where p.action = 'check-in' and ${emitFilter}
                ) ci
                join employees e on e.id = ci.employee_id
                left join sites s on s.id = ci.site_id
                order by ci.check_in_at desc, e.first_name, e.last_name, ci.employee_id
                ${pageSize ? sql`limit ${pageSize} offset ${(page - 1) * pageSize}` : sql``}
            `)
 
            if (!pageSize) total = rows.rows.length
 
            res.json({
                success: true,
                data: {
                    rows: rows.rows,
                    pagination: {
                        page,
                        pageSize: pageSize ?? rows.rows.length,
                        total,
                        totalPages: pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1,
                    },
                },
            })
        } catch (error: any) {
            console.error('[attendance-report]', error)
            // drizzle wraps DB failures in a "Query failed: …" message that dumps
            // the SQL — useless to an admin. The real Postgres error is on .cause.
            const detail = error?.cause?.message ?? error?.message
            res.status(500).json({ success: false, message: detail || 'Internal Server Error' })
        }
    }

   /**
     * Attendance summary — one row per employee, aggregating every duty inside
     * the date range.
     *
     * A duty is a check-in paired with the next punch; it is complete when that
     * punch is a check-out. Night shifts pair across midnight (20:00 → 06:00 is
     * one complete duty), so the widened range below can find the next-morning
     * check-out of a check-in on the last requested day — the same convention
     * the daily report uses.
     *
     * "Present days" counts distinct check-in dates; "incomplete punching"
     * counts duties whose check-out never happened (still open, or a double
     * check-in). Employees with no punches in range still appear with zeros, so
     * total absence is visible instead of silently dropped. Working days and the
     * derived absent days / attendance rate are computed server-side, so the
     * Excel export gets the same numbers as the table.
     *
     * Same filters as the daily report (date range / site / employee) plus
     * department and status, so it slots into the same filter bar.
     *
     * A Field Officer's row names the site he last checked in at inside the range
     * (`siteNames` lists every one he worked), because he is not tied to one
     * primary site any more. Anyone who punches without choosing a site keeps the
     * assigned-site name this report has always shown.
     */
    public async attendanceSummaryReport(req: Request, res: Response){
        try {
            const from = (req.query.from as string | undefined)?.trim()
            const to = (req.query.to as string | undefined)?.trim()
            const siteId = (req.query.siteId as string | undefined)?.trim()
            const employeeId = (req.query.employeeId as string | undefined)?.trim()
            const department = (req.query.department as string | undefined)?.trim()
            const status = (req.query.status as string | undefined)?.trim()

            const pageRaw = Number(req.query.page)
            const sizeRaw = Number(req.query.pageSize)
            const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1
            const pageSize = Number.isInteger(sizeRaw) && sizeRaw > 0 ? Math.min(sizeRaw, 10000) : null

            // Employees the summary covers. A site filter restricts to employees
            // actually assigned to that site (the same EXISTS the roster uses);
            // their punches are then narrowed to the site in the CTE below.
            const empConds = []
            if (employeeId && idParamModel.safeParse({ id: employeeId }).success)
                empConds.push(sql`e.id = ${employeeId}`)
            if (department)
                empConds.push(sql`e.department ilike ${`%${department}%`}`)
            if (status === 'active') empConds.push(sql`e.is_active = true`)
            if (status === 'inactive') empConds.push(sql`e.is_active = false`)
            if (siteId && idParamModel.safeParse({ id: siteId }).success)
                empConds.push(sql`exists (
                    select 1 from employee_sites es
                    where es.employee_id = e.id and es.site_id = ${siteId}
                )`)
            const empWhere = empConds.length ? sql`where ${sql.join(empConds, sql` and `)}` : sql``

            // Punches narrowed like the daily report. from/to are always applied;
            // the optional site/employee filters restrict what each row counts.
            const punchConds = []
            if (from) punchConds.push(sql`al.created_at >= ${from}::date`)
            if (to) punchConds.push(sql`al.created_at < (${to}::date + interval '2 day')`)
            if (siteId && idParamModel.safeParse({ id: siteId }).success)
                punchConds.push(sql`al.site_id = ${siteId}`)
            if (employeeId && idParamModel.safeParse({ id: employeeId }).success)
                punchConds.push(sql`al.employee_id = ${employeeId}`)
            const punchWhere = punchConds.length ? sql`where ${sql.join(punchConds, sql` and `)}` : sql``

            // Only the paged view needs the roster count; the export path skips
            // the extra round trip and reports the rows it actually got.
            let total = 0
            if (pageSize) {
                const tally = await db.execute<{ count: number }>(sql`
                    select count(*)::int as count
                    from employees e
                    ${empWhere}
                `)
                total = tally.rows[0]?.count ?? 0
            }

            const rows = await db.execute<SummaryReportRow>(sql`
                with punches as (
                    select
                        al.id,
                        al.employee_id,
                        al.action,
                        al.created_at,
                        -- Which site opened each duty — a Field Officer's summary
                        -- has to say where he actually turned up, not only where
                        -- HR filed his assignment.
                        al.site_id,
                        row_number() over (
                            partition by al.employee_id
                            order by al.created_at
                        ) as rn
                    from attendance_logs al
                    ${punchWhere}
                ),
                duties as (
                    -- Pair each check-in with the very next punch; the join keeps
                    -- it only when that next punch is a check-out, so a still-open
                    -- duty (or a double check-in) is left incomplete.
                    select
                        p.id,
                        p.employee_id,
                        p.created_at as check_in_at,
                        p.site_id as check_in_site_id,
                        co.created_at as check_out_at,
                        case when co.id is not null then 1 else 0 end as completed
                    from punches p
                    left join punches co
                        on co.employee_id = p.employee_id
                        and co.rn = p.rn + 1
                        and co.action = 'check-out'
                    where p.action = 'check-in'
                        and p.created_at < ${to ? sql`(${to}::date + interval '1 day')` : sql`'infinity'`}
                ),
                attended as (
                    -- Sites a duty was OPENED at. A cross-site check-out (in at A,
                    -- out at B) stays attributed to A, the same way the daily
                    -- report pairs a duty onto its check-in.
                    select d.employee_id, s.id as site_id, s.site_name, d.check_in_at
                    from duties d
                    join sites s on s.id = d.check_in_site_id
                ),
                attended_summary as (
                    select
                        a.employee_id,
                        string_agg(distinct a.site_name, ', ' order by a.site_name) as site_names
                    from attended a
                    group by a.employee_id
                ),
                attended_latest as (
                    select distinct on (a.employee_id) a.employee_id, a.site_name
                    from attended a
                    order by a.employee_id, a.check_in_at desc
                ),
                summary as (
                    select
                        d.employee_id,
                        count(*) as total_duties,
                        count(distinct date(d.check_in_at)) as present_days,
                        count(*) filter (where d.completed = 0) as incomplete_punching,
                        sum(case when d.completed = 1
                                 then extract(epoch from d.check_out_at - d.check_in_at)
                                 else 0 end) as total_duty_seconds
                    from duties d
                    group by d.employee_id
                )
                select
                    e.id as "employeeId",
                    concat(e.first_name, ' ', e.last_name) as "employeeName",
                    e.department as "department",
                    e.designation as "designation",
                    e.is_active as "isActive",
                    -- Where he last punched in within the range, and only when he
                    -- punched nowhere (or with no site on the row) the site he is
                    -- assigned to. Employees who never choose a site keep the
                    -- value this report has always shown them.
                    coalesce(
                        worked.site_name,
                        (
                            select s.site_name
                            from employee_sites es
                            join sites s on s.id = es.site_id
                            where es.employee_id = e.id
                            order by es.created_at, s.site_name
                            limit 1
                        )
                    ) as "siteName",
                    workedSites.site_names as "siteNames",
                    coalesce(s.total_duties, 0)::int as "totalDuties",
                    coalesce(s.present_days, 0)::int as "presentDays",
                    coalesce(s.incomplete_punching, 0)::int as "incompletePunching",
                    coalesce(s.total_duty_seconds, 0)::int as "totalDutySeconds"
                from employees e
                left join summary s on s.employee_id = e.id
                left join attended_latest worked on worked.employee_id = e.id
                left join attended_summary workedSites on workedSites.employee_id = e.id
                ${empWhere}
                order by e.first_name, e.last_name, e.id
                ${pageSize ? sql`limit ${pageSize} offset ${(page - 1) * pageSize}` : sql``}
            `)

            if (!pageSize) total = rows.rows.length

            // Working days = calendar days in the requested range. Absence and the
            // attendance rate derive from it, so they share one source of truth.
            const workingDays = from && to
                ? Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
                : null

            const enriched = rows.rows.map((row) => {
                const absentDays = workingDays === null
                    ? null
                    : Math.max(0, workingDays - row.presentDays)
                const attendanceRate = workingDays && workingDays > 0
                    ? Math.round((row.presentDays / workingDays) * 1000) / 10
                    : null
                return {
                    ...row,
                    workingDays,
                    absentDays,
                    attendanceRate,
                    totalCheckIns: row.totalDuties,
                    totalCheckOuts: Math.max(0, row.totalDuties - row.incompletePunching),
                }
            })

            res.json({
                success: true,
                data: {
                    rows: enriched,
                    pagination: {
                        page,
                        pageSize: pageSize ?? enriched.length,
                        total,
                        totalPages: pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1,
                    },
                    meta: { from, to, workingDays },
                },
            })
        } catch (error: any) {
            console.error('[attendance-summary]', error)
            const detail = error?.cause?.message ?? error?.message
            res.status(500).json({ success: false, message: detail || 'Internal Server Error' })
        }
    }

    /**
     * Per-day attendance detail for ONE employee — the drill-down behind the
     * summary report's "View" button. Every calendar day in the range comes
     * back with a status the UI can paint a tile with:
     *
     *   present    — at least one completed duty (check-in paired with check-out)
     *   incomplete — punched in but never out (open duty or double check-in)
     *   absent     — no punches on a day that has already passed
     *   upcoming   — a future day, nothing to judge yet
     *
     * Duties pair across midnight exactly like the summary aggregate, so a
     * 20:00 → 06:00 night shift counts as present on the day it started.
     */
    public async attendanceDayDetails(req: Request, res: Response) {
        try {
            const employeeId = (req.query.employeeId as string | undefined)?.trim()
            const from = (req.query.from as string | undefined)?.trim()
            const to = (req.query.to as string | undefined)?.trim()

            if (!employeeId || !idParamModel.safeParse({ id: employeeId }).success)
                return res.status(400).json({ success: false, message: 'A valid employeeId is required' })
            if (!from || !to)
                return res.status(400).json({ success: false, message: 'from and to dates are required' })

            // The tiles render one square per day; an unbounded range would
            // happily draw ten thousand of them, so cap at a year.
            const dayCount = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
            if (Number.isNaN(dayCount) || dayCount < 1)
                return res.status(400).json({ success: false, message: 'Invalid date range' })
            if (dayCount > 366)
                return res.status(400).json({ success: false, message: 'Date range cannot exceed 366 days' })

            const rows = await db.execute<DayDetailRow>(sql`
                with punches as (
                    select
                        al.id,
                        al.action,
                        al.created_at,
                        al.device_info,
                        row_number() over (order by al.created_at) as rn
                    from attendance_logs al
                    where al.employee_id = ${employeeId}
                        and al.created_at >= ${from}::date
                        -- widened like the summary so a last-day check-in can
                        -- still find its next-morning check-out
                        and al.created_at < (${to}::date + interval '2 day')
                ),
                duties as (
                    select
                        p.created_at as check_in_at,
                        co.created_at as check_out_at,
                        p.device_info,
                        case when co.id is not null then 1 else 0 end as completed
                    from punches p
                    left join punches co
                        on co.rn = p.rn + 1
                        and co.action = 'check-out'
                    where p.action = 'check-in'
                        and p.created_at < (${to}::date + interval '1 day')
                ),
                per_day as (
                    select
                        date(d.check_in_at) as day,
                        count(*)::int as duties,
                        count(*) filter (where d.completed = 1)::int as completed_duties,
                        min(d.check_in_at) as first_check_in,
                        max(d.check_out_at) as last_check_out,
                        sum(case when d.completed = 1
                            then extract(epoch from d.check_out_at - d.check_in_at)
                            else 0 end)::int as duty_seconds,
                        -- Device of the day's FIRST check-in that reported one —
                        -- the handset the attendance was given from.
                        (array_agg(d.device_info order by d.check_in_at)
                            filter (where d.device_info is not null))[1] as device_info
                    from duties d
                    group by date(d.check_in_at)
                )
                select
                    to_char(gs.day, 'YYYY-MM-DD') as "date",
                    case
                        when pd.completed_duties > 0 then 'present'
                        when pd.duties > 0 then 'incomplete'
                        when gs.day > current_date then 'upcoming'
                        else 'absent'
                    end as "status",
                    coalesce(pd.duties, 0)::int as "duties",
                    coalesce(pd.duty_seconds, 0)::int as "dutySeconds",
                    to_char(pd.first_check_in, 'HH24:MI') as "checkIn",
                    to_char(pd.last_check_out, 'HH24:MI') as "checkOut",
                    pd.device_info as "deviceInfo"
                from generate_series(${from}::date, ${to}::date, interval '1 day') as gs(day)
                left join per_day pd on pd.day = gs.day
                order by gs.day
            `)

            res.json({
                success: true,
                data: {
                    rows: rows.rows,
                    meta: { employeeId, from, to },
                },
            })
        } catch (error: any) {
            console.error('[attendance-day-details]', error)
            const detail = error?.cause?.message ?? error?.message
            res.status(500).json({ success: false, message: detail || 'Internal Server Error' })
        }
    }

    /**
     * Shift attendance report — one row per employee assigned to the scoped
     * site(s) for a single date, with that day's duty paired onto it.
     *
     * Status uses the same derivation as the mobile team grid (no second
     * status system): no check-in → Absent; check-in only → Present; plus a
     * check-out → Completed; supervisor-recorded reason → Incomplete (with the
     * reason as the description). Duties pair first-check-in/last-check-out
     * like the history endpoint, so corrected punches collapse to one row.
     *
     * The `shifts` column is site-level context, not a per-employee posting
     * (the schema maps shifts to site+date via shift_attendance): the shift
     * summaries submitted for that row's site on that date, comma-joined.
     * Shift-wise present totals and their group photos ride in
     * `summary.byShift`, where the image viewer reads them from.
     *
     * Read-only back-office data behind the same admin guard as the rest of
     * this router. Results are paged; the summary always covers the full
     * filtered set. Cached 5 minutes per filter combo (PG is the truth).
     */
    public async shiftAttendanceReport(req: Request, res: Response) {
        try {
            const locationId = (req.query.locationId as string | undefined)?.trim() || null
            const siteId = (req.query.siteId as string | undefined)?.trim() || null
            const date = (req.query.date as string | undefined)?.trim()

            if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
                return res.status(400).json({ success: false, message: 'date (YYYY-MM-DD) is required' })
            }
            if (locationId && idParamModel.safeParse({ id: locationId }).error) {
                return res.status(400).json({ success: false, message: 'Invalid locationId' })
            }
            if (siteId && idParamModel.safeParse({ id: siteId }).error) {
                return res.status(400).json({ success: false, message: 'Invalid siteId' })
            }

            // Authorization is structural: admin-only router, and the site must
            // belong to the location when both are given — a forged combo 400s
            // instead of silently returning another site's rows.
            if (locationId) {
                const [loc] = await db
                    .select({ id: clientLocations.id })
                    .from(clientLocations)
                    .where(eq(clientLocations.id, locationId))
                if (!loc) return res.status(404).json({ success: false, message: 'Location not found' })
            }
            if (siteId) {
                const [site] = await db
                    .select({ id: sites.id, locationId: sites.locationId })
                    .from(sites)
                    .where(eq(sites.id, siteId))
                if (!site) return res.status(404).json({ success: false, message: 'Site not found' })
                if (locationId && site.locationId !== locationId) {
                    return res.status(400).json({ success: false, message: 'Site does not belong to the selected location' })
                }
            }

            const pageRaw = Number(req.query.page)
            const sizeRaw = Number(req.query.pageSize ?? req.query.limit)
            const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1
            const pageSize = Number.isInteger(sizeRaw) && sizeRaw > 0 ? Math.min(sizeRaw, 10000) : null
            const limitKey = pageSize === null ? 'all' : String(pageSize)

            // Read-through report cache (spec key family, 5-min TTL). Any Redis
            // error falls back to PG — the report never fails for cache reasons.
            const { getShiftReportCached, setShiftReportCached } = await import('../../services/shiftAttendanceCache.js')
            const cached = await getShiftReportCached(locationId ?? 'all', siteId ?? 'all', date, page, limitKey)
            if (cached) return res.json({ success: true, data: cached })

            // One predicate family for every query below, so the roster, the
            // rows, the summary and the shift context always describe the same
            // filtered set. Admins see all locations/sites; the guard is the
            // admin-only router, and a mismatched site+location combo 400s.
            const scopeConds = []
            if (siteId) scopeConds.push(sql`s.id = ${siteId}`)
            else if (locationId) scopeConds.push(sql`s.location_id = ${locationId}`)
            const scopeFilter = scopeConds.length ? sql`where ${sql.join(scopeConds, sql` and `)}` : sql``

            // One scoped_sites/roster/duty definition for the tally, the rows and
            // the summary, so the three can never describe different sets of
            // people — and so a duty is attributed to the site it was punched at
            // rather than copied onto every site its employee is listed at.
            const ctes = sql`
                scoped_sites as (
                    select s.id, s.site_name
                    from sites s
                    ${scopeFilter}
                ),
                roster as (
                    select distinct e.id as employee_id, e.first_name, e.last_name,
                           e.phone, es.site_id
                    from employees e
                    join employee_sites es on es.employee_id = e.id
                    join scoped_sites ss on ss.id = es.site_id
                    where e.is_active = true
                    union
                    -- Whoever punched at a scoped site today is on that site's
                    -- grid, even if his assignment sits elsewhere: a Field Officer
                    -- works the site he selected, and an attendance grid that
                    -- ignored the choice would show him absent everywhere.
                    select distinct e.id, e.first_name, e.last_name, e.phone, al.site_id
                    from attendance_logs al
                    join employees e on e.id = al.employee_id
                    join scoped_sites ss on ss.id = al.site_id
                    where e.is_active = true
                      and al.site_id is not null
                      and coalesce(al.attendance_date, (al.created_at at time zone 'Asia/Kolkata')::date) = ${date}::date
                ),
                punched as (
                    select al.employee_id, al.site_id,
                        min(al.created_at) filter (where al.action = 'check-in') as check_in_at,
                        max(al.created_at) filter (where al.action = 'check-out') as check_out_at,
                        max(al.incomplete_reason) filter (where al.action = 'check-in') as incomplete_reason
                    from attendance_logs al
                    where coalesce(al.attendance_date, (al.created_at at time zone 'Asia/Kolkata')::date) = ${date}::date
                      and exists (select 1 from roster r where r.employee_id = al.employee_id)
                    group by al.employee_id, al.site_id
                ),
                duties as (
                    -- The duty a grid row shows: what was punched AT this site, or
                    -- the day's site-less punches when nothing was — which is how
                    -- every account that never chose a site is recorded, so those
                    -- rows keep the times they always showed.
                    select distinct on (r.employee_id, r.site_id)
                        r.employee_id, r.site_id,
                        p.check_in_at, p.check_out_at, p.incomplete_reason
                    from roster r
                    join punched p on p.employee_id = r.employee_id
                        and (p.site_id = r.site_id or p.site_id is null)
                    order by r.employee_id, r.site_id, (p.site_id = r.site_id) desc nulls last
                )`

            const tally = await db.execute<{ count: number }>(sql`
                with ${ctes}
                select count(*)::int as count
                from roster r
                left join duties d on d.employee_id = r.employee_id and d.site_id = r.site_id
            `)
            const total = tally.rows[0]?.count ?? 0

            const rows = await db.execute<ShiftReportRow>(sql`
                with ${ctes}
                select
                    r.employee_id as "employeeId",
                    concat(r.first_name, ' ', r.last_name) as "employeeName",
                    r.phone as "phone",
                    r.site_id as "siteId",
                    (select ss.site_name from scoped_sites ss where ss.id = r.site_id) as "siteName",
                    to_char(d.check_in_at, 'HH24:MI') as "checkIn",
                    to_char(d.check_out_at, 'HH24:MI') as "checkOut",
                    case
                        when d.incomplete_reason is not null then 'Incomplete'
                        when d.check_out_at is not null then 'Completed'
                        when d.check_in_at is not null then 'Present'
                        else 'Absent'
                    end as "status",
                    d.incomplete_reason as "description"
                from roster r
                left join duties d on d.employee_id = r.employee_id and d.site_id = r.site_id
                order by r.first_name, r.last_name, r.employee_id, r.site_id
                ${pageSize ? sql`limit ${pageSize} offset ${(page - 1) * pageSize}` : sql``}
            `)

            // Summary over the FULL filtered set (never just the page), with
            // the same roster/duty definitions as the rows above.
            const summaryRows = await db.execute<{ status: string; count: number }>(sql`
                with ${ctes}
                select
                    case
                        when d.incomplete_reason is not null then 'Incomplete'
                        when d.check_out_at is not null then 'Completed'
                        when d.check_in_at is not null then 'Present'
                        else 'Absent'
                    end as status,
                    count(*)::int as count
                from roster r
                left join duties d on d.employee_id = r.employee_id and d.site_id = r.site_id
                group by 1
            `)
            const counts: Record<string, number> = { Present: 0, Completed: 0, Incomplete: 0, Absent: 0 }
            for (const row of summaryRows.rows) {
                if (row.status in counts) counts[row.status] = row.count
            }

            // Shift context for the scoped sites on this date — the existing
            // Morning/Day/Night/General vocabulary from shift_attendance, with
            // present totals and group photos for the summary block + viewer.
            // Site-level data by design (shifts map to site+date, not to an
            // employee); rows list every shift submitted for their site+date.
            const shiftSummary = await db.execute<{
                shift: string; present: number; image_path: string | null
            }>(sql`
                select sa.shift,
                       sum(sa.present_employees)::int as present,
                       max(sa.image_path) as image_path
                from shift_attendance sa
                join sites s on s.id = sa.site_id
                ${scopeConds.length
                    ? sql`where ${sql.join(scopeConds, sql` and `)} and sa.attendance_date = ${date}::date`
                    : sql`where sa.attendance_date = ${date}::date`}
                group by sa.shift
                order by sa.shift
            `)
            const shiftsBySite = await db.execute<{ site_id: string; shift: string }>(sql`
                select distinct sa.site_id, sa.shift
                from shift_attendance sa
                join sites s on s.id = sa.site_id
                ${scopeConds.length
                    ? sql`where ${sql.join(scopeConds, sql` and `)} and sa.attendance_date = ${date}::date`
                    : sql`where sa.attendance_date = ${date}::date`}
            `)
            const shiftsForSite = new Map<string, string[]>()
            for (const row of shiftsBySite.rows) {
                const arr = shiftsForSite.get(row.site_id) ?? []
                arr.push(row.shift)
                shiftsForSite.set(row.site_id, arr)
            }

            const normImage = (p: string | null) =>
                !p ? null
                : p.startsWith('/uploads/') ? p
                : p.startsWith('/') ? `/uploads${p}`
                : `/uploads/${p}`

            const enriched = rows.rows.map((row) => ({
                ...row,
                // Comma-joined site-day shifts, or null when the site submitted
                // none — the UI renders '—'. Capitalized there, not here.
                shifts: (shiftsForSite.get(row.siteId) ?? []).join(', ') || null,
            }))

            const payload = {
                rows: enriched,
                pagination: {
                    page,
                    pageSize: pageSize ?? enriched.length,
                    total,
                    totalPages: pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1,
                },
                summary: {
                    date,
                    totalEmployees: total,
                    present: counts.Present,
                    completed: counts.Completed,
                    incomplete: counts.Incomplete,
                    absent: counts.Absent,
                    byShift: shiftSummary.rows.map((row) => ({
                        shift: row.shift,
                        presentEmployees: row.present,
                        imagePath: row.image_path,
                        imageUrl: normImage(row.image_path),
                    })),
                },
                meta: { locationId, siteId, date },
            }

            await setShiftReportCached(locationId ?? 'all', siteId ?? 'all', date, page, limitKey, payload)

            res.json({ success: true, data: payload })
        } catch (error: any) {
            console.error('[shift-attendance-report]', error)
            const detail = error?.cause?.message ?? error?.message
            res.status(500).json({ success: false, message: detail || 'Internal Server Error' })
        }
    }

    /**
     * Employee violations report — one row per violation report in scope, newest
     * first, with employee / site / location / reporting-supervisor names joined
     * so the panel renders columns without per-row lookups. Read-only and
     * immutable: no update/delete endpoints exist for violations by design.
     * Same admin guard, filter/pagination family and cache contract as the
     * shift attendance report.
     */
    public async violationsReport(req: Request, res: Response) {
        try {
            const locationId = (req.query.locationId as string | undefined)?.trim() || null
            const siteId = (req.query.siteId as string | undefined)?.trim() || null
            const date = (req.query.date as string | undefined)?.trim()

            if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
                return res.status(400).json({ success: false, message: 'date (YYYY-MM-DD) is required' })
            }
            if (locationId && idParamModel.safeParse({ id: locationId }).error) {
                return res.status(400).json({ success: false, message: 'Invalid locationId' })
            }
            if (siteId && idParamModel.safeParse({ id: siteId }).error) {
                return res.status(400).json({ success: false, message: 'Invalid siteId' })
            }

            if (locationId) {
                const [loc] = await db
                    .select({ id: clientLocations.id })
                    .from(clientLocations)
                    .where(eq(clientLocations.id, locationId))
                if (!loc) return res.status(404).json({ success: false, message: 'Location not found' })
            }
            if (siteId) {
                const [site] = await db
                    .select({ id: sites.id, locationId: sites.locationId })
                    .from(sites)
                    .where(eq(sites.id, siteId))
                if (!site) return res.status(404).json({ success: false, message: 'Site not found' })
                if (locationId && site.locationId !== locationId) {
                    return res.status(400).json({ success: false, message: 'Site does not belong to the selected location' })
                }
            }

            const pageRaw = Number(req.query.page)
            const sizeRaw = Number(req.query.pageSize ?? req.query.limit)
            const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1
            const pageSize = Number.isInteger(sizeRaw) && sizeRaw > 0 ? Math.min(sizeRaw, 10000) : null
            const limitKey = pageSize === null ? 'all' : String(pageSize)

            const { getViolationReportCached, setViolationReportCached } = await import('../../services/employeeViolationCache.js')
            const cached = await getViolationReportCached(locationId ?? 'all', siteId ?? 'all', date, page, limitKey)
            if (cached) return res.json({ success: true, data: cached })

            // Raw fragments against the `v` alias used below — Drizzle column
            // refs would render `"employee_violations".col`, which Postgres
            // rejects when the table is aliased (error 42P01).
            const conds = [sql`v.violation_date = ${date}::date`]
            if (siteId) conds.push(sql`v.site_id = ${siteId}`)
            else if (locationId) {
                conds.push(sql`exists (
                    select 1 from sites s
                    where s.id = v.site_id and s.location_id = ${locationId}
                )`)
            }

            const tally = await db.execute<{ count: number }>(sql`
                select count(*)::int as count
                from employee_violations v
                ${conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``}
            `)
            const total = tally.rows[0]?.count ?? 0

            // Reporter name via users → employees (supervisor accounts link to
            // an employee row); falls back to null rather than dropping the row
            // when the link is absent.
            const rows = await db.execute<ViolationReportRow>(sql`
                select
                    v.id as "id",
                    to_char(v.violation_date, 'YYYY-MM-DD') as "violationDate",
                    cl.location_name as "locationName",
                    s.site_name as "siteName",
                    concat(e.first_name, ' ', e.last_name) as "employeeName",
                    e.phone as "phone",
                    v.violation_type as "violationType",
                    v.reason as "reason",
                    v.evidence_image_path as "evidenceImagePath",
                    coalesce(
                        nullif(concat(se.first_name, ' ', se.last_name), ' '),
                        null
                    ) as "supervisorName",
                    to_char(v.created_at, 'HH24:MI') as "time",
                    to_char(v.created_at, 'YYYY-MM-DD HH24:MI:SS') as "reportedAt"
                from employee_violations v
                join employees e on e.id = v.employee_id
                join sites s on s.id = v.site_id
                left join client_locations cl on cl.id = s.location_id
                left join users u on u.id = v.supervisor_id
                left join employees se on se.id = u.employee_id
                ${conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``}
                order by v.created_at desc, v.id desc
                ${pageSize ? sql`limit ${pageSize} offset ${(page - 1) * pageSize}` : sql``}
            `)

            const payload = {
                rows: rows.rows.map((row) => ({
                    ...row,
                    // DB stores a relative path; the panel renders an <img src>
                    // against the /uploads static mount. Null when no photo was
                    // attached — the UI then shows a dash / hides the thumbnail.
                    imageUrl: !row.evidenceImagePath
                        ? null
                        : String(row.evidenceImagePath).startsWith('/uploads/')
                            ? row.evidenceImagePath
                            : String(row.evidenceImagePath).startsWith('/')
                                ? `/uploads${row.evidenceImagePath}`
                                : `/uploads/${row.evidenceImagePath}`,
                })),
                pagination: {
                    page,
                    pageSize: pageSize ?? rows.rows.length,
                    total,
                    totalPages: pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1,
                },
                meta: { locationId, siteId, date },
            }

            await setViolationReportCached(locationId ?? 'all', siteId ?? 'all', date, page, limitKey, payload)

            res.json({ success: true, data: payload })
        } catch (error: any) {
            console.error('[violations-report]', error)
            const detail = error?.cause?.message ?? error?.message
            res.status(500).json({ success: false, message: detail || 'Internal Server Error' })
        }
    }
/**
      * Collection report — one row per file a `report_collector` has submitted,
     * newest first. Each row carries the collector's name, the description they
     * wrote, the original filename and a download link for the stored file.
     * Read-only back-office data, so it shares the attendance report's
     * filter/pagination family (date range + employee) and response shape.
     */
      public async listReportSubmissions(req: Request, res: Response){
        try {
            const from = (req.query.from as string | undefined)?.trim()
            const to = (req.query.to as string | undefined)?.trim()
            const employeeId = (req.query.employeeId as string | undefined)?.trim()
 
            const pageRaw = Number(req.query.page)
            const sizeRaw = Number(req.query.pageSize)
            const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1
            const pageSize = Number.isInteger(sizeRaw) && sizeRaw > 0 ? Math.min(sizeRaw, 10000) : null
 
            const conds = []
            if (from) conds.push(sql`rs.submitted_at >= ${from}::date`)
            if (to) conds.push(sql`rs.submitted_at < (${to}::date + interval '1 day')`)
            if (employeeId && idParamModel.safeParse({ id: employeeId }).success)
                conds.push(sql`rs.employee_id = ${employeeId}`)
 
            const whereSql = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``
 
            // Only the paged view needs the total; the export-less design keeps
            // the count and rows queries separate so the page skips the tally.
            let total = 0
            if (pageSize) {
                const tally = await db.execute<{ count: number }>(sql`
                    select count(*)::int as count
                    from report_submissions rs
                    ${whereSql}
                `)
                total = tally.rows[0]?.count ?? 0
            }
 
            const rows = await db.execute<ReportSubmissionRow>(sql`
                select
                    rs.id,
                    rs.employee_id as "employeeId",
                    concat(e.first_name, ' ', e.last_name) as "employeeName",
                    e.department as "department",
                    rs.description as "description",
                    rs.original_name as "originalName",
                    rs.file_path as "filePath",
                    rs.geo_lat as "geoLat",
                    rs.geo_lng as "geoLng",
                    rs.face_distance as "faceDistance",
                    to_char(rs.submitted_at, 'YYYY-MM-DD HH24:MI:SS') as "submittedAt"
                from report_submissions rs
                join employees e on e.id = rs.employee_id
                ${whereSql}
                order by rs.submitted_at desc, e.first_name, e.last_name
                ${pageSize ? sql`limit ${pageSize} offset ${(page - 1) * pageSize}` : sql``}
            `)
 
            if (!pageSize) total = rows.rows.length
 
            // Download URLs are relative to the API base; the client resolves them
            // with its bearer token attached (an <a href> can't carry it).
            const enriched = rows.rows.map((row) => ({
                ...row,
                downloadUrl: `/employee/reports/${row.id}/download`,
            }))
 
            res.json({
                success: true,
                data: {
                    rows: enriched,
                    pagination: {
                        page,
                        pageSize: pageSize ?? enriched.length,
                        total,
                        totalPages: pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1,
                    },
                },
            })
        } catch (error: any) {
            console.error('[reports/submissions]', error)
            const detail = error?.cause?.message ?? error?.message
            res.status(500).json({ success: false, message: detail || 'Internal Server Error' })
        }
    }
 
    /**
     * Streams the stored file back for one submission. Keyed by submission id,
     * never the file path, so the browser can't wander through uploads/reports
     * by guessing paths. The filename offered to the client is the collector's
     * original name, not the random one the file has on disk.
     */
    public async downloadReport(req: Request, res: Response){
        try {
            const paramResult = idParamModel.safeParse(req.params)
            if (paramResult.error)
                return res.status(400).json({ success: false, message: 'invalid report id' })
 
            const { id } = paramResult.data
 
            const [submission] = await db
                .select({
                    filePath: reportSubmissions.filePath,
                    originalName: reportSubmissions.originalName,
                })
                .from(reportSubmissions)
                .where(eq(reportSubmissions.id, id))
 
            if (!submission) return res.status(404).json({ success: false, message: 'Report not found' })
 
            if (!submission.filePath) {
                // Notes-only report — the collector submitted remarks, no document.
                return res.status(404).json({ success: false, message: 'This report was submitted without a file' })
            }
            const absPath = reportAbsolutePath(submission.filePath)
            if (!absPath || !existsSync(absPath)) {
                return res.status(404).json({ success: false, message: 'Report file is missing on disk' })
            }
 
            // Strip anything that could break out of a quoted filename or smuggle
            // extra headers; the fallback keeps a download possible either way.
            const safeName = (submission.originalName || 'report').replace(/[\r\n"\\]+/g, '_')
 
            res.setHeader('Content-Type', 'application/octet-stream')
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
            )
            res.setHeader('Content-Length', statSync(absPath).size)
 
            const stream = createReadStream(absPath)
            stream.on('error', (err) => {
                console.error('[reports/download:stream]', err)
                res.destroy()
            })
            stream.pipe(res)
        } catch (error: any) {
            console.error('[reports/download]', error)
            res.status(500).json({ success: false, message: error?.cause?.message ?? error?.message ?? 'Internal Server Error' })
        }
    }
 
    /**
     * The sites an employee is assigned to, as a JSON array on each row.
     *
     * Aggregated in SQL rather than fetched per employee: the alternative is one
     * query per row, and this list is the first screen an admin opens.
     */
    private readonly assignedSites = sql<
        { id: string; siteName: string; locationId: string; locationName: string }[]
    >`coalesce(
        json_agg(
            json_build_object(
                'id', ${sites.id},
                'siteName', ${sites.siteName},
                'locationId', ${clientLocations.id},
                'locationName', ${clientLocations.locationName}
            )
            order by ${sites.siteName}
        ) filter (where ${sites.id} is not null),
        '[]'::json
    )`

    /**
     * Replace an employee's site assignments.
     *
     * The admin form shows one site, so it owns the whole set: whatever it sends
     * becomes the assignment. Anything else would leave the form showing one site
     * while the employee could still punch in at another.
     */
    private async setEmployeeSite(tx: any, employeeId: string, siteId: string | null) {
        await tx.delete(employeeSites).where(eq(employeeSites.employeeId, employeeId))
        if (siteId) await tx.insert(employeeSites).values({ employeeId, siteId })
    }

    /**
     * The tracking engine geofences against `FO:{userId}:sites`, which for an
     * Operational Head includes his own `employee_sites` row (he works from the
     * one site on his employee record, not a Field Officer posting). Drop that
     * key once the assignment has committed, so the next GPS batch rebuilds the
     * list instead of trusting the old fence for the rest of the day.
     *
     * Only needed after a write that can follow an existing login account — a
     * freshly registered employee has no account and so no cached list yet.
     */
    private async invalidateTrackingSitesCache(employeeId: string) {
        try {
            const [account] = await db
                .select({ id: usersTable.id })
                .from(usersTable)
                .where(eq(usersTable.employeeId, employeeId))
                .limit(1)
            if (account) await clearSitesCacheOnly(account.id)
        } catch {
            // Best-effort: a cleared-or-missed key only costs one rebuild query.
        }
    }

    /**
     * Admin dashboard snapshot — the aggregate figures the landing page renders,
     * all derived from real data in one round trip (admin-guarded by the router).
     *
     * There is deliberately NO "failed face match" metric: a failed verification
     * returns 401 and is never written to attendance_logs (a punch is recorded
     * only on success), so no such count exists anywhere. "Absent Today" —
     * active, site-assigned employees with no check-in today — takes its place.
     *
     * Dates and hours are converted to IST explicitly (`at time zone`), the same
     * convention the attendance reports use, so the numbers agree with them
     * regardless of the DB session's timezone. No user input reaches these
     * queries, so the SQL is static.
     */
    public async dashboardSummary(_req: Request, res: Response) {
        try {
            // Today / the logical punch-day, in IST. Reused across the queries.
            const TODAY = `(current_timestamp at time zone 'Asia/Kolkata')::date`
            const DAY = `coalesce(al.attendance_date, (al.created_at at time zone 'Asia/Kolkata')::date)`

            const [dateQ, presentQ, rosterQ, facesQ, recogQ, hourlyQ, recentQ] = await Promise.all([
                db.execute<{ date: string }>(sql.raw(`select to_char(${TODAY}, 'YYYY-MM-DD') as date`)),

                // Present + late per day (today, yesterday). "Present" = distinct
                // employees with a check-in; "late" = first check-in after 09:30.
                db.execute<{ day: string; present: number; late: number }>(sql.raw(`
                    with ci as (
                        select al.employee_id,
                               ${DAY} as day,
                               min((al.created_at at time zone 'Asia/Kolkata')::time) as first_in
                        from attendance_logs al
                        where al.action = 'check-in'
                          and ${DAY} between ${TODAY} - 1 and ${TODAY}
                        group by 1, 2
                    )
                    select to_char(day, 'YYYY-MM-DD') as day,
                           count(*)::int as present,
                           count(*) filter (where first_in > time '09:30')::int as late
                    from ci group by day
                `)),

                // Active, site-assigned roster and how many of them checked in
                // today / yesterday — absent = roster - present (assigned).
                db.execute<{ roster: number; present_today: number; present_yesterday: number }>(sql.raw(`
                    with roster as (
                        select e.id from employees e
                        where e.is_active
                          and exists (select 1 from employee_sites es where es.employee_id = e.id)
                    ),
                    att as (
                        select distinct al.employee_id, ${DAY} as day
                        from attendance_logs al
                        where al.action = 'check-in'
                          and ${DAY} between ${TODAY} - 1 and ${TODAY}
                    )
                    select
                        (select count(*) from roster)::int as roster,
                        (select count(*) from roster r where exists
                            (select 1 from att a where a.employee_id = r.id and a.day = ${TODAY}))::int as present_today,
                        (select count(*) from roster r where exists
                            (select 1 from att a where a.employee_id = r.id and a.day = ${TODAY} - 1))::int as present_yesterday
                `)),

                // Enrolment coverage of the active workforce + faces added this week.
                db.execute<{ active_employees: number; faces_enrolled: number; new_faces_week: number }>(sql.raw(`
                    select
                        count(*) filter (where is_active)::int as active_employees,
                        count(*) filter (where is_active and has_registered_face)::int as faces_enrolled,
                        count(*) filter (where is_active and has_registered_face
                            and face_registered_at >= (current_timestamp at time zone 'Asia/Kolkata') - interval '7 days')::int as new_faces_week
                    from employees
                `)),

                // Recognition quality today: mean cosine similarity (1 - distance)
                // over biometric check-ins that recorded a distance.
                db.execute<{ avg_match: number | null; verified_today: number }>(sql.raw(`
                    select round(avg(1 - al.face_distance)::numeric, 2) as avg_match,
                           count(*)::int as verified_today
                    from attendance_logs al
                    where al.action = 'check-in'
                      and ${DAY} = ${TODAY}
                      and al.face_distance is not null
                      and coalesce(al.attendance_method, 'biometric') = 'biometric'
                `)),

                // Check-in volume by IST hour, today. Client renders 06:00–18:00.
                db.execute<{ hour: number; count: number }>(sql.raw(`
                    select extract(hour from (al.created_at at time zone 'Asia/Kolkata'))::int as hour,
                           count(*)::int as count
                    from attendance_logs al
                    where al.action = 'check-in'
                      and ${DAY} = ${TODAY}
                    group by 1 order by 1
                `)),

                // Recent punches today (in + out), newest first, with the match
                // confidence the scan recorded (null for manual/legacy rows).
                db.execute<{ id: string; name: string; site: string | null; time: string; action: string; method: string; conf: number | null }>(sql.raw(`
                    select al.id::text as id,
                           concat(e.first_name, ' ', e.last_name) as name,
                           s.site_name as site,
                           to_char(al.created_at at time zone 'Asia/Kolkata', 'HH24:MI') as time,
                           al.action as action,
                           coalesce(al.attendance_method, 'biometric') as method,
                           round((1 - al.face_distance)::numeric, 2) as conf
                    from attendance_logs al
                    join employees e on e.id = al.employee_id
                    left join sites s on s.id = al.site_id
                    where ${DAY} = ${TODAY}
                    order by al.created_at desc
                    limit 10
                `)),
            ])

            const todayISO = dateQ.rows[0]?.date ?? null
            const byDay = new Map(presentQ.rows.map((r) => [r.day, r]))
            const t = byDay.get(todayISO ?? '')
            // Yesterday is simply "one day before today" in IST.
            const y = byDay.get(
                (() => {
                    const d = new Date(`${todayISO}T00:00:00`)
                    d.setDate(d.getDate() - 1)
                    const p = (n: number) => String(n).padStart(2, '0')
                    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
                })()
            )

            const roster = rosterQ.rows[0] ?? { roster: 0, present_today: 0, present_yesterday: 0 }
            const faces = facesQ.rows[0] ?? { active_employees: 0, faces_enrolled: 0, new_faces_week: 0 }
            const recog = recogQ.rows[0] ?? { avg_match: null, verified_today: 0 }

            // 24-slot hour series so the chart never has to fill gaps itself.
            const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }))
            for (const r of hourlyQ.rows) {
                if (r.hour >= 0 && r.hour < 24) hourly[r.hour] = { hour: r.hour, count: r.count }
            }

            return res.json({
                success: true,
                data: {
                    date: todayISO,
                    stats: {
                        presentToday: t?.present ?? 0,
                        presentYesterday: y?.present ?? 0,
                        lateToday: t?.late ?? 0,
                        lateYesterday: y?.late ?? 0,
                        absentToday: Math.max(0, roster.roster - roster.present_today),
                        absentYesterday: Math.max(0, roster.roster - roster.present_yesterday),
                        rosterAssigned: roster.roster,
                        facesEnrolled: faces.faces_enrolled,
                        activeEmployees: faces.active_employees,
                        newFacesWeek: faces.new_faces_week,
                    },
                    recognition: {
                        avgMatch: recog.avg_match ?? null,
                        threshold: MATCH_THRESHOLD,
                        verifiedToday: recog.verified_today,
                    },
                    hourly,
                    recent: recentQ.rows,
                },
            })
        } catch (error: any) {
            console.error('[dashboard-summary]', error)
            const detail = error?.cause?.message ?? error?.message
            res.status(500).json({ success: false, message: detail || 'Internal Server Error' })
        }
    }

    /** List employees with their site, optionally filtered. */
    public async listEmployees (req: Request, res: Response){
        try {
            const search = (req.query.search as string | undefined)?.trim()
            const status = req.query.status as string | undefined
            const siteId = req.query.siteId as string | undefined
            const locationId = req.query.locationId as string | undefined

            const conditions = []

            if (search) {
                const like = `%${search}%`
                conditions.push(
                    or(
                        ilike(employees.firstName, like),
                        ilike(employees.lastName, like),
                        ilike(employees.phone, like),
                        ilike(employees.email, like)
                    )
                )
            }

            if (status === 'active') conditions.push(eq(employees.isActive, true))
            if (status === 'inactive') conditions.push(eq(employees.isActive, false))

            // EXISTS rather than a condition on the join: filtering the join would
            // also strip the other sites out of the aggregate above, so a
            // multi-site employee would appear to have only the one filtered on.
            if (siteId && idParamModel.safeParse({ id: siteId }).success) {
                conditions.push(
                    sql`exists (select 1 from "employee_sites" es where es.employee_id = ${employees.id} and es.site_id = ${siteId})`
                )
            }

            if (locationId && idParamModel.safeParse({ id: locationId }).success) {
                conditions.push(
                    sql`exists (
                        select 1 from "employee_sites" es
                        join "sites" s on s.id = es.site_id
                        where es.employee_id = ${employees.id} and s.location_id = ${locationId}
                    )`
                )
            }

            const rows = await db
                .select({
                    id: employees.id,
                    firstName: employees.firstName,
                    lastName: employees.lastName,
                    phone: employees.phone,
                    email: employees.email,
                    department: employees.department,
                    designation: employees.designation,
                    isActive: employees.isActive,
                    imagePath: employees.imagePath,
                    hasRegisteredFace: employees.hasRegisteredFace,
                    faceRegisteredAt: employees.faceRegisteredAt,
                    createdAt: employees.createdAt,
                    updatedAt: employees.updatedAt,
                    // Scalar subquery: one user per employee, so no aggregation needed.
                    // Returns null when the employee has never signed in; fallback to ['employee'].
                    roles: sql<string[]>`coalesce((select roles from users u where u.employee_id = ${employees.id}), ARRAY['employee']::text[])`,
                    sites: this.assignedSites,
                })
                .from(employees)
                .leftJoin(employeeSites, eq(employeeSites.employeeId, employees.id))
                .leftJoin(sites, eq(sites.id, employeeSites.siteId))
                .leftJoin(clientLocations, eq(clientLocations.id, sites.locationId))
                .where(conditions.length ? and(...conditions) : undefined)
                .groupBy(employees.id)
                .orderBy(desc(employees.createdAt))

            res.json({ success: true, data: { employees: rows } });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    public async handleEployeeRegister(req: Request, res: Response){
        try {
            const validationResult = await createEmployeeSchema.safeParseAsync(req.body);

            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { firstName, lastName, phone, email, department, designation, siteId, isActive } =
                validationResult.data;

            const existingPhone = await db.query.employees.findFirst({
                where: eq(employees.phone, phone),
            });

            if (existingPhone) {
                return res.status(409).json({
                    success: false,
                    message: 'Phone number already exists',
                });
            }

            // Checked here as well as by the unique constraint so the form gets a
            // message it can put on the field rather than a raw Postgres error.
            if (email) {
                const existingEmail = await db.query.employees.findFirst({
                    where: eq(employees.email, email),
                });
                if (existingEmail) {
                    return res.status(409).json({
                        success: false,
                        message: 'Another employee already uses that email address',
                    });
                }
            }

            if (siteId) {
                const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
                if (!site) {
                    return res.status(404).json({ success: false, message: 'Site not found' });
                }
            }

            // One transaction: an employee created without the site assignment the
            // admin asked for cannot check in anywhere, and nothing in the UI would
            // show that the second half failed.
            const employee = await db.transaction(async (tx) => {
                const [row] = await tx
                    .insert(employees)
                    .values({
                        firstName,
                        lastName,
                        phone,
                        email: email ?? null,
                        department: department ?? null,
                        designation: designation ?? null,
                        isActive: isActive ?? true,
                    })
                    .returning();

                if (row && siteId) await this.setEmployeeSite(tx, row.id, siteId)

                return row
            });

            // New assignment changes which supervisors see this employee — drop
            // the affected roster/list caches (best-effort, never fails the request).
            if (siteId) await invalidateRosterForSite(siteId)

            res.status(201).json({
                success: true,
                message: siteId
                    ? 'Employee registered and assigned to the site'
                    : 'Employee registered. Assign a site before they try to check in.',
                data: employee,
            });
        } catch (error:any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    public async updateEmployee (req: Request, res: Response){
        try {
            const paramResult = idParamModel.safeParse(req.params);
            if (paramResult.error) return res.status(400).json({ success: false, message: 'invalid employee id' })

            const validationResult = await updateEmployeeModel.safeParseAsync(req.body);
            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { id } = paramResult.data
            const { siteId, ...patch } = validationResult.data

            const existing = await db.query.employees.findFirst({ where: eq(employees.id, id) });
            if (!existing) {
                return res.status(404).json({ success: false, message: 'Employee not found' });
            }

            if (patch.phone && patch.phone !== existing.phone) {
                const clash = await db.query.employees.findFirst({
                    where: eq(employees.phone, patch.phone),
                });
                if (clash) {
                    return res.status(409).json({
                        success: false,
                        message: 'Another employee already uses that phone number',
                    });
                }
            }

            if (patch.email && patch.email !== existing.email) {
                const clash = await db.query.employees.findFirst({
                    where: eq(employees.email, patch.email),
                });
                if (clash) {
                    return res.status(409).json({
                        success: false,
                        message: 'Another employee already uses that email address',
                    });
                }
            }

            if (siteId) {
                const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
                if (!site) {
                    return res.status(404).json({ success: false, message: 'Site not found' });
                }
            }

            // Capture pre-change sites so cache invalidation covers removals too.
            const beforeSites = siteId !== undefined
                ? await db.select({ siteId: employeeSites.siteId }).from(employeeSites).where(eq(employeeSites.employeeId, id))
                : []

            const employee = await db.transaction(async (tx) => {
                let row = existing

                if (Object.keys(patch).length) {
                    const [updated] = await tx
                        .update(employees)
                        .set({ ...patch, updatedAt: new Date() })
                        .where(eq(employees.id, id))
                        .returning();
                    if (updated) row = updated
                }

                // undefined leaves the assignment alone; null clears it.
                if (siteId !== undefined) await this.setEmployeeSite(tx, id, siteId)

                return row
            });

            if (siteId !== undefined) {
                const touched = new Set<string>([
                    ...beforeSites.map((r) => r.siteId),
                    ...(siteId ? [siteId] : []),
                ])
                for (const sid of touched) await invalidateRosterForSite(sid)
                await this.invalidateTrackingSitesCache(id)
            }

            res.json({ success: true, message: 'Employee updated', data: employee });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    /**
     * Delete an employee.
     *
     * Refused once they have attendance history: attendance_logs cascades from
     * employees, so a delete would erase the record of every shift they worked —
     * exactly the data this system exists to keep. Deactivating is the answer,
     * and it also stops the mobile sign-in.
     */
    public async deleteEmployee (req: Request, res: Response){
        try {
            const paramResult = idParamModel.safeParse(req.params);
            if (paramResult.error) return res.status(400).json({ success: false, message: 'invalid employee id' })

            const { id } = paramResult.data

            const existing = await db.query.employees.findFirst({ where: eq(employees.id, id) });
            if (!existing) {
                return res.status(404).json({ success: false, message: 'Employee not found' });
            }

            const [logTally] = await db
                .select({ count: sql<number>`count(*)::int` })
                .from(attendanceLogs)
                .where(eq(attendanceLogs.employeeId, id))

            const count = logTally?.count ?? 0

            if (count > 0) {
                return res.status(409).json({
                    success: false,
                    message: `${existing.firstName} has ${count} attendance record${count === 1 ? '' : 's'} and cannot be deleted. Deactivate instead — that blocks sign-in and check-ins while keeping the history.`,
                });
            }

            // Site assignments and the login row cascade away with the employee.
            // Both are access, not history, so losing them is correct.
            await db.delete(employees).where(eq(employees.id, id));

            // The row is gone, so nothing points at the photo any more — leaving it
            // on disk would be an orphaned image of someone no longer on the roster.
            await deleteFaceImage(existing.imagePath);

            res.json({ success: true, message: 'Employee deleted' });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    public async createClientLocation (req: Request, res: Response){
        try {
            const validationResult = await createClientLocationModel.safeParseAsync(req.body);
            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { locationName, siteCode, address } = validationResult.data

            const existingLocation =
            await db.query.clientLocations.findFirst({
                where: eq(
                clientLocations.locationName,
                locationName)
            });

            if (existingLocation) {
            res.status(409).json({
                success: false,
                message: 'Location already exists',
            });
            return;
            }

            const [location] = await db
            .insert(clientLocations)
            .values({
                locationName,
                siteCode: siteCode ?? null,
                address: address ?? null,
            })
            .returning();

            res.status(201).json({
            success: true,
            message: 'Location created. Add at least one site to it before assigning employees.',
            data: location,
            });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
            success: false,
            message:
                error.message || 'Internal Server Error',
            });
        }
    }

    /**
     * Create a site under a location. The site carries the geofence, so this is
     * the endpoint that decides where an employee may physically punch in.
     */
    public async createSite (req: Request, res: Response){
        try {
            const validationResult = await createSiteModel.safeParseAsync(req.body);
            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { locationId, siteName, siteCode, address, latitude, longitude, allowedRadiusMeters } =
                validationResult.data

            const location = await db.query.clientLocations.findFirst({
                where: eq(clientLocations.id, locationId),
            });

            if (!location) {
                res.status(404).json({
                    success: false,
                    message: 'Location not found',
                });
                return;
            }

            // Site names are unique per location, not globally - two clients can
            // each have a "Gate 2". Scope the duplicate check the same way.
            const existingSite = await db.query.sites.findFirst({
                where: and(eq(sites.locationId, locationId), eq(sites.siteName, siteName)),
            });

            if (existingSite) {
                res.status(409).json({
                    success: false,
                    message: 'A site with that name already exists under this location',
                });
                return;
            }

            const [site] = await db
                .insert(sites)
                .values({
                    locationId,
                    siteName,
                    siteCode: siteCode ?? null,
                    address: address ?? null,
                    // numeric columns round-trip as strings in node-postgres, so
                    // the driver wants strings on the way in too.
                    latitude: latitude.toString(),
                    longitude: longitude.toString(),
                    allowedRadiusMeters: allowedRadiusMeters?.toString() ?? '100',
                })
                .returning();

            res.status(201).json({
                success: true,
                message: 'Site created successfully',
                data: { ...site, location: { id: location.id, locationName: location.locationName } },
            });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    /** List locations with the number of sites under each. */
    public async listClientLocations (req: Request, res: Response){
        try {
            const rows = await db
                .select({
                    id: clientLocations.id,
                    locationName: clientLocations.locationName,
                    city: clientLocations.city,
                    siteCode: clientLocations.siteCode,
                    address: clientLocations.address,
                    isActive: clientLocations.isActive,
                    createdAt: clientLocations.createdAt,
                    // Left join, not inner: a location with no sites yet must still
                    // appear, otherwise a freshly created one vanishes from the list.
                    siteCount: sql<number>`count(${sites.id})::int`,
                })
                .from(clientLocations)
                .leftJoin(sites, eq(sites.locationId, clientLocations.id))
                .groupBy(clientLocations.id)
                .orderBy(clientLocations.locationName)

            res.json({ success: true, data: { locations: rows } });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    public async updateClientLocation (req: Request, res: Response){
        try {
            const paramResult = idParamModel.safeParse(req.params);
            if (paramResult.error) return res.status(400).json({ success: false, message: 'invalid location id' })

            const validationResult = await updateClientLocationModel.safeParseAsync(req.body);
            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { id } = paramResult.data
            const patch = validationResult.data

            const existing = await db.query.clientLocations.findFirst({
                where: eq(clientLocations.id, id),
            });

            if (!existing) {
                return res.status(404).json({ success: false, message: 'Location not found' });
            }

            // The unique index would reject this anyway, but as a 500-looking
            // Postgres error rather than something the form can show on a field.
            if (patch.locationName && patch.locationName !== existing.locationName) {
                const clash = await db.query.clientLocations.findFirst({
                    where: eq(clientLocations.locationName, patch.locationName),
                });
                if (clash) {
                    return res.status(409).json({
                        success: false,
                        message: 'Another location already uses that name',
                    });
                }
            }

            const [location] = await db
                .update(clientLocations)
                .set(patch)
                .where(eq(clientLocations.id, id))
                .returning();

            res.json({ success: true, message: 'Location updated', data: location });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    /**
     * Delete a location.
     *
     * Refused while it still has sites. The foreign key cascades, so allowing it
     * would silently take out every site beneath it — and with them the geofences
     * and employee assignments — from a single click. Deleting the sites first
     * makes that consequence explicit.
     */
    public async deleteClientLocation (req: Request, res: Response){
        try {
            const paramResult = idParamModel.safeParse(req.params);
            if (paramResult.error) return res.status(400).json({ success: false, message: 'invalid location id' })

            const { id } = paramResult.data

            const existing = await db.query.clientLocations.findFirst({
                where: eq(clientLocations.id, id),
            });

            if (!existing) {
                return res.status(404).json({ success: false, message: 'Location not found' });
            }

            const [siteTally] = await db
                .select({ count: sql<number>`count(*)::int` })
                .from(sites)
                .where(eq(sites.locationId, id))

            const count = siteTally?.count ?? 0

            if (count > 0) {
                return res.status(409).json({
                    success: false,
                    message: `This location still has ${count} site${count === 1 ? '' : 's'}. Delete or move them first, or deactivate the location instead.`,
                });
            }

            await db.delete(clientLocations).where(eq(clientLocations.id, id));

            res.json({ success: true, message: 'Location deleted' });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    public async updateSite (req: Request, res: Response){
        try {
            const paramResult = idParamModel.safeParse(req.params);
            if (paramResult.error) return res.status(400).json({ success: false, message: 'invalid site id' })

            const validationResult = await updateSiteModel.safeParseAsync(req.body);
            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { id } = paramResult.data
            const { latitude, longitude, allowedRadiusMeters, ...rest } = validationResult.data

            const existing = await db.query.sites.findFirst({ where: eq(sites.id, id) });
            if (!existing) {
                return res.status(404).json({ success: false, message: 'Site not found' });
            }

            const targetLocationId = rest.locationId ?? existing.locationId

            if (rest.locationId && rest.locationId !== existing.locationId) {
                const location = await db.query.clientLocations.findFirst({
                    where: eq(clientLocations.id, rest.locationId),
                });
                if (!location) {
                    return res.status(404).json({ success: false, message: 'Location not found' });
                }
            }

            // Names are unique per location, so both a rename and a re-parent can
            // collide — check against whichever location the site will end up in.
            const nextName = rest.siteName ?? existing.siteName
            if (nextName !== existing.siteName || targetLocationId !== existing.locationId) {
                const clash = await db.query.sites.findFirst({
                    where: and(eq(sites.locationId, targetLocationId), eq(sites.siteName, nextName)),
                });
                if (clash && clash.id !== id) {
                    return res.status(409).json({
                        success: false,
                        message: 'A site with that name already exists under this location',
                    });
                }
            }

            const [site] = await db
                .update(sites)
                .set({
                    ...rest,
                    // Only touch the numeric columns when they were actually sent —
                    // spreading `undefined` into .set() would be a no-op, but
                    // `null` would wipe a NOT NULL column.
                    ...(latitude !== undefined ? { latitude: latitude.toString() } : {}),
                    ...(longitude !== undefined ? { longitude: longitude.toString() } : {}),
                    ...(allowedRadiusMeters !== undefined
                        ? { allowedRadiusMeters: allowedRadiusMeters.toString() }
                        : {}),
                })
                .where(eq(sites.id, id))
                .returning();

            // Position, radius and the active flag are precisely what a fence is
            // computed from, and the tracking engine geofences against a cached
            // copy of each posted account's site list (FO:{userId}:sites, 24 h).
            // Without this an edited site keeps its OLD fence for the rest of the
            // day — the same staleness that hides a newly assigned one.
            await invalidateSitesCacheForSite(id);

            res.json({ success: true, message: 'Site updated', data: site });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    /**
     * Delete a site.
     *
     * Refused once attendance has been logged against it: attendance_logs.site_id
     * is ON DELETE NO ACTION, so the delete would fail on the constraint anyway —
     * this turns that into a 409 that says what to do instead. Employee
     * assignments cascade away, which is correct; they are authorisations, not
     * history.
     */
    public async deleteSite (req: Request, res: Response){
        try {
            const paramResult = idParamModel.safeParse(req.params);
            if (paramResult.error) return res.status(400).json({ success: false, message: 'invalid site id' })

            const { id } = paramResult.data

            const existing = await db.query.sites.findFirst({ where: eq(sites.id, id) });
            if (!existing) {
                return res.status(404).json({ success: false, message: 'Site not found' });
            }

            const [logTally] = await db
                .select({ count: sql<number>`count(*)::int` })
                .from(attendanceLogs)
                .where(eq(attendanceLogs.siteId, id))

            const count = logTally?.count ?? 0

            if (count > 0) {
                return res.status(409).json({
                    success: false,
                    message: `This site has ${count} attendance record${count === 1 ? '' : 's'} against it and cannot be deleted. Deactivate it instead — that stops new check-ins and keeps the history.`,
                });
            }

            await db.delete(sites).where(eq(sites.id, id));

            // Cascade or not, a cached site list can still name this site, and the
            // engine would then try to open a visit against a row that no longer
            // exists. Drop it for everyone who had it.
            await invalidateSitesCacheForSite(id);

            res.json({ success: true, message: 'Site deleted' });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    /** List sites, optionally narrowed to one location. */
    public async listSites (req: Request, res: Response){
        try {
            const locationId = req.query.locationId as string | undefined

            const rows = await db
                .select({
                    id: sites.id,
                    siteName: sites.siteName,
                    siteCode: sites.siteCode,
                    address: sites.address,
                    latitude: sites.latitude,
                    longitude: sites.longitude,
                    allowedRadiusMeters: sites.allowedRadiusMeters,
                    isActive: sites.isActive,
                    locationId: clientLocations.id,
                    locationName: clientLocations.locationName,
                })
                .from(sites)
                .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
                .where(locationId ? eq(sites.locationId, locationId) : undefined)

            res.json({ success: true, data: { sites: rows } });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    /**
     * Authorise an employee to check in at one site.
     *
     * Assignment is per-site rather than per-location on purpose: being posted to
     * a client's head office should not authorise a punch at their warehouse
     * across town.
     */
    public async assignSiteToEmployee (req: Request, res: Response){
        try {
            const validationResult = await assignSiteModel.safeParseAsync(req.body);
            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { employeeId, siteId } = validationResult.data;

            const employee = await db.query.employees.findFirst({
                where: eq(employees.id, employeeId),
            });

            if (!employee) {
                res.status(404).json({
                    success: false,
                    message: 'Employee not found',
                });
                return;
            }

            const site = await db.query.sites.findFirst({
                where: eq(sites.id, siteId),
            });

            if (!site) {
                res.status(404).json({
                    success: false,
                    message: 'Site not found',
                });
                return;
            }

            const existing = await db.query.employeeSites.findFirst({
                where: and(
                    eq(employeeSites.employeeId, employeeId),
                    eq(employeeSites.siteId, siteId)
                ),
            });

            if (existing) {
                res.status(409).json({
                    success: false,
                    message: 'Site already assigned to employee',
                });
                return;
            }

            const [assignment] = await db
                .insert(employeeSites)
                .values({ employeeId, siteId })
                .returning();

            await invalidateRosterForSite(siteId)
            await this.invalidateTrackingSitesCache(employeeId)

            res.status(201).json({
                success: true,
                message: 'Site assigned successfully',
                data: assignment,
            });
        } catch (error:any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message:
                    error.message ||
                    'Internal Server Error',
            });
        }
    }

    /**
     * Replace an employee's roles in the users table.
     *
     * The `employee` role is mandatory — it is the gate for check-in/out and
     * must always be present. The client enforces this in the UI; we enforce it
     * here so a direct API call cannot strip it.
     *
     * When the employee has no login account yet (they've never signed in and
     * nobody has registered them by phone), the account is created here with
     * the default password '12345' — same scheme as registerByPhone — and then
     * the roles are applied, so admins can grant roles without waiting for the
     * employee's first sign-in.
     */
    public async updateEmployeeRoles(req: Request, res: Response) {
        try {
            const paramResult = idParamModel.safeParse(req.params)
            if (paramResult.error)
                return res.status(400).json({ success: false, message: 'invalid employee id' })

            const bodyResult = updateEmployeeRolesModel.safeParse(req.body)
            if (bodyResult.error)
                return res.status(400).json({ message: 'body validation failed', error: bodyResult.error.issues })

            const { id } = paramResult.data
            const { roles } = bodyResult.data

            const existing = await db.query.employees.findFirst({ where: eq(employees.id, id) })
            if (!existing)
                return res.status(404).json({ success: false, message: 'Employee not found' })

            // Always keep the mandatory 'employee' role, including on the
            // auto-created account path below.
            const finalRoles = roles.includes('employee') ? roles : [...roles, 'employee']

            const [account] = await db
                .select({ id: usersTable.id })
                .from(usersTable)
                .where(eq(usersTable.employeeId, id))
                .limit(1)

            let createdAccount = false
            let updated: { id: string; roles: string[] }[]

            if (!account) {
                // `phone` is UNIQUE across users. If some other account (e.g. an
                // admin row) already holds this phone, we cannot create a login
                // for the employee — explain instead of throwing a DB error.
                const [phoneHolder] = await db
                    .select({ id: usersTable.id })
                    .from(usersTable)
                    .where(eq(usersTable.phone, existing.phone))
                    .limit(1)
                if (phoneHolder)
                    return res.status(409).json({
                        success: false,
                        message: `An account already exists for phone ${existing.phone} but it is not linked to this employee — contact the administrator.`,
                    })

                // No login account yet — register one with the default
                // password, the same way the sign-up-by-phone flow does.
                const defaultPassword = '12345'
                const salt = randomBytes(32).toString('hex')
                const hash = createHmac('sha256', salt).update(defaultPassword).digest('hex')

                updated = await db.transaction(async (tx) => {
                    const [newUser] = await tx
                        .insert(usersTable)
                        .values({
                            employeeId: existing.id,
                            phone: existing.phone,
                            password: hash,
                            salt,
                            roles: finalRoles,
                        })
                        .returning({ id: usersTable.id, roles: usersTable.roles })

                    // Keep the employee → user link in sync, as registerByPhone does.
                    await tx
                        .update(employees)
                        .set({ userId: newUser!.id })
                        .where(eq(employees.id, existing.id))

                    return newUser ? [newUser] : []
                })
                createdAccount = true
            } else {
                updated = await db
                    .update(usersTable)
                    .set({ roles: finalRoles })
                    .where(eq(usersTable.employeeId, id))
                    .returning({ id: usersTable.id, roles: usersTable.roles })
            }

            if (!updated.length)
                return res.status(500).json({
                    success: false,
                    message: 'Could not create login account or update roles.',
                })

            return res.json({
                success: true,
                message: createdAccount
                    ? 'Login account created with default password 12345 and roles updated'
                    : 'Roles updated',
                data: { roles: updated[0]!.roles, accountCreated: createdAccount },
            })
        } catch (error: any) {
            console.error('[update-roles]', error)
            return res.status(500).json({ success: false, message: error.message || 'Internal Server Error' })
        }
    }

}

/** One row of the collection report — a single report submission. `filePath` is
 * null when the collector submitted notes without a document. */
interface ReportSubmissionRow {
    id: string
    employeeId: string
    employeeName: string
    department: string | null
    description: string | null
    originalName: string | null
    filePath: string | null
    geoLat: string | null
    geoLng: string | null
    faceDistance: string | null
    submittedAt: string
    [key: string]: unknown
}
/** One row of the summary report — a single employee's aggregates over the range. */
interface SummaryReportRow {
    employeeId: string
    employeeName: string
    department: string | null
    designation: string | null
    isActive: boolean
    siteName: string | null
    /** Every site a duty was opened at inside the range, comma separated. */
    siteNames: string | null
    totalDuties: number
    presentDays: number
    incompletePunching: number
    totalDutySeconds: number
    [key: string]: unknown
}

/** One day of the per-employee drill-down — a calendar day with its status. */
interface DayDetailRow {
    date: string
    status: 'present' | 'incomplete' | 'absent' | 'upcoming'
    duties: number
    dutySeconds: number
    checkIn: string | null
    checkOut: string | null
    deviceInfo: string | null
    [key: string]: unknown
}

/** One row of the daily attendance summary — a single employee's day. */
interface DailyReportRow {
    id: string
    employeeName: string
    siteName: string | null
    createdAtDateOnly: string
    checkIn: string | null
    checkOut: string | null
    dutyTime: string | null
    distanceM: number | null
    deviceInfo: string | null
    [key: string]: unknown
}

/** One row of the employee violations report — a single violation report. */
interface ViolationReportRow {
    id: string
    violationDate: string
    locationName: string | null
    siteName: string | null
    employeeName: string
    phone: string
    violationType: string
    reason: string
    supervisorName: string | null
    time: string | null
    reportedAt: string | null
    [key: string]: unknown
}

/** One row of the shift attendance report — an employee's day at one site. */
interface ShiftReportRow {
    employeeId: string
    employeeName: string
    phone: string
    siteId: string
    siteName: string | null
    checkIn: string | null
    checkOut: string | null
    status: string
    description: string | null
    [key: string]: unknown
}

export default EmployeesController