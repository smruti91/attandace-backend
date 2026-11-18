/**
 * Seed the role_pages table with the defaults that used to be hard-coded in the
 * mobile app's drawer layout, so existing deployments keep the exact same
 * behaviour after switching to database-driven page assignment.
 *
 *   npx tsx src/scripts/seed-role-pages.ts
 *
 * Rows are upserted only when the role has no row yet — an admin's custom page
 * set is never overwritten by a re-run.
 */

import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { rolePages } from '../db/schema'

// Page keys must match PAGE_REGISTRY in the app (demo/src/config/pageRegistry.ts).
const DEFAULT_ROLE_PAGES: Record<string, string[]> = {
    employee: ['home', 'profile'],
    // Supervisor punches the team from the Employees Attendance grid — no
    // 'take-attendance' (see the revocations below for existing rows).
    supervisor: ['home', 'profile', 'register-employee', 'employees-attendance', 'shift-attendance', 'employee-violations'],
    // No 'report_collector' — submitting collection reports is the client-visits
    // FACILITY, granted to any role below; it was never a role of its own.
    field_officer: ['home', 'profile', 'field-officer', 'fo-shift-attendance', 'officer-employee-attendance', 'officer-shift-attendance', 'take-attendance'],
    // Operational Head: no tracking screen — see the revocations below.
    oh: ['home', 'profile'],
    site_manager: ['home', 'profile', 'send-location'],
    // Circle Officer: read-only monitoring — exactly the two attendance reports,
    // Employee Attendance and Shift Attendance (the Supervisor-submitted shift
    // rows, viewed through the same screen a Field Officer uses). No punch,
    // tracking or face-enrolment facility: a CO must not be able to write.
    co: ['home', 'profile', 'officer-employee-attendance', 'fo-shift-attendance'],
}

async function main() {
    for (const [role, pages] of Object.entries(DEFAULT_ROLE_PAGES)) {
        await db
            .insert(rolePages)
            .values({ role, pages })
            .onConflictDoNothing({ target: rolePages.role })

        console.log(`role '${role}' -> [${pages.join(', ')}]`)
    }

    // Additive backfill: existing deployments have rows from before newer pages
    // shipped. Append missing keys — never overwrite an admin's custom page set.
    const backfills: Record<string, string[]> = {
        supervisor: ['employees-attendance', 'shift-attendance', 'employee-violations'],
        field_officer: ['fo-shift-attendance', 'officer-employee-attendance', 'officer-shift-attendance', 'take-attendance'],
        co: ['officer-employee-attendance', 'fo-shift-attendance'],
    }
    for (const [role, keys] of Object.entries(backfills)) {
        const [row] = await db.select().from(rolePages).where(eq(rolePages.role, role))
        if (!row) continue
        const have = new Set(((row.pages ?? []) as string[]))
        const missing = keys.filter((k) => !have.has(k))
        if (missing.length > 0) {
            const next = [...((row.pages ?? []) as string[]), ...missing]
            await db.update(rolePages).set({ pages: next }).where(eq(rolePages.role, role))
            console.log(`role '${role}' backfilled -> [${next.join(', ')}]`)
        }
    }

    // Removal backfill: the mirror of the additive one above, for a page a role
    // must stop seeing. Only the listed key is dropped, so everything else the
    // admin granted to that row is left exactly as it was. Needed because an
    // existing deployment already has a row (the seed never overwrites one), and
    // a row is what takes precedence over the defaults in the controller.
    const revocations: Record<string, string[]> = {
        // "Take Employee Attendance" is revoked from the Supervisor: the same
        // punches (biometric + manual, check-in / check-out) are taken from the
        // "Employees Attendance" grid, so the standalone screen was a duplicate
        // menu entry. The cross-device attendance API is unaffected — a role
        // holds that facility through EITHER page key, and this role keeps
        // 'employees-attendance'. Field Officers keep 'take-attendance' — that
        // screen is their normal way of punching a team.
        supervisor: ['take-attendance'],
        // "Operational Visits" no longer needs a menu entry: the OH's tracking is
        // started and stopped by his Face Check-In / Check-Out on Home, and the
        // end-of-day sweep closes the rest. "Employees Attendance" is likewise
        // revoked — the OH punches his team from the Home flow, not this grid.
        oh: ['oh-visits', 'employees-attendance'],
        // Field Officers take attendance from the "Take Attendance" screen; the
        // Supervisor-style "Employees Attendance" grid is not a menu for them.
        field_officer: ['employees-attendance'],
        // Circle Officer is read-only monitoring with exactly two menus. His
        // sites are derived from the Field Officers assigned to him, so he needs
        // neither his own attendance history nor a posting-dependent report, and
        // "Register Employee" is a write facility he must never hold — an early
        // deployment granted it to `co` by mistake.
        co: ['attendance-history', 'register-employee', 'officer-shift-attendance'],
    }
    for (const [role, keys] of Object.entries(revocations)) {
        const [row] = await db.select().from(rolePages).where(eq(rolePages.role, role))
        if (!row) continue
        const have = (row.pages ?? []) as string[]
        const dropped = keys.filter((k) => have.includes(k))
        if (dropped.length > 0) {
            const next = have.filter((k) => !dropped.includes(k))
            await db.update(rolePages).set({ pages: next }).where(eq(rolePages.role, role))
            console.log(`role '${role}' revoked [${dropped.join(', ')}] -> [${next.join(', ')}]`)
        }
    }

    // Obsolete role rows: "Report Collector" was once modelled as a role, but it
    // is a facility — the `client-visits` page, granted to whichever role needs
    // it (Roles & Facilities -> "Report Collector"). No account can be given
    // that role any more, so the row is dropped instead of lingering as a
    // phantom entry in the panel. Idempotent: nothing happens once it is gone.
    for (const role of ['report_collector']) {
        const removed = await db.delete(rolePages).where(eq(rolePages.role, role)).returning({ role: rolePages.role })
        if (removed.length > 0) console.log(`role '${role}' row removed — it is a facility (client-visits), not a role`)
    }

    console.log('\nrole_pages seeded. Edit the rows (or PUT /auth/role-pages as admin) to change what each role sees — no app update needed.')
    process.exit(0)
}

main().catch((err) => {
    console.error('seed-role-pages failed:', err)
    process.exit(1)
})
