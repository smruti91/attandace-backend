import type { Request, Response } from 'express';
import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';

import { db } from '../../db';
import {
    clientLocations,
    coFoAssignments,
    employees,
    fieldOfficerSites,
    sites,
    usersTable,
} from '../../db/schema';
import {
    assignmentHistoryQueryModel,
    assignFieldOfficersModel,
    circleOfficerListQueryModel,
} from './models';
import {
    CO_ROLE,
    FIELD_OFFICER_ROLE,
    resolveViewerSiteScope,
} from '../../services/circleOfficerScope';
import { clearOfficerAttCacheForUser } from '../../services/officerAttendanceCache';
import { invalidateFoShiftCacheForViewer } from '../../services/shiftAttendanceCache';

/**
 * Admin panel: Circle Officer Management.
 *
 * Nothing here invents a new hierarchy. The CO → FO link is the only new
 * relationship; the FO's sites already live in `field_officer_sites` and the
 * employees on those sites in `employee_sites`, so a Circle Officer's visibility
 * is computed from those existing tables by services/circleOfficerScope — the
 * same code the CO's own mobile reports run through. That is what keeps the
 * admin's answer and the CO's answer from ever disagreeing.
 *
 * Assignments are never deleted. Removing an officer stamps the row
 * (`removedAt`, `isActive = false`) and leaves it in place, so the audit trail
 * shows who was under whom, when, and which admin moved him.
 */

// A closed assignment whose officer later went to a DIFFERENT Circle Officer is a
// reassignment; one whose officer simply stayed out is a removal. Derived rather
// than stored, so the two can never contradict the rows they describe.
//
// The outer row is referenced by its literal table-qualified name inside the
// subquery. Interpolating the column objects would render them bare ("fo_user_id")
// and PostgreSQL would bind those to the subquery's own `newer` row, turning the
// correlation into a tautology and labelling every closed row REMOVED.
const ASSIGNMENT_STATUS = sql`case
    when ${coFoAssignments.isActive} then 'ACTIVE'
    when exists (
        select 1 from co_fo_assignments newer
        where newer.fo_user_id = co_fo_assignments.fo_user_id
          and newer.id <> co_fo_assignments.id
          and newer.co_user_id <> co_fo_assignments.co_user_id
          and (newer.is_active = true or newer.assigned_at > co_fo_assignments.removed_at)
    ) then 'REASSIGNED'
    else 'REMOVED'
end`;

function displayName(row: { firstName?: string | null; lastName?: string | null; phone?: string | null }): string {
    const name = [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
    return name || row.phone || 'Unknown';
}

interface Account {
    userId: string;
    employeeId: string | null;
    name: string;
    phone: string;
    designation: string | null;
    isActive: boolean;
    roles: string[] | null;
}

export default class CircleOfficerAdminController {
    /** Names of any accounts by id — the audit trail needs the CO, the FO and the
     * admin who assigned, and one batched query beats three joins on the same
     * table with aliases. */
    private async accountsById(ids: string[]): Promise<Map<string, Account>> {
        const unique = [...new Set(ids.filter(Boolean))];
        if (unique.length === 0) return new Map();
        const rows = await db
            .select({
                userId: usersTable.id,
                employeeId: employees.id,
                firstName: employees.firstName,
                lastName: employees.lastName,
                phone: usersTable.phone,
                designation: employees.designation,
                isActive: usersTable.isActive,
                roles: usersTable.roles,
            })
            .from(usersTable)
            .leftJoin(employees, eq(usersTable.employeeId, employees.id))
            .where(inArray(usersTable.id, unique));
        return new Map(rows.map((r) => [r.userId, { ...r, name: displayName(r) }]));
    }

    /** The CO's active Field Officers, with the sites each one is posted to. */
    private async activeOfficers(coUserId: string) {
        const rows = await db
            .select({
                foUserId: coFoAssignments.foUserId,
                assignedAt: coFoAssignments.assignedAt,
            })
            .from(coFoAssignments)
            .where(and(
                eq(coFoAssignments.coUserId, coUserId),
                eq(coFoAssignments.isActive, true),
            ))
            .orderBy(asc(coFoAssignments.assignedAt));
        if (rows.length === 0) return [];

        const foIds = rows.map((r) => r.foUserId);
        const [accounts, postings] = await Promise.all([
            this.accountsById(foIds),
            db
                .select({
                    foUserId: fieldOfficerSites.fieldOfficerUserId,
                    id: sites.id,
                    siteName: sites.siteName,
                    siteCode: sites.siteCode,
                    locationName: clientLocations.locationName,
                })
                .from(fieldOfficerSites)
                .innerJoin(sites, eq(fieldOfficerSites.siteId, sites.id))
                .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
                .where(and(
                    inArray(fieldOfficerSites.fieldOfficerUserId, foIds),
                    eq(sites.isActive, true),
                )),
        ]);

        const sitesByOfficer = new Map<string, { id: string; siteName: string; siteCode: string | null; locationName: string }[]>();
        for (const p of postings) {
            const list = sitesByOfficer.get(p.foUserId) ?? [];
            if (!list.some((s) => s.id === p.id)) {
                list.push({ id: p.id, siteName: p.siteName, siteCode: p.siteCode, locationName: p.locationName });
                sitesByOfficer.set(p.foUserId, list);
            }
        }

        return foIds.map((foUserId) => {
            const account = accounts.get(foUserId);
            const list = (sitesByOfficer.get(foUserId) ?? [])
                .sort((a, b) => a.locationName.localeCompare(b.locationName) || a.siteName.localeCompare(b.siteName));
            return {
                id: foUserId,
                employeeId: account?.employeeId ?? null,
                name: account?.name ?? 'Unknown',
                phone: account?.phone ?? '',
                designation: account?.designation ?? null,
                siteCount: list.length,
                sites: list,
            };
        });
    }

    // ── GET /employee/circle-officer/circle-officers ─────────────────────────
    /** The management table: every Circle Officer account, with the Field
     * Officers currently under him and how many. */
    public async handleListCircleOfficers(req: Request, res: Response) {
        try {
            const parsed = circleOfficerListQueryModel.safeParse(req.query);
            if (!parsed.success) {
                return res.status(400).json({ success: false, message: 'query validation failed', error: parsed.error.issues });
            }

            const conditions = [sql`${usersTable.roles} @> ARRAY[${CO_ROLE}]::text[]`];
            const search = parsed.data.search;
            if (search) {
                const term = `%${search.toLowerCase()}%`;
                const matched = or(
                    sql`lower(trim(concat(coalesce(${employees.firstName}, ''), ' ', coalesce(${employees.lastName}, '')))) like ${term}`,
                    ilike(usersTable.phone, term),
                    sql`lower(${employees.id}::text) like ${term}`,
                );
                if (matched) conditions.push(matched);
            }

            const rows = await db
                .select({
                    coUserId: usersTable.id,
                    employeeId: employees.id,
                    firstName: employees.firstName,
                    lastName: employees.lastName,
                    phone: usersTable.phone,
                    designation: employees.designation,
                    isActive: usersTable.isActive,
                    createdAt: usersTable.createdAt,
                })
                .from(usersTable)
                .leftJoin(employees, eq(usersTable.employeeId, employees.id))
                .where(and(...conditions))
                .orderBy(asc(employees.firstName), asc(employees.lastName));

            const coIds = rows.map((r) => r.coUserId);
            const assignments = coIds.length === 0 ? [] : await db
                .select({
                    coUserId: coFoAssignments.coUserId,
                    foUserId: coFoAssignments.foUserId,
                })
                .from(coFoAssignments)
                .where(and(
                    inArray(coFoAssignments.coUserId, coIds),
                    eq(coFoAssignments.isActive, true),
                ))
                .orderBy(asc(coFoAssignments.assignedAt));

            const officerNames = await this.accountsById(assignments.map((a) => a.foUserId));
            const byCo = new Map<string, { id: string; name: string; phone: string; employeeId: string | null }[]>();
            for (const a of assignments) {
                const account = officerNames.get(a.foUserId);
                const list = byCo.get(a.coUserId) ?? [];
                list.push({
                    id: a.foUserId,
                    name: account?.name ?? 'Unknown',
                    phone: account?.phone ?? '',
                    employeeId: account?.employeeId ?? null,
                });
                byCo.set(a.coUserId, list);
            }

            const circleOfficers = rows.map((r) => {
                const fieldOfficers = byCo.get(r.coUserId) ?? [];
                return {
                    coUserId: r.coUserId,
                    employeeId: r.employeeId,
                    name: displayName(r),
                    phone: r.phone,
                    designation: r.designation,
                    accountActive: r.isActive,
                    foCount: fieldOfficers.length,
                    fieldOfficers,
                    // 'Inactive' is the account, 'Unassigned' the monitoring scope:
                    // a CO without Field Officers sees only his own postings, which
                    // is exactly what the panel wants an admin to notice.
                    status: !r.isActive ? 'Inactive' : fieldOfficers.length > 0 ? 'Active' : 'Unassigned',
                };
            });

            return res.json({
                success: true,
                data: {
                    circleOfficers,
                    total: circleOfficers.length,
                    unassigned: circleOfficers.filter((c) => c.status === 'Unassigned').length,
                },
            });
        } catch (err: any) {
            console.error('[co-list]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── GET /employee/circle-officer/field-officers ──────────────────────────
    /** The picker: every Field Officer account with his sites and the Circle
     * Officer he currently reports to, so the admin sees the consequence of a
     * check BEFORE saving it instead of discovering a silent transfer after. */
    public async handleListFieldOfficers(_req: Request, res: Response) {
        try {
            const rows = await db
                .select({
                    userId: usersTable.id,
                    employeeId: employees.id,
                    firstName: employees.firstName,
                    lastName: employees.lastName,
                    phone: usersTable.phone,
                    designation: employees.designation,
                    isActive: usersTable.isActive,
                })
                .from(usersTable)
                .leftJoin(employees, eq(usersTable.employeeId, employees.id))
                .where(and(
                    sql`${usersTable.roles} @> ARRAY[${FIELD_OFFICER_ROLE}]::text[]`,
                    eq(usersTable.isActive, true),
                ))
                .orderBy(asc(employees.firstName), asc(employees.lastName));

            const foIds = rows.map((r) => r.userId);
            const [postings, current] = foIds.length === 0 ? [[], []] : await Promise.all([
                db
                    .select({
                        foUserId: fieldOfficerSites.fieldOfficerUserId,
                        id: sites.id,
                        siteName: sites.siteName,
                        locationName: clientLocations.locationName,
                    })
                    .from(fieldOfficerSites)
                    .innerJoin(sites, eq(fieldOfficerSites.siteId, sites.id))
                    .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
                    .where(and(
                        inArray(fieldOfficerSites.fieldOfficerUserId, foIds),
                        eq(sites.isActive, true),
                    )),
                db
                    .select({
                        foUserId: coFoAssignments.foUserId,
                        coUserId: coFoAssignments.coUserId,
                    })
                    .from(coFoAssignments)
                    .where(and(
                        inArray(coFoAssignments.foUserId, foIds),
                        eq(coFoAssignments.isActive, true),
                    )),
            ]);

            const coNames = await this.accountsById(current.map((c) => c.coUserId));
            const sitesByOfficer = new Map<string, { id: string; siteName: string; locationName: string }[]>();
            for (const p of postings) {
                const list = sitesByOfficer.get(p.foUserId) ?? [];
                if (!list.some((s) => s.id === p.id)) {
                    list.push({ id: p.id, siteName: p.siteName, locationName: p.locationName });
                    sitesByOfficer.set(p.foUserId, list);
                }
            }
            const coByOfficer = new Map(current.map((c) => [c.foUserId, c.coUserId]));

            const fieldOfficers = rows.map((r) => {
                const list = (sitesByOfficer.get(r.userId) ?? [])
                    .sort((a, b) => a.locationName.localeCompare(b.locationName) || a.siteName.localeCompare(b.siteName));
                const coUserId = coByOfficer.get(r.userId) ?? null;
                const co = coUserId ? coNames.get(coUserId) : undefined;
                return {
                    id: r.userId,
                    employeeId: r.employeeId,
                    name: displayName(r),
                    phone: r.phone,
                    designation: r.designation,
                    siteCount: list.length,
                    sites: list,
                    currentCo: coUserId ? { id: coUserId, name: co?.name ?? 'Unknown', employeeId: co?.employeeId ?? null } : null,
                };
            });

            return res.json({ success: true, data: { fieldOfficers, total: fieldOfficers.length } });
        } catch (err: any) {
            console.error('[co-field-officers]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── GET /employee/circle-officer/circle-officers/:coId ───────────────────
    /** One CO's full picture: his Field Officers, their sites, and the site set
     * his mobile reports will actually read — resolved by the SAME service the
     * reports use, so the admin is shown the real answer rather than a rebuild. */
    public async handleCircleOfficerDetail(req: Request, res: Response) {
        try {
            const coId = String(req.params.coId);
            const checked = await this.requireCircleOfficer(coId);
            if ('error' in checked) {
                return res.status('status' in checked ? checked.status! : 404).json({ success: false, message: checked.error });
            }
            const { user } = checked;

            const [fieldOfficers, viewer] = await Promise.all([
                this.activeOfficers(coId),
                resolveViewerSiteScope(user),
            ]);

            const [row] = await db
                .select({
                    employeeId: employees.id,
                    firstName: employees.firstName,
                    lastName: employees.lastName,
                    phone: usersTable.phone,
                    designation: employees.designation,
                    isActive: usersTable.isActive,
                })
                .from(usersTable)
                .leftJoin(employees, eq(usersTable.employeeId, employees.id))
                .where(eq(usersTable.id, coId));

            return res.json({
                success: true,
                data: {
                    circleOfficer: {
                        coUserId: coId,
                        employeeId: row?.employeeId ?? null,
                        name: row ? displayName(row) : 'Unknown',
                        phone: row?.phone ?? '',
                        designation: row?.designation ?? null,
                        accountActive: row?.isActive ?? true,
                        foCount: fieldOfficers.length,
                    },
                    fieldOfficers,
                    scope: viewer.scope,
                    sites: viewer.sites,
                },
            });
        } catch (err: any) {
            console.error('[co-detail]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── GET /employee/circle-officer/history ─────────────────────────────────
    /** The audit trail. Every assignment ever made is here, newest first; closed
     * rows keep their removedAt and the admin who made the change is on the row
     * that opened it. No endpoint deletes or edits one. */
    public async handleHistory(req: Request, res: Response) {
        try {
            const parsed = assignmentHistoryQueryModel.safeParse(req.query);
            if (!parsed.success) {
                return res.status(400).json({ success: false, message: 'query validation failed', error: parsed.error.issues });
            }
            const { coUserId, foUserId, status, limit } = parsed.data;

            const conditions = [];
            if (coUserId) conditions.push(eq(coFoAssignments.coUserId, coUserId));
            if (foUserId) conditions.push(eq(coFoAssignments.foUserId, foUserId));
            if (status) conditions.push(sql`${ASSIGNMENT_STATUS} = ${status}`);

            const rows = await db
                .select({
                    id: coFoAssignments.id,
                    coUserId: coFoAssignments.coUserId,
                    foUserId: coFoAssignments.foUserId,
                    assignedBy: coFoAssignments.assignedBy,
                    assignedAt: coFoAssignments.assignedAt,
                    removedAt: coFoAssignments.removedAt,
                    isActive: coFoAssignments.isActive,
                    status: ASSIGNMENT_STATUS,
                })
                .from(coFoAssignments)
                .where(conditions.length ? and(...conditions) : undefined)
                .orderBy(desc(coFoAssignments.assignedAt), desc(coFoAssignments.createdAt))
                .limit(limit);

            const nameIds = [
                ...rows.map((r) => r.coUserId),
                ...rows.map((r) => r.foUserId),
                ...rows.map((r) => r.assignedBy),
            ].filter((v): v is string => Boolean(v));
            const accounts = await this.accountsById(nameIds);

            const history = rows.map((r) => {
                const co = accounts.get(r.coUserId);
                const fo = accounts.get(r.foUserId);
                const by = r.assignedBy ? accounts.get(r.assignedBy) : undefined;
                return {
                    id: r.id,
                    coUserId: r.coUserId,
                    coName: co?.name ?? 'Unknown',
                    coEmployeeId: co?.employeeId ?? null,
                    foUserId: r.foUserId,
                    foName: fo?.name ?? 'Unknown',
                    foEmployeeId: fo?.employeeId ?? null,
                    foPhone: fo?.phone ?? null,
                    assignedBy: r.assignedBy,
                    assignedByName: by?.name ?? (r.assignedBy ? 'Unknown' : 'System'),
                    assignedAt: r.assignedAt ? new Date(r.assignedAt).toISOString() : null,
                    removedAt: r.removedAt ? new Date(r.removedAt).toISOString() : null,
                    status: r.status,
                    isActive: r.isActive,
                };
            });

            return res.json({ success: true, data: { history, total: history.length } });
        } catch (err: any) {
            console.error('[co-history]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── PUT /employee/circle-officer/circle-officers/:coId/field-officers ────
    /**
     * Body: { foUserIds: [...], confirmReassign: false }
     *
     * The complete desired set, like the officer site-posting editor. Ids not in
     * it are released (their rows closed, never deleted); new ones are assigned.
     *
     * An officer already under a different Circle Officer is NOT moved silently:
     * without `confirmReassign` the whole call is refused with 409 and the list of
     * conflicts, so the panel can show "Rakesh is under Anil — confirm to move"
     * before writing. One active Circle Officer per officer is a database
     * constraint, so this refusal is not the only thing standing between a buggy
     * client and a split assignment.
     */
    public async handleAssignFieldOfficers(req: Request, res: Response) {
        try {
            const coId = String(req.params.coId);
            const checked = await this.requireCircleOfficer(coId);
            if ('error' in checked) {
                return res.status('status' in checked ? checked.status! : 404).json({ success: false, message: checked.error });
            }

            const parsed = assignFieldOfficersModel.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({ success: false, message: 'body validation failed', error: parsed.error.issues });
            }
            const desired = [...new Set(parsed.data.foUserIds)];

            if (desired.includes(coId)) {
                return res.status(400).json({ success: false, message: 'A Circle Officer cannot be assigned to himself.' });
            }

            // Every id must be a live Field Officer account.
            if (desired.length) {
                const found = await this.accountsById(desired);
                const unknown = desired.filter((id) => !found.has(id));
                if (unknown.length) {
                    return res.status(400).json({ success: false, message: `Unknown user(s): ${unknown.join(', ')}` });
                }
                const notOfficer = desired.filter((id) => !found.get(id)!.roles?.includes(FIELD_OFFICER_ROLE));
                if (notOfficer.length) {
                    return res.status(400).json({
                        success: false,
                        message: `Not a Field Officer: ${notOfficer.map((id) => `${found.get(id)!.name} (${found.get(id)!.phone})`).join(', ')}. Assign the role on the Employees or Field Officers page first.`,
                    });
                }
                const inactive = desired.filter((id) => !found.get(id)!.isActive);
                if (inactive.length) {
                    return res.status(400).json({
                        success: false,
                        message: 'Deactivated accounts cannot be assigned to a Circle Officer.',
                    });
                }
            }

            const current = await db
                .select({ foUserId: coFoAssignments.foUserId })
                .from(coFoAssignments)
                .where(and(eq(coFoAssignments.coUserId, coId), eq(coFoAssignments.isActive, true)));
            const currentIds = new Set(current.map((r) => r.foUserId));

            // Officers asked for who are active under some other CO.
            const conflicts = desired.length === 0 ? [] : await db
                .select({
                    foUserId: coFoAssignments.foUserId,
                    coUserId: coFoAssignments.coUserId,
                })
                .from(coFoAssignments)
                .where(and(
                    inArray(coFoAssignments.foUserId, desired),
                    eq(coFoAssignments.isActive, true),
                    ne(coFoAssignments.coUserId, coId),
                ));
            if (conflicts.length && !parsed.data.confirmReassign) {
                const ids = await this.accountsById([
                    ...conflicts.map((c) => c.foUserId),
                    ...conflicts.map((c) => c.coUserId),
                ]);
                return res.status(409).json({
                    success: false,
                    message: 'One or more Field Officers are currently assigned to another Circle Officer. Confirm the reassignment to move them.',
                    data: {
                        conflicts: conflicts.map((c) => ({
                            foUserId: c.foUserId,
                            foName: ids.get(c.foUserId)?.name ?? 'Unknown',
                            currentCoId: c.coUserId,
                            currentCoName: ids.get(c.coUserId)?.name ?? 'Unknown',
                        })),
                    },
                });
            }

            const toAdd = desired.filter((id) => !currentIds.has(id));
            const toRemove = [...currentIds].filter((id) => !desired.includes(id));
            const movedIn = [...new Set(conflicts.map((c) => c.foUserId))];
            const previousCoes = [...new Set(conflicts.map((c) => c.coUserId))];

            // @ts-ignore — req.user set by authenticationMiddleware; the admin
            // guard above already refused anything unauthenticated.
            const adminId = req.user?.id as string | undefined;
            const now = new Date();

            await db.transaction(async (tx) => {
                // Release first, then open: the unique active-per-officer index
                // would refuse a new row while the old CO still holds one.
                if (toRemove.length) {
                    await tx
                        .update(coFoAssignments)
                        .set({ isActive: false, removedAt: now })
                        .where(and(
                            eq(coFoAssignments.coUserId, coId),
                            inArray(coFoAssignments.foUserId, toRemove),
                            eq(coFoAssignments.isActive, true),
                        ));
                }
                if (movedIn.length) {
                    await tx
                        .update(coFoAssignments)
                        .set({ isActive: false, removedAt: now })
                        .where(and(
                            inArray(coFoAssignments.foUserId, movedIn),
                            eq(coFoAssignments.isActive, true),
                            ne(coFoAssignments.coUserId, coId),
                        ));
                }
                if (toAdd.length) {
                    await tx
                        .insert(coFoAssignments)
                        .values(toAdd.map((foUserId) => ({
                            coUserId: coId,
                            foUserId,
                            assignedBy: adminId ?? null,
                        })))
                        .onConflictDoNothing();
                }
            });

            // Both sides must see the change on their next request: the new CO
            // gains records, the old one loses them. Their report caches are keyed
            // per viewer, so this is exactly the set to drop (§7 "immediately").
            for (const viewer of [coId, ...previousCoes]) {
                await clearOfficerAttCacheForUser(viewer);
                await invalidateFoShiftCacheForViewer(viewer);
            }

            return res.json({
                success: true,
                message: 'Field Officer assignments updated',
                data: {
                    assigned: toAdd.length,
                    released: toRemove.length,
                    reassigned: movedIn.length,
                    total: desired.length,
                },
            });
        } catch (err: any) {
            console.error('[co-assign]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── DELETE /employee/circle-officer/circle-officers/:coId/field-officers/:foUserId
    /** Release one officer from one CO. The row is closed, not deleted, so the
     * history keeps showing that the pairing existed and who ended it. */
    public async handleRemoveFieldOfficer(req: Request, res: Response) {
        try {
            const coId = String(req.params.coId);
            const foUserId = String(req.params.foUserId);
            const checked = await this.requireCircleOfficer(coId);
            if ('error' in checked) {
                return res.status('status' in checked ? checked.status! : 404).json({ success: false, message: checked.error });
            }

            const [active] = await db
                .select({ id: coFoAssignments.id })
                .from(coFoAssignments)
                .where(and(
                    eq(coFoAssignments.coUserId, coId),
                    eq(coFoAssignments.foUserId, foUserId),
                    eq(coFoAssignments.isActive, true),
                ))
                .limit(1);
            if (!active) {
                return res.status(404).json({ success: false, message: 'That Field Officer is not assigned to this Circle Officer.' });
            }

            await db
                .update(coFoAssignments)
                .set({ isActive: false, removedAt: new Date() })
                .where(eq(coFoAssignments.id, active.id));

            await clearOfficerAttCacheForUser(coId);
            await invalidateFoShiftCacheForViewer(coId);

            return res.json({ success: true, message: 'Field Officer released from this Circle Officer' });
        } catch (err: any) {
            console.error('[co-remove-officer]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Guard ────────────────────────────────────────────────────────────────
    /** The target account must exist and carry the Circle Officer role. Role
     * assignment itself stays where it already lives (PATCH
     * /employee/employees/:id/roles), so this panel never grows a second way to
     * create or move an identity. */
    private async requireCircleOfficer(userId: string): Promise<
        | { error: string; status?: number }
        | { user: typeof usersTable.$inferSelect; error?: undefined }
    > {
        const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
        if (!user) return { error: 'User not found' };
        if (!user.roles?.includes(CO_ROLE)) {
            return { error: 'User is not a Circle Officer', status: 400 };
        }
        return { user };
    }
}
