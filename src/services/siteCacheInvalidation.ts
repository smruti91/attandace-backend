import { and, eq, sql } from 'drizzle-orm'

import { db } from '../db'
import { employeeSites, fieldOfficerSites, usersTable } from '../db/schema'
import { clearSitesCacheOnly } from './foTrackingCache'

/**
 * Cache invalidation for the geofence list the tracking engine works from.
 *
 * `FO:{userId}:sites` is written once and re-read on every GPS batch for a full
 * day (24-hour TTL, refreshed again by touchSession on each accepted batch), and
 * the engine only rebuilds it on a MISS. So any change that alters what a site
 * list should contain — a new officer posting, an approved or edited
 * coordinate, a radius, a deactivation — is invisible to tracking until the key
 * expires, unless the write clears it. The symptom is precise and easy to miss:
 * the officer walks into a site the admin assigned hours ago, every fix is
 * stored with `visit_id` NULL, and no visit row ever appears, while the sites he
 * already had in the cache keep working perfectly.
 *
 * This mirrors the two sources `loadAssignedSites` reads: the
 * `field_officer_sites` postings, and the single `employee_sites` record an
 * Operational Head falls back to when he carries no posting. Any account whose
 * list can contain the site must be dropped.
 *
 * Best-effort by design: Redis here is acceleration, never authority, so a
 * failure costs one rebuilt batch — it must never break the admin write that
 * succeeded.
 */
export async function invalidateSitesCacheForSite(siteId: string): Promise<void> {
    try {
        const userIds = new Set<string>()

        const officers = await db
            .select({ userId: fieldOfficerSites.fieldOfficerUserId })
            .from(fieldOfficerSites)
            .where(eq(fieldOfficerSites.siteId, siteId))
        for (const o of officers) userIds.add(o.userId)

        const heads = await db
            .select({ userId: usersTable.id })
            .from(employeeSites)
            .innerJoin(usersTable, eq(usersTable.employeeId, employeeSites.employeeId))
            .where(
                and(
                    eq(employeeSites.siteId, siteId),
                    sql`${usersTable.roles} && ARRAY['oh']::text[]`
                )
            )
        for (const h of heads) userIds.add(h.userId)

        await Promise.all([...userIds].map((userId) => clearSitesCacheOnly(userId)))
    } catch (err: any) {
        console.error('[site-cache] invalidate failed:', err?.message ?? err)
    }
}
