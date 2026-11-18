import { and, eq, inArray, sql } from 'drizzle-orm'

import { db } from '../db'
import {
    clientLocations,
    coFoAssignments,
    employees,
    fieldOfficerSites,
    sites,
    usersTable,
} from '../db/schema'

/**
 * Who may see which sites — the one place that answers it for every read-only
 * attendance report in the app.
 *
 * The system already has the whole hierarchy, so nothing is duplicated here:
 *   CO ──(co_fo_assignments)──► FO ──(field_officer_sites)──► Site
 *     └──(field_officer_sites, when the admin also posts the CO directly)
 *
 * A Circle Officer's visibility is therefore derived, never assigned: the CO's
 * sites are the sites of the Field Officers currently under them. The direct
 * posting is kept in the union on purpose — an existing CO who was posted to
 * sites in the "Officers & Sites" screen before the CO→FO link existed must not
 * lose the records he could already read (that would be a silent regression),
 * and adding a posting to a CO is still the admin's decision, never the CO's.
 *
 * The result of this module is the hard authorization boundary for every report
 * that uses it: the id list goes straight into the SQL, so a forged filter id in
 * a request can only ever narrow the set, never widen it.
 */

// Role keys. `field-officer/controller.ts` exports the same three for the
// tracking engine; they live here as far as this concern (reading attendance)
// is allowed to depend on the module that owns writing visits.
export const CO_ROLE = 'co'
export const FIELD_OFFICER_ROLE = 'field_officer'
export const OH_ROLE = 'oh'

/** Roles allowed to read the officer-scoped attendance reports. */
export const VIEWER_ROLES: readonly string[] = [CO_ROLE, FIELD_OFFICER_ROLE, OH_ROLE]

export function isCircleOfficer(roles: readonly string[] | null | undefined): boolean {
    return Boolean(roles?.includes(CO_ROLE))
}

/** The Field Officers currently under this Circle Officer (active rows only). */
export async function assignedFieldOfficerIds(coUserId: string): Promise<string[]> {
    const rows = await db
        .select({ foUserId: coFoAssignments.foUserId })
        .from(coFoAssignments)
        .where(and(
            eq(coFoAssignments.coUserId, coUserId),
            eq(coFoAssignments.isActive, true),
        ))
    return [...new Set(rows.map((r) => r.foUserId))]
}

export interface ScopeOfficer {
    id: string
    name: string
    phone: string | null
    employeeId: string | null
    designation: string | null
}

/** A site inside the viewer's scope, with the officers who cover it. `officers`
 * is only ever populated for the sites a Circle Officer reaches through an
 * assigned Field Officer — it is what the reports show in their "Field Officer"
 * column and filter on. */
export interface ScopedSite {
    id: string
    siteName: string
    siteCode: string | null
    address: string | null
    latitude: string
    longitude: string
    allowedRadiusMeters: string
    locationId: string
    locationName: string
    officers: ScopeOfficer[]
}

export interface ViewerSiteScope {
    /** 'circle-officer' when the scope is (at least partly) derived from the
     * CO's Field Officers — the client uses it to decide whether the Field
     * Officer column / filter applies, instead of testing the role itself. */
    scope: 'officer-sites' | 'circle-officer'
    /** The CO's active Field Officers; empty for every other viewer. */
    officers: ScopeOfficer[]
    sites: ScopedSite[]
}

const EMPTY: ViewerSiteScope = { scope: 'officer-sites', officers: [], sites: [] }

/** The site columns every consumer needs, in one select — each report maps the
 * subset it shows, so the joins stay written once. */
const SITE_COLUMNS = {
    id: sites.id,
    siteName: sites.siteName,
    siteCode: sites.siteCode,
    address: sites.address,
    latitude: sites.latitude,
    longitude: sites.longitude,
    allowedRadiusMeters: sites.allowedRadiusMeters,
    locationId: sites.locationId,
    locationName: clientLocations.locationName,
}

const OFFICER_COLUMNS = {
    id: usersTable.id,
    name: sql<string>`coalesce(nullif(trim(concat(${employees.firstName}, ' ', ${employees.lastName})), ''), ${usersTable.phone})`,
    phone: usersTable.phone,
    employeeId: employees.id,
    designation: employees.designation,
}

/**
 * The viewer's authorized site set. Only ever called with an id taken from the
 * verified token, never from a request body.
 */
export async function resolveViewerSiteScope(user: {
    id: string
    roles: string[] | null
}): Promise<ViewerSiteScope> {
    // 1. Sites this account is itself posted to (Field Officer, OH, or a CO the
    //    admin also posted directly). Inactive sites are excluded here, so a
    //    closed site can never be read through any path.
    const own = await db
        .select(SITE_COLUMNS)
        .from(fieldOfficerSites)
        .innerJoin(sites, eq(fieldOfficerSites.siteId, sites.id))
        .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
        .where(and(
            eq(fieldOfficerSites.fieldOfficerUserId, user.id),
            eq(sites.isActive, true),
        ))

    const byId = new Map<string, ScopedSite>()
    for (const row of own) byId.set(row.id, { ...row, officers: [] })

    if (!isCircleOfficer(user.roles)) {
        return {
            scope: 'officer-sites',
            officers: [],
            sites: [...byId.values()].sort(sortSites),
        }
    }

    // 2. A Circle Officer additionally reaches every site of every Field
    //    Officer assigned to him right now.
    const foIds = await assignedFieldOfficerIds(user.id)
    if (foIds.length === 0) {
        return { scope: 'circle-officer', officers: [], sites: [...byId.values()].sort(sortSites) }
    }

    const officerRows = await db
        .select(OFFICER_COLUMNS)
        .from(usersTable)
        .leftJoin(employees, eq(usersTable.employeeId, employees.id))
        .where(inArray(usersTable.id, foIds))
    const officers = officerRows
        .map((o) => ({ ...o, name: String(o.name ?? '').trim() || o.phone || 'Unknown' }))
        .sort((a, b) => a.name.localeCompare(b.name))
    const officerById = new Map(officers.map((o) => [o.id, o]))

    const throughOfficers = await db
        .select({ ...SITE_COLUMNS, foUserId: fieldOfficerSites.fieldOfficerUserId })
        .from(fieldOfficerSites)
        .innerJoin(sites, eq(fieldOfficerSites.siteId, sites.id))
        .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
        .where(and(
            inArray(fieldOfficerSites.fieldOfficerUserId, foIds),
            eq(sites.isActive, true),
        ))

    for (const row of throughOfficers) {
        const officer = officerById.get(row.foUserId)
        const { foUserId, ...site } = row
        const existing = byId.get(site.id)
        if (existing) {
            byId.set(site.id, { ...existing, officers: addOfficer(existing.officers, officer) })
        } else {
            byId.set(site.id, { ...site, officers: addOfficer([], officer) })
        }
    }

    return { scope: 'circle-officer', officers, sites: [...byId.values()].sort(sortSites) }
}

function addOfficer(list: ScopeOfficer[], officer: ScopeOfficer | undefined): ScopeOfficer[] {
    if (!officer) return list
    if (list.some((o) => o.id === officer.id)) return list
    return [...list, officer].sort((a, b) => a.name.localeCompare(b.name))
}

const sortSites = (a: ScopedSite, b: ScopedSite) =>
    a.locationName.localeCompare(b.locationName) || a.siteName.localeCompare(b.siteName)

/**
 * Sites reachable through one specific assigned Field Officer — the check behind
 * the reports' Field Officer filter. Returns null when that officer is not under
 * this CO, which the callers answer with 403 rather than an empty list, so a
 * forged id reads as a refusal and not as "no data".
 */
export async function fieldOfficerSitesFor(
    coUserId: string,
    foUserId: string
): Promise<string[] | null> {
    const [assigned] = await db
        .select({ foUserId: coFoAssignments.foUserId })
        .from(coFoAssignments)
        .where(and(
            eq(coFoAssignments.coUserId, coUserId),
            eq(coFoAssignments.foUserId, foUserId),
            eq(coFoAssignments.isActive, true),
        ))
        .limit(1)
    if (!assigned) return null

    const rows = await db
        .select({ siteId: fieldOfficerSites.siteId })
        .from(fieldOfficerSites)
        .innerJoin(sites, eq(fieldOfficerSites.siteId, sites.id))
        .where(and(
            eq(fieldOfficerSites.fieldOfficerUserId, foUserId),
            eq(sites.isActive, true),
        ))
    return rows.map((r) => r.siteId)
}

/** Every active site of the given officers, as a flat id list. Used when a
 * reassignment has to drop exactly the caches those sites feed. */
export async function sitesOfOfficers(foUserIds: string[]): Promise<string[]> {
    if (foUserIds.length === 0) return []
    const rows = await db
        .select({ siteId: fieldOfficerSites.siteId })
        .from(fieldOfficerSites)
        .where(inArray(fieldOfficerSites.fieldOfficerUserId, foUserIds))
    return [...new Set(rows.map((r) => r.siteId))]
}
