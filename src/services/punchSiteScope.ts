import { and, eq } from 'drizzle-orm'

import { db } from '../db'
import {
    clientLocations,
    employeeSites,
    fieldOfficerSites,
    sites,
} from '../db/schema'

/**
 * The sites one account may record its OWN attendance at — the single list the
 * punch path authorises against and the mobile app renders as a choice.
 *
 * A Field Officer works from the client sites he is posted to
 * (`field_officer_sites`), which is exactly the list his tracking fence already
 * uses, and he keeps whatever site rows his own employee record carries
 * (`employee_sites`) — the same union the app has been resolving his geofence
 * against since the two tables first disagreed. Posting an officer is therefore
 * what makes a site punchable; nothing is assigned twice and no site is widened
 * by this module.
 *
 * Every other role keeps the list it always had: the sites on their own employee
 * record. The union is not a permission — `canSelectPunchSite` decides who may
 * choose from it, and the caller's verified roles (never a client flag) feed
 * that. Inactive sites drop out of both halves, so a closed site stops
 * authorising punches at once, without anyone being unassigned.
 */

// The role this feature exists for. Declared here rather than imported from the
// tracking module, which owns writing visits: reading a punch authorisation
// should not depend on that controller's constants. `circleOfficerScope.ts`
// keeps its own copy for the same reason.
export const FIELD_OFFICER_ROLE = 'field_officer'

export interface PunchSite {
    id: string
    siteName: string
    siteCode: string | null
    latitude: string
    longitude: string
    allowedRadiusMeters: string
    locationId: string
    locationName: string
}

const SITE_COLUMNS = {
    id: sites.id,
    siteName: sites.siteName,
    siteCode: sites.siteCode,
    latitude: sites.latitude,
    longitude: sites.longitude,
    // The app fences against the site it was given, so the radius travels with
    // it — and the server re-measures the fix, which needs the same number.
    allowedRadiusMeters: sites.allowedRadiusMeters,
    locationId: sites.locationId,
    locationName: clientLocations.locationName,
}

/**
 * One assigned site's slice of the officer's today, exactly as
 * `/auth/attendance/status` reports it.
 *
 * The facts come first (`checkInAt` / `checkOutAt`) and the two verdicts the
 * buttons are wired to come after, so a screen can show the times without
 * re-deriving the rules — and cannot derive them differently from the server.
 * `canCheckOut` is true at sites he never checked in at, which is the feature:
 * he closes the duty wherever he actually is standing.
 *
 * The coordinates ride along so the phone fences against exactly the numbers the
 * server will re-measure, rather than matching the site up again by name.
 */
export interface PunchSiteStatus {
    siteId: string
    siteName: string
    siteCode: string | null
    locationName: string
    latitude: string
    longitude: string
    allowedRadiusMeters: string
    checkInAt: string | null
    checkOutAt: string | null
    isOpenHere: boolean
    canCheckIn: boolean
    canCheckOut: boolean
}

/**
 * Whether this account gets to pick the site it punches at.
 *
 * Field Officer only, on purpose: an ordinary employee is posted to one place
 * and has never had a choice to make, and a Supervisor punching ON BEHALF of
 * someone already has the site decided by the roster he is working through. The
 * answer is computed from the token's roles in one place, so neither the menu
 * grid nor any screen has to test a role name — the app reads this back as
 * `siteSelectionRequired` from /auth/attendance/status.
 */
export function canSelectPunchSite(roles: readonly string[] | null | undefined): boolean {
    return Boolean(roles?.includes(FIELD_OFFICER_ROLE))
}

/**
 * The officer's punchable sites, de-duplicated and ordered as the app lists
 * them. Called with ids taken from the verified token, never from a body.
 */
export async function loadPunchSites(user: {
    id: string
    employeeId: string | null
}): Promise<PunchSite[]> {
    const posted = await db
        .select(SITE_COLUMNS)
        .from(fieldOfficerSites)
        .innerJoin(sites, eq(fieldOfficerSites.siteId, sites.id))
        .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
        .where(and(
            eq(fieldOfficerSites.fieldOfficerUserId, user.id),
            eq(sites.isActive, true),
        ))

    const assigned = user.employeeId
        ? await db
            .select(SITE_COLUMNS)
            .from(employeeSites)
            .innerJoin(sites, eq(employeeSites.siteId, sites.id))
            .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
            .where(and(
                eq(employeeSites.employeeId, user.employeeId),
                eq(sites.isActive, true),
            ))
        : []

    const byId = new Map<string, PunchSite>()
    for (const row of [...assigned, ...posted]) {
        if (!byId.has(row.id)) byId.set(row.id, row)
    }

    return [...byId.values()].sort(
        (a, b) =>
            a.locationName.localeCompare(b.locationName) ||
            a.siteName.localeCompare(b.siteName) ||
            // Two sites in one client can share a name; the id keeps the order
            // stable so the app's dropdown cannot reshuffle between renders.
            a.id.localeCompare(b.id)
    )
}

/**
 * The one site of that list a punch may be recorded at, or null when the id is
 * not the officer's to use. A forged site id must read as a refusal (403) and
 * never as "punch filed somewhere else".
 */
export async function resolvePunchSite(
    user: { id: string; employeeId: string | null },
    siteId: string
): Promise<PunchSite | null> {
    // UUID-shaped before anything reaches the joins: `::uuid` comparisons on a
    // hand-typed string would throw a database error rather than a refusal.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) {
        return null
    }
    const [row] = await db
        .select(SITE_COLUMNS)
        .from(fieldOfficerSites)
        .innerJoin(sites, eq(fieldOfficerSites.siteId, sites.id))
        .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
        .where(and(
            eq(fieldOfficerSites.fieldOfficerUserId, user.id),
            eq(sites.id, siteId),
            eq(sites.isActive, true),
        ))
        .limit(1)
    if (row) return row

    if (!user.employeeId) return null
    const [own] = await db
        .select(SITE_COLUMNS)
        .from(employeeSites)
        .innerJoin(sites, eq(employeeSites.siteId, sites.id))
        .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
        .where(and(
            eq(employeeSites.employeeId, user.employeeId),
            eq(sites.id, siteId),
            eq(sites.isActive, true),
        ))
        .limit(1)
    return own ?? null
}
