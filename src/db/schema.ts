import { pgTable, uuid, varchar, text, boolean, timestamp, numeric, date, integer,
  index,
  uniqueIndex,
  check, } from 'drizzle-orm/pg-core'

import { customType } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── Custom pgvector type (128 dimensions) ─────────────────────────────────────
// Drizzle doesn't ship a first-class vector() column yet,
// so we define it via customType — works perfectly with pgvector.
const vector = (dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    // JS → Postgres: number[] → '[f1,f2,...,f128]'
    toDriver(value: number[]): string {
      return `[${value.join(',')}]`;
    },
    // Postgres → JS: '[f1,f2,...,f128]' → number[]
    fromDriver(value: string): number[] {
      return value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(Number);
    },
  });

export const usersTable = pgTable('users', {
    id: uuid('id').primaryKey().defaultRandom(),

    // Nullable because an admin is not an employee. The unique constraint stays:
    // Postgres treats NULLs as distinct under UNIQUE, so any number of admin
    // rows can coexist while each employee still maps to at most one user.
    employeeId: uuid('employee_id').unique().references(()=>employees.id, { onDelete: 'cascade' }),
    phone: varchar('phone', { length: 15 }).notNull().unique(),
    password: varchar('password', { length: 66 }),
    salt: text('salt'),
    // 'employee' | 'admin' | 'superviser'. Kept for backward compat; new code reads `roles`.
    role: varchar('role', { length: 20 }).notNull().default('employee'),

    // Multiple roles per user. Populated at sign-up and editable from the admin
    // panel. Backfilled from `role` by migration 0011. Possible values:
    //   'employee'         — can check in/out (all users get this by default)
    //   'supervisor'       — can register other employees' faces on their phone
    // There is no 'report_collector' here: submitting collection reports is the
    // `client-visits` FACILITY granted per role in role_pages, not a role.
    roles: text('roles').array().notNull().default(sql`'{employee}'`),
    isActive: boolean('is_active').notNull().default(true),
    // LKSGuard (#6): an account still on its initial default password is forced
    // through a change on first LKSGuard sign-in. Defaults false so every
    // existing (attendance) row is unaffected — only the LKSGuard assignment
    // flow flips it true, and only LKSGuard's login handler reads it.
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    // Change Password: the instant this account's password last changed.
    // Mobile access tokens are non-expiring signed JWTs (see createUserToken in
    // app/auth/utils/token.ts), so deleting the client's copy does not revoke
    // them — the guard compares a token's `iat` against this and refuses anything
    // minted before the change. Left NULL by every row that predates the feature,
    // which the guard reads as "nothing to revoke yet": a migration therefore
    // cannot sign anybody out mid-shift.
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    // withTimezone, like every other table here. A bare `timestamp` column takes
    // the wall-clock reading and forgets which clock it came from: `now()` writes
    // UTC, node-postgres reads it back as local, and the row silently shifts by
    // the server's offset.
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
})

// ── role_pages ────────────────────────────────────────────────────────────────
// Which mobile-app pages each role may see. One row per role; `pages` holds
// page keys that both the server and the app agree on (see PAGE_REGISTRY in the
// app: 'home', 'profile', 'register-employee', …). The mobile app reads this at
// sign-in and builds its drawer from it, so granting or revoking a page for a
// role is a pure database change — no app release required. Roles with no row
// fall back to the server's built-in defaults.
export const rolePages = pgTable('role_pages', {
    id: uuid('id').primaryKey().defaultRandom(),

    role: varchar('role', { length: 30 }).notNull().unique(),

    pages: text('pages').array().notNull().default(sql`'{}'`),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
    roleIdx: uniqueIndex('role_pages_role_idx').on(table.role),
}))

// ── refresh_tokens ────────────────────────────────────────────────────────────
// Refresh-token rotation needs server-side state: on each refresh the presented
// token is revoked and a replacement issued, so a replayed token can be detected
// and rejected. Only the sha256 of the token is stored — a database leak alone
// does not yield usable credentials.
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    userId: uuid('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),

    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Lookup on refresh is by hash; revoke-all-for-user is by userId.
    tokenHashIdx: uniqueIndex('refresh_tokens_token_hash_idx').on(table.tokenHash),
    userIdx: index('refresh_tokens_user_idx').on(table.userId),
  })
);


// ── employees ─────────────────────────────────────────────────────────────────
export const employees = pgTable(
  'employees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id'),
    // Identity
    firstName:   varchar('first_name',  { length: 100 }).notNull(),
    lastName:    varchar('last_name',   { length: 100 }).notNull(),
    phone:       varchar('phone',       { length: 20  }).notNull().unique(),

    // Nullable: staff on the shop floor often have no work address, and phone is
    // the identifier everything else keys on. Unique all the same, so a typo that
    // duplicates a colleague's address is caught — Postgres treats NULLs as
    // distinct, so any number of employees without one still coexist.
    email:       varchar('email',       { length: 160 }).unique(),

    department:  varchar('department',  { length: 100 }),
    designation: varchar('designation', { length: 100 }),
 
    // Face biometrics — 128-d FaceNet descriptor from face-api.js
    imagePath:        varchar('image_path', { length: 255 }),
    faceEmbedding:     vector(512)('face_embedding'),
    hasRegisteredFace: boolean('has_registered_face').notNull().default(false),
    faceRegisteredAt:  timestamp('face_registered_at', { withTimezone: true }),
 
    // Meta
    isActive:  boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // ivfflat ANN index for cosine similarity search
    // Built in migration (see migrations below) — Drizzle can't express
    // WITH (lists=100) directly so we use a raw SQL index helper
    faceEmbeddingIdx: index('employees_face_embedding_idx').on(table.faceEmbedding),
 
    // Faster employee lookups
    phoneIdx:     uniqueIndex('employees_phone_idx').on(table.phone),
    isActiveIdx:  index('employees_is_active_idx').on(table.isActive),
  })
);

// ── password_reset_requests ──────────────────────────────────────────────────
// Forgot-password, handled by a human instead of an OTP. An employee who cannot
// sign in asks for a reset; an admin reviews the ask in the web panel and sets
// the account back to the temporary password. Nothing here is a credential: no
// token, no hash, no password — the request is only a queue entry plus its audit
// trail, so a leak of this table buys an attacker nothing.
//
// `processedBy` and `processedAt` are the audit trail ("who reset whose password,
// when"). Rows are never deleted: a processed request stays as history, which is
// what lets the partial unique index below allow a fresh request later.
export const passwordResetRequests = pgTable(
  'password_reset_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // The login account being reset. Cascade: the request is meaningless once the
    // account is gone.
    userId: uuid('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),

    // Denormalised for the admin table, which shows the employee id, name and
    // designation without joining through the login row.
    // Set null (not cascade) so the history survives an employee being removed
    // while their login row lingers.
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'set null' }),

    // 'PENDING' | 'APPROVED' | 'COMPLETED' | 'REJECTED'. APPROVED is reserved: in
    // this workflow approving IS the reset, which lands the row on COMPLETED, so
    // nothing writes APPROVED today. It is allowed by the CHECK so a future
    // two-step approve-then-reset needs no migration.
    status: varchar('status', { length: 12 }).notNull().default('PENDING'),

    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),

    processedAt: timestamp('processed_at', { withTimezone: true }),

    // Admin who acted. Set null rather than cascade: the audit trail must outlive
    // the admin account, and a removed admin is still who did it.
    processedBy: uuid('processed_by').references(() => usersTable.id, { onDelete: 'set null' }),

    // Optional admin note. A rejection writes the admin's reason here; a reset
    // leaves it alone, because its audit facts are processedBy and processedAt.
    remarks: text('remarks'),
  },
  (table) => ({
    userIdx: index('password_reset_requests_user_idx').on(table.userId),
    statusIdx: index('password_reset_requests_status_idx').on(table.status),
    requestedAtIdx: index('password_reset_requests_requested_at_idx').on(table.requestedAt),

    // One live request per account. Partial so a completed/rejected history does
    // not block a later ask, and unique so two handsets tapping "send request"
    // simultaneously cannot both land a row — the 409 guard in the handler is
    // this index, not a read-then-insert check (same trick as the site-location
    // PENDING queue above).
    onePendingPerUser: uniqueIndex('password_reset_requests_pending_idx')
      .on(table.userId)
      .where(sql`${table.status} = 'PENDING'`),

    statusValid: check(
      'password_reset_requests_status_valid',
      sql`${table.status} IN ('PENDING','APPROVED','COMPLETED','REJECTED')`
    ),
  })
);
 
// ── attendance_logs ───────────────────────────────────────────────────────────
// Extended for Supervisor → Employees Attendance (no second table):
// supervisor punch attribution, capture method, manual photo and the logical
// attendance day. `attendanceDate` is the day the Supervisor selected in the
// UI; `createdAt` stays the DB clock (insert time via the BullMQ worker).
// Older rows predate the column — readers fall back to DATE(created_at).
export const attendanceLogs = pgTable(
  'attendance_logs',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    employeeId:   uuid('employee_id')
                    .notNull()
                    .references(() => employees.id, { onDelete: 'cascade' }),

    // 'check-in' | 'check-out'
    action:       varchar('action', { length: 10 }).notNull(),

    // The site the punch was made at — not the parent location. A location can
    // span several sites kilometres apart, so only the site identifies where the
    // employee actually stood. The parent location is reachable via sites.locationId.
    siteId: uuid('site_id')
      .references(() => sites.id),

    // Supervisor who recorded this punch (null for self punches).
    supervisorId: uuid('supervisor_id')
      .references(() => usersTable.id, { onDelete: 'set null' }),

    // How the check-in frame was captured: 'biometric' (face-verified) | 'manual' (camera photo).
    // Null on legacy self-punch rows — readers treat null as 'biometric'.
    attendanceMethod: varchar('attendance_method', { length: 10 }),

    // Legacy manual-capture photo, e.g. "attendance-images/EMP_<uuid>_20260916_084530_<rand>.jpg".
    // Null for biometric punches, and null for manual punches too — the supervisor
    // flow is image-free now, so the row is justified by `supervisorId` + session.
    imagePath: varchar('image_path', { length: 500 }),

    // One-line signature of the handset that recorded the punch (brand +
    // model + OS + app version), sent by the mobile app as `device`. Answers
    // "from which mobile was this attendance given". Supervisor punches carry
    // the supervisor's device. Null on legacy rows and when the app sent
    // nothing — reports render those as "—".
    deviceInfo: varchar('device_info', { length: 200 }),

    // How a duty was ENDED, recorded only on the check-out row. NULL means the
    // employee (or a supervisor) punched it: the historical behaviour and still
    // the overwhelming majority. 'auto_checkout' is written by the 23:59 IST
    // end-of-day sweep in services/autoCheckout.ts for a day left open when the
    // employee never checked out — same vocabulary as tracking_sessions
    // .checkout_type, so a report can tell a real midnight departure from a
    // closed-by-server one instead of reading an inflated duty length as honest
    // overtime.
    checkoutType: varchar('checkout_type', { length: 16 }),

    // Incomplete closure (supervisor marked PRESENT attendance closed because the
    // employee left before checkout). Set ONLY on the day's check-in row;
    // check_out stays NULL so INCOMPLETE is never confused with a real checkout.
    // No separate attendance_status column on purpose: status is derived
    // (no check-in → ABSENT; check-in + incomplete_reason → INCOMPLETE;
    // check-in + check-out → COMPLETED; check-in only → PRESENT), keeping one
    // source of truth that also covers legacy rows.
    incompleteReason: text('incomplete_reason'),
    incompleteAt: timestamp('incomplete_at', { withTimezone: true }),
    incompleteBy: uuid('incomplete_by')
      .references(() => usersTable.id, { onDelete: 'set null' }),

    // Logical attendance day (YYYY-MM-DD). Defaults to CURRENT_DATE so the
    // worker can omit it for self punches; supervisor flows set it explicitly
    // from the selected day filter.
    attendanceDate: date('attendance_date').default(sql`CURRENT_DATE`),

    // Cosine distance at time of scan — useful for audit / threshold tuning
    faceDistance: numeric('face_distance', { precision: 6, scale: 4 }),

    // Optional: store geo coords for server-side geo-fence audit
    geoLat: numeric('geo_lat', { precision: 10, scale: 7 }),
    geoLng: numeric('geo_lng', { precision: 10, scale: 7 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Primary query pattern: employee + date range
    employeeDateIdx: index('att_logs_employee_date_idx').on(
      table.employeeId,
      table.createdAt
    ),
    // Reports by date
    dateIdx: index('att_logs_date_idx').on(table.createdAt),
    // Filter by action
    actionIdx: index('att_logs_action_idx').on(table.action),
    // Supervisor team day-filter: employee + logical day
    employeeAttDateIdx: index('att_logs_employee_attdate_idx').on(
      table.employeeId,
      table.attendanceDate
    ),
    // Web shift-attendance report: all punches for one logical day at a set of
    // sites (DATE + site filter across every employee). Justified by that new
    // query pattern; roster lookups keep using employee_sites_site_idx.
    attDateSiteIdx: index('att_logs_attdate_site_idx').on(
      table.attendanceDate,
      table.siteId
    ),
    supervisorIdx: index('att_logs_supervisor_idx').on(table.supervisorId),
    // Duplicate protection at the source of truth: one check-in and one
    // check-out per employee + logical day + site. Partial (per-action) rather
    // than a whole-row UNIQUE so the check-in/check-out PAIR can coexist.
    // Redis checkin/checkout locks are only the fast path; this is the guarantee.
    // (site_id is always set on supervisor punches; legacy NULL-site self
    // punches keep PG's NULL-distinct behaviour and are unaffected.)
    checkinOnceIdx: uniqueIndex('att_logs_checkin_once_idx')
      .on(table.employeeId, table.attendanceDate, table.siteId)
      .where(sql`${table.action} = 'check-in'`),
    checkoutOnceIdx: uniqueIndex('att_logs_checkout_once_idx')
      .on(table.employeeId, table.attendanceDate, table.siteId)
      .where(sql`${table.action} = 'check-out'`),
  })
);

// ── client_locations ──────────────────────────────────────────────────────────
// A location is an organisational bucket — a client, a city, a branch — that
// groups the sites beneath it. It deliberately carries NO coordinates: a location
// can span several sites kilometres apart, so a single lat/lng for it would be
// meaningless and, worse, ambiguous about which one a geofence check should use.
// The geofence lives on `sites`, which is the only place it exists.
export const clientLocations = pgTable(
  'client_locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    locationName: varchar('location_name', {
      length: 200,
    }).notNull(),

    // Free-form context for the back office; not used in any check.
    city: varchar('city', { length: 120 }),
    siteCode: varchar('site_code', { length: 50 }),
    address: text('address'),

    isActive: boolean('is_active')
      .notNull()
      .default(true),

    // withTimezone for the same reason as users: a bare timestamp column stores
    // a reading with no clock attached and drifts by the server's offset.
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    // The create endpoint already rejects duplicate names; enforcing it here
    // means a race between two concurrent creates can't slip one through.
    locationNameIdx: uniqueIndex('client_locations_name_idx').on(table.locationName),
  })
);

// ── sites ─────────────────────────────────────────────────────────────────────
// Where employees actually work, and the unit the geofence is defined on.
export const sites = pgTable(
  'sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    locationId: uuid('location_id')
      .references(() => clientLocations.id, { onDelete: 'cascade' })
      .notNull(),

    siteName: varchar('site_name', { length: 200 }).notNull(),
    // Optional short identifier the client already uses on their own paperwork.
    siteCode: varchar('site_code', { length: 50 }),
    address: text('address'),

    // Same precision as attendance_logs.geo_lat/geo_lng so a distance comparison
    // never has to round one side. 7 decimal places is ~1 cm — far finer than any
    // phone GPS fix, and the smallest radius worth setting is metres.
    latitude: numeric('latitude', { precision: 10, scale: 7 }).notNull(),
    longitude: numeric('longitude', { precision: 10, scale: 7 }).notNull(),

    // notNull with a default, unlike the old nullable column: a site without a
    // radius cannot be geofenced at all, and silently treating null as "no limit"
    // would let anyone punch in from anywhere.
    allowedRadiusMeters: numeric('allowed_radius_meters', {
      precision: 8,
      scale: 2,
    })
      .notNull()
      .default('100'),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    // Names only have to be unique within their location — two clients may both
    // have a "Gate 2".
    locationSiteIdx: uniqueIndex('sites_location_name_idx').on(
      table.locationId,
      table.siteName
    ),
    locationIdx: index('sites_location_idx').on(table.locationId),
    isActiveIdx: index('sites_is_active_idx').on(table.isActive),

    // Coordinates swapped into the wrong columns is the classic bug here, and it
    // stays invisible until someone can't check in. Longitude beyond ±90 is the
    // one case the database itself can catch.
    latRange: check('sites_lat_range', sql`${table.latitude} BETWEEN -90 AND 90`),
    lngRange: check('sites_lng_range', sql`${table.longitude} BETWEEN -180 AND 180`),
    radiusPositive: check('sites_radius_positive', sql`${table.allowedRadiusMeters} > 0`),
  })
);

// ── employee_sites ────────────────────────────────────────────────────────────
// Which sites an employee may check in at. Assignment is per-site, not per-
// location: being posted to a client's head office should not authorise a punch
// at their warehouse across town.
export const employeeSites = pgTable(
  'employee_sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    employeeId: uuid('employee_id')
      .references(() => employees.id, {
        onDelete: 'cascade',
      })
      .notNull(),

    siteId: uuid('site_id')
      .references(() => sites.id, {
        onDelete: 'cascade',
      })
      .notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The assign endpoint checks for an existing pair first; this closes the same
    // race the location-name index does.
    pairIdx: uniqueIndex('employee_sites_pair_idx').on(table.employeeId, table.siteId),
    // "who works at this site" — the reverse of the pair index, which can't serve it.
    siteIdx: index('employee_sites_site_idx').on(table.siteId),
  })
);

// ── report_submissions ────────────────────────────────────────────────────────
// One row per report a collector submits. The document is optional — a visit can
// be reported as notes only — and the face-auth distance is captured so a
// supervisor can spot submissions where the face match was poor.
export const reportSubmissions = pgTable(
  'report_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),

    // Path relative to the server's uploads root (e.g. "reports/uuid.pdf").
    // Null when the collector submitted notes without a document.
    filePath: varchar('file_path', { length: 500 }),
    originalName: varchar('original_name', { length: 255 }),
    description: text('description'),
    // GPS recorded on the device at the moment of submission.
    geoLat: numeric('geo_lat', { precision: 10, scale: 7 }),
    geoLng: numeric('geo_lng', { precision: 10, scale: 7 }),

    // Cosine distance from the face-auth step — audit trail, not a gate.
    faceDistance: numeric('face_distance', { precision: 6, scale: 4 }),

    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    employeeIdx: index('report_submissions_employee_idx').on(table.employeeId),
    dateIdx:     index('report_submissions_date_idx').on(table.submittedAt),
  })
);

// ── app_settings ─────────────────────────────────────────────────────────────
// Key/value store for runtime-configurable behaviour. Read by the mobile app
// through GET /auth/fo/config so a change to the tracking interval is a
// database edit, not an app release.
export const appSettings = pgTable('app_settings', {
    key: varchar('key', { length: 100 }).primaryKey(),
    value: text('value'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── field_officer_sites ──────────────────────────────────────────────────────
// Which client sites a Field Officer is posted to. Deliberately separate from
// `employee_sites`: an FO visits many sites in a day without any geofence
// punch, so conflating the two tables would change the meaning of the geofence
// assignment for regular employees.
export const fieldOfficerSites = pgTable(
    'field_officer_sites',
    {
        id: uuid('id').primaryKey().defaultRandom(),

        // The user account carrying the 'field_officer' role.
        fieldOfficerUserId: uuid('field_officer_user_id')
            .notNull()
            .references(() => usersTable.id, { onDelete: 'cascade' }),

        siteId: uuid('site_id')
            .notNull()
            .references(() => sites.id, { onDelete: 'cascade' }),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
        // One row per officer-site pair; the assign flow also checks for an
        // existing pair first, this closes the concurrent-insert race.
        pairIdx: uniqueIndex('field_officer_sites_pair_idx').on(
            table.fieldOfficerUserId,
            table.siteId
        ),
        officerIdx: index('field_officer_sites_officer_idx').on(table.fieldOfficerUserId),
        siteIdx: index('field_officer_sites_site_idx').on(table.siteId),
    })
);

// ── co_fo_assignments ────────────────────────────────────────────────────────
// Which Field Officers report to which Circle Officer. The CO's attendance
// visibility is derived entirely from this list plus the existing relationships
// (FO → field_officer_sites → employee_sites → attendance), so no site or
// employee is ever assigned to a CO directly — that would duplicate
// `field_officer_sites`, which is already the posting table.
//
// History is kept in the table itself: a removal or a reassignment stamps
// `removedAt` and clears `isActive` on the old row, and the new CO gets a fresh
// row. Nothing is deleted, so "who reported to whom on date X" stays answerable
// and an FO's attendance history is untouched by any re-posting (§7).
//
// Keyed by USER id, not employee id, exactly like `field_officer_sites`: the
// officer roles hang off the login account (`users.roles`), and the reports scope
// on the account that signed in.
export const coFoAssignments = pgTable(
    'co_fo_assignments',
    {
        id: uuid('id').primaryKey().defaultRandom(),

        // The user account carrying the 'co' role.
        coUserId: uuid('co_user_id')
            .notNull()
            .references(() => usersTable.id, { onDelete: 'cascade' }),

        // The user account carrying the 'field_officer' role.
        foUserId: uuid('fo_user_id')
            .notNull()
            .references(() => usersTable.id, { onDelete: 'cascade' }),

        // Admin who made the assignment ("who assigned whom" audit). Set null
        // rather than cascade: an admin account being removed must not silently
        // erase the hierarchy it created.
        assignedBy: uuid('assigned_by')
            .references(() => usersTable.id, { onDelete: 'set null' }),

        assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
        removedAt: timestamp('removed_at', { withTimezone: true }),

        // Current membership flag. Kept as a real column (not derived from
        // removedAt) because every scope query filters on it and the two partial
        // unique indexes below can only be expressed over a plain boolean.
        isActive: boolean('is_active').notNull().default(true),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => ({
        // "One CO must not hold the same FO twice" and "one FO may answer to only
        // one CO at a time", both over the ACTIVE rows only — history rows are
        // what lets the same pair be assigned again later. A partial unique index
        // is the only thing that can express that: the application checks first
        // (for a readable 409), this closes the race between two admins.
        activePairIdx: uniqueIndex('co_fo_assignments_active_pair_idx').on(
            table.coUserId,
            table.foUserId
        ).where(sql`${table.isActive} = true`),
        activeFoIdx: uniqueIndex('co_fo_assignments_active_fo_idx')
            .on(table.foUserId)
            .where(sql`${table.isActive} = true`),

        // The two directions the scope is resolved in: "this CO's FOs" on every
        // CO report read, and "this FO's current CO" in the assignment picker.
        coIdx: index('co_fo_assignments_co_idx').on(table.coUserId),
        foIdx: index('co_fo_assignments_fo_idx').on(table.foUserId),

        // An FO who is also a CO must not be put under himself — the hierarchy
        // would resolve to a cycle of one and every scope query would happily
        // accept it.
        notSelf: check('co_fo_assignments_not_self', sql`${table.coUserId} <> ${table.foUserId}`),
        // Consistency of the two liveness fields, which are always written
        // together: an active row has no end, and a closed row has one.
        activeNoEnd: check(
            'co_fo_assignments_active_no_end',
            sql`(${table.isActive} = true AND ${table.removedAt} IS NULL) OR (${table.isActive} = false AND ${table.removedAt} IS NOT NULL)`
        ),
    })
);

// ── visits ───────────────────────────────────────────────────────────────────
// One Field Officer session at one client site: check-in, check-out, and the
// captured coordinates for both ends. Location points collected during the
// visit live in visit_location_points, keyed by visit id.
export const visits = pgTable(
    'visits',
    {
        id: uuid('id').primaryKey().defaultRandom(),

        fieldOfficerUserId: uuid('field_officer_user_id')
            .notNull()
            .references(() => usersTable.id, { onDelete: 'cascade' }),

        siteId: uuid('site_id')
            .notNull()
            .references(() => sites.id, { onDelete: 'cascade' }),

        // Server-side timestamps (defaultNow) — the device clock is never
        // trusted for the authoritative start/end of a visit.
        checkInAt: timestamp('check_in_at', { withTimezone: true })
            .notNull()
            .defaultNow(),

        checkInLatitude: numeric('check_in_latitude', { precision: 10, scale: 7 }),
        checkInLongitude: numeric('check_in_longitude', { precision: 10, scale: 7 }),

        checkOutAt: timestamp('check_out_at', { withTimezone: true }),
        checkOutLatitude: numeric('check_out_latitude', { precision: 10, scale: 7 }),
        checkOutLongitude: numeric('check_out_longitude', { precision: 10, scale: 7 }),

        // The tracking session this visit was auto-detected in. Null for rows
        // from the legacy manual check-in/out flow, which had no session.
        trackingSessionId: uuid('tracking_session_id')
            .references(() => trackingSessions.id, { onDelete: 'cascade' }),

        // How each boundary was established: 'face' (manual, face-verified) or
        // 'gps' (auto-detected by the geofence engine). Null on legacy rows.
        checkInSource: varchar('check_in_source', { length: 8 }),
        checkOutSource: varchar('check_out_source', { length: 8 }),

        // GPS accuracy (metres) of the fixes that opened/closed the visit.
        checkInAccuracy: numeric('check_in_accuracy', { precision: 8, scale: 2 }),
        checkOutAccuracy: numeric('check_out_accuracy', { precision: 8, scale: 2 }),

        // Exit honesty for 5-minute sampling: the last fix seen INSIDE the
        // fence and the first fix seen OUTSIDE it. The checkout stamp uses the
        // first-outside observation — never a fabricated in-between time.
        lastInsideAt: timestamp('last_inside_at', { withTimezone: true }),
        firstOutsideAt: timestamp('first_outside_at', { withTimezone: true }),

        // 'active' | 'completed'
        status: varchar('status', { length: 12 }).notNull().default('active'),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => ({
        // The OH dashboard's primary query: one officer's visits on a day.
        officerDateIdx: index('visits_officer_checkin_idx').on(
            table.fieldOfficerUserId,
            table.checkInAt
        ),
        siteIdx: index('visits_site_idx').on(table.siteId),
        statusIdx: index('visits_status_idx').on(table.status),
        sessionIdx: index('visits_session_idx').on(table.trackingSessionId),

        // Rule 2 of the backend contract: no more than one active visit per
        // Field Officer. A partial unique index enforces it even if two
        // check-in requests race past the application-level check.
        oneActivePerOfficer: uniqueIndex('visits_one_active_per_officer_idx')
            .on(table.fieldOfficerUserId)
            .where(sql`${table.status} = 'active'`),

        statusValid: check('visits_status_valid', sql`${table.status} IN ('active', 'completed')`),
    })
);

// ── visit_location_points ────────────────────────────────────────────────────
// GPS breadcrumbs uploaded roughly every 5 minutes while a visit is active.
// `recorded_at` is the device clock at capture (offline queuing means it can
// reach the server late); `created_at` is the server clock at ingest. Accuracy
// is stored so bad fixes can be filtered or flagged later.
export const visitLocationPoints = pgTable(
    'visit_location_points',
    {
        id: uuid('id').primaryKey().defaultRandom(),

        // The session this point was recorded in. The permanent home of every
        // fix — including travel fixes between sites, which belong to no visit.
        trackingSessionId: uuid('tracking_session_id')
            .references(() => trackingSessions.id, { onDelete: 'cascade' }),

        // The site visit active when the fix arrived, if any. Nullable: fixes
        // recorded while travelling between sites belong to the session only.
        // (Relaxed from NOT NULL when sessions arrived; legacy rows always
        // carry a visit.)
        visitId: uuid('visit_id')
            .references(() => visits.id, { onDelete: 'cascade' }),

        // Denormalised for cheap per-officer queries and tamper-evident audit.
        fieldOfficerUserId: uuid('field_officer_user_id')
            .notNull()
            .references(() => usersTable.id, { onDelete: 'cascade' }),

        // Nullable: travel fixes recorded between site visits belong to the
        // session, not to any site.
        siteId: uuid('site_id')
            .references(() => sites.id, { onDelete: 'cascade' }),

        latitude: numeric('latitude', { precision: 10, scale: 7 }).notNull(),
        longitude: numeric('longitude', { precision: 10, scale: 7 }).notNull(),

        // Metres, as reported by the phone's GPS. Nullable: a fix without an
        // accuracy figure is still worth keeping, just flagged.
        accuracy: numeric('accuracy', { precision: 8, scale: 2 }),
        speed: numeric('speed', { precision: 8, scale: 2 }),          // m/s, optional
        batteryLevel: numeric('battery_level', { precision: 5, scale: 2 }), // 0–100, optional
        heading: numeric('heading', { precision: 6, scale: 2 }),      // degrees 0–360, optional

        recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

        // Client-generated idempotency key — retries after a timeout or a
        // replayed batch never double-insert.
        clientUuid: varchar('client_uuid', { length: 36 }).notNull(),
    },
    (table) => ({
        // Dedup at the database level, matching the app's idempotent uploads.
        dedupIdx: uniqueIndex('visit_points_dedup_idx').on(table.visitId, table.clientUuid),
        // Session-grain dedup: travel points carry no visit, so the session
        // pair is what keeps a retried batch from double-storing.
        sessionDedupIdx: uniqueIndex('visit_points_session_dedup_idx').on(
            table.trackingSessionId,
            table.clientUuid
        ),
        // Drawing the polyline: every point of a visit in chronological order.
        visitOrderIdx: index('visit_points_visit_recorded_idx').on(table.visitId, table.recordedAt),
        // Session route: every point of a tracking session in order.
        sessionOrderIdx: index('visit_points_session_recorded_idx').on(
            table.trackingSessionId,
            table.recordedAt
        ),
        officerIdx: index('visit_points_officer_idx').on(table.fieldOfficerUserId),
        latRange: check('visit_points_lat_range', sql`${table.latitude} BETWEEN -90 AND 90`),
        lngRange: check('visit_points_lng_range', sql`${table.longitude} BETWEEN -180 AND 180`),
    })
);

// ── tracking_sessions ───────────────────────────────────────────────────────
// One Field Officer working session: opened by Face Check-In, closed by Face
// Check-Out. While it is active the server auto-detects site entries/exits
// from the ~5-minute GPS stream and records them as `visits` rows linked
// here — the officer never checks in/out per site by hand.
export const trackingSessions = pgTable(
    'tracking_sessions',
    {
        id: uuid('id').primaryKey().defaultRandom(),

        fieldOfficerUserId: uuid('field_officer_user_id')
            .notNull()
            .references(() => usersTable.id, { onDelete: 'cascade' }),

        // Face-verified session boundaries. Server clock (defaultNow), never
        // the device clock.
        faceCheckInAt: timestamp('face_check_in_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        faceCheckInLatitude: numeric('face_check_in_latitude', { precision: 10, scale: 7 }),
        faceCheckInLongitude: numeric('face_check_in_longitude', { precision: 10, scale: 7 }),
        faceCheckInAccuracy: numeric('face_check_in_accuracy', { precision: 8, scale: 2 }),

        faceCheckOutAt: timestamp('face_check_out_at', { withTimezone: true }),
        faceCheckOutLatitude: numeric('face_check_out_latitude', { precision: 10, scale: 7 }),
        faceCheckOutLongitude: numeric('face_check_out_longitude', { precision: 10, scale: 7 }),
        faceCheckOutAccuracy: numeric('face_check_out_accuracy', { precision: 8, scale: 2 }),

        // How the session ended: 'face' (officer face-checked out on the
        // phone) or 'auto_max_duty' (the server-side 10-hour sweeper closed
        // it). Null while the session is still active.
        checkoutType: varchar('checkout_type', { length: 16 }),

        // 'active' | 'completed'
        status: varchar('status', { length: 12 }).notNull().default('active'),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => ({
        // The OH timeline query: one officer's sessions on a day.
        officerDateIdx: index('tracking_sessions_officer_checkin_idx').on(
            table.fieldOfficerUserId,
            table.faceCheckInAt
        ),
        statusIdx: index('tracking_sessions_status_idx').on(table.status),

        // One open session per officer — the partial unique index turns any
        // double-start race into a constraint error the API maps to 409.
        oneActivePerOfficer: uniqueIndex('tracking_sessions_one_active_idx')
            .on(table.fieldOfficerUserId)
            .where(sql`${table.status} = 'active'`),
        statusValid: check(
            'tracking_sessions_status_valid',
            sql`${table.status} IN ('active', 'completed')`
        ),
    })
);

// ── fo_visit_events ────────────────────────────────────────────────────────
// Append-only audit trail for the Field Officer visit lifecycle. One row per
// state transition — never updated, never deleted. The OH panel can replay a
// session's story from here without inferring it from point/visit rows.
//
// Event types:
//   CHECK_IN               — Face Check-In opened a tracking session
//   SITE_ENTRY             — geofence engine opened a site visit (auto)
//   SITE_EXIT              — geofence engine closed a site visit (auto)
//   CHECK_OUT              — Face Check-Out closed the session (manual)
//   AUTO_MAX_DUTY_CHECKOUT — 10-hour server sweeper closed the session
// (LOCATION_TRACKED is deliberately NOT logged here — at one row per ~5-min
// fix it would be pure noise; the points table is that record.)
export const foVisitEvents = pgTable(
    'fo_visit_events',
    {
        id: uuid('id').primaryKey().defaultRandom(),

        trackingSessionId: uuid('tracking_session_id')
            .references(() => trackingSessions.id, { onDelete: 'cascade' }),

        visitId: uuid('visit_id')
            .references(() => visits.id, { onDelete: 'cascade' }),

        fieldOfficerUserId: uuid('field_officer_user_id')
            .notNull()
            .references(() => usersTable.id, { onDelete: 'cascade' }),

        eventType: varchar('event_type', { length: 24 }).notNull(),

        latitude: numeric('latitude', { precision: 10, scale: 7 }),
        longitude: numeric('longitude', { precision: 10, scale: 7 }),

        // When the event happened (observation time for GPS-derived events,
        // server time for session boundaries).
        eventTime: timestamp('event_time', { withTimezone: true }).notNull().defaultNow(),

        // Free-form context: { siteId, siteName, source, reason, ... }.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: customType<{ data: any; driverData: string }>({
            dataType() { return 'jsonb'; },
            toDriver(value: any): string { return JSON.stringify(value); },
            fromDriver(value: string): any {
                try { return typeof value === 'string' ? JSON.parse(value) : value; }
                catch { return value; }
            },
        })('metadata'),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
        sessionIdx: index('fo_visit_events_session_idx').on(table.trackingSessionId),
        officerTimeIdx: index('fo_visit_events_officer_time_idx').on(
            table.fieldOfficerUserId,
            table.eventTime
        ),
        typeIdx: index('fo_visit_events_type_idx').on(table.eventType),
    })
);

// ── shift_attendance ────────────────────────────────────────────────────────
// Group/shift summary submitted by a Supervisor: one row per site + date +
// shift (enforced by unique index). Separate from attendance_logs (individual
// punches) — reuses sites/users for assignment, stores only the group photo
// path (files under shift-attendance-images/, never binary in PG).
export const shiftAttendance = pgTable(
  'shift_attendance',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),

    supervisorId: uuid('supervisor_id')
      .references(() => usersTable.id, { onDelete: 'set null' }),

    // Logical day; server default CURRENT_DATE (authoritative, not device clock).
    attendanceDate: date('attendance_date').notNull().default(sql`CURRENT_DATE`),

    // Controlled vocabulary only: morning | day | night | general.
    shift: varchar('shift', { length: 10 }).notNull(),

    presentEmployees: integer('present_employees').notNull(),

    description: text('description'),

    // DB-relative group photo, e.g. "shift-attendance-images/<site>_20260916_morning_<rand>.jpg".
    imagePath: varchar('image_path', { length: 500 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => ({
    // Business rule: one submission per site/date/shift (PG is the ultimate
    // duplicate guard; Redis lock is only the fast-path for double-taps).
    siteDateShiftUnique: uniqueIndex('shift_attendance_site_date_shift_idx').on(
      table.siteId,
      table.attendanceDate,
      table.shift,
    ),
    siteDateIdx: index('shift_attendance_site_date_idx').on(table.siteId, table.attendanceDate),
    supervisorIdx: index('shift_attendance_supervisor_idx').on(table.supervisorId),
    shiftValid: check('shift_attendance_shift_valid', sql`${table.shift} IN ('morning','day','night','general')`),
    presentValid: check('shift_attendance_present_valid', sql`${table.presentEmployees} > 0 AND ${table.presentEmployees} <= 5000`),
  })
);

// ── employee_violations ─────────────────────────────────────────────────────
// Supervisor-reported conduct observations. Pure record-keeping: creating a row
// takes NO disciplinary action (no suspension/termination/salary/status change
// anywhere in the codebase reads this table for enforcement). Immutability is
// by design — there are no update/delete endpoints; later review workflows
// should add their own audited tables rather than mutating history.
export const employeeViolations = pgTable(
  'employee_violations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),

    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),

    // Reporting supervisor (server session, never client-supplied). Set null
    // keeps history if the supervisor's login is ever removed.
    supervisorId: uuid('supervisor_id')
      .references(() => usersTable.id, { onDelete: 'set null' }),

    // Controlled vocabulary (see VIOLATION_TYPES in auth/controller.ts, which
    // mirrors this list). Neutral "violation/observation" wording only.
    violationType: varchar('violation_type', { length: 40 }).notNull(),

    reason: text('reason').notNull(),

    // Optional evidence photo attached by the reporting supervisor. Stored on
    // disk like every other capture (violation-evidence-images/); only the
    // DB-relative path lives here. Null when no photo was attached.
    evidenceImagePath: varchar('evidence_image_path', { length: 500 }),

    // Logical day, server clock (CURRENT_DATE default — never the device clock).
    violationDate: date('violation_date').notNull().default(sql`CURRENT_DATE`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => ({
    siteDateIdx: index('violations_site_date_idx').on(table.siteId, table.violationDate),
    employeeIdx: index('violations_employee_idx').on(table.employeeId),
    supervisorIdx: index('violations_supervisor_idx').on(table.supervisorId),
    typeValid: check(
      'violations_type_valid',
      sql`${table.violationType} IN ('late_arrival','unauthorized_absence','leaving_duty_post','leaving_site_without_permission','sleeping_during_duty','negligence_of_duty','failure_security_procedure','failure_vigilance','failure_patrol','failure_register_log','unauthorized_visitor_handling','improper_uniform_id','inappropriate_conduct','violation_client_site_rules','unauthorized_access','improper_handling_property','equipment_misuse','failure_report_incident','other')`
    ),
  })
);

// ── site_location_submissions ────────────────────────────────────────────────
// A Site Manager submits the live GPS of a site they are posted to; an admin
// approves or rejects it. The submission is the PENDING proposal — the site's
// own latitude/longitude are only rewritten when it is APPROVED, so the official
// geofence never moves until review. Every row is kept (approved, rejected and
// pending alike) as the audit trail: who submitted, who reviewed, the previous
// and the newly-applied coordinates, and the rejection reason.
export const siteLocationSubmissions = pgTable(
  'site_location_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    clientLocationId: uuid('client_location_id')
      .notNull()
      .references(() => clientLocations.id, { onDelete: 'cascade' }),

    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),

    // The user account carrying the 'site_manager' role. `set null` keeps the
    // history readable if that login is ever removed.
    submittedBy: uuid('submitted_by')
      .references(() => usersTable.id, { onDelete: 'set null' }),

    // The proposed coordinates (numeric precision mirrors `sites` exactly so a
    // comparison never has to round one side).
    latitude: numeric('latitude', { precision: 10, scale: 7 }).notNull(),
    longitude: numeric('longitude', { precision: 10, scale: 7 }).notNull(),
    // GPS accuracy in metres at capture — nullable (older devices / no fix).
    accuracy: numeric('accuracy', { precision: 8, scale: 2 }),

    // Site coordinates immediately before THIS approval — for the audit trail.
    // Null on pending/rejected rows and on approvals where nothing was captured.
    previousLatitude: numeric('previous_latitude', { precision: 10, scale: 7 }),
    previousLongitude: numeric('previous_longitude', { precision: 10, scale: 7 }),

    // 'PENDING' | 'APPROVED' | 'REJECTED'
    status: varchar('status', { length: 12 }).notNull().default('PENDING'),

    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),

    // Reviewing admin + moment. Rejection reason required only when REJECTED
    // (enforced in the controller, not a CHECK, so approved rows keep it null).
    reviewedBy: uuid('reviewed_by').references(() => usersTable.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
  },
  (table) => ({
    siteIdx: index('site_location_submissions_site_idx').on(table.siteId),
    statusIdx: index('site_location_submissions_status_idx').on(table.status),
    submittedByIdx: index('site_location_submissions_submitter_idx').on(table.submittedBy),
    submittedAtIdx: index('site_location_submissions_submitted_at_idx').on(table.submittedAt),

    // Requirement 9: at most one PENDING proposal per site. Partial and unique
    // so approved/rejected history can pile up while a fresh duplicate is
    // impossible even across concurrent inserts (the 409 guard is this index).
    onePendingPerSite: uniqueIndex('site_location_submissions_pending_idx')
      .on(table.siteId)
      .where(sql`${table.status} = 'PENDING'`),

    statusValid: check(
      'site_location_submissions_status_valid',
      sql`${table.status} IN ('PENDING','APPROVED','REJECTED')`
    ),
    latRange: check('site_location_submissions_lat_range', sql`${table.latitude} BETWEEN -90 AND 90`),
    lngRange: check('site_location_submissions_lng_range', sql`${table.longitude} BETWEEN -180 AND 180`),
  })
);

// ══════════════════════════════════════════════════════════════════════════════
// LKSGuard — company-device communication audit
// ──────────────────────────────────────────────────────────────────────────────
// Logically separated from the attendance tables but reusing `employees` and
// `usersTable` (never a duplicate employee table, #31). The server is the
// permanent source of truth (#17): a synced call/SMS/contact row stays after the
// employee deletes it on the handset. Every event stream keys idempotency on
// (deviceId, clientUuid) exactly like `visit_location_points`, so a retried sync
// batch can never double-store (#19).
// ── lksguard_devices ───────────────────────────────────────────────────────────
// One row per installed LKSGuard handset. `deviceId` is the stable, client-
// generated install id (not an IMEI — nothing requiring extra privileges); the
// server binds it to the employee who is currently assigned the device (#7).
// Permission flags are a last-seen snapshot the app refreshes on heartbeat (#27).
export const lksguardDevices = pgTable(
  'lksguard_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Stable per-install identifier the app generates once and persists in
    // SecureStorage. Unique — this is what a sync batch and heartbeat look up.
    deviceId: varchar('device_id', { length: 64 }).notNull().unique(),

    // The employee the device is CURRENTLY bound to. Nullable until an admin
    // assignment is claimed by a device; `set null` keeps the device row (and
    // its history) readable if the employee is removed — historical records
    // carry their own employeeId and are never rewritten (#22).
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'set null' }),

    phone: varchar('phone', { length: 20 }),
    deviceName: varchar('device_name', { length: 120 }),
    manufacturer: varchar('manufacturer', { length: 60 }),
    model: varchar('model', { length: 60 }),
    androidVersion: varchar('android_version', { length: 30 }),
    appVersion: varchar('app_version', { length: 30 }),

    // ACTIVE | BLOCKED | DEACTIVATED (#7/#21). A BLOCKED device's syncs are
    // rejected by the API; the CHECK keeps the vocabulary closed.
    status: varchar('status', { length: 12 }).notNull().default('ACTIVE'),

    // Permission snapshot (device-declared; advisory for the admin, not a gate).
    permCall: boolean('perm_call').notNull().default(false),
    permSms: boolean('perm_sms').notNull().default(false),
    permContacts: boolean('perm_contacts').notNull().default(false),

    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    deviceIdx: uniqueIndex('lksguard_devices_device_id_idx').on(table.deviceId),
    employeeStatusIdx: index('lksguard_devices_employee_status_idx').on(
      table.employeeId,
      table.status
    ),
    statusValid: check(
      'lksguard_devices_status_valid',
      sql`${table.status} IN ('ACTIVE','BLOCKED','DEACTIVATED')`
    ),
  })
);

// ── lksguard_employee_devices ──────────────────────────────────────────────────
// Assignment history (append-oriented, #22). Assigning writes an open row
// (unassignedAt null); reassigning closes the previous open row and opens a new
// one. Nothing here mutates historical call/SMS/contact rows, so those keep the
// employee who generated them. The "is this device currently assigned to this
// employee" check at device-register reads the open row.
export const lksguardEmployeeDevices = pgTable(
  'lksguard_employee_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),

    // Nullable: an admin authorises an employee BEFORE the handset has ever run
    // (the app mints its own install id on first launch). Such an assignment has
    // no device row yet; it becomes bound when handleRegisterDevice creates the
    // lksguardDevices row and back-fills this column.
    deviceRowId: uuid('device_row_id').references(() => lksguardDevices.id, {
      onDelete: 'cascade',
    }),

    // Admin user who made the assignment (audit + #23).
    assignedBy: uuid('assigned_by').references(() => usersTable.id, { onDelete: 'set null' }),

    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    // null = the assignment is currently open.
    unassignedAt: timestamp('unassigned_at', { withTimezone: true }),
  },
  (table) => ({
    deviceRowIdx: index('lksguard_emp_dev_device_idx').on(table.deviceRowId),
    employeeIdx: index('lksguard_emp_dev_employee_idx').on(table.employeeId),
  })
);

// ── lksguard_call_records ──────────────────────────────────────────────────────
export const lksguardCallRecords = pgTable(
  'lksguard_call_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Client-generated idempotency key (#19). Dedup is scoped to the device so
    // two phones could never collide on a reused uuid.
    eventUuid: varchar('event_uuid', { length: 36 }).notNull(),

    deviceId: varchar('device_id', { length: 64 }).notNull(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),

    phoneNumber: varchar('phone_number', { length: 20 }),
    // INCOMING | OUTGOING | MISSED (#10).
    callType: varchar('call_type', { length: 10 }).notNull(),

    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds').notNull().default(0),

    // Device clock at the call; serverReceivedAt is the ingest clock (#10).
    eventTime: timestamp('event_time', { withTimezone: true }).notNull(),
    serverReceivedAt: timestamp('server_received_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dedupIdx: uniqueIndex('lksguard_call_dedup_idx').on(table.deviceId, table.eventUuid),
    // Admin employee + date-range filter (#13/#33).
    employeeTimeIdx: index('lksguard_call_employee_time_idx').on(table.employeeId, table.eventTime),
    deviceIdx: index('lksguard_call_device_idx').on(table.deviceId),
    typeValid: check(
      'lksguard_call_type_valid',
      sql`${table.callType} IN ('INCOMING','OUTGOING','MISSED')`
    ),
  })
);

// ── lksguard_sms_records ───────────────────────────────────────────────────────
// Content is only present under the SMS_CONTENT policy and, even then, is stored
// AES-256-GCM encrypted (#11/#24). List responses never return the ciphertext —
// only an explicit, audited content-view endpoint decrypts it.
export const lksguardSmsRecords = pgTable(
  'lksguard_sms_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventUuid: varchar('event_uuid', { length: 36 }).notNull(),

    deviceId: varchar('device_id', { length: 64 }).notNull(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),

    phoneNumber: varchar('phone_number', { length: 20 }),
    // SENT | RECEIVED (#11).
    direction: varchar('direction', { length: 10 }).notNull(),
    messageTimestamp: timestamp('message_timestamp', { withTimezone: true }),

    // SMS_METADATA_ONLY | SMS_CONTENT — the policy in force when captured.
    policy: varchar('policy', { length: 20 }).notNull().default('SMS_METADATA_ONLY'),
    // Base64 ciphertext + IV; null for metadata-only rows.
    contentCipher: text('content_cipher'),
    contentIv: text('content_iv'),

    // Device clock at the message; serverReceivedAt is the ingest clock.
    messageTime: timestamp('message_time', { withTimezone: true }).notNull(),
    serverReceivedAt: timestamp('server_received_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dedupIdx: uniqueIndex('lksguard_sms_dedup_idx').on(table.deviceId, table.eventUuid),
    employeeTimeIdx: index('lksguard_sms_employee_time_idx').on(table.employeeId, table.messageTime),
    deviceIdx: index('lksguard_sms_device_idx').on(table.deviceId),
    directionValid: check('lksguard_sms_direction_valid', sql`${table.direction} IN ('SENT','RECEIVED')`),
    policyValid: check(
      'lksguard_sms_policy_valid',
      sql`${table.policy} IN ('SMS_METADATA_ONLY','SMS_CONTENT')`
    ),
  })
);

// ── lksguard_contacts ──────────────────────────────────────────────────────────
// Upserted on (deviceId, contactUuid): a re-sync updates the existing row rather
// than piling up duplicates (#12). Only the fields the policy needs are stored.
export const lksguardContacts = pgTable(
  'lksguard_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    deviceId: varchar('device_id', { length: 64 }).notNull(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),

    contactUuid: varchar('contact_uuid', { length: 64 }).notNull(),
    contactName: varchar('contact_name', { length: 200 }),
    phoneNumber: varchar('phone_number', { length: 20 }),
    email: varchar('email', { length: 160 }),

    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    dedupIdx: uniqueIndex('lksguard_contacts_dedup_idx').on(table.deviceId, table.contactUuid),
    employeeIdx: index('lksguard_contacts_employee_idx').on(table.employeeId),
    phoneIdx: index('lksguard_contacts_phone_idx').on(table.phoneNumber),
  })
);

// ── lksguard_audit_logs ────────────────────────────────────────────────────────
// Append-only record of sensitive admin actions (#23). Never updated or deleted
// from the app; retention is the only lifecycle (see lksguardRetention service).
export const lksguardAuditLogs = pgTable(
  'lksguard_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    adminUserId: uuid('admin_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    // Free-form controlled string, e.g. ASSIGN_DEVICE, BLOCK_DEVICE, VIEW_SMS_CONTENT.
    action: varchar('action', { length: 40 }).notNull(),
    resourceType: varchar('resource_type', { length: 30 }),
    resourceId: varchar('resource_id', { length: 64 }),

    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'set null' }),
    deviceId: varchar('device_id', { length: 64 }),
    ipAddress: varchar('ip_address', { length: 64 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    adminIdx: index('lksguard_audit_admin_idx').on(table.adminUserId),
    createdIdx: index('lksguard_audit_created_idx').on(table.createdAt),
    actionIdx: index('lksguard_audit_action_idx').on(table.action),
  })
);

// ── Type exports (inferred from schema) ──────────────────────────────────────export type Employee        = typeof employees.$inferSelect;
export type NewEmployee     = typeof employees.$inferInsert;
export type AttendanceLog   = typeof attendanceLogs.$inferSelect;
export type NewAttendanceLog = typeof attendanceLogs.$inferInsert;
export type ClientLocation  = typeof clientLocations.$inferSelect;
export type NewClientLocation = typeof clientLocations.$inferInsert;
export type Site            = typeof sites.$inferSelect;
export type NewSite         = typeof sites.$inferInsert;
export type EmployeeSite    = typeof employeeSites.$inferSelect;
export type RolePages       = typeof rolePages.$inferSelect;
export type ReportSubmission    = typeof reportSubmissions.$inferSelect;
export type NewReportSubmission = typeof reportSubmissions.$inferInsert;
export type Visit            = typeof visits.$inferSelect;
export type NewVisit         = typeof visits.$inferInsert;
export type TrackingSession    = typeof trackingSessions.$inferSelect;
export type NewTrackingSession = typeof trackingSessions.$inferInsert;
export type VisitLocationPoint    = typeof visitLocationPoints.$inferSelect;
export type NewVisitLocationPoint = typeof visitLocationPoints.$inferInsert;
export type FieldOfficerSite    = typeof fieldOfficerSites.$inferSelect;
export type NewFieldOfficerSite = typeof fieldOfficerSites.$inferInsert;
export type CoFoAssignment    = typeof coFoAssignments.$inferSelect;
export type NewCoFoAssignment = typeof coFoAssignments.$inferInsert;
export type AppSetting = typeof appSettings.$inferSelect;
export type FoVisitEvent = typeof foVisitEvents.$inferSelect;
export type NewFoVisitEvent = typeof foVisitEvents.$inferInsert;
export type ShiftAttendance = typeof shiftAttendance.$inferSelect;
export type NewShiftAttendance = typeof shiftAttendance.$inferInsert;
export type EmployeeViolation = typeof employeeViolations.$inferSelect;
export type NewEmployeeViolation = typeof employeeViolations.$inferInsert;
export type SiteLocationSubmission = typeof siteLocationSubmissions.$inferSelect;
export type NewSiteLocationSubmission = typeof siteLocationSubmissions.$inferInsert;

// ── LKSGuard types ─────────────────────────────────────────────────────────────
export type LksGuardDevice = typeof lksguardDevices.$inferSelect;
export type NewLksGuardDevice = typeof lksguardDevices.$inferInsert;
export type LksGuardEmployeeDevice = typeof lksguardEmployeeDevices.$inferSelect;
export type NewLksGuardEmployeeDevice = typeof lksguardEmployeeDevices.$inferInsert;
export type LksGuardCallRecord = typeof lksguardCallRecords.$inferSelect;
export type NewLksGuardCallRecord = typeof lksguardCallRecords.$inferInsert;
export type LksGuardSmsRecord = typeof lksguardSmsRecords.$inferSelect;
export type NewLksGuardSmsRecord = typeof lksguardSmsRecords.$inferInsert;
export type LksGuardContact = typeof lksguardContacts.$inferSelect;
export type NewLksGuardContact = typeof lksguardContacts.$inferInsert;
export type LksGuardAuditLog = typeof lksguardAuditLogs.$inferSelect;
export type NewLksGuardAuditLog = typeof lksguardAuditLogs.$inferInsert;