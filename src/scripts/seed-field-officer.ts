/**
 * Grant the field_officer role to an existing user and post them to client
 * sites. Run against a user who already exists (create employees in the admin
 * panel first):
 *
 *   npx tsx src/scripts/seed-field-officer.ts <phone> ["Site Name" ...]
 *
 * With no site names, the officer is assigned every active site — handy for a
 * demo account; production assignments should be explicit.
 */

import 'dotenv/config'
import { eq, and, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import { usersTable, sites, fieldOfficerSites } from '../db/schema'

async function main() {
    const [phone, ...siteNames] = process.argv.slice(2)
    if (!phone) {
        console.error('Usage: npx tsx src/scripts/seed-field-officer.ts <phone> ["Site Name" ...]')
        process.exit(1)
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.phone, phone))
    if (!user) {
        console.error(`No user with phone ${phone}. Create the employee/user first.`)
        process.exit(1)
    }

    // Grant the role, idempotently.
    const roles = user.roles ?? []
    if (!roles.includes('field_officer')) {
        await db
            .update(usersTable)
            .set({ roles: [...roles, 'field_officer'] })
            .where(eq(usersTable.id, user.id))
        console.log(`Role field_officer granted to ${phone}`)
    } else {
        console.log(`${phone} already has field_officer`)
    }

    // Resolve target sites: by name if given, else every active site.
    const targetSites = siteNames.length
        ? await db
              .select()
              .from(sites)
              .where(and(eq(sites.isActive, true), inArray(sites.siteName, siteNames)))
        : await db.select().from(sites).where(eq(sites.isActive, true))

    if (!targetSites.length) {
        console.error('No matching active sites. Check the names against the sites table.')
        process.exit(1)
    }

    for (const site of targetSites) {
        await db
            .insert(fieldOfficerSites)
            .values({ fieldOfficerUserId: user.id, siteId: site.id })
            .onConflictDoNothing()
        console.log(`Assigned site: ${site.siteName}`)
    }

    const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(fieldOfficerSites)
        .where(eq(fieldOfficerSites.fieldOfficerUserId, user.id))

    console.log(`\nDone. ${phone} is now a Field Officer with ${countRow?.count ?? 0} assigned site(s).`)
    console.log('Default tracking interval: 5 minutes — change app_settings.fo_tracking_interval_minutes to adjust.')
    process.exit(0)
}

main().catch((err) => {
    console.error('seed-field-officer failed:', err)
    process.exit(1)
})
