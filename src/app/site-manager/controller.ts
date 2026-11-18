import type { Request, Response } from 'express';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { db } from '../../db';
import {
    usersTable,
    employees,
    sites,
    clientLocations,
    employeeSites,
    siteLocationSubmissions,
    appSettings,
} from '../../db/schema';
import {
    createSubmissionModel,
    rejectSubmissionModel,
    adminSubmissionsQueryModel,
} from './models';
import { invalidateSitesCacheForSite } from '../../services/siteCacheInvalidation';

// ── Constants ────────────────────────────────────────────────────────────────
// The role this module gates on. A Site Manager is an employee (users.employee_id
// is set) whose assignable sites come from the existing employee_sites join — so
// "which sites may this manager submit for" and "is this submission authorised"
// are answered by the SAME table the attendance geofence already trusts.
export const SITE_MANAGER_ROLE = 'site_manager';

// Optional GPS-accuracy ceiling (metres) read by the app's Send Location button
// and enforced server-side. Absent/unset key ⇒ no accuracy gate.
const MAX_ACCURACY_KEY = 'site_manager_max_accuracy_m';

// The submission shape joined with its site, client location and submitter —
// shared by the manager's own history and the admin review list.
const submissionWithNames = {
    id: siteLocationSubmissions.id,
    clientLocationId: siteLocationSubmissions.clientLocationId,
    siteId: siteLocationSubmissions.siteId,
    locationName: clientLocations.locationName,
    siteName: sites.siteName,
    latitude: siteLocationSubmissions.latitude,
    longitude: siteLocationSubmissions.longitude,
    accuracy: siteLocationSubmissions.accuracy,
    status: siteLocationSubmissions.status,
    submittedAt: siteLocationSubmissions.submittedAt,
    submittedBy: siteLocationSubmissions.submittedBy,
    submitterName: sql<string | null>`trim(coalesce(${employees.firstName}, '') || ' ' || coalesce(${employees.lastName}, ''))`,
    submitterPhone: usersTable.phone,
    reviewedBy: siteLocationSubmissions.reviewedBy,
    reviewedAt: siteLocationSubmissions.reviewedAt,
    rejectionReason: siteLocationSubmissions.rejectionReason,
    previousLatitude: siteLocationSubmissions.previousLatitude,
    previousLongitude: siteLocationSubmissions.previousLongitude,
};

function fromSubmissionsJoined() {
    return db
        .select(submissionWithNames)
        .from(siteLocationSubmissions)
        .innerJoin(sites, eq(siteLocationSubmissions.siteId, sites.id))
        .innerJoin(clientLocations, eq(siteLocationSubmissions.clientLocationId, clientLocations.id))
        .leftJoin(usersTable, eq(siteLocationSubmissions.submittedBy, usersTable.id))
        .leftJoin(employees, eq(usersTable.employeeId, employees.id));
}

export default class SiteManagerController {
    // ── Shared guards ────────────────────────────────────────────────────────

    /** Resolve the signed-in user and confirm the site_manager role. Returns
     * null after already sending the error response, or the user row. Mirrors
     * FieldOfficerController#requireFieldOfficer exactly. */
    private async requireSiteManager(
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

        if (!user.roles?.includes(SITE_MANAGER_ROLE)) {
            res.status(403).json({ success: false, message: 'Site Manager role required' });
            return null;
        }

        return user;
    }

    /** The manager's assigned, still-active site ids (via their employee_sites).
     * Returns null (after responding) when the account has no linked employee. */
    private async assignedSiteIds(
        user: typeof usersTable.$inferSelect,
        res: Response
    ): Promise<string[] | null> {
        if (!user.employeeId) {
            res.status(400).json({ success: false, message: 'Employee profile not linked to this account' });
            return null;
        }
        const rows = await db
            .select({ siteId: employeeSites.siteId })
            .from(employeeSites)
            .innerJoin(sites, eq(employeeSites.siteId, sites.id))
            .where(and(eq(employeeSites.employeeId, user.employeeId), eq(sites.isActive, true)));
        return rows.map((r) => r.siteId);
    }

    // ── Mobile: config ───────────────────────────────────────────────────────

    /** GET /auth/site-manager/config — the optional accuracy ceiling so the app
     * can gate its Send button the same way the server gates the write. */
    public async handleConfig(_req: Request, res: Response) {
        try {
            const [row] = await db
                .select()
                .from(appSettings)
                .where(eq(appSettings.key, MAX_ACCURACY_KEY));
            const parsed = row?.value ? Number(row.value) : NaN;
            const maxAccuracyMeters = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
            return res.json({ success: true, data: { maxAccuracyMeters } });
        } catch (err: any) {
            console.error('[sm-config]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Mobile: client locations ─────────────────────────────────────────────

    /** GET /auth/site-manager/locations — the distinct client locations that
     * own at least one of the manager's assigned sites. First dropdown level. */
    public async handleLocations(req: Request, res: Response) {
        try {
            const user = await this.requireSiteManager(req, res);
            if (!user) return;
            if (!user.employeeId) {
                return res.status(400).json({ success: false, message: 'Employee profile not linked to this account' });
            }

            const rows = await db
                .select({
                    id: clientLocations.id,
                    locationName: clientLocations.locationName,
                    city: clientLocations.city,
                })
                .from(employeeSites)
                .innerJoin(sites, eq(employeeSites.siteId, sites.id))
                .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
                .where(
                    and(
                        eq(employeeSites.employeeId, user.employeeId),
                        eq(sites.isActive, true),
                        eq(clientLocations.isActive, true)
                    )
                )
                .groupBy(clientLocations.id, clientLocations.locationName, clientLocations.city)
                .orderBy(asc(clientLocations.locationName));

            return res.json({ success: true, data: { locations: rows } });
        } catch (err: any) {
            console.error('[sm-locations]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Mobile: sites under a client location ────────────────────────────────

    /** GET /auth/site-manager/sites/:clientLocationId — the manager's assigned
     * sites beneath one client location. Second dropdown level. The locationId
     * filter plus the employee_sites join mean a forged id can never widen the
     * set beyond sites the caller is actually posted to. */
    public async handleSitesByClient(req: Request, res: Response) {
        try {
            const user = await this.requireSiteManager(req, res);
            if (!user) return;
            if (!user.employeeId) {
                return res.status(400).json({ success: false, message: 'Employee profile not linked to this account' });
            }

            const clientLocationId = req.params.clientLocationId as string;
            const rows = await db
                .select({
                    id: sites.id,
                    siteName: sites.siteName,
                    siteCode: sites.siteCode,
                    address: sites.address,
                    latitude: sites.latitude,
                    longitude: sites.longitude,
                    allowedRadiusMeters: sites.allowedRadiusMeters,
                })
                .from(employeeSites)
                .innerJoin(sites, eq(employeeSites.siteId, sites.id))
                .where(
                    and(
                        eq(employeeSites.employeeId, user.employeeId),
                        eq(sites.locationId, clientLocationId),
                        eq(sites.isActive, true)
                    )
                )
                .orderBy(sites.siteName);

            return res.json({ success: true, data: { sites: rows } });
        } catch (err: any) {
            console.error('[sm-sites]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Mobile: submit ───────────────────────────────────────────────────────

    /** POST /auth/site-manager/location-submissions — store a PENDING proposal.
     * The official site coordinates are NOT touched here (that happens on admin
     * approval). Full server-side authorisation: site exists + active, belongs to
     * the claimed client location, is assigned to the caller, and no other
     * submission for the site is already pending. */
    public async handleCreateSubmission(req: Request, res: Response) {
        try {
            const user = await this.requireSiteManager(req, res);
            if (!user) return;

            const parsed = createSubmissionModel.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({ success: false, message: 'body validation failed', error: parsed.error.issues });
            }
            const { clientLocationId, siteId, latitude, longitude, accuracy } = parsed.data;

            const assigned = await this.assignedSiteIds(user, res);
            if (!assigned) return;
            if (!assigned.includes(siteId)) {
                return res.status(403).json({ success: false, message: 'You are not assigned to this site' });
            }

            // Site must exist, be active, and sit under the claimed client location.
            const [site] = await db
                .select({ id: sites.id, locationId: sites.locationId, isActive: sites.isActive })
                .from(sites)
                .where(eq(sites.id, siteId));
            if (!site || !site.isActive) {
                return res.status(404).json({ success: false, message: 'Site not found or inactive' });
            }
            if (site.locationId !== clientLocationId) {
                return res.status(400).json({ success: false, message: 'Site does not belong to the selected client location' });
            }

            // Optional accuracy ceiling, enforced server-side too.
            const [accRow] = await db.select().from(appSettings).where(eq(appSettings.key, MAX_ACCURACY_KEY));
            const maxAcc = accRow?.value ? Number(accRow.value) : NaN;
            if (Number.isFinite(maxAcc) && maxAcc > 0) {
                if (accuracy == null) {
                    return res.status(400).json({ success: false, message: 'GPS accuracy is required for this submission' });
                }
                if (accuracy > maxAcc) {
                    return res.status(400).json({ success: false, message: `GPS accuracy must be within ${maxAcc} metres` });
                }
            }

            // Friendly pre-check (the partial-unique index is the race-safe guard).
            const [existing] = await db
                .select({ id: siteLocationSubmissions.id })
                .from(siteLocationSubmissions)
                .where(and(eq(siteLocationSubmissions.siteId, siteId), eq(siteLocationSubmissions.status, 'PENDING')))
                .limit(1);
            if (existing) {
                return res.status(409).json({
                    success: false,
                    message: 'A location submission for this site is already pending administrator approval.',
                });
            }

            const [created] = await db
                .insert(siteLocationSubmissions)
                .values({
                    clientLocationId,
                    siteId,
                    submittedBy: user.id,
                    // numeric columns round-trip as strings in node-postgres.
                    latitude: latitude.toString(),
                    longitude: longitude.toString(),
                    accuracy: accuracy == null ? null : Number(accuracy).toString(),
                    status: 'PENDING',
                })
                .returning();

            return res.status(201).json({ success: true, data: { submission: created } });
        } catch (err: any) {
            // 23505 = unique violation on the partial "one PENDING per site"
            // index — two submissions raced past the pre-check.
            if (err?.code === '23505') {
                return res.status(409).json({
                    success: false,
                    message: 'A location submission for this site is already pending administrator approval.',
                });
            }
            console.error('[sm-create-submission]', err?.cause ?? err);
            return res.status(500).json({ success: false, message: err?.cause?.message ?? err.message });
        }
    }

    // ── Mobile: my submission history ────────────────────────────────────────

    /** GET /auth/site-manager/location-submissions — the manager's own history,
     * newest first, so rejected rows can surface their reason. */
    public async handleListSubmissions(req: Request, res: Response) {
        try {
            const user = await this.requireSiteManager(req, res);
            if (!user) return;

            const rows = await fromSubmissionsJoined()
                .where(eq(siteLocationSubmissions.submittedBy, user.id))
                .orderBy(desc(siteLocationSubmissions.submittedAt));

            return res.json({ success: true, data: { submissions: rows } });
        } catch (err: any) {
            console.error('[sm-list-submissions]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Admin: review list ───────────────────────────────────────────────────

    /** GET /employee/site-manager/submissions?status=PENDING — the approval
     * queue. Defaults to every status when no filter is supplied. */
    public async handleAdminList(req: Request, res: Response) {
        try {
            const q = adminSubmissionsQueryModel.safeParse(req.query);
            if (!q.success) {
                return res.status(400).json({ success: false, message: 'query validation failed', error: q.error.issues });
            }

            const where = q.data.status ? eq(siteLocationSubmissions.status, q.data.status) : undefined;
            const rows = await fromSubmissionsJoined()
                .where(where)
                .orderBy(desc(siteLocationSubmissions.submittedAt));

            return res.json({ success: true, data: { submissions: rows } });
        } catch (err: any) {
            console.error('[sm-admin-list]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** GET /employee/site-manager/submissions/:id — one submission plus the
     * site's CURRENT approved coordinates, so the admin map can compare the two. */
    public async handleAdminDetail(req: Request, res: Response) {
        try {
            const id = req.params.id as string;
            const [submission] = await fromSubmissionsJoined().where(eq(siteLocationSubmissions.id, id));
            if (!submission) {
                return res.status(404).json({ success: false, message: 'Submission not found' });
            }

            const [site] = await db
                .select({ latitude: sites.latitude, longitude: sites.longitude, allowedRadiusMeters: sites.allowedRadiusMeters })
                .from(sites)
                .where(eq(sites.id, submission.siteId));

            return res.json({ success: true, data: { submission, currentApproved: site ?? null } });
        } catch (err: any) {
            console.error('[sm-admin-detail]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Admin: approve ───────────────────────────────────────────────────────

    /** POST /employee/site-manager/submissions/:id/approve — make the submitted
     * coordinates official. Writes the site's lat/lng, stamps the submission
     * APPROVED with the previous coordinates for audit, and invalidates the
     * FO/OH Redis site cache so geofencing picks up the new position. */
    public async handleApprove(req: Request, res: Response) {
        try {
            // @ts-ignore — set by authenticationMiddleware
            const adminId = req.user?.id as string;
            const id = req.params.id as string;

            const updated = await db.transaction(async (tx) => {
                const [submission] = await tx
                    .select()
                    .from(siteLocationSubmissions)
                    .where(eq(siteLocationSubmissions.id, id))
                    .for('update');
                if (!submission) return { notFound: true as const };
                if (submission.status !== 'PENDING') return { alreadyReviewed: true as const, submission };

                const [site] = await tx
                    .select({ latitude: sites.latitude, longitude: sites.longitude })
                    .from(sites)
                    .where(eq(sites.id, submission.siteId));
                if (!site) return { notFound: true as const };

                // Move the official geofence to the approved point (radius kept).
                await tx
                    .update(sites)
                    .set({ latitude: submission.latitude, longitude: submission.longitude })
                    .where(eq(sites.id, submission.siteId));

                const [row] = await tx
                    .update(siteLocationSubmissions)
                    .set({
                        status: 'APPROVED',
                        reviewedBy: adminId ?? null,
                        reviewedAt: new Date(),
                        // Audit: remember where the site pointed before this move.
                        previousLatitude: site.latitude,
                        previousLongitude: site.longitude,
                    })
                    .where(eq(siteLocationSubmissions.id, id))
                    .returning();

                return { submission: row };
            });

            if ('notFound' in updated && updated.notFound) {
                return res.status(404).json({ success: false, message: 'Submission not found' });
            }
            if ('alreadyReviewed' in updated && updated.alreadyReviewed) {
                return res.status(409).json({ success: false, message: 'This submission has already been reviewed' });
            }

            const submission = (updated as { submission: typeof siteLocationSubmissions.$inferSelect }).submission;

            // Invalidate cached site coordinates for every FO/OH posted to the
            // site — the next GPS batch rebuilds from the new DB position.
            await invalidateSitesCacheForSite(submission.siteId);

            return res.json({ success: true, data: { submission } });
        } catch (err: any) {
            console.error('[sm-approve]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Admin: reject ────────────────────────────────────────────────────────

    /** POST /employee/site-manager/submissions/:id/reject — mark REJECTED with a
     * required reason. The official site coordinates are left untouched. */
    public async handleReject(req: Request, res: Response) {
        try {
            // @ts-ignore — set by authenticationMiddleware
            const adminId = req.user?.id as string;
            const id = req.params.id as string;

            const parsed = rejectSubmissionModel.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({ success: false, message: 'body validation failed', error: parsed.error.issues });
            }

            const [row] = await db
                .update(siteLocationSubmissions)
                .set({
                    status: 'REJECTED',
                    reviewedBy: adminId ?? null,
                    reviewedAt: new Date(),
                    rejectionReason: parsed.data.reason,
                })
                .where(and(eq(siteLocationSubmissions.id, id), eq(siteLocationSubmissions.status, 'PENDING')))
                .returning();

            if (!row) {
                return res.status(409).json({ success: false, message: 'Submission not found or already reviewed' });
            }

            return res.json({ success: true, data: { submission: row } });
        } catch (err: any) {
            console.error('[sm-reject]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }
}
