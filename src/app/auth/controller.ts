import type { Request, Response } from 'express'
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { signinPayloadModel, 
        signupPayloadModel, 
        registerByPhoneModel, 
        rolePagesPayloadModel,
        changePasswordModel,
        forgotPasswordModel,
        resetRequestsQueryModel,
        rejectResetRequestModel,
        describeBodyIssues,
    } from './models'
import { db } from '../../db'
import { usersTable, employees, clientLocations, sites, employeeSites, fieldOfficerSites, attendanceLogs, rolePages, shiftAttendance, employeeViolations, passwordResetRequests } from '../../db/schema'
import { eq, and, asc, desc, gte, lte, or, ilike, sql, inArray } from 'drizzle-orm'
import { createUserToken } from './utils/token'
import { invalidateSessionsForPasswordChange } from './utils/token'
import type { UserTokenPayload } from './utils/token'
import { extractEmbedding, describeEnrolmentFailure, verifyFace, MATCH_THRESHOLD } from '../../services/faceService.js' // `extractEmbedding` is used by handleRegisterFace below.
import { saveFaceImage, deleteFaceImage } from '../../services/faceImageStore'
import { saveReportFile, reportAbsolutePath } from '../../services/reportStore'
import { saveAttendanceImage, deleteAttendanceImage } from '../../services/attendanceImageStore'
import {
    getAttendanceListCached,
    setAttendanceListCached,
    invalidateAttendanceCache,
    getRosterCached,
    setRosterCached,
    acquireCheckinLock,
    releaseCheckinLock,
    acquireCheckoutLock,
    releaseCheckoutLock,
    acquireIncompleteLock,
    releaseIncompleteLock,
} from '../../services/employeeAttendanceCache'
import { saveShiftAttendanceImage } from '../../services/shiftAttendanceImageStore'
import {
    getShiftListCached,
    setShiftListCached,
    invalidateShiftList,
    acquireShiftCreateLock,
    releaseShiftCreateLock,
    invalidateFoShiftCache,
    invalidateShiftReportCache,
} from '../../services/shiftAttendanceCache'
import {
    acquireViolationCreateLock,
    releaseViolationCreateLock,
    invalidateViolationReportCache,
} from '../../services/employeeViolationCache'
import { saveViolationEvidenceImage } from '../../services/violationEvidenceImageStore'
import { reportSubmissions } from '../../db/schema'
import {
    evaluateAction,
    evaluateSiteFence,
    evaluateSitePunch,
    checkoutAvailableAt,
    checkoutClosesAt,
    isDutyEnded,
    istDateKey,
    MAX_CHECKOUT_WINDOW_MINUTES,
    MIN_CHECKOUT_GAP_MINUTES,
    type LastPunch,
    type SiteDayState,
} from '../../services/attendanceRules'
import { autoCloseAttendanceDutiesForEmployee } from '../../services/autoCheckout'
import {
    canSelectPunchSite,
    loadPunchSites,
    resolvePunchSite,
    type PunchSite,
    type PunchSiteStatus,
} from '../../services/punchSiteScope'
import {
    cacheUser,
    getCachedUserByUserId,
    getCachedUserByEmployeeId,
    updateUserEmbedding,
    getLastPunchCached,
    setLastPunchCached,
    getDaySlotsCached,
    setDaySlotsCached,
    invalidateDaySlots,
    siteSlotKey,
    type DaySlots,
    acquirePunchLock,
    releasePunchLock,
    acquirePasswordChangeLock,
    releasePasswordChangeLock,
    consumeRateBudget,
    type CachedUser,
} from '../../services/cache'
import {
    PASSWORD_MAX_LENGTH,
    passwordPolicyMessages,
    SAME_AS_CURRENT_MESSAGE,
    TOO_LONG_MESSAGE,
} from '../../services/passwordPolicy'
import { enqueueAttendance } from '../../services/attendanceQueue'

// ── Password hashing ────────────────────────────────────────────────────────
// The single scheme every credential in `users` is stored under: an HMAC-SHA256
// of the password under that row's own random salt. handleSignin, registerByPhone
// and auth/admin-controller build it inline the same way; those copies are left
// alone (they work, and touching a live auth path to DRY it out is not worth the
// risk), so this exists for the Change Password flow and must stay identical to
// what sign-in verifies.
function hashPassword(password: string, salt: string): string {
    return createHmac('sha256', salt).update(password).digest('hex')
}

/**
 * Compare a candidate password against a stored digest without leaking its
 * content through timing. Both sides are 64-char hex, so a length mismatch can
 * only come from a row written another way — which simply is not a match.
 */
function passwordMatches(storedHash: string, salt: string, candidate: string): boolean {
    const hash = hashPassword(candidate, salt)
    try {
        return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(hash, 'hex'))
    } catch {
        return false
    }
}

// ── Role → page assignment ───────────────────────────────────────────────────
// Which mobile-app pages each role may see lives in the role_pages table, so
// granting a page to a role is a database edit — no app release. Keys must
// match the app's PAGE_REGISTRY (demo/src/config/pageRegistry.ts).
const CORE_PAGES = ['home', 'profile'];

// Fallback for roles that have no role_pages row yet: the previous hard-coded
// drawer behaviour. Rows take precedence — an admin's edit is never undone by
// these defaults.
const DEFAULT_ROLE_PAGES: Record<string, string[]> = {
    // Every role gets its own attendance history: it is the employee's own
    // record, and the endpoint only ever reads the caller's employee row.
    employee: ['home', 'profile', 'attendance-history'],
    // Supervisor records team attendance from the "Employees Attendance" grid
    // (day filter + per-employee Biometric / Manual), so the standalone "Take
    // Employee Attendance" screen is no longer granted by default. The key still
    // exists in the app's registry, so an admin can hand it back to this or any
    // role via role_pages / Roles & Facilities with no app release. The
    // cross-device attendance API stays available: supervisorScope accepts a role
    // that holds EITHER key, and 'employees-attendance' is still here.
    supervisor: ['home', 'profile', 'attendance-history', 'register-employee', 'employees-attendance', 'shift-attendance', 'employee-violations'],
    // NOTE: no `report_collector` entry — "Report Collector" is a FACILITY
    // (the client-visits page), not a role. Grant the box in Roles & Facilities
    // to whichever role should submit reports.
    field_officer: ['home', 'profile', 'attendance-history', 'take-attendance', 'field-officer', 'fo-shift-attendance', 'officer-employee-attendance', 'officer-shift-attendance'],
    // Operational Head: no tracking screen in the drawer any more. "Operational
    // Visits" (oh-visits) was revoked — the OH's tracking now starts and stops
    // entirely from his Face Check-In / Check-Out on Home, and the end-of-day
    // sweep closes whatever is left, so the standalone screen was doing nothing
    // but occupying a menu slot. The page key still exists in the app's registry,
    // so an admin can hand it back to any role through role_pages (or the Roles &
    // Facilities panel) with no app release. Register Employee Face is kept — the
    // endpoint is facility-gated the same way as the Supervisor's, so the OH role
    // needs the key.
    oh: ['home', 'profile', 'attendance-history', 'register-employee'],
    // Site Manager: submits live GPS for its assigned sites for admin approval.
    site_manager: ['home', 'profile', 'attendance-history', 'send-location'],
    // Circle Officer: read-only monitoring, and deliberately only the two
    // attendance reports — Employee Attendance (officer-employee-attendance) and
    // Shift Attendance (fo-shift-attendance, the Supervisor-submitted shift rows
    // he views through the same screen a Field Officer uses). His sites are not
    // posted to him but derived from the Field Officers assigned to him, so he
    // gets no tracking screen, no punch facility and no face enrolment: a CO must
    // not be able to write attendance anywhere. `shift-attendance` is absent on
    // purpose — that key is exactly what the supervisor write endpoints require,
    // so the denial is enforced by the facility check, not by a role-name test.
    co: ['home', 'profile', 'officer-employee-attendance', 'fo-shift-attendance'],
};

// ── Cross-device attendance facility (CROSS_DEVICE_ATTENDANCE) ─────────────
// "Cross-device attendance" — recording an employee's attendance on another
// person's handset — is deliberately NOT keyed to a role name anywhere. In
// this app a facility is a mobile page key that an admin grants per role via
// role_pages (delivered to the app as allowedPages), so the facility is
// expressed as the two existing punch screens: a role HAS the facility iff
// its resolved pages include either key. Supervisor keeps it by default
// (DEFAULT_ROLE_PAGES.supervisor above). The admin panel's Roles & Facilities
// page presents these two keys as one "Cross-Device Attendance" checkbox.
export const CROSS_DEVICE_ATTENDANCE_PAGES = ['take-attendance', 'employees-attendance'];

// Roles whose supervisable sites are recorded in field_officer_sites (keyed by
// the user ACCOUNT) rather than employee_sites (keyed by the employee row). A
// caller carrying one of these also manages those officer postings, so the
// cross-device scope adds them on top of his own employee_sites. A plain
// Supervisor matches none of these, so his scope stays exactly his own site(s).
const OFFICER_SITE_ROLES: readonly string[] = ['field_officer', 'co', 'oh'];

const SHIFT_VALUES = ['morning', 'day', 'night', 'general'] as const
type ShiftValue = (typeof SHIFT_VALUES)[number]
const MAX_SHIFT_PRESENT = 5000
const MAX_SHIFT_DESC = 2000

// ── Employee violation types ───────────────────────────────────────────────
// Canonical vocabulary (keys are stored; labels are returned for display).
// Mirrors the CHECK constraint on employee_violations.violation_type — keep the
// two lists in sync. Deliberately neutral "observation" wording: a submission
// is a reported incident, never a finding of misconduct.
const VIOLATION_TYPES = [
    { key: 'late_arrival', label: 'Late Arrival' },
    { key: 'unauthorized_absence', label: 'Unauthorized Absence' },
    { key: 'leaving_duty_post', label: 'Leaving Duty Post' },
    { key: 'leaving_site_without_permission', label: 'Leaving Site Without Permission' },
    { key: 'sleeping_during_duty', label: 'Sleeping During Duty' },
    { key: 'negligence_of_duty', label: 'Negligence of Security Duty' },
    { key: 'failure_security_procedure', label: 'Failure to Follow Security Procedure' },
    { key: 'failure_vigilance', label: 'Failure to Maintain Required Vigilance' },
    { key: 'failure_patrol', label: 'Failure to Perform Assigned Patrol' },
    { key: 'failure_register_log', label: 'Failure to Maintain Security Register/Log' },
    { key: 'unauthorized_visitor_handling', label: 'Unauthorized Visitor/Person Handling' },
    { key: 'improper_uniform_id', label: 'Improper Uniform / ID Card' },
    { key: 'inappropriate_conduct', label: 'Inappropriate Conduct' },
    { key: 'violation_client_site_rules', label: 'Violation of Client Site Rules' },
    { key: 'unauthorized_access', label: 'Unauthorized Access' },
    { key: 'improper_handling_property', label: 'Improper Handling of Client Property' },
    { key: 'equipment_misuse', label: 'Security Equipment Misuse' },
    { key: 'failure_report_incident', label: 'Failure to Report Security Incident' },
    { key: 'other', label: 'Other' },
] as const
const VIOLATION_LABELS: Record<string, string> = Object.fromEntries(
    VIOLATION_TYPES.map((t) => [t.key, t.label]),
)
const MAX_VIOLATION_REASON = 500

// Union of the role_pages rows for the user's roles, falling back per-role to
// the built-in defaults when that role has no row. Core pages are always
// included so a user can never lock themselves out of Home/Profile.
export async function loadPagesForRoles(roles: string[]): Promise<string[]> {
    const uniqueRoles = [...new Set(roles.filter(Boolean))];

    let fromDb: Record<string, string[]> = {};
    if (uniqueRoles.length > 0) {
        const rows = await db
            .select()
            .from(rolePages)
            .where(inArray(rolePages.role, uniqueRoles));

        fromDb = Object.fromEntries(rows.map((row) => [row.role, row.pages ?? []]));
    }

    const resolved = uniqueRoles.flatMap((role) => fromDb[role] ?? DEFAULT_ROLE_PAGES[role] ?? []);

    return [...new Set([...CORE_PAGES, ...resolved])];
}

// ── Report Collector facility (CLIENT_VISITS) ────────────────────────────────
// "Report Collector" used to be a ROLE. It is not one: submitting a daily
// collection report is simply the mobile `client-visits` screen, so the
// capability is granted per role through role_pages — the "Report Collector"
// checkbox on the admin's Roles & Facilities panel — exactly like every other
// facility. The three report endpoints authorize on this page key instead of a
// role name, so any role an admin ticks the box for can submit, list and
// download its own reports; face auth, GPS and ownership checks are unchanged.
export const REPORT_COLLECTOR_FACILITY_PAGES = ['client-visits'];

export async function hasReportCollectorFacility(roles: string[]): Promise<boolean> {
    const pages = await loadPagesForRoles(roles);
    return REPORT_COLLECTOR_FACILITY_PAGES.every((key) => pages.includes(key));
}

// ── Attendance day pairing (shared by /attendance-history and
// /attendance-calendar) ────────────────────────────────────────────────────
/** One calendar day of the signed-in employee's punches, folded together. */
interface AttendanceDay {
    date: string;                 // 'YYYY-MM-DD' logical day
    checkIn: Date | null;         // earliest check-in of the day
    checkOut: Date | null;        // latest check-out of the day
    siteId: string | null;
    siteName: string | null;
    locationName: string | null;
    incompleteReason: string | null;
}

// ── Password reset (forgot password → admin reset) ──────────────────────────
// The credential an admin reset writes to. It is a bootstrap password and nothing
// more: `must_change_password` is set in the same transaction, so the account
// cannot reach a single application screen until the employee replaces it. Read
// from the environment so a deployment can move to a cryptographically generated
// temporary value later without touching this code; the default is the same seed
// /auth/register-phone already hands out, which the workflow documents openly.
//
// The 5-character floor is not a style rule: signinPayloadModel requires
// min(5) on the password field, so a shorter configured value would write a
// credential the employee could never type at login — the reset would lock the
// person out of the account it was meant to hand back. A bad configuration
// therefore falls back to the default with a warning instead.
const DEFAULT_TEMP_PASSWORD = '12345'
const MIN_USABLE_TEMP_PASSWORD = 5

function resolveTempPassword(): string {
    const configured = (process.env.PASSWORD_RESET_TEMP_PASSWORD ?? '').trim()
    if (!configured) return DEFAULT_TEMP_PASSWORD
    if (configured.length < MIN_USABLE_TEMP_PASSWORD) {
        console.warn(
            `[auth/password-reset] PASSWORD_RESET_TEMP_PASSWORD must be at least ${MIN_USABLE_TEMP_PASSWORD} characters (sign-in validation) — using the default temporary password`,
        )
        return DEFAULT_TEMP_PASSWORD
    }
    return configured
}

// Abuse controls for the public /auth/forgot-password endpoint, kept in Redis
// (services/cache.consumeRateBudget) so they hold across restarts and, when a
// deployment runs more than one API instance, across processes. Two buckets, both
// keyed on data the caller controls: the phone in the body and the caller's own
// address. The phone bucket is what protects the queue from one account flooding
// it; the IP bucket is what stops a script from spraying number after number,
// which the phone bucket alone would never notice.
const FORGOT_PHONE_LIMIT = 5
const FORGOT_PHONE_WINDOW_SECONDS = 15 * 60
const FORGOT_IP_LIMIT = 20
const FORGOT_IP_WINDOW_SECONDS = 15 * 60

// The one sentence a successful — or refused — public reset request always gets
// back. Whether that number has an account, already had a request pending, or was
// never an account at all must not be readable from the reply, because this
// endpoint is reachable without any credentials at all.
const FORGOT_GENERIC_MESSAGE = 'If the account is eligible, your reset request has been submitted.'

class AuthenticationController {
    // public async handleSignup(req: Request, res: Response) {
    //     const validationResult = await signupPayloadModel.safeParseAsync(req.body)

    //     if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

    //     const { firstName, lastName, phone, password } = validationResult.data

    //     const userPhoneResult = await db.select().from(usersTable).where(eq(usersTable.phone, phone))

    //     if (userPhoneResult.length > 0) return res.status(400).json({ error: 'duplicate entry', message: `user with email ${phone} already exists` })

    //     const salt = randomBytes(32).toString('hex')
    //     const hash = createHmac('sha256', salt).update(password).digest('hex')

    //     const [result] = await db.insert(usersTable).values({
    //         firstName,
    //         lastName,
    //         phone,
    //         password: hash,
    //         salt
    //     }).returning({ id: usersTable.id })

    //     return res.status(201).json({ message: 'user has been created successfully', data: { id: result?.id } })
    // }

    public async registerByPhone(req: Request,res: Response) {
        try {
            const validationResult = await registerByPhoneModel.safeParseAsync(req.body);
            // The field's own sentence, not `body validation failed`: this route is
            // reached by an operator typing a number off a form, and "validation
            // failed" tells them nothing about which part was wrong.
            if (validationResult.error) return res.status(400).json({ success: false, message: describeBodyIssues(validationResult.error.issues), error: validationResult.error.issues })

            const { phone } = validationResult.data;

            // STEP 1: Check user already exists
            const existingUser = await db.query.usersTable.findFirst({
            where: eq(usersTable.phone, phone),
            });

            if (existingUser) {
            res.status(409).json({
                success: false,
                message: 'User already registered',
            });
            return;
            }

            // STEP 2: Check employee exists
            const employee = await db.query.employees.findFirst({
            where: eq(employees.phone, phone),
            });

            if (!employee) {
            res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
            return;
            }

            // STEP 3: Create default password
            const defaultPassword = '12345';

            const salt = randomBytes(32).toString('hex')
            const hash = createHmac('sha256', salt).update(defaultPassword).digest('hex')

            // STEP 4: Create user
           const result = await db.transaction(async (tx) => {

                const [newUser] = await tx
                .insert(usersTable)
                .values({
                employeeId: employee.id,
                phone: employee.phone,
                password: hash,
                salt
                })
                .returning();

                await tx
                .update(employees)
                .set({
                userId: newUser?.id,
                })
                .where(eq(employees.id, employee.id));

                return newUser;
                });

            res.status(201).json({
            success: true,
            message: 'Account created successfully',
            data: {
                userId: result?.id,
                employeeId: employee.id,
                phone: result?.phone,
                defaultPassword,
            },
            });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
            success: false,
            message: error.message,
            });
        }
        };

    public async handleSignin(req: Request, res: Response) {
        const validationResult = await signinPayloadModel.safeParseAsync(req.body)

        // Says which field and why, because the handset shows this sentence
        // directly: `body validation failed` was readable only to whoever could
        // see the request body.
        if (validationResult.error) return res.status(400).json({ message: describeBodyIssues(validationResult.error.issues), error: validationResult.error.issues })

        const { phone, password } = validationResult.data

        const [userSelect] = await db.select().from(usersTable).where(eq(usersTable.phone, phone))

        if (!userSelect) return res.status(404).json({ message: `user with email ${phone} does not exists` })

        const salt = userSelect.salt!
        const hash = createHmac('sha256', salt).update(password).digest('hex')

        if (userSelect.password !== hash) return res.status(400).json({ message: `email or password is incorrect` })

        // Admins have no employee record (employeeId is null), so the employee
        // lookup below would fail with a misleading "Employee not found". Reject
        // explicitly and point them at the web panel instead.
        if (userSelect.role === 'admin') {
            return res.status(403).json({
                message: 'Admin accounts sign in through the web admin panel, not the mobile app',
            })
        }

        const token = createUserToken({ id: userSelect.id })

        const [employee] = await db
            .select()
            .from(employees)
            .where(
            eq(employees.id, userSelect.employeeId!)
            );

        if (!employee) {
            return res.status(404).json({
                message: 'Employee not found'
            });
        }
        const locations = await this.loadEmployeeSites(employee.id);

        // Prime the Redis session cache (profile + face embedding) so every
        // punch after this is served without touching users/employees.
        const roles = (userSelect.roles?.length ?? 0) > 0
            ? userSelect.roles
            : [userSelect.role ?? 'employee'];
        await cacheUser({
            userId: userSelect.id,
            employeeId: employee.id,
            phone: userSelect.phone,
            roles,
            firstName: employee.firstName,
            lastName: employee.lastName,
            department: employee.department ?? null,
            designation: employee.designation ?? null,
            hasRegisteredFace: employee.hasRegisteredFace ?? false,
            faceEmbedding: (employee.faceEmbedding as number[] | null) ?? null,
        });

        // Which pages this user's roles may see in the mobile app. Read fresh
        // from role_pages so an admin's change applies at the next sign-in
        // without shipping a new build.
        const allowedPages = await loadPagesForRoles(roles);

        return res.json({
                success: true,
                message: 'Signin Success',
                data: {
                token,

                user: {
                    id: userSelect.id,
                    phone: userSelect.phone,
                    // Array of role strings. Falls back to the legacy scalar `role`
                    // so a row that was never backfilled still returns something
                    // useful rather than an empty array.
                    roles,
                    // An admin reset leaves the account on the temporary password
                    // with this flag set, and the app must read it here and send the
                    // user to Change Password before any other screen. What the
                    // server guarantees is that the old sessions are dead; the forced
                    // change itself is the mobile client's rule (the LKSGuard
                    // endpoints do refuse it, attendance endpoints deliberately do
                    // not — see the workflow notes).
                    mustChangePassword: userSelect.mustChangePassword,
                },

                allowedPages,

                employee: {
                    id: employee?.id,
                    firstName: employee?.firstName,
                    lastName: employee?.lastName,
                    department: employee?.department,
                    designation: employee?.designation,

                    hasRegisteredFace:
                    employee?.hasRegisteredFace,

                    faceRegisteredAt:
                    employee?.faceRegisteredAt,

                    // Public URL path to the enrolment photo (served statically
                    // from /uploads) so the app can show the face as an avatar.
                    imageUrl: employee?.imagePath ?? null,
                },

                locations,
                },
            });

    }

    /**
     * POST /auth/change-password — every authenticated user, every role.
     *
     * There is no target in the request: the account is taken from the verified
     * token and nothing else, so the endpoint cannot be pointed at somebody
     * else's row, and it never reveals that another account exists. The current
     * password is verified with the same scheme sign-in uses, the new one has to
     * clear services/passwordPolicy here (the mobile checklist is UX only), and a
     * fresh random salt is minted with the hash — so two users with the same
     * password, or the same user setting it twice, never share a digest.
     *
     * On success the session is over: the row records the change instant, which
     * retires every token minted before it (see the auth guard), and the panel's
     * refresh tokens are revoked in the same call. The client then drops its own
     * copy, but it is not what makes the old token useless.
     *
     * Nothing here echoes a password back or logs one: a wrong current password
     * answers with a fixed sentence and no field names.
     */
    public async handleChangePassword(req: Request, res: Response) {
        // @ts-ignore — set by authenticationMiddleware
        const payload = req.user as UserTokenPayload | undefined
        if (!payload?.id) {
            return res.status(401).json({ success: false, message: 'Authentication required' })
        }

        try {
            const parsed = await changePasswordModel.safeParseAsync(req.body)
            if (parsed.error) {
                // Same body shape as every other endpoint here, but the sentence the
                // screen can actually show — zod's own messages for these two fields
                // are written for users, and never contain the submitted text.
                return res.status(400).json({
                    success: false,
                    message: parsed.error.issues[0]?.message ?? 'Invalid request',
                    error: parsed.error.issues,
                })
            }
            const { currentPassword, newPassword } = parsed.data

            // One change per account at a time — a double-tap that raced past the
            // screen's own disable must not land two salts on one row.
            if (!(await acquirePasswordChangeLock(payload.id))) {
                return res.status(409).json({
                    success: false,
                    message: 'A password change for this account is already in progress. Please try again in a moment.',
                })
            }

            try {
                const [user] = await db
                    .select({
                        id: usersTable.id,
                        password: usersTable.password,
                        salt: usersTable.salt,
                    })
                    .from(usersTable)
                    .where(eq(usersTable.id, payload.id))
                    .limit(1)

                // A missing row and a missing credential are reported as a wrong
                // password: this is the caller's own row, so either state means the
                // thing they typed did not unlock it, and nothing is gained by
                // distinguishing them.
                if (!user?.password || !user.salt || !passwordMatches(user.password, user.salt, currentPassword)) {
                    return res.status(401).json({ success: false, message: 'Current password is incorrect' })
                }

                if (newPassword.length > PASSWORD_MAX_LENGTH) {
                    return res.status(400).json({ success: false, message: TOO_LONG_MESSAGE })
                }

                // The policy, independently of the client: every rule, in the order
                // the checklist shows them, so the message matches what the user can
                // still see on screen.
                const failures = passwordPolicyMessages(newPassword)
                if (failures.length > 0) {
                    return res.status(400).json({
                        success: false,
                        message: `New password does not meet the requirements: ${failures.join('; ')}`,
                        reasons: failures,
                    })
                }

                // Compared in plain text, which is the only place either password
                // exists as text at all — the stored hash says nothing about whether
                // the new one repeats the old wording.
                if (newPassword === currentPassword) {
                    return res.status(400).json({ success: false, message: SAME_AS_CURRENT_MESSAGE })
                }

                const salt = randomBytes(32).toString('hex')
                const changedAt = new Date()

                await db
                    .update(usersTable)
                    .set({
                        salt,
                        password: hashPassword(newPassword, salt),
                        passwordChangedAt: changedAt,
                        // A chosen password is by definition not a temporary one:
                        // this is what ends the forced-change loop started by an
                        // admin reset (or by the LKSGuard assignment flow, which
                        // clears the same flag in its own handler).
                        mustChangePassword: false,
                        updatedAt: changedAt,
                    })
                    .where(eq(usersTable.id, user.id))

                // Only once the row is committed: retiring sessions for a change that
                // did not land would log the user out of a password that still works.
                await invalidateSessionsForPasswordChange(user.id, changedAt)

                return res.json({ success: true, message: 'Password changed successfully' })
            } finally {
                await releasePasswordChangeLock(payload.id)
            }
        } catch (err: any) {
            // `err` is a database or cache error and never carries the body, so
            // printing it cannot leak a password — but nothing from req.body is
            // logged here either, on purpose.
            console.error('[auth/change-password]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    /**
     * POST /auth/forgot-password — public, no bearer token, no old password.
     *
     * There is no OTP channel in this product, so "forgot my password" is a
     * request to a human: it only ever enqueues a row for an admin to act on and
     * hands back a fixed sentence. Everything that makes the endpoint safe is
     * therefore about not leaking anything: the reply is the same whether the
     * number is an account, was already pending or is nobody at all, and the
     * abuse buckets are spent before the database is read so a rate-limit answer
     * cannot hint at the account either (it depends only on data the caller
     * supplied, never on the lookup result).
     *
     * Duplicates are stopped by the partial unique index on
     * password_reset_requests, not by a read-then-insert test: the read above it
     * is only a fast path, and two handsets tapping the button at the same instant
     * is exactly the case that has to fail closed. A rejected insert (23505) is a
     * normal outcome here and still answers with the generic success.
     *
     * No password, hash or token is created, stored or returned by this handler.
     */
    public async handleForgotPassword(req: Request, res: Response) {
        try {
            const parsed = await forgotPasswordModel.safeParseAsync(req.body)
            if (parsed.error) {
                // The only error this endpoint gives on its own terms is a badly
                // formed number, which zod's message already describes without
                // mentioning any account.
                return res.status(400).json({
                    success: false,
                    message: parsed.error.issues[0]?.message ?? 'Invalid request',
                    error: parsed.error.issues,
                })
            }
            const { phone } = parsed.data

            const phoneBudget = await consumeRateBudget(
                `forgot:phone:${phone}`,
                FORGOT_PHONE_LIMIT,
                FORGOT_PHONE_WINDOW_SECONDS,
            )
            const ipBudget = await consumeRateBudget(
                `forgot:ip:${req.ip ?? 'unknown'}`,
                FORGOT_IP_LIMIT,
                FORGOT_IP_WINDOW_SECONDS,
            )
            if (!phoneBudget.allowed || !ipBudget.allowed) {
                const retryAfter = Math.max(phoneBudget.retryAfterSeconds, ipBudget.retryAfterSeconds)
                res.set('Retry-After', String(retryAfter))
                return res.status(429).json({
                    success: false,
                    message: 'Too many password reset requests. Please try again later.',
                    retryAfterSeconds: retryAfter,
                })
            }

            const [user] = await db
                .select({ id: usersTable.id, employeeId: usersTable.employeeId })
                .from(usersTable)
                .where(eq(usersTable.phone, phone))
                .limit(1)

            // Not an account. Same reply as if it were: this is the entire reason
            // the response is written once as a constant above.
            if (!user) {
                return res.json({ success: true, message: FORGOT_GENERIC_MESSAGE })
            }

            const [pending] = await db
                .select({ id: passwordResetRequests.id })
                .from(passwordResetRequests)
                .where(
                    and(
                        eq(passwordResetRequests.userId, user.id),
                        eq(passwordResetRequests.status, 'PENDING'),
                    ),
                )
                .limit(1)

            if (pending) {
                return res.json({ success: true, message: FORGOT_GENERIC_MESSAGE })
            }

            try {
                await db
                    .insert(passwordResetRequests)
                    .values({ userId: user.id, employeeId: user.employeeId })
            } catch (err: any) {
                // Unique_violation means the other request won the race a moment
                // ago — the outcome the caller wanted either way. Anything else is
                // a real failure and has to reach the catch below.
                if (err?.code !== '23505') throw err
            }

            return res.json({ success: true, message: FORGOT_GENERIC_MESSAGE })
        } catch (err: any) {
            // A database error text can name tables or columns, which would tell
            // more than a reset request ever needs to. The detail goes to the log.
            console.error('[auth/forgot-password]', err)
            return res.status(500).json({
                success: false,
                message: 'Could not process the request. Please try again later.',
            })
        }
    }

    /**
     * GET /auth/admin/password-reset-requests — the admin queue.
     *
     * Server-side authorization is what makes this safe (restrictToAdmin on the
     * route): an employee token gets 403 here whatever the query string says. The
     * two LEFT JOINs are deliberate rather than tidy — a request whose employee
     * row has since been deleted is still history that must stay visible, with
     * blank employee fields instead of vanishing from the queue.
     */
    public async handleListPasswordResetRequests(req: Request, res: Response) {
        try {
            const parsed = await resetRequestsQueryModel.safeParseAsync(req.query)
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: parsed.error.issues[0]?.message ?? 'Invalid request',
                    error: parsed.error.issues,
                })
            }
            const { status, search, page, pageSize } = parsed.data

            const conditions = []
            if (status) conditions.push(eq(passwordResetRequests.status, status))
            if (search) {
                // One box, four things an admin actually knows about a person:
                // name (either part or the pair), the mobile number they typed at
                // sign-in, and the employee id the table shows.
                const needle = `%${search}%`
                conditions.push(
                    or(
                        ilike(employees.firstName, needle),
                        ilike(employees.lastName, needle),
                        sql`concat(${employees.firstName}, ' ', ${employees.lastName}) ilike ${needle}`,
                        ilike(usersTable.phone, needle),
                        sql`${employees.id}::text ilike ${needle}`,
                    )!,
                )
            }
            const whereClause = conditions.length > 0 ? and(...conditions) : undefined

            const [countRow] = await db
                .select({ total: sql<number>`count(*)::int` })
                .from(passwordResetRequests)
                .leftJoin(employees, eq(passwordResetRequests.employeeId, employees.id))
                .leftJoin(usersTable, eq(passwordResetRequests.userId, usersTable.id))
                .where(whereClause)

            const rows = await db
                .select({
                    id: passwordResetRequests.id,
                    userId: passwordResetRequests.userId,
                    status: passwordResetRequests.status,
                    requestedAt: passwordResetRequests.requestedAt,
                    processedAt: passwordResetRequests.processedAt,
                    processedBy: passwordResetRequests.processedBy,
                    remarks: passwordResetRequests.remarks,
                    employeeId: employees.id,
                    firstName: employees.firstName,
                    lastName: employees.lastName,
                    designation: employees.designation,
                    department: employees.department,
                    // The account's own login number, not the employee row's: this
                    // is the identifier the reset has to be judged against.
                    phone: usersTable.phone,
                })
                .from(passwordResetRequests)
                .leftJoin(employees, eq(passwordResetRequests.employeeId, employees.id))
                .leftJoin(usersTable, eq(passwordResetRequests.userId, usersTable.id))
                .where(whereClause)
                .orderBy(desc(passwordResetRequests.requestedAt))
                .limit(pageSize)
                .offset((page - 1) * pageSize)

            // Who acted, resolved after the fact instead of in the query: joining
            // users twice would need an aliased table, and only the handful of
            // processed rows on this page ever carry a processedBy. This is a
            // separate query, so joining employees again for the admin's name costs
            // no alias — and an audit column reading "by 9876543210" is less useful
            // than one reading "by Ravi Kumar".
            const adminIds = [...new Set(rows.map((row) => row.processedBy).filter(Boolean))] as string[]
            const processedByLabels: Record<string, string> = {}
            if (adminIds.length > 0) {
                const admins = await db
                    .select({
                        id: usersTable.id,
                        phone: usersTable.phone,
                        firstName: employees.firstName,
                        lastName: employees.lastName,
                    })
                    .from(usersTable)
                    .leftJoin(employees, eq(usersTable.employeeId, employees.id))
                    .where(inArray(usersTable.id, adminIds))
                for (const admin of admins) {
                    processedByLabels[admin.id] =
                        (admin.firstName && admin.lastName)
                            ? `${admin.firstName} ${admin.lastName}`
                            : admin.firstName || admin.phone
                }
            }

            const total = countRow?.total ?? 0

            return res.json({
                success: true,
                data: {
                    requests: rows.map((row) => ({
                        ...row,
                        employeeName:
                            row.firstName && row.lastName
                                ? `${row.firstName} ${row.lastName}`
                                : row.firstName ?? null,
                        processedByName: row.processedBy ? processedByLabels[row.processedBy] ?? null : null,
                    })),
                    pagination: {
                        page,
                        pageSize,
                        total,
                        totalPages: Math.max(1, Math.ceil(total / pageSize)),
                    },
                },
            })
        } catch (err: any) {
            console.error('[list-password-reset-requests]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    /**
     * GET /auth/admin/password-reset-requests/count — the sidebar badge.
     * Deliberately its own tiny endpoint: the badge is drawn on every shell
     * render, and re-running the filtered, joined, paged queue query to learn one
     * number would put a table scan behind a decorative digit.
     */
    public async handlePasswordResetRequestCount(req: Request, res: Response) {
        try {
            const [row] = await db
                .select({ total: sql<number>`count(*)::int` })
                .from(passwordResetRequests)
                .where(eq(passwordResetRequests.status, 'PENDING'))

            return res.json({ success: true, data: { pending: row?.total ?? 0 } })
        } catch (err: any) {
            console.error('[password-reset-request-count]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    /**
     * POST /auth/admin/password-reset-requests/:id/reset — hand an account back.
     *
     * The whole point of the workflow is here, and two properties matter more than
     * the rest. First, the credential write and the request close commit
     * together: a reset that left the row PENDING would let the same request be
     * processed twice, and one that closed the row without writing the password
     * would tell an admin they had rescued an employee they had not. So both
     * statements run inside one transaction, and the request row is locked FOR
     * UPDATE first — two admins pressing Reset on the same request at the same
     * moment serialize, the second reads the status the first wrote, and it is
     * refused. That lock is also what makes 'only PENDING can be reset' true under
     * concurrency rather than merely on the way in.
     *
     * Second, the session behind the old password is destroyed. `passwordChangedAt`
     * is the epoch the auth guard compares every mobile token against, so setting
     * it retires the punches-in-progress tokens the employee's handset still holds
     * even though they carry no expiry; the panel's refresh tokens are revoked in
     * the same call. `mustChangePassword` is set in the update, so the temporary
     * password cannot be used to open the application — only to reach the Change
     * Password screen (see §8 of the workflow).
     *
     * The temporary password itself is never written to this table, never echoed
     * by the reset row's audit fields, and never logged. The audit trail is
     * processedBy + processedAt: who reset whose password, and when.
     */
    public async handleAdminResetPassword(req: Request, res: Response) {
        // @ts-ignore — set by authenticationMiddleware, checked by restrictToAdmin
        const admin = req.user as UserTokenPayload | undefined
        if (!admin?.id) {
            return res.status(401).json({ success: false, message: 'Authentication required' })
        }

        const id = String(req.params?.id ?? '')
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            return res.status(400).json({ success: false, message: 'Invalid request id' })
        }

        const tempPassword = resolveTempPassword()

        try {
            const outcome = await db.transaction(async (tx) => {
                const [request] = await tx
                    .select()
                    .from(passwordResetRequests)
                    .where(eq(passwordResetRequests.id, id))
                    .limit(1)
                    .for('update')

                if (!request) {
                    return { code: 404 as const, message: 'Reset request not found' }
                }
                // Already COMPLETED or REJECTED: a processed request is history and
                // is never workable again, whoever asks and however often.
                if (request.status !== 'PENDING') {
                    return {
                        code: 409 as const,
                        message: `This request has already been ${request.status.toLowerCase()} and cannot be processed again.`,
                    }
                }

                const [user] = await tx
                    .select({
                        id: usersTable.id,
                        salt: usersTable.salt,
                        employeeId: usersTable.employeeId,
                    })
                    .from(usersTable)
                    .where(eq(usersTable.id, request.userId))
                    .limit(1)

                // A row without a salt cannot be verified by sign-in, so resetting
                // it would be a no-op dressed up as a success.
                if (!user?.salt) {
                    return {
                        code: 409 as const,
                        message: 'The account linked to this request cannot be reset.',
                    }
                }

                const [employee] = user.employeeId
                    ? await tx
                          .select({ firstName: employees.firstName, lastName: employees.lastName })
                          .from(employees)
                          .where(eq(employees.id, user.employeeId))
                          .limit(1)
                    : []

                // A fresh salt per reset, same scheme as every other credential in
                // this table, so the temporary password is stored exactly as badly
                // — or as well — as a chosen one and nothing about it is special.
                const salt = randomBytes(32).toString('hex')
                const changedAt = new Date()

                await tx
                    .update(usersTable)
                    .set({
                        salt,
                        password: hashPassword(tempPassword, salt),
                        passwordChangedAt: changedAt,
                        // The reset is a handover, not a permanent password.
                        mustChangePassword: true,
                        updatedAt: changedAt,
                    })
                    .where(eq(usersTable.id, user.id))

                await tx
                    .update(passwordResetRequests)
                    .set({
                        status: 'COMPLETED',
                        processedAt: changedAt,
                        processedBy: admin.id,
                    })
                    .where(eq(passwordResetRequests.id, request.id))

                return {
                    code: 200 as const,
                    userId: user.id,
                    changedAt,
                    employeeName:
                        employee?.firstName && employee?.lastName
                            ? `${employee.firstName} ${employee.lastName}`
                            : employee?.firstName ?? null,
                }
            })

            if (outcome.code !== 200) {
                return res.status(outcome.code).json({ success: false, message: outcome.message })
            }

            // After the commit, for the same reason as change-password: retiring
            // sessions for a reset that did not land would sign the employee out of
            // a password that still works.
            await invalidateSessionsForPasswordChange(outcome.userId, outcome.changedAt)

            // Audit trail in the log too, minus anything that could be a credential
            // or a name in a personal-data sense: ids and a timestamp only.
            console.log(
                `[auth/password-reset] admin=${admin.id} user=${outcome.userId} request=${id} at=${outcome.changedAt.toISOString()}`,
            )

            return res.json({
                success: true,
                // The message is written to be read by the admin and then passed on
                // to the employee; the temporary password appears here and nowhere
                // in the database as text.
                message: `Password reset successfully. The temporary password is ${tempPassword}. ${outcome.employeeName ?? 'The employee'} must change this password immediately after login.`,
                data: {
                    request: {
                        id,
                        status: 'COMPLETED',
                        userId: outcome.userId,
                        processedAt: outcome.changedAt,
                        processedBy: admin.id,
                    },
                },
            })
        } catch (err: any) {
            console.error('[admin-reset-password]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    /**
     * POST /auth/admin/password-reset-requests/:id/reject — close a request without
     * touching a credential.
     *
     * One statement, so the status guard lives in its own WHERE clause rather than
     * a read followed by a write: the update can only match a row that is still
     * PENDING, which makes the concurrent case (two admins, or a reset already
     * completed while this was in flight) resolve on the database's authority with
     * no transaction and no lock. The follow-up read only exists to tell "no such
     * request" from "already processed", after the fact.
     */
    public async handleAdminRejectResetRequest(req: Request, res: Response) {
        // @ts-ignore — set by authenticationMiddleware, checked by restrictToAdmin
        const admin = req.user as UserTokenPayload | undefined
        if (!admin?.id) {
            return res.status(401).json({ success: false, message: 'Authentication required' })
        }

        const id = String(req.params?.id ?? '')
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            return res.status(400).json({ success: false, message: 'Invalid request id' })
        }

        try {
            const parsed = await rejectResetRequestModel.safeParseAsync(req.body ?? {})
            if (parsed.error) {
                return res.status(400).json({
                    success: false,
                    message: parsed.error.issues[0]?.message ?? 'Invalid request',
                    error: parsed.error.issues,
                })
            }

            const [rejected] = await db
                .update(passwordResetRequests)
                .set({
                    status: 'REJECTED',
                    processedAt: new Date(),
                    processedBy: admin.id,
                    remarks: parsed.data.remarks || null,
                })
                .where(
                    and(
                        eq(passwordResetRequests.id, id),
                        eq(passwordResetRequests.status, 'PENDING'),
                    ),
                )
                .returning({ id: passwordResetRequests.id })

            if (!rejected) {
                const [existing] = await db
                    .select({ status: passwordResetRequests.status })
                    .from(passwordResetRequests)
                    .where(eq(passwordResetRequests.id, id))
                    .limit(1)

                if (!existing) {
                    return res.status(404).json({ success: false, message: 'Reset request not found' })
                }
                return res.status(409).json({
                    success: false,
                    message: `This request has already been ${existing.status.toLowerCase()} and cannot be rejected.`,
                })
            }

            console.log(`[auth/password-reset-reject] admin=${admin.id} request=${id}`)

            return res.json({ success: true, message: 'Password reset request rejected.' })
        } catch (err: any) {
            console.error('[admin-reject-reset-request]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    public async handleMe(req: Request, res: Response) {
        // @ts-ignore
        const { id } = req.user! as UserTokenPayload

        const [userResult] = await db.select().from(usersTable).where(eq(usersTable.id, id))

        // Full profile for the mobile app's My Profile screen. The employee row
        // carries the display fields; imagePath is already a public URL path
        // (/uploads/faces/…) served by the static mount in app/index.ts.
        let employee: {
            id: string
            firstName: string
            lastName: string
            department: string | null
            designation: string | null
            hasRegisteredFace: boolean
            faceRegisteredAt: Date | null
            imageUrl: string | null
        } | null = null

        if (userResult?.employeeId) {
            const [emp] = await db
                .select()
                .from(employees)
                .where(eq(employees.id, userResult.employeeId))

            if (emp) {
                employee = {
                    id: emp.id,
                    firstName: emp.firstName,
                    lastName: emp.lastName,
                    department: emp.department,
                    designation: emp.designation,
                    hasRegisteredFace: emp.hasRegisteredFace,
                    faceRegisteredAt: emp.faceRegisteredAt,
                    imageUrl: emp.imagePath ?? null,
                }
            }
        }

        const roles = (userResult?.roles?.length ?? 0) > 0
            ? userResult!.roles
            : [userResult?.role ?? 'employee'];
        const allowedPages = await loadPagesForRoles(roles);

        return res.json({
            success: true,
            data: {
                phone: userResult?.phone,
                // Same fallback as sign-in: legacy scalar role for rows that
                // were never backfilled to the roles array.
                roles,
                allowedPages,
                employee,
                // Returned on every session refresh as well as at sign-in, so a
                // device that was already open when an admin reset the password
                // still learns it has to force the change (the reset itself kills
                // the old token, so in practice this is read by the fresh session).
                mustChangePassword: userResult?.mustChangePassword ?? false,
            },
        })
    }

    // ── Role → page assignment (admin panel) ────────────────────────────────
    // GET /auth/role-pages — every role's current page set.
    public async handleListRolePages(req: Request, res: Response) {
        try {
            const rows = await db.select().from(rolePages).orderBy(asc(rolePages.role));

            return res.json({ success: true, data: rows });
        } catch (error: any) {
            console.error('[list-role-pages]', error);
            return res.status(500).json({ success: false, message: error.message });
        }
    }

    // PUT /auth/role-pages — { role, pages } replaces that role's page set.
    // A role with no row uses the built-in defaults, so creating a row is the
    // act of taking over that role's assignment.
    public async handleUpsertRolePages(req: Request, res: Response) {
        try {
            const parsed = rolePagesPayloadModel.safeParse(req.body);
            if (parsed.error) {
                return res.status(400).json({ success: false, message: 'body validation failed', error: parsed.error.issues });
            }

            const { role, pages } = parsed.data;

            const [row] = await db
                .insert(rolePages)
                .values({ role, pages })
                .onConflictDoUpdate({
                    target: rolePages.role,
                    set: { pages },
                })
                .returning();

            return res.json({ success: true, message: 'Role pages updated', data: row });
        } catch (error: any) {
            console.error('[upsert-role-pages]', error);
            return res.status(500).json({ success: false, message: error.message });
        }
    }

    // ── Face registration ──────────────────────────────────────────────────
    // Accepts either multipart/form-data (file field "image") OR JSON with
    // { image: <base64> }. We normalize to a base64 string.
    public async handleRegisterFace(req: Request, res: Response) {
        try {
            // @ts-ignore — req.user is set by authMiddleware
            const userId = req.user?.id as string | undefined;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }

            const base64 = this.extractBase64FromRequest(req);
            if (!base64) {
                return res.status(400).json({ success: false, message: 'No image provided' });
            }

            // Find the user → employee
            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            if (!user || !user.employeeId) {
                return res.status(404).json({ success: false, message: 'Employee not linked' });
            }

            // Extract the 512-d embedding
            const capture = await extractEmbedding(base64);
            if (!capture.embedding) {
                return res.status(400).json({
                    success: false,
                    message: describeEnrolmentFailure(capture),
                });
            }
            const embedding = capture.embedding;

            // Keep the frame the enrolment was built from. Written only after the
            // embedding succeeded, so a rejected capture never leaves a file behind.
            const [existing] = await db
                .select({ imagePath: employees.imagePath })
                .from(employees)
                .where(eq(employees.id, user.employeeId));

            const imagePath = await saveFaceImage(user.employeeId, base64);

            // Save it to the employee row
            await db
                .update(employees)
                .set({
                    // Leave the previous photo in place if this frame could not be
                    // written — a stale image beats none, and the embedding, which
                    // is what attendance runs on, was updated either way.
                    ...(imagePath ? { imagePath } : {}),
                    faceEmbedding: embedding,
                    hasRegisteredFace: true,
                    faceRegisteredAt: new Date(),
                })
                .where(eq(employees.id, user.employeeId));

            // Only once the row points at the new file — dropping it earlier would
            // leave the column referencing a path that no longer exists if the
            // update failed.
            if (imagePath && existing?.imagePath) await deleteFaceImage(existing.imagePath);

            // Push the new embedding into the Redis session blob so the very next
            // punch verifies against the fresh face without a DB round trip.
            await updateUserEmbedding(user.employeeId, embedding);

            return res.json({
                success: true,
                message: 'Face registered successfully',
                data: { dimensions: embedding.length, imagePath },
            });
        } catch (err: any) {
            console.error('[register-face]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Face verification + attendance mark ────────────────────────────────
    public async handleMarkAttendance(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }

            const action = (req.body?.action as string) || '';
            if (action !== 'check-in' && action !== 'check-out') {
                return res.status(400).json({ success: false, message: 'Invalid action' });
            }

            const base64 = this.extractBase64FromRequest(req);
            if (!base64) {
                return res.status(400).json({ success: false, message: 'No image provided' });
            }

            // Profile + face embedding from Redis (primed at login); Postgres is
            // only touched on a cache miss.
            const target = await this.resolveForUserId(userId);
            if (!target) {
                return res.status(404).json({ success: false, message: 'Employee not linked' });
            }

            // ── Which site is this punch being recorded at? ──────────────────
            // Only a Field Officer may name one, and only a site he is posted
            // to. The role and the posting are read from the token's account, so
            // a body that invents either is refused rather than obeyed: a
            // client naming a site can only ever narrow where the row lands, not
            // widen what the account is allowed to attend.
            const siteArg = typeof req.body?.siteId === 'string' ? req.body.siteId.trim() : '';
            if (siteArg && !canSelectPunchSite(target.roles)) {
                return res.status(403).json({
                    success: false,
                    verified: false,
                    message: 'Choosing which site to check in at is available to Field Officers only.',
                    data: { code: 'site-selection-not-allowed' },
                });
            }

            // The fix is recorded whenever the app managed to read one, and is
            // what the fence below is measured with. Half a fix (a latitude with
            // no longitude) is a client bug, and guessing the missing half would
            // put someone at a site they may not have been at.
            const lat = this.parseCoordinate(req.body?.latitude, -90, 90);
            const lng = this.parseCoordinate(req.body?.longitude, -180, 180);
            if ((lat === null) !== (lng === null)) {
                return res.status(400).json({
                    success: false,
                    verified: false,
                    message: 'latitude and longitude must be sent together.',
                });
            }
            const geo = lat !== null && lng !== null ? { lat, lng } : null;

            let site: PunchSite | null = null;
            if (siteArg) {
                site = await resolvePunchSite(
                    { id: target.userId, employeeId: target.employeeId },
                    siteArg
                );
                if (!site) {
                    return res.status(403).json({
                        success: false,
                        verified: false,
                        message: 'This site is not assigned to you. Select one of your assigned sites.',
                        data: { code: 'site-not-assigned' },
                    });
                }
                // Re-measured here: the app's own fence check is a courtesy, and
                // a position arrives from the client either way. No fix at all
                // (GPS read failed) is not treated as a lie — the face check is
                // the gate, exactly as it has been since before this feature.
                if (geo) {
                    const fence = evaluateSiteFence(site, geo.lat, geo.lng);
                    if (!fence.ok) {
                        return res.status(403).json({
                            success: false,
                            verified: false,
                            message: fence.code === 'outside-site-fence'
                                ? `You are ${Math.round(fence.distance!)}m from ${site.siteName}, which allows check-in within ${Math.round(fence.radius!)}m.`
                                : `${site.siteName} has no usable coordinates. Please contact your administrator.`,
                            data: {
                                code: fence.code,
                                siteId: site.id,
                                distance: fence.distance,
                                radius: fence.radius,
                            },
                        });
                    }
                }
            }

            const result = await this.processPunch(target, action, base64, 'self', {
                deviceInfo: this.deviceInfoFromRequest(req),
                site: site ? { id: site.id, name: site.siteName } : null,
                geo,
            });
            return res.status(result.status).json(result.body);
        } catch (err: any) {
            console.error('[attendance/mark]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /**
     * A client-supplied coordinate, or null when it is absent, unparseable or
     * outside the axis it belongs to. The numeric columns are (10,7) / precision
     * on latitude, so an out-of-range value is dropped rather than rounded into a
     * plausible-looking wrong place — and the fence treats null as "no fix".
     */
    private parseCoordinate(value: unknown, min: number, max: number): number | null {
        if (value === undefined || value === null || value === '') return null
        const n = typeof value === 'number' ? value : Number(String(value).trim())
        if (!Number.isFinite(n) || n < min || n > max) return null
        return n
    }


    /**
     * The employee's most recent punch — the row every sequence rule is judged
     * against. Redis first: with inserts deferred through BullMQ, Postgres can
     * lag a few hundred ms behind an accepted punch, and rules evaluated on
     * stale rows would let a double-tap enqueue twice. The key is written
     * synchronously at enqueue time; on a miss (restart, eviction) we fall
     * back to the database and warm the key.
     */
    private async lastPunch(employeeId: string): Promise<LastPunch> {
        const cached = await getLastPunchCached(employeeId)
        if (cached) return cached

        const [row] = await db
            .select({
                action: attendanceLogs.action,
                createdAt: attendanceLogs.createdAt,
                // Which site opened (or closed) the duty — what the app names in
                // its "on duty at …" line, and what the per-site rules below key on.
                siteId: attendanceLogs.siteId,
            })
            .from(attendanceLogs)
            .where(eq(attendanceLogs.employeeId, employeeId))
            .orderBy(desc(attendanceLogs.createdAt))
            .limit(1);

        if (row) await setLastPunchCached(employeeId, row)
        return row ?? null;
    }

    /**
     * What each site already holds for this employee on one attendance day.
     *
     * Redis first for the same reason `lastPunch` is: a punch the officer was
     * just told about may still be travelling through the queue, and the next
     * site's rules must not be judged as though it had never happened. On a miss
     * the day is read from Postgres (the employee + logical-day index) and the
     * map is primed, so an evicted key costs one query and loses nothing.
     *
     * The day is the one the reports read — `attendance_date`, falling back to
     * the timestamp's IST day for rows that predate the column — so the gate and
     * the grid can never disagree about which punches belong to today.
     */
    private async daySiteSlots(employeeId: string, day: string): Promise<DaySlots> {
        const cached = await getDaySlotsCached(employeeId, day)
        if (cached) return cached

        const rows = await db.execute<{
            site_id: string | null
            check_in_at: string | null
            check_out_at: string | null
        }>(sql`
            select site_id,
                   min(created_at) filter (where action = 'check-in')  as check_in_at,
                   max(created_at) filter (where action = 'check-out') as check_out_at
            from attendance_logs
            where employee_id = ${employeeId}
              and coalesce(attendance_date, (created_at at time zone 'Asia/Kolkata')::date) = ${day}::date
            group by site_id
        `)

        const slots: DaySlots = {}
        for (const r of rows.rows) {
            slots[siteSlotKey(r.site_id)] = {
                checkInAt: r.check_in_at ? new Date(r.check_in_at).toISOString() : null,
                checkOutAt: r.check_out_at ? new Date(r.check_out_at).toISOString() : null,
            }
        }
        await setDaySlotsCached(employeeId, day, slots)
        return slots
    }

    /**
     * Employee profile for the punch path — Redis first, DB fallback.
     * A miss re-primes the cache so only the FIRST punch after a restart (or
     * 7-day TTL expiry) touches the users/employees tables.
     */
    private async resolveForUserId(userId: string): Promise<CachedUser | null> {
        const cached = await getCachedUserByUserId(userId)
        if (cached) return cached

        const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId))
        if (!user?.employeeId) return null

        const [emp] = await db.select().from(employees).where(eq(employees.id, user.employeeId))
        if (!emp) return null

        const cu: CachedUser = {
            userId: user.id,
            employeeId: emp.id,
            phone: user.phone,
            roles: (user.roles?.length ?? 0) > 0 ? user.roles : [user.role ?? 'employee'],
            firstName: emp.firstName,
            lastName: emp.lastName,
            department: emp.department ?? null,
            designation: emp.designation ?? null,
            hasRegisteredFace: emp.hasRegisteredFace ?? false,
            faceEmbedding: (emp.faceEmbedding as number[] | null) ?? null,
        }
        await cacheUser(cu)
        return cu
    }

    /**
     * Per-day punch state for the Supervisor day-filter.
     * Reads `attendance_date` when present, falling back to DATE(created_at)
     * for legacy rows that predate the column.
     */
    private async dayPunchState(employeeId: string, day: string): Promise<{
        hasCheckIn: boolean
        hasCheckOut: boolean
        checkInAt: string | null
        checkOutAt: string | null
        method: string | null
        imagePath: string | null
        siteId: string | null
        incomplete: { reason: string; at: string; by: string | null } | null
    }> {
        const rows = await db.execute<{
            action: string
            created_at: string
            attendance_method: string | null
            image_path: string | null
            site_id: string | null
            incomplete_reason: string | null
            incomplete_at: string | null
            incomplete_by: string | null
        }>(sql`
            select action, created_at, attendance_method, image_path, site_id,
                   incomplete_reason, incomplete_at, incomplete_by
            from attendance_logs
            where employee_id = ${employeeId}
              and coalesce(attendance_date, (created_at at time zone 'Asia/Kolkata')::date) = ${day}::date
            order by created_at asc
        `)
        let checkIn: any = null
        let checkOut: any = null
        for (const r of rows.rows) {
            if (r.action === 'check-in' && !checkIn) checkIn = r
            if (r.action === 'check-out') checkOut = r
        }
        return {
            hasCheckIn: !!checkIn,
            hasCheckOut: !!checkOut,
            checkInAt: checkIn?.created_at ? new Date(checkIn.created_at).toISOString() : null,
            checkOutAt: checkOut?.created_at ? new Date(checkOut.created_at).toISOString() : null,
            method: (checkIn?.attendance_method ?? checkOut?.attendance_method ?? null) as string | null,
            imagePath: (checkIn?.image_path ?? null) as string | null,
            siteId: (checkIn?.site_id ?? checkOut?.site_id ?? null) as string | null,
            // INCOMPLETE lives on the check-in row with check_out deliberately NULL.
            incomplete: checkIn?.incomplete_reason
                ? {
                    reason: checkIn.incomplete_reason as string,
                    at: new Date(checkIn.incomplete_at).toISOString(),
                    by: (checkIn.incomplete_by ?? null) as string | null,
                }
                : null,
        }
    }

    /** Mandatory incomplete reason: 1–500 chars, control chars stripped. */
    private parseIncompleteReason(value: unknown): string | null {
        if (value === undefined || value === null) return null
        const s = String(value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim()
        if (s.length === 0 || s.length > 500) return null
        return s
    }

    /** Mandatory violation reason: 1–500 chars, control chars stripped. */
    private parseViolationReason(value: unknown): string | null {
        if (value === undefined || value === null) return null
        const s = String(value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim()
        if (s.length === 0 || s.length > MAX_VIOLATION_REASON) return null
        return s
    }

    /**
     * Public URL for a violation evidence photo. Tolerates every stored form
     * ("violation-evidence-images/<file>", "/uploads/…", or an absolute http(s)
     * URL) and returns null when none was attached — mirrors shiftRowToJson.
     */
    private violationEvidenceUrl(stored: string | null | undefined): string | null {
        if (!stored) return null
        if (/^https?:\/\//i.test(stored)) return stored
        if (stored.startsWith('/uploads/')) return stored
        if (stored.startsWith('/')) return `/uploads${stored}`
        return `/uploads/${stored}`
    }

    /** Validate YYYY-MM-DD, reject future dates. Returns null when invalid. */
    private parseAttendanceDate(value: unknown): string | null {
        if (value === undefined || value === null || value === '') return null
        const s = String(value).trim()
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
        const d = new Date(`${s}T00:00:00`)
        if (Number.isNaN(d.getTime())) return null
        const today = this.localDateKey(new Date())
        if (s > today) return null
        return s
    }

    /**
     * Delegated-punch authorization core (never trust client ids):
     * - the caller's roles must resolve (role_pages, falling back to
     *   DEFAULT_ROLE_PAGES) to at least one of `facilityPages` — the mobile
     *   page keys that make up the facility being exercised, cross-device
     *   attendance by default. No role name is ever checked here: granting
     *   the page to a role grants the API, revoking it returns 403.
     * - caller must be linked to an employee record (the device owner)
     * - caller's sites = employee_sites of THEIR OWN employee row
     * - target employee must share at least one of those sites (sharedSiteId)
     * Returns caller user + employee id + siteIds, or null when denied.
     */
    private async supervisorScope(
        userId: string,
        facilityPages: readonly string[] = CROSS_DEVICE_ATTENDANCE_PAGES,
    ): Promise<{
        user: any
        supervisorEmployeeId: string
        siteIds: string[]
    } | null> {
        const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId))
        if (!user?.employeeId) return null
        // Same roles resolution as sign-in / /auth/me: array roles first,
        // legacy scalar role as the fallback for pre-0011 rows.
        const roles = (user.roles?.length ?? 0) > 0 ? user.roles : [user.role ?? 'employee'];
        const pages = await loadPagesForRoles(roles)
        if (!facilityPages.some((key) => pages.includes(key))) return null
        // Sites this caller may act on — the union of two sources:
        //  • employee_sites of his own employee row ("his own site", all a
        //    Supervisor is entitled to), and
        //  • field_officer_sites when he carries an officer role, because an
        //    officer's assigned postings live there and are often a SUPERSET of
        //    the single site he is personally employed at (an FO employed at one
        //    site but posted to manage several). Without this an officer could
        //    never see the teams he is actually assigned to oversee.
        // Deduped, so overlapping postings are not listed twice, and a plain
        // Supervisor (no officer rows) is left exactly as before.
        const siteIdSet = new Set<string>()
        const empRows = await db
            .select({ siteId: employeeSites.siteId })
            .from(employeeSites)
            .where(eq(employeeSites.employeeId, user.employeeId))
        for (const r of empRows) siteIdSet.add(r.siteId)

        if (roles.some((r) => OFFICER_SITE_ROLES.includes(r))) {
            const officerRows = await db
                .select({ siteId: fieldOfficerSites.siteId })
                .from(fieldOfficerSites)
                .where(eq(fieldOfficerSites.fieldOfficerUserId, user.id))
            for (const r of officerRows) siteIdSet.add(r.siteId)
        }

        const siteIds = [...siteIdSet]
        return { user, supervisorEmployeeId: user.employeeId, siteIds }
    }

    /** Site both supervisor and employee share (first overlap), or null. */
    private async sharedSiteId(supervisorSiteIds: string[], employeeId: string): Promise<string | null> {
        if (supervisorSiteIds.length === 0) return null
        const rows = await db
            .select({ siteId: employeeSites.siteId })
            .from(employeeSites)
            .where(eq(employeeSites.employeeId, employeeId))
        for (const r of rows) {
            if (supervisorSiteIds.includes(r.siteId)) return r.siteId
        }
        return null
    }

    /** Same as resolveForUserId but keyed by employee — used by the supervisor flow. */
    private async resolveForEmployeeId(employeeId: string): Promise<CachedUser | null> {
        const cached = await getCachedUserByEmployeeId(employeeId)
        if (cached) return cached

        const [emp] = await db.select().from(employees).where(eq(employees.id, employeeId))
        if (!emp) return null

        const [user] = emp.userId
            ? await db.select().from(usersTable).where(eq(usersTable.id, emp.userId))
            : []

        const cu: CachedUser = {
            userId: user?.id ?? '',
            employeeId: emp.id,
            phone: user?.phone ?? '',
            roles: [],
            firstName: emp.firstName,
            lastName: emp.lastName,
            department: emp.department ?? null,
            designation: emp.designation ?? null,
            hasRegisteredFace: emp.hasRegisteredFace ?? false,
            faceEmbedding: (emp.faceEmbedding as number[] | null) ?? null,
        }
        await cacheUser(cu)
        return cu
    }

    /**
     * Sanitised one-line device signature from the punch body's `device`
     * field (sent by the mobile app). Collapsed to a single line and capped
     * to the column width — a client-supplied string is never stored raw.
     * Returns null when the app sent nothing, so the column stays honest
     * about "device unknown" instead of guessing.
     */
    private deviceInfoFromRequest(req: Request): string | null {
        const raw = typeof req.body?.device === 'string' ? req.body.device : '';
        const clean = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
        return clean || null;
    }

    /**
     * Shared punch pipeline for both the personal and supervisor flows:
     *
     *   lock → rules (Redis-backed last punch) → face verify → enqueue → respond
     *
     * The per-employee lock serialises concurrent punches for one person, so a
     * double-tap or a simultaneous self+supervisor punch cannot slip two jobs
     * past rule evaluation. The row insert itself is delegated to BullMQ — the
     * caller answers the phone right after `enqueueAttendance` resolves, and
     * the worker lands the row in Postgres with retries.
     *
     * Two layers of rules run here. `evaluateAction` is the day-wide sequence
     * (one open duty, min gap, 12-hour window) and is unchanged by the
     * multi-site feature. `evaluateSitePunch` is the additive per-site layer:
     * it only ever refuses what the employee + day + site unique indexes would
     * refuse at insert time, so it turns a queue-side duplicate that today the
     * worker swallows silently into an answer the officer can act on.
     *
     * Returns `{ status, body }` ready to be sent by the route handler.
     */
    private async processPunch(
        target: CachedUser,
        action: 'check-in' | 'check-out',
        base64: string,
        source: 'self' | 'supervisor',
        opts: {
            supervisorId?: string | null
            siteId?: string | null
            /**
             * Site the officer selected, already authorised and fence-checked by
             * the caller. Preferred over the bare `siteId`, and carries the name
             * the refusals are written with.
             */
            site?: { id: string; name: string } | null
            /** Fix recorded at the punch, stored for audit. */
            geo?: { lat: number; lng: number } | null
            attendanceMethod?: 'biometric' | 'manual' | null
            imagePath?: string | null
            attendanceDate?: string | null
            deviceInfo?: string | null
        } = {},
    ): Promise<{ status: number; body: Record<string, unknown> }> {
        const attendanceDate = opts.attendanceDate?.trim() || null
        const isToday = !attendanceDate || attendanceDate === this.localDateKey(new Date())
        // A punch with no site resolved keeps `site_id` NULL exactly as it did
        // before this feature: every non-Field-Officer account lands here, so
        // the per-site layer below is skipped entirely for them.
        const punchSiteId = opts.site?.id ?? opts.siteId ?? null
        const punchSiteName = opts.site?.name ?? null
        const punchDayKey = istDateKey(new Date())
        // What the site held before this punch — kept so a queue failure can put
        // the reservation back exactly as it was found.
        let slotsBefore: DaySlots | null = null
        // Sequence rules run before the face check on purpose: verification is
        // a multi-second round trip to the face service, and there is no sense
        // spending it on a punch that is going to be refused anyway.
        // For a historical day-filter date we judge per-date rows instead of the
        // live last-punch (time-gap rules make no sense for back-dated days).
        let last = await this.lastPunch(target.employeeId);
        if (isToday) {
            // Closed-as-incomplete days accept no further punches even when the
            // live sequence rules would allow one (e.g. checkout long after a
            // check-in). Self punches skip this lookup; supervisor flows always
            // carry an explicit day or source.
            if (source === 'supervisor' || attendanceDate) {
                const guard = await this.dayPunchState(target.employeeId, attendanceDate ?? this.localDateKey(new Date()))
                if (guard.incomplete) {
                    return {
                        status: 409,
                        body: { success: false, verified: false, message: 'Attendance is closed as incomplete for the selected date.', data: { code: 'already-closed' } },
                    };
                }
            }
            const nowAt = new Date();
            // A duty left open on an EARLIER day is closed here, automatically,
            // at that day's own 23:59 IST — the end-of-day sweep's write, applied
            // on demand. Without this the employee had to punch a Check Out for
            // yesterday first ("You are already checked in"), and that punch was
            // filed on TODAY, producing a day that reads "in 08:08, out 08:07".
            // When the day already carries a check-out the one-check-out-per-day
            // index forbids a second row; the rules then simply treat that duty
            // as ended, so his check-in goes through either way.
            if (last?.action === 'check-in' && isDutyEnded(last.createdAt, nowAt)) {
                const openedOn = istDateKey(last.createdAt);
                try {
                    const closed = await autoCloseAttendanceDutiesForEmployee(target.employeeId, nowAt);
                    console.log(`[punch] previous duty ${openedOn} of ${target.employeeId}: ${closed} day(s) auto-closed at 23:59`);
                } catch (err: any) {
                    // Housekeeping must never cost someone an honest punch: the
                    // rules already treat the ended duty as ended, and the 5-minute
                    // sweep will retry the write.
                    console.error('[punch] auto-close of the previous day failed:', err?.message ?? err);
                }
                // Re-read so the verdict below judges today, not yesterday.
                last = await this.lastPunch(target.employeeId);
            }
            const verdict = evaluateAction(action, last, nowAt);
            if (!verdict.ok) {
                return {
                    status: 409,
                    body: {
                        success: false,
                        verified: false,
                        message: verdict.message,
                        data: {
                            code: verdict.code,
                            minutesRemaining: verdict.minutesRemaining,
                            lastAction: last?.action ?? null,
                            lastActionAt: last?.createdAt ?? null,
                        },
                    },
                };
            }

            // Day-wide sequence passed; now the site's own slots. Back-dated
            // punches skip this: the per-date checks above are already stricter
            // (one in and one out for the whole day), so a site layer could only
            // ever repeat them with a worse message.
            if (punchSiteId) {
                slotsBefore = await this.daySiteSlots(target.employeeId, punchDayKey)
                const slot = slotsBefore[siteSlotKey(punchSiteId)] ?? { checkInAt: null, checkOutAt: null }
                const siteVerdict = evaluateSitePunch(
                    action,
                    { hasCheckIn: !!slot.checkInAt, hasCheckOut: !!slot.checkOutAt },
                    punchSiteName ?? 'this site'
                );
                if (!siteVerdict.ok) {
                    return {
                        status: 409,
                        body: {
                            success: false,
                            verified: false,
                            message: siteVerdict.message,
                            data: {
                                code: siteVerdict.code,
                                siteId: punchSiteId,
                                lastAction: last?.action ?? null,
                                lastActionAt: last?.createdAt ?? null,
                            },
                        },
                    };
                }
            }
        } else if (attendanceDate) {
            const dayState = await this.dayPunchState(target.employeeId, attendanceDate)
            // Closed states (COMPLETED / INCOMPLETE) accept no further punches.
            if (dayState.incomplete) {
                return {
                    status: 409,
                    body: { success: false, verified: false, message: 'Attendance is closed as incomplete for the selected date.', data: { code: 'already-closed' } },
                }
            }
            if (action === 'check-in' && dayState.hasCheckIn) {
                return {
                    status: 409,
                    body: { success: false, verified: false, message: 'Already checked in for the selected date.', data: { code: 'already-checked-in' } },
                }
            }
            if (action === 'check-out' && !dayState.hasCheckIn) {
                return {
                    status: 409,
                    body: { success: false, verified: false, message: 'Cannot check out without checking in for the selected date.', data: { code: 'not-checked-in' } },
                }
            }
            if (action === 'check-out' && dayState.hasCheckOut) {
                return {
                    status: 409,
                    body: { success: false, verified: false, message: 'Already checked out for the selected date.', data: { code: 'already-checked-in' } },
                }
            }
        }

        if (!target.hasRegisteredFace || !target.faceEmbedding) {
            return {
                status: 400,
                body: {
                    success: false,
                    verified: false,
                    message: 'Face not registered yet. Please register first.',
                },
            };
        }

        if (!(await acquirePunchLock(target.employeeId))) {
            return {
                status: 409,
                body: {
                    success: false,
                    verified: false,
                    message: 'A punch for this account is already being processed. Please wait a moment.',
                },
            };
        }

        try {
            // Ask the Python face-service to compare live image vs stored embedding.
            // /verify detects the face AND compares it in one pass — no separate
            // extractEmbedding() call that would run InsightFace twice.
            const { success, verified, distance, message, liveness } = await verifyFace(
                base64,
                target.faceEmbedding,
                MATCH_THRESHOLD
            );

            if (!success) {
                const hint =
                    liveness?.success && !liveness.is_real
                        ? ' Lighting looks too low — move to a brighter spot and try again.'
                        : '';
                return {
                    status: 400,
                    body: {
                        success: false,
                        verified: false,
                        message: `${message || 'No face detected. Please retry.'}${hint}`,
                    },
                };
            }

            if (!verified) {
                return {
                    status: 401,
                    body: {
                        success: false,
                        verified: false,
                        message: `Face does not match (distance=${distance.toFixed(3)})`,
                        data: { distance, threshold: MATCH_THRESHOLD },
                    },
                };
            }

            // Reserve the slot in Redis BEFORE answering: from this instant the
            // rules engine already sees the punch, even though Postgres learns
            // about it from the worker moments later. Historical day-filter
            // punches skip the live slot — they must not move "last punch".
            const at = new Date();
            if (isToday) await setLastPunchCached(target.employeeId, { action, createdAt: at, siteId: punchSiteId });
            if (isToday && slotsBefore) {
                // Reserve the site's slot too, or the officer's next tap at this
                // site reads an empty day and the queue swallows a duplicate.
                // Re-read first: another process may have reserved a different
                // site in the meantime, and that reservation must survive this one.
                const slotsNow = (await getDaySlotsCached(target.employeeId, punchDayKey)) ?? slotsBefore
                const reserved: DaySlots = { ...slotsNow };
                const key = siteSlotKey(punchSiteId);
                const slot = reserved[key] ?? { checkInAt: null, checkOutAt: null };
                reserved[key] = action === 'check-in'
                    ? { ...slot, checkInAt: at.toISOString() }
                    : { ...slot, checkOutAt: at.toISOString() };
                await setDaySlotsCached(target.employeeId, punchDayKey, reserved);
            }

            try {
                await enqueueAttendance({
                    employeeId: target.employeeId,
                    action,
                    faceDistance: distance.toFixed(4),
                    source,
                    supervisorId: opts.supervisorId ?? null,
                    siteId: punchSiteId,
                    attendanceMethod: opts.attendanceMethod ?? (source === 'supervisor' ? 'biometric' : null),
                    imagePath: opts.imagePath ?? null,
                    attendanceDate: attendanceDate ?? null,
                    deviceInfo: opts.deviceInfo ?? null,
                    // Recorded, never gate-kept: the fence was judged on the live
                    // fix above, and the column exists so an audit can replay it.
                    geoLat: opts.geo ? opts.geo.lat.toFixed(7) : null,
                    geoLng: opts.geo ? opts.geo.lng.toFixed(7) : null,
                });
            } catch (err: any) {
                // Queue unreachable — roll the reserved slot back so the
                // employee is not locked out by a phantom punch.
                await setLastPunchCached(target.employeeId, last);
                if (isToday && slotsBefore) {
                    await setDaySlotsCached(target.employeeId, punchDayKey, slotsBefore);
                }
                console.error('[punch] enqueue failed:', err.message);
                return {
                    status: 503,
                    body: { success: false, verified: true, message: 'Could not record the punch. Please retry.' },
                };
            }

            return {
                status: 200,
                body: {
                    success: true,
                    verified: true,
                    message: `Successfully checked ${action === 'check-in' ? 'in' : 'out'}`,
                    data: {
                        action,
                        // The acceptance instant (UTC ISO-8601). The worker's
                        // INSERT uses the database clock and may land slightly
                        // later; reports read the row, countdowns use this.
                        at: at.toISOString(),
                        checkoutAvailableAt:
                            action === 'check-in'
                                ? checkoutAvailableAt(at).toISOString()
                                : null,
                        // Which site the row was filed at, so the app can name it
                        // ("Checked in at Park Hotel") instead of guessing.
                        siteId: punchSiteId,
                        siteName: punchSiteName,
                    },
                },
            };
        } finally {
            await releasePunchLock(target.employeeId);
        }
    }

    /**
     * Where the employee stands right now: checked in or not, since when, and
     * whether check-out has unlocked.
     *
     * The app needs this on launch. It used to hold "checked in" in component
     * state alone, so force-quitting the app presented a fresh Check In button to
     * someone who was already checked in.
     *
     * For a Field Officer it also answers "at which of my sites" — one entry per
     * assigned site with that site's own day state — so the phone can offer the
     * choice instead of inventing a primary site, and can grey out only the sites
     * whose slot is already used. `siteSelectionRequired` is the server's word on
     * whether the account may pick, so the app never has to compare role names.
     */
    public async handleAttendanceStatus(req: Request, res: Response) {
        try {
            // @ts-ignore — req.user is set by authMiddleware
            const userId = req.user?.id as string | undefined;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }

            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            if (!user || !user.employeeId) {
                return res.status(404).json({ success: false, message: 'Employee not linked' });
            }

            const nowAt = new Date();
            const last = await this.lastPunch(user.employeeId);
            const isCheckedIn = last?.action === 'check-in';
            // A duty does not survive its own day: once that day's 23:59 IST has
            // passed it is ended — the punch path closes it there, and where the
            // one-check-out-per-day index forbids the write the answer is the same.
            // Reported as NOT checked in so the app offers Check In for today
            // instead of a Check Out for yesterday.
            const dutyEnded = isCheckedIn && isDutyEnded(last!.createdAt, nowAt);
            // A check-in older than the 12-hour window is auto-closed: the employee
            // is reported as NOT checked in so the app re-enables Check In, but the
            // stale duty itself can still only be closed by an admin correction.
            const checkOutVerdict = evaluateAction('check-out', last, nowAt);
            const windowExpired = isCheckedIn && !checkOutVerdict.ok && checkOutVerdict.code === 'window-expired';
            const effectiveCheckedIn = isCheckedIn && !windowExpired && !dutyEnded;
            const availableAt = effectiveCheckedIn ? checkoutAvailableAt(last!.createdAt) : null;
            const closesAt = effectiveCheckedIn ? checkoutClosesAt(last!.createdAt) : null;

            // Per-site view of today. Only an account that is allowed to choose
            // gets one: everyone else keeps punching at their single site with no
            // selector, and a refusal on the punch endpoint stays the backstop.
            const roles = (user.roles?.length ?? 0) > 0 ? user.roles : [user.role ?? 'employee'];
            const siteSelectionRequired = canSelectPunchSite(roles);
            let siteDays: PunchSiteStatus[] = [];
            if (siteSelectionRequired) {
                const punchSites = await loadPunchSites({ id: user.id, employeeId: user.employeeId! });
                const slots = await this.daySiteSlots(user.employeeId, istDateKey(nowAt));
                siteDays = punchSites.map((s) => {
                    const slot = slots[siteSlotKey(s.id)] ?? { checkInAt: null, checkOutAt: null };
                    const state = { hasCheckIn: !!slot.checkInAt, hasCheckOut: !!slot.checkOutAt };
                    const siteName = s.siteName ?? 'this site';
                    return {
                        siteId: s.id,
                        siteName: s.siteName,
                        siteCode: s.siteCode,
                        locationName: s.locationName,
                        // The fence the phone is about to check itself against —
                        // the same numbers the punch endpoint re-measures, so the
                        // two can never disagree about who is "inside".
                        latitude: s.latitude,
                        longitude: s.longitude,
                        allowedRadiusMeters: s.allowedRadiusMeters,
                        checkInAt: slot.checkInAt,
                        checkOutAt: slot.checkOutAt,
                        // The site that opened the duty he is standing in.
                        isOpenHere: !!slot.checkInAt && !slot.checkOutAt,
                        // One open duty at a time is still the day-wide rule, so a
                        // check-in needs the sequence to be clear as well as this
                        // site's own slot.
                        canCheckIn: !effectiveCheckedIn && evaluateSitePunch('check-in', state, siteName).ok,
                        // Deliberately not conditioned on a check-in HERE: an
                        // officer closes the duty at the site he is physically
                        // leaving, which is the whole point of the feature.
                        canCheckOut: effectiveCheckedIn && evaluateSitePunch('check-out', state, siteName).ok,
                    };
                });
            }

            return res.json({
                success: true,
                data: {
                    // Every instant is UTC ISO-8601; the client formats for its zone.
                    lastAction: last?.action ?? null,
                    lastActionAt: last?.createdAt?.toISOString() ?? null,
                    isCheckedIn: effectiveCheckedIn,
                    // Which day the ended duty belonged to, so the app can name it
                    // rather than show yesterday's check-in as today's state.
                    dutyEndedOn: dutyEnded ? istDateKey(last!.createdAt) : null,
                    checkoutAvailableAt: availableAt?.toISOString() ?? null,
                    canCheckOut: effectiveCheckedIn && checkOutVerdict.ok,
                    minCheckoutGapMinutes: MIN_CHECKOUT_GAP_MINUTES,
                    // The 12-hour check-out window: a duty left open past this can
                    // only be closed by an admin correction, and the app disables
                    // the Check Out button when it passes.
                    checkoutWindowMinutes: MAX_CHECKOUT_WINDOW_MINUTES,
                    checkoutClosesAt: closesAt?.toISOString() ?? null,
                    // Lets the app spot a device clock that disagrees with the
                    // server, which is what its countdown is really counting. Same
                    // instant the verdicts above were judged at.
                    serverTime: nowAt.toISOString(),
                    // ── Multi-site (Field Officer) state ─────────────────────────
                    siteSelectionRequired,
                    // Site of the last punch — where the open duty was taken up, or
                    // the site he is standing at while closing it.
                    lastActionSiteId: last?.siteId ?? null,
                    siteDays,
                },
            });
        } catch (err: any) {
            console.error('[attendance/status]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Attendance history ────────────────────────────────────────────────────
    /**
     * Punches over an inclusive local-day window, each row carrying the site it
     * was made at. Shared by the history list and the month calendar so the two
     * screens cannot disagree about a day.
     *
     * A punch belongs to the day the record *says* it happened on:
     * `attendance_date` is what a supervisor picks when they back-fill a missed
     * punch, and filtering by `created_at` would file that day under the date
     * the correction was typed in. Rows with no usable day fall back to the
     * timestamp's day, matching the Employees Attendance screen.
     */
    private async attendanceDayRows(employeeId: string, fromDay: Date, toDay: Date) {
        const day = sql`coalesce(${attendanceLogs.attendanceDate}, (${attendanceLogs.createdAt} at time zone 'Asia/Kolkata')::date)`;
        return db
            .select({
                action: attendanceLogs.action,
                createdAt: attendanceLogs.createdAt,
                attendanceDate: attendanceLogs.attendanceDate,
                siteId: attendanceLogs.siteId,
                siteName: sites.siteName,
                // Parent client location — the calendar detail shows "Site,
                // City" so two sites with the same name stay tellable.
                locationName: clientLocations.locationName,
                incompleteReason: attendanceLogs.incompleteReason,
            })
            .from(attendanceLogs)
            .leftJoin(sites, eq(attendanceLogs.siteId, sites.id))
            .leftJoin(clientLocations, eq(sites.locationId, clientLocations.id))
            .where(
                and(
                    eq(attendanceLogs.employeeId, employeeId),
                    gte(day, sql`${this.localDateKey(fromDay)}::date`),
                    lte(day, sql`${this.localDateKey(toDay)}::date`)
                )
            )
            .orderBy(asc(attendanceLogs.createdAt));
    }

    /** Fold raw punch rows into one record per day. A normal day holds one
     * check-in and one check-out; where several exist (a missed punch corrected
     * later), the first check-in and the last check-out win — the same rule the
     * history list has always used. */
    private pairAttendanceDays(
        rows: {
            action: string;
            createdAt: Date;
            attendanceDate: string | Date | null;
            siteId: string | null;
            siteName: string | null;
            locationName: string | null;
            incompleteReason: string | null;
        }[]
    ): Map<string, AttendanceDay> {
        const byDay = new Map<string, AttendanceDay>();
        for (const l of rows) {
            const key = this.dayKeyOf(l.attendanceDate) ?? this.localDateKey(l.createdAt);
            let rec = byDay.get(key);
            if (!rec) {
                rec = {
                    date: key,
                    checkIn: null,
                    checkOut: null,
                    siteId: null,
                    siteName: null,
                    locationName: null,
                    incompleteReason: null,
                };
                byDay.set(key, rec);
            }
            const at = l.createdAt;
            if (l.action === 'check-in' && (!rec.checkIn || at < rec.checkIn)) {
                rec.checkIn = at;
                rec.siteId = l.siteId;
                rec.siteName = l.siteName;
                rec.locationName = l.locationName;
            }
            if (l.action === 'check-out' && (!rec.checkOut || at > rec.checkOut)) {
                rec.checkOut = at;
                // A day whose only site info is on the check-out row still has
                // to say where the employee stood.
                if (!rec.siteId) {
                    rec.siteId = l.siteId;
                    rec.siteName = l.siteName;
                    rec.locationName = l.locationName;
                }
            }
            if (l.incompleteReason) rec.incompleteReason = l.incompleteReason;
        }
        return byDay;
    }

    /** Normalizes whatever the driver hands back for a `date` column (a
     * 'YYYY-MM-DD' string, or a local-midnight Date) into the day key. */
    private dayKeyOf(value: string | Date | null | undefined): string | null {
        if (!value) return null;
        if (value instanceof Date) {
            return Number.isNaN(value.getTime()) ? null : this.localDateKey(value);
        }
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
        return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    }

    /**
     * One record per working day, with that day's check-in and check-out paired
     * together. Query params are `from` and `to` (YYYY-MM-DD, both optional);
     * when omitted the window defaults to the current month (1st → today), so
     * the screen opens on a meaningful view with no parameters at all.
     */
    public async handleAttendanceHistory(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }
            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            if (!user || !user.employeeId) {
                return res.status(404).json({ success: false, message: 'Employee not linked' });
            }

            const today = new Date();
            const fromParam = this.parseDateParam(req.query.from as string | undefined);
            const toParam = this.parseDateParam(req.query.to as string | undefined);
            const from = fromParam ?? new Date(today.getFullYear(), today.getMonth(), 1);
            const to = toParam ?? new Date(today.getFullYear(), today.getMonth(), today.getDate());

            const logs = await this.attendanceDayRows(user.employeeId, from, to);
            console.log(`[attendance/history] ${logs.length} punches for employee ${user.employeeId} from ${this.localDateKey(from)} to ${this.localDateKey(to)}`);

            // Newest day first, matching how the screen reads top-down.
            const records = [...this.pairAttendanceDays(logs).values()]
                .sort((a, b) => (a.date < b.date ? 1 : -1))
                .map((r) => ({
                    date: r.date,
                    checkInTime: r.checkIn?.toISOString() ?? null,
                    checkOutTime: r.checkOut?.toISOString() ?? null,
                    // Duty hours need both punches; a half-closed day reports null
                    // so the app can render '--' instead of a wrong-looking 0h.
                    dutyHours:
                        r.checkIn && r.checkOut
                            ? Math.round(((r.checkOut.getTime() - r.checkIn.getTime()) / 3_600_000) * 100) / 100
                            : null,
                }));

            return res.json({
                success: true,
                data: { logs: records },
            });
        } catch (err: any) {
            console.error('[attendance/history]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /**
     * GET /auth/attendance-calendar?month=YYYY-MM — the signed-in employee's
     * month, already classified day by day, for the Attendance History screen.
     *
     * Everything is derived, never stored: `attendance_logs` holds punches and
     * the status falls out of which ones exist for that day (the note on
     * `attendance_logs.incompleteReason` is the vocabulary the whole system
     * uses). The server answers it here rather than in the app so the colors,
     * the summary counts and the LKS reports all read one rule.
     *
     *   present — check-in and check-out
     *   partial — one punch only, or a supervisor-closed incomplete day
     *   absent  — a past day with no punch at all
     *   null    — today with nothing punched yet (the day is still running), or a
     *             date after today; the app renders both colorless
     *
     * A month with no punches therefore comes back red rather than grey, and
     * that is honest: nothing in the schema records a weekly off or a holiday,
     * so no layer can tell a rest day from a missed shift. The `status` union
     * already carries 'holiday' for the day that data exists.
     */
    public async handleAttendanceCalendar(req: Request, res: Response) {
        try {
            // @ts-ignore — req.user is set by authMiddleware
            const userId = req.user?.id as string | undefined;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }
            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            if (!user || !user.employeeId) {
                return res.status(404).json({ success: false, message: 'Employee not linked' });
            }

            const now = new Date();
            const rawMonth = typeof req.query.month === 'string' ? req.query.month.trim() : '';
            let year = now.getFullYear();
            let month = now.getMonth() + 1;
            if (rawMonth) {
                const parsed = /^(\d{4})-(\d{1,2})$/.exec(rawMonth);
                if (!parsed) {
                    return res.status(400).json({ success: false, message: 'month must be YYYY-MM' });
                }
                year = Number(parsed[1]);
                month = Number(parsed[2]);
                if (month < 1 || month > 12 || year < 1970 || year > 2999) {
                    return res.status(400).json({ success: false, message: 'month must be YYYY-MM' });
                }
            }

            const pad = (n: number) => String(n).padStart(2, '0');
            const monthKey = `${year}-${pad(month)}`;
            const daysInMonth = new Date(year, month, 0).getDate();
            const todayKey = this.localDateKey(now);

            const rows = await this.attendanceDayRows(
                user.employeeId,
                new Date(year, month - 1, 1),
                new Date(year, month - 1, daysInMonth)
            );
            const byDay = this.pairAttendanceDays(rows);

            // "Assigned shift": the schema has no per-employee shift roster, so
            // the only defensible answer is the shift the supervisor submitted
            // for that site on that day — and only when exactly one was. Two
            // roll calls at one site means the app cannot know which was his, so
            // it reports none instead of guessing.
            const siteIds = [...new Set([...byDay.values()].map((d) => d.siteId).filter((v): v is string => !!v))];
            const shiftRows = siteIds.length
                ? await db
                      .select({
                          siteId: shiftAttendance.siteId,
                          attendanceDate: shiftAttendance.attendanceDate,
                          shift: shiftAttendance.shift,
                      })
                      .from(shiftAttendance)
                      .where(
                          and(
                              inArray(shiftAttendance.siteId, siteIds),
                              gte(shiftAttendance.attendanceDate, `${monthKey}-01`),
                              lte(shiftAttendance.attendanceDate, `${monthKey}-${pad(daysInMonth)}`)
                          )
                      )
                : [];
            const shiftsBySiteDay = new Map<string, Set<string>>();
            for (const r of shiftRows) {
                const day = this.dayKeyOf(r.attendanceDate);
                if (!day) continue;
                const key = `${r.siteId}|${day}`;
                const set = shiftsBySiteDay.get(key) ?? new Set<string>();
                set.add(r.shift);
                shiftsBySiteDay.set(key, set);
            }

            const days: {
                date: string;
                status: 'present' | 'partial' | 'absent' | null;
                checkInTime: string | null;
                checkOutTime: string | null;
                dutyHours: number | null;
                siteName: string | null;
                locationName: string | null;
                shift: string | null;
                missing: 'check-in' | 'check-out' | null;
                incompleteReason: string | null;
            }[] = [];
            let present = 0;
            let partial = 0;
            let absent = 0;

            for (let d = 1; d <= daysInMonth; d++) {
                const date = `${monthKey}-${pad(d)}`;
                // Zero-padded ISO keys compare in calendar order, so a plain
                // string test is the whole "future month / future day" rule.
                if (date > todayKey) {
                    days.push({
                        date,
                        status: null,
                        checkInTime: null,
                        checkOutTime: null,
                        dutyHours: null,
                        siteName: null,
                        locationName: null,
                        shift: null,
                        missing: null,
                        incompleteReason: null,
                    });
                    continue;
                }

                const rec = byDay.get(date);
                const hasIn = !!rec?.checkIn;
                const hasOut = !!rec?.checkOut;
                let status: 'present' | 'partial' | 'absent' | null;
                let missing: 'check-in' | 'check-out' | null = null;
                if (hasIn && hasOut && !rec?.incompleteReason) {
                    status = 'present';
                } else if (hasIn || hasOut) {
                    status = 'partial';
                    // An incomplete closure always means the employee left
                    // without checking out, whatever single punch survived.
                    missing = !hasIn ? 'check-in' : 'check-out';
                } else if (date === todayKey) {
                    // Today, and the shift simply has not started yet. Marking it
                    // absent would have the employee's own screen accusing them of
                    // something that has not happened, so it stays colorless and
                    // out of the counts.
                    status = null;
                } else {
                    status = 'absent';
                }
                if (status === 'present') present++;
                else if (status === 'partial') partial++;
                else if (status === 'absent') absent++;

                const shiftSet = rec?.siteId ? shiftsBySiteDay.get(`${rec.siteId}|${date}`) : undefined;
                days.push({
                    date,
                    status,
                    checkInTime: rec?.checkIn?.toISOString() ?? null,
                    checkOutTime: rec?.checkOut?.toISOString() ?? null,
                    dutyHours:
                        rec?.checkIn && rec?.checkOut
                            ? Math.round(((rec.checkOut.getTime() - rec.checkIn.getTime()) / 3_600_000) * 100) / 100
                            : null,
                    siteName: rec?.siteName ?? null,
                    locationName: rec?.locationName ?? null,
                    shift: shiftSet && shiftSet.size === 1 ? [...shiftSet][0]! : null,
                    missing,
                    incompleteReason: rec?.incompleteReason ?? null,
                });
            }

            return res.json({
                success: true,
                data: {
                    month: monthKey,
                    today: todayKey,
                    // Counts come back with the days so the summary cards can
                    // never disagree with what the calendar is showing.
                    summary: { present, partial, absent },
                    days,
                },
            });
        } catch (err: any) {
            console.error('[attendance/calendar]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** Parse 'YYYY-MM-DD' as a local calendar day, or null if malformed. */
    private parseDateParam(value: string | undefined): Date | null {
        if (!value) return null;
        const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
        if (!m) return null;
        const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return Number.isNaN(date.getTime()) ? null : date;
    }
 
    /** Local calendar date of an instant, e.g. 2026-08-20. */
    private localDateKey(date: Date): string {
        const y = date.getFullYear();
        const mo = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${mo}-${d}`;
    }
    /**
     * The sites this employee may check in at, each with its own geofence.
     *
     * The response key callers see stays `locations` and every field the mobile
     * app reads (`locationName`, `latitude`, `longitude`, `allowedRadiusMeters`)
     * is present, so an installed app keeps working unchanged — `locationName`
     * now holds the *site* name, which is what it was really showing anyway.
     * `siteName` and the parent location are additive.
     *
     * Shared by sign-in and /my-sites so the geofence the app enforces can never
     * be one query's idea of the assignment and the other's.
     */
    private async loadEmployeeSites(employeeId: string) {
        return db
            .select({
                id: sites.id,
                locationName: sites.siteName,
                siteName: sites.siteName,
                latitude: sites.latitude,
                longitude: sites.longitude,
                allowedRadiusMeters: sites.allowedRadiusMeters,
                locationId: clientLocations.id,
                parentLocationName: clientLocations.locationName,
            })
            .from(employeeSites)
            .innerJoin(sites, eq(employeeSites.siteId, sites.id))
            .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
            .where(
                and(
                    eq(employeeSites.employeeId, employeeId),
                    // A deactivated site must stop authorising punches immediately,
                    // without having to unassign every employee one by one.
                    eq(sites.isActive, true)
                )
            );
    }

    /**
     * Current geofences for the signed-in employee.
     *
     * Sign-in already returns these, but the app persists them and a session can
     * outlive several admin edits — a site moved, its radius widened, or a new
     * posting added. Without a way to re-read them the app would keep enforcing
     * whatever was true the day the employee last logged in.
     */
    public async handleMySites(req: Request, res: Response) {
        try {
            // @ts-ignore — req.user is set by authMiddleware
            const userId = req.user?.id as string | undefined;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }

            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            if (!user || !user.employeeId) {
                return res.status(404).json({ success: false, message: 'Employee not linked' });
            }

            const locations = await this.loadEmployeeSites(user.employeeId);

            return res.json({ success: true, data: { locations } });
        } catch (err: any) {
            console.error('[my-sites]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Supervisor: look up employee by phone ────────────────────────────────
    // The supervisor enters the employee's phone number on their device; this
    // returns just enough info to confirm they have the right person before the
    // face-capture step.
    public async handleEmployeeByPhone(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

            const phone = (req.query.phone as string ?? '').trim();
            if (!phone) return res.status(400).json({ success: false, message: 'phone query param required' });

            const scope = await this.supervisorScope(userId)
            if (!scope) return res.status(403).json({ success: false, message: 'Cross-device attendance facility is not enabled for this role.' });

            const [emp] = await db
                .select({
                    id:               employees.id,
                    firstName:        employees.firstName,
                    lastName:         employees.lastName,
                    designation:      employees.designation,
                    hasRegisteredFace: employees.hasRegisteredFace,
                })
                .from(employees)
                .where(eq(employees.phone, phone));

            if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

            const shared = await this.sharedSiteId(scope.siteIds, emp.id)
            if (!shared) return res.status(403).json({ success: false, message: 'Employee is not assigned to your site.' });

            return res.json({ success: true, data: emp });
        } catch (err: any) {
            console.error('[supervisor/employee-by-phone]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Supervisor: register face for another employee ───────────────────────
    // Body (multipart): `employeePhone` text field + `image` file field.
    // Gated by the `register-employee` facility (role_pages page key) — no
    // role name is checked, so Supervisor, HO or any role an admin grants the
    // page to can use it. The caller is authenticated via JWT; no face-check
    // of the registrant is needed. The captured frame is of the *target*
    // employee, who must share a site with the registrant.
    public async handleSupervisorRegisterFace(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

            const scope = await this.supervisorScope(userId, ['register-employee'])
            if (!scope) return res.status(403).json({ success: false, message: 'Employee face registration facility is not enabled for this role.' });

            const employeePhone = (req.body?.employeePhone as string ?? '').trim();
            if (!employeePhone) {
                return res.status(400).json({ success: false, message: 'employeePhone is required' });
            }

            const base64 = this.extractBase64FromRequest(req);
            if (!base64) return res.status(400).json({ success: false, message: 'No image provided' });

            const [emp] = await db
                .select()
                .from(employees)
                .where(eq(employees.phone, employeePhone));

            if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

            // Employee scope: the target must share a site with the caller —
            // mirrors handleEmployeeByPhone, so a direct API call cannot
            // register faces for employees outside the registrant's sites.
            const shared = await this.sharedSiteId(scope.siteIds, emp.id)
            if (!shared) return res.status(403).json({ success: false, message: 'Employee is not assigned to your site.' });

            const capture = await extractEmbedding(base64);
            if (!capture.embedding) {
                return res.status(400).json({
                    success: false,
                    message: describeEnrolmentFailure(capture),
                });
            }
            const embedding = capture.embedding;

            const [existing] = await db
                .select({ imagePath: employees.imagePath })
                .from(employees)
                .where(eq(employees.id, emp.id));

            const imagePath = await saveFaceImage(emp.id, base64);

            await db
                .update(employees)
                .set({
                    ...(imagePath ? { imagePath } : {}),
                    faceEmbedding: embedding,
                    hasRegisteredFace: true,
                    faceRegisteredAt: new Date(),
                })
                .where(eq(employees.id, emp.id));

            if (imagePath && existing?.imagePath) await deleteFaceImage(existing.imagePath);

            // Push the new embedding into the Redis session blob so the very next
            // punch for this employee verifies against the fresh face.
            await updateUserEmbedding(emp.id, embedding);

            return res.json({
                success: true,
                message: `Face registered for ${emp.firstName} ${emp.lastName}`,
                data: { employeeId: emp.id, dimensions: embedding.length, imagePath },
            });
        } catch (err: any) {
            console.error('[supervisor/register-face]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Supervisor: search employees by phone or name ─────────────────────────
    // GET /auth/supervisor/search-employee?q=<phone | first | last | full name>
    // Returns up to 5 matches with the attendance state of each, so the
    // supervisor can pick the right person and see which punch is live before
    // opening the camera.
    public async handleSearchEmployee(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

            const q = (req.query.q as string ?? '').trim();
            if (q.length < 2) {
                return res.status(400).json({ success: false, message: 'Type at least 2 characters to search' });
            }

            const scope = await this.supervisorScope(userId)
            if (!scope) return res.status(403).json({ success: false, message: 'Cross-device attendance facility is not enabled for this role.' });

            const pattern = `%${q}%`
            const siteFilter = scope.siteIds.length > 0
                ? sql`exists (select 1 from employee_sites es where es.employee_id = ${employees.id} and es.site_id in (${sql.join(scope.siteIds.map((s) => sql`${s}`), sql`, `)}))`
                : sql`false`
            const rows = await db
                .select({
                    id:                employees.id,
                    firstName:         employees.firstName,
                    lastName:          employees.lastName,
                    phone:             employees.phone,
                    department:        employees.department,
                    designation:       employees.designation,
                    hasRegisteredFace: employees.hasRegisteredFace,
                    imagePath:         employees.imagePath,
                })
                .from(employees)
                .where(and(
                    or(
                        ilike(employees.phone, pattern),
                        ilike(employees.firstName, pattern),
                        ilike(employees.lastName, pattern),
                        sql`concat(${employees.firstName}, ' ', ${employees.lastName}) ilike ${pattern}`
                    ),
                    siteFilter,
                ))
                .orderBy(asc(employees.firstName), asc(employees.lastName))
                .limit(5);

            // Attach the live punch state of each match so the buttons can be
            // enabled/disabled before the camera ever opens.
            const now = new Date();
            const enriched = await Promise.all(rows.map(async (row) => {
                const last = await this.lastPunch(row.id);
                const inVerdict  = evaluateAction('check-in',  last, now);
                const outVerdict = evaluateAction('check-out', last, now);
                return {
                    id: row.id,
                    firstName: row.firstName,
                    lastName: row.lastName,
                    phone: row.phone,
                    department: row.department,
                    designation: row.designation,
                    hasRegisteredFace: row.hasRegisteredFace,
                    imageUrl: row.imagePath ?? null,
                    attendance: {
                        lastAction: last?.action ?? null,
                        lastActionAt: last?.createdAt ?? null,
                        canCheckIn: inVerdict.ok,
                        canCheckOut: outVerdict.ok,
                        // Populated when check-out is locked by the minimum gap.
                        minutesRemaining:
                            !outVerdict.ok && outVerdict.code === 'too-soon'
                                ? outVerdict.minutesRemaining ?? null
                                : null,
                        blockedReason: outVerdict.ok ? null : outVerdict.message,
                    },
                };
            }));

            return res.json({ success: true, data: { employees: enriched } });
        } catch (err: any) {
            console.error('[supervisor/search-employee]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Supervisor: mark attendance for another employee ─────────────────────
    // Body (JSON or multipart): `image` + `employeeId` + `action` + optional `attendanceDate` (YYYY-MM-DD).
    // The captured frame must be the TARGET employee's face — it is verified
    // against THEIR stored embedding, so a supervisor cannot punch someone in
    // by photographing themselves. Sequence rules (already checked in, minimum
    // gap, window expired) are evaluated for the target exactly like the
    // personal punch flow. Reuses the Redis + BullMQ pipeline via processPunch.
    // Authorization: employee must share a site with the supervisor (derived
    // server-side from employee_sites — never trusted from the client).
    public async handleSupervisorMarkAttendance(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

            const scope = await this.supervisorScope(userId)
            if (!scope) {
                return res.status(403).json({ success: false, message: 'Cross-device attendance facility is not enabled for this role.' });
            }

            const action = (req.body?.action as string) || '';
            if (action !== 'check-in' && action !== 'check-out') {
                return res.status(400).json({ success: false, message: 'Invalid action' });
            }

            const employeeId = (req.body?.employeeId as string) || '';
            if (!employeeId) {
                return res.status(400).json({ success: false, message: 'employeeId is required' });
            }

            let attendanceDate: string | null = null
            if (req.body?.attendanceDate !== undefined && req.body?.attendanceDate !== null && String(req.body.attendanceDate).trim() !== '') {
                const parsed = this.parseAttendanceDate(req.body.attendanceDate)
                if (!parsed) return res.status(400).json({ success: false, message: 'Invalid attendanceDate. Use YYYY-MM-DD, not in the future.' })
                attendanceDate = parsed
            }

            const base64 = this.extractBase64FromRequest(req);
            if (!base64) return res.status(400).json({ success: false, message: 'No image provided' });

            const [emp] = await db.select({ id: employees.id }).from(employees).where(eq(employees.id, employeeId));
            if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

            const siteId = await this.sharedSiteId(scope.siteIds, employeeId)
            if (!siteId) return res.status(403).json({ success: false, message: 'Employee is not assigned to your site.' });

            const target = await this.resolveForEmployeeId(employeeId);
            if (!target) return res.status(404).json({ success: false, message: 'Employee not found' });

            // Date-scoped idempotency before the multi-second face round trip,
            // so a double-tap doesn't pay for two verifications. Refused here
            // rather than inside processPunch, which keeps the shared pipeline
            // untouched for the self-punch flow.
            const day = attendanceDate ?? this.localDateKey(new Date())
            const acquireIdem = action === 'check-in' ? acquireCheckinLock : acquireCheckoutLock
            const releaseIdem = action === 'check-in' ? releaseCheckinLock : releaseCheckoutLock
            if (!(await acquireIdem(employeeId, day, siteId))) {
                return res.status(409).json({
                    success: false,
                    message: action === 'check-in'
                        ? 'Check-in is already being processed.'
                        : 'Checkout is already being processed.',
                });
            }
            try {
                const result = await this.processPunch(target, action, base64, 'supervisor', {
                    supervisorId: scope.user.id,
                    siteId,
                    attendanceMethod: 'biometric',
                    attendanceDate,
                    deviceInfo: this.deviceInfoFromRequest(req),
                });
                if (result.status === 200) {
                    await invalidateAttendanceCache(siteId, day)
                    // The web shift report embeds attendance state — drop it too.
                    // (Self-punch hot path relies on the 5-min TTL instead.)
                    await invalidateShiftReportCache()
                }
                if (result.status === 401) {
                    // Name the mismatch after the TARGET so the supervisor knows
                    // the frame didn't match the person being punched for.
                    result.body.message = `Face does not match ${target.firstName} ${target.lastName}`;
                }
                return res.status(result.status).json(result.body);
            } finally {
                await releaseIdem(employeeId, day, siteId)
            }
        } catch (err: any) {
            console.error('[supervisor/mark-attendance]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Supervisor: team roster for Employees Attendance ─────────────────────
    // GET /auth/supervisor/team?date=YYYY-MM-DD (defaults to today).
    // Returns ONLY employees assigned to site(s) managed by the logged-in
    // supervisor, each with backend-derived Present/Absent status for the day
    // plus checkout state. Frontend must not decide status locally.
    public async handleSupervisorTeam(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
            const scope = await this.supervisorScope(userId)
            if (!scope) return res.status(403).json({ success: false, message: 'Cross-device attendance facility is not enabled for this role.' });
            if (scope.siteIds.length === 0) return res.json({ success: true, data: { date: this.localDateKey(new Date()), employees: [] } });

            let day = this.localDateKey(new Date())
            if (req.query.date !== undefined && String(req.query.date).trim() !== '') {
                const parsed = this.parseAttendanceDate(req.query.date)
                if (!parsed) return res.status(400).json({ success: false, message: 'Invalid date. Use YYYY-MM-DD, not in the future.' })
                day = parsed
            }

            // Read-through attendance cache (spec: attendance:cache:{siteId}:{date},
            // TTL 5 min). Hits skip PG entirely; misses are computed below and
            // cached per site. Any Redis error falls back to PG transparently.
            // Note: cached rows embed the live gating fields (canCheckOut,
            // minutesRemaining), so a countdown can lag up to the TTL — the
            // next refresh re-reads PG and checkout is re-validated server-side.
            const cachedBySite = new Map<string, any[]>()
            const missSites: string[] = []
            for (const sid of scope.siteIds) {
                const hit = await getAttendanceListCached(sid, day)
                if (hit) cachedBySite.set(sid, hit)
                else missSites.push(sid)
            }

            const enrichOne = async (row: {
                id: string; firstName: string; lastName: string; phone: string;
                designation: string | null; hasRegisteredFace: boolean;
                imagePath: string | null; siteId: string; siteName: string;
            }, now: Date, isToday: boolean) => {
                const dayState = await this.dayPunchState(row.id, day)
                const last = await this.lastPunch(row.id)
                const inVerdict = evaluateAction('check-in', last, now)
                const outVerdict = evaluateAction('check-out', last, now)
                // ABSENT → no check-in; PRESENT → checked in, open;
                // COMPLETED → checked out; INCOMPLETE → closed with a reason
                // (check_out stays NULL — never a faked checkout).
                const status = dayState.incomplete
                    ? 'Incomplete'
                    : dayState.hasCheckOut
                        ? 'Completed'
                        : dayState.hasCheckIn
                            ? 'Present'
                            : 'Absent'
                const closed = status === 'Completed' || status === 'Incomplete'
                return {
                    id: row.id,
                    firstName: row.firstName,
                    lastName: row.lastName,
                    employeeName: `${row.firstName} ${row.lastName}`.trim(),
                    phone: row.phone,
                    designation: row.designation,
                    hasRegisteredFace: row.hasRegisteredFace,
                    imageUrl: row.imagePath ?? null,
                    siteId: dayState.siteId ?? row.siteId,
                    siteName: row.siteName,
                    attendanceDate: day,
                    status,
                    hasCheckedIn: dayState.hasCheckIn,
                    hasCheckedOut: dayState.hasCheckOut,
                    checkInAt: dayState.checkInAt,
                    checkOutAt: dayState.checkOutAt,
                    attendanceMethod: dayState.method ?? null,
                    incompleteReason: dayState.incomplete?.reason ?? null,
                    incompleteAt: dayState.incomplete?.at ?? null,
                    incompleteBy: dayState.incomplete?.by ?? null,
                    // Live rule verdicts for today drive button enablement;
                    // for historical days the day-state is the truth.
                    // Closed days offer no check-in/out — only View.
                    canCheckIn: closed ? false : (isToday ? inVerdict.ok && !dayState.hasCheckIn : !dayState.hasCheckIn),
                    canCheckOut: closed ? false : (isToday ? outVerdict.ok && dayState.hasCheckIn && !dayState.hasCheckOut : dayState.hasCheckIn && !dayState.hasCheckOut),
                    canMarkIncomplete: status === 'Present',
                    minutesRemaining: isToday && !outVerdict.ok && (outVerdict as any).code === 'too-soon' ? (outVerdict as any).minutesRemaining ?? null : null,
                    blockedReason: isToday && !outVerdict.ok && dayState.hasCheckIn && !dayState.hasCheckOut ? (outVerdict as any).message ?? null : null,
                }
            }

            if (missSites.length > 0) {
                // Roster read-through per supervisor+site (spec:
                // supervisor:employees:{supervisorId}:{siteId}, TTL 5 min).
                const rosterBySite = new Map<string, any[]>()
                const rosterMiss: string[] = []
                for (const sid of missSites) {
                    const rc = await getRosterCached(scope.user.id, sid)
                    if (rc) rosterBySite.set(sid, rc)
                    else rosterMiss.push(sid)
                }
                if (rosterMiss.length > 0) {
                    const pgRoster = await db
                        .select({
                            id: employees.id,
                            firstName: employees.firstName,
                            lastName: employees.lastName,
                            phone: employees.phone,
                            designation: employees.designation,
                            hasRegisteredFace: employees.hasRegisteredFace,
                            imagePath: employees.imagePath,
                            siteId: sites.id,
                            siteName: sites.siteName,
                        })
                        .from(employees)
                        .innerJoin(employeeSites, eq(employeeSites.employeeId, employees.id))
                        .innerJoin(sites, eq(sites.id, employeeSites.siteId))
                        .where(and(
                            inArray(employeeSites.siteId, rosterMiss),
                            eq(employees.isActive, true),
                        ))
                        .orderBy(asc(employees.firstName), asc(employees.lastName))
                    for (const sid of rosterMiss) {
                        const slice = pgRoster.filter((r) => r.siteId === sid)
                        await setRosterCached(scope.user.id, sid, slice)
                        rosterBySite.set(sid, slice)
                    }
                }

                const now = new Date()
                const isToday = day === this.localDateKey(new Date())
                for (const sid of missSites) {
                    const roster = rosterBySite.get(sid) ?? []
                    const enriched = await Promise.all(roster.map((row) => enrichOne(row, now, isToday)))
                    await setAttendanceListCached(sid, day, enriched)
                    cachedBySite.set(sid, enriched)
                }
            }

            // Merge per-site lists in site order, de-dupe employees posted to
            // 2+ of the supervisor's sites (keep first site), sort by name so
            // the order is stable regardless of cache hit/miss mix.
            const seen = new Map<string, any>()
            for (const sid of scope.siteIds) {
                for (const row of cachedBySite.get(sid) ?? []) {
                    if (!seen.has(row.id)) seen.set(row.id, row)
                }
            }
            const enriched = [...seen.values()]
                .sort((a, b) => String(a.firstName).localeCompare(String(b.firstName))
                    || String(a.lastName).localeCompare(String(b.lastName))
                    || String(a.id).localeCompare(String(b.id)))
                .map((row, i) => ({ slNo: i + 1, ...row }))

            // Audit display: who closed each INCOMPLETE day (from the session
            // user recorded at close time). Only incomplete rows need it.
            const closerIds = [...new Set(enriched.filter((r) => r.incompleteBy).map((r) => r.incompleteBy as string))]
            if (closerIds.length > 0) {
                const closers = await db
                    .select({
                        userId: usersTable.id,
                        firstName: employees.firstName,
                        lastName: employees.lastName,
                    })
                    .from(usersTable)
                    .leftJoin(employees, eq(employees.id, usersTable.employeeId))
                    .where(inArray(usersTable.id, closerIds))
                const names = new Map(closers.map((c) => [c.userId, `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || null]))
                for (const r of enriched) {
                    ;(r as any).incompleteByName = r.incompleteBy ? (names.get(r.incompleteBy) ?? null) : null
                }
            } else {
                for (const r of enriched) (r as any).incompleteByName = null
            }

            // Backend-computed day summary (never derived from visible rows).
            const summary = {
                date: day,
                totalEmployees: enriched.length,
                present: enriched.filter((r) => r.status === 'Present').length,
                completed: enriched.filter((r) => r.status === 'Completed').length,
                incomplete: enriched.filter((r) => r.status === 'Incomplete').length,
                absent: enriched.filter((r) => r.status === 'Absent').length,
            }

            return res.json({ success: true, data: { date: day, employees: enriched, summary } });
        } catch (err: any) {
            console.error('[supervisor/team]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Supervisor: manual attendance (no face verify, no camera) ────────────
    // POST /auth/supervisor/manual-attendance
    // Body JSON { employeeId, attendanceDate? } — the supervisor's authenticated
    // session is the audit trail, so no image is required. `image` (base64 of a
    // device-compressed JPEG) is still accepted for previously shipped builds and
    // stored under attendance-images/ when present. Either way the check-in goes
    // through the SAME day-state rules, Redis locks + BullMQ pipeline as biometric.
    public async handleSupervisorManualAttendance(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
            const scope = await this.supervisorScope(userId)
            if (!scope) return res.status(403).json({ success: false, message: 'Cross-device attendance facility is not enabled for this role.' });

            const employeeId = String(req.body?.employeeId ?? '').trim()
            if (!employeeId) return res.status(400).json({ success: false, message: 'employeeId is required' });

            let attendanceDate: string | null = null
            if (req.body?.attendanceDate !== undefined && req.body?.attendanceDate !== null && String(req.body.attendanceDate).trim() !== '') {
                const parsed = this.parseAttendanceDate(req.body.attendanceDate)
                if (!parsed) return res.status(400).json({ success: false, message: 'Invalid attendanceDate. Use YYYY-MM-DD, not in the future.' })
                attendanceDate = parsed
            }
            const day = attendanceDate ?? this.localDateKey(new Date())

            // Optional by design: manual mode is image-less. Absent means "no
            // image", not "no attendance" — the check-in itself is what matters.
            const base64 = this.extractBase64FromRequest(req);

            const [emp] = await db.select({ id: employees.id }).from(employees).where(eq(employees.id, employeeId));
            if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

            const siteId = await this.sharedSiteId(scope.siteIds, employeeId)
            if (!siteId) return res.status(403).json({ success: false, message: 'Employee is not assigned to your site.' });

            const dayState = await this.dayPunchState(employeeId, day)
            if (dayState.incomplete) return res.status(409).json({ success: false, message: 'Attendance is closed as incomplete for the selected date.' });
            if (dayState.hasCheckIn) return res.status(409).json({ success: false, message: 'Already checked in for the selected date.' });

            // Today also respects the live sequence rules (already-checked-in).
            if (day === this.localDateKey(new Date())) {
                const last = await this.lastPunch(employeeId)
                const verdict = evaluateAction('check-in', last, new Date())
                if (!verdict.ok) return res.status(409).json({ success: false, message: verdict.message, data: { code: (verdict as any).code } });
            }

            // Date-scoped idempotency (spec: attendance:checkin:{employee}:{date}:{site},
            // SET NX EX 30s) against double-taps/retries; the PG partial unique
            // index is the final guarantee. Kept alongside the punch lock, which
            // serialises the verify pipeline for the same person.
            if (!(await acquireCheckinLock(employeeId, day, siteId))) {
                return res.status(409).json({ success: false, message: 'Check-in is already being processed.' });
            }
            if (!(await acquirePunchLock(employeeId))) {
                await releaseCheckinLock(employeeId, day, siteId)
                return res.status(409).json({ success: false, message: 'A punch for this employee is already being processed. Please retry.' });
            }
            try {
                let imagePath: string | null = null
                if (base64) {
                    try {
                        imagePath = await saveAttendanceImage(employeeId, day, base64)
                    } catch (e: any) {
                        return res.status(400).json({ success: false, message: `Image save failed: ${e?.message ?? 'invalid image'}` });
                    }
                }

                const at = new Date()
                if (day === this.localDateKey(new Date())) await setLastPunchCached(employeeId, { action: 'check-in', createdAt: at });
                try {
                    await enqueueAttendance({
                        employeeId,
                        action: 'check-in',
                        faceDistance: null,
                        source: 'supervisor',
                        supervisorId: scope.user.id,
                        siteId,
                        attendanceMethod: 'manual',
                        imagePath,
                        attendanceDate: day,
                        deviceInfo: this.deviceInfoFromRequest(req),
                    })
                } catch (e: any) {
                    if (day === this.localDateKey(new Date())) await setLastPunchCached(employeeId, await this.lastPunch(employeeId));
                    // A legacy photo build landed the image but the attendance did
                    // not — remove the orphan so failed check-ins never accumulate
                    // images. (No-op when nothing was stored, i.e. manual mode.)
                    await deleteAttendanceImage(imagePath)
                    console.error('[supervisor/manual] enqueue failed:', e?.message)
                    return res.status(503).json({ success: false, message: 'Could not record attendance. Please retry.' });
                }

                // PG-affecting step accepted → invalidate the day cache so the
                // next grid read comes from Postgres, not stale Redis data.
                await invalidateAttendanceCache(siteId, day)
                await invalidateShiftReportCache()

                return res.json({ success: true, verified: true, message: 'Manual check-in recorded', data: { action: 'check-in', at: at.toISOString(), attendanceDate: day, imagePath, siteId } });
            } finally {
                await releasePunchLock(employeeId);
                await releaseCheckinLock(employeeId, day, siteId)
            }
        } catch (err: any) {
            console.error('[supervisor/manual-attendance]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Supervisor: checkout (no image — identity was fixed at check-in) ─────
    // POST /auth/supervisor/checkout { employeeId, attendanceDate? }
    // Records check-out via the same queue; refuses double checkout.
    public async handleSupervisorCheckout(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
            const scope = await this.supervisorScope(userId)
            if (!scope) return res.status(403).json({ success: false, message: 'Cross-device attendance facility is not enabled for this role.' });

            const employeeId = String(req.body?.employeeId ?? '').trim()
            if (!employeeId) return res.status(400).json({ success: false, message: 'employeeId is required' });

            let attendanceDate: string | null = null
            if (req.body?.attendanceDate !== undefined && req.body?.attendanceDate !== null && String(req.body.attendanceDate).trim() !== '') {
                const parsed = this.parseAttendanceDate(req.body.attendanceDate)
                if (!parsed) return res.status(400).json({ success: false, message: 'Invalid attendanceDate. Use YYYY-MM-DD, not in the future.' })
                attendanceDate = parsed
            }
            const day = attendanceDate ?? this.localDateKey(new Date())

            const [emp] = await db.select({ id: employees.id }).from(employees).where(eq(employees.id, employeeId));
            if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

            const siteId = await this.sharedSiteId(scope.siteIds, employeeId)
            if (!siteId) return res.status(403).json({ success: false, message: 'Employee is not assigned to your site.' });

            const dayState = await this.dayPunchState(employeeId, day)
            if (!dayState.hasCheckIn) return res.status(409).json({ success: false, message: 'Cannot check out without checking in for the selected date.' });
            if (dayState.incomplete) return res.status(409).json({ success: false, message: 'Attendance is closed as incomplete for the selected date.' });
            if (dayState.hasCheckOut) return res.status(409).json({ success: false, message: 'Already checked out for the selected date.' });

            if (day === this.localDateKey(new Date())) {
                const last = await this.lastPunch(employeeId)
                const verdict = evaluateAction('check-out', last, new Date())
                if (!verdict.ok) return res.status(409).json({ success: false, message: verdict.message, data: { code: (verdict as any).code, minutesRemaining: (verdict as any).minutesRemaining ?? null } });
            }

            // Date-scoped idempotency (spec: attendance:checkout:{employee}:{date}:{site}).
            // Prevents concurrent duplicate checkouts; the PG partial unique
            // index refuses any second checkout row regardless.
            if (!(await acquireCheckoutLock(employeeId, day, siteId))) {
                return res.status(409).json({ success: false, message: 'Checkout is already being processed.' });
            }
            if (!(await acquirePunchLock(employeeId))) {
                await releaseCheckoutLock(employeeId, day, siteId)
                return res.status(409).json({ success: false, message: 'A punch for this employee is already being processed. Please retry.' });
            }
            try {
                // Re-validate inside the locks: a concurrent mark-incomplete or
                // checkout may have closed the day while this request waited.
                const fresh = await this.dayPunchState(employeeId, day)
                if (!fresh.hasCheckIn) return res.status(409).json({ success: false, message: 'Cannot check out without checking in for the selected date.' });
                if (fresh.incomplete) return res.status(409).json({ success: false, message: 'Attendance is closed as incomplete for the selected date.' });
                if (fresh.hasCheckOut) return res.status(409).json({ success: false, message: 'Already checked out for the selected date.' });

                const at = new Date()
                if (day === this.localDateKey(new Date())) await setLastPunchCached(employeeId, { action: 'check-out', createdAt: at });
                try {
                    await enqueueAttendance({
                        employeeId,
                        action: 'check-out',
                        faceDistance: null,
                        source: 'supervisor',
                        supervisorId: scope.user.id,
                        siteId,
                        attendanceMethod: (fresh.method as any) ?? 'biometric',
                        attendanceDate: day,
                    })
                } catch (e: any) {
                    console.error('[supervisor/checkout] enqueue failed:', e?.message)
                    return res.status(503).json({ success: false, message: 'Could not record checkout. Please retry.' });
                }
                await invalidateAttendanceCache(siteId, day)
                await invalidateShiftReportCache()
                return res.json({ success: true, message: 'Checked out successfully', data: { action: 'check-out', at: at.toISOString(), attendanceDate: day } });
            } finally {
                await releasePunchLock(employeeId);
                await releaseCheckoutLock(employeeId, day, siteId)
            }
        } catch (err: any) {
            console.error('[supervisor/checkout]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Supervisor: mark attendance incomplete (employee left before checkout) ──
    // POST /auth/supervisor/mark-incomplete { employeeId, attendanceDate?, reason }
    // Closes a PRESENT day without faking a checkout: check_out stays NULL and
    // the check-in row carries incomplete_reason/at/by (the audit trail — who,
    // when, why — comes from the authenticated session, never the client).
    // Allowed only from PRESENT; COMPLETED/INCOMPLETE days are rejected.
    public async handleMarkIncomplete(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
            const scope = await this.supervisorScope(userId)
            if (!scope) return res.status(403).json({ success: false, message: 'Cross-device attendance facility is not enabled for this role.' });

            const employeeId = String(req.body?.employeeId ?? '').trim()
            if (!employeeId) return res.status(400).json({ success: false, message: 'employeeId is required' });

            const reason = this.parseIncompleteReason(req.body?.reason)
            if (!reason) {
                const rawLen = String(req.body?.reason ?? '').trim().length
                return res.status(400).json({
                    success: false,
                    message: rawLen > 500
                        ? 'Reason cannot exceed 500 characters.'
                        : 'A reason is required to mark attendance incomplete.',
                });
            }

            let attendanceDate: string | null = null
            if (req.body?.attendanceDate !== undefined && req.body?.attendanceDate !== null && String(req.body.attendanceDate).trim() !== '') {
                const parsed = this.parseAttendanceDate(req.body.attendanceDate)
                if (!parsed) return res.status(400).json({ success: false, message: 'Invalid attendanceDate. Use YYYY-MM-DD, not in the future.' })
                attendanceDate = parsed
            }
            const day = attendanceDate ?? this.localDateKey(new Date())

            const [emp] = await db.select({
                id: employees.id,
                firstName: employees.firstName,
                lastName: employees.lastName,
            }).from(employees).where(eq(employees.id, employeeId));
            if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

            const siteId = await this.sharedSiteId(scope.siteIds, employeeId)
            if (!siteId) return res.status(403).json({ success: false, message: 'Employee is not assigned to your site.' });

            const dayState = await this.dayPunchState(employeeId, day)
            if (!dayState.hasCheckIn) return res.status(409).json({ success: false, message: 'Cannot mark incomplete without checking in for the selected date.' });
            if (dayState.hasCheckOut) return res.status(409).json({ success: false, message: 'Attendance is already completed for the selected date.' });
            if (dayState.incomplete) return res.status(409).json({ success: false, message: 'Attendance is already marked incomplete for the selected date.' });

            // Serialize with checkout/check-in for the same person (punch lock)
            // plus the date-scoped incomplete idempotency lock for double-taps.
            if (!(await acquireIncompleteLock(employeeId, day, siteId))) {
                return res.status(409).json({ success: false, message: 'Incomplete marking is already being processed.' });
            }
            if (!(await acquirePunchLock(employeeId))) {
                await releaseIncompleteLock(employeeId, day, siteId)
                return res.status(409).json({ success: false, message: 'A punch for this employee is already being processed. Please retry.' });
            }
            try {
                // Atomic close: the UPDATE only touches a still-PRESENT day, so
                // two simultaneous requests (or a racing checkout) cannot both
                // succeed — the loser updates zero rows.
                //
                // "Still open" is judged per SITE, not per day: an officer who
                // worked A and then B has a check-out on the day (at A) and an
                // unclosed duty at B, and a day-wide test would refuse to close
                // B as incomplete. Rows punched without a site compare NULL to
                // NULL here, so every other role behaves exactly as before.
                const updated = await db.execute(sql`
                    update attendance_logs ci set
                        incomplete_reason = ${reason},
                        incomplete_at = now(),
                        incomplete_by = ${scope.user.id}
                    where ci.id = (
                        select open.id from attendance_logs open
                        where open.employee_id = ${employeeId}
                          and open.action = 'check-in'
                          and open.incomplete_reason is null
                          and coalesce(open.attendance_date, (open.created_at at time zone 'Asia/Kolkata')::date) = ${day}::date
                          and not exists (
                              select 1 from attendance_logs co
                              where co.employee_id = open.employee_id
                                and co.action = 'check-out'
                                and coalesce(co.attendance_date, (co.created_at at time zone 'Asia/Kolkata')::date) = ${day}::date
                                and co.site_id is not distinct from open.site_id
                          )
                        order by open.created_at desc
                        limit 1
                    )
                    and ci.incomplete_reason is null
                    returning ci.id
                `)
                if (updated.rows.length === 0) {
                    return res.status(409).json({ success: false, message: 'Attendance has already been completed or closed.' });
                }

                await invalidateAttendanceCache(siteId, day)
                await invalidateShiftReportCache()
                // The day is closed: whatever the officer's own punch reserved
                // for it must not keep offering a check-out the database now
                // refuses, so the next read rebuilds the day from these rows.
                await invalidateDaySlots(employeeId, day)

                const [srow] = await db.select({ siteName: sites.siteName }).from(sites).where(eq(sites.id, siteId)).limit(1)
                return res.json({
                    success: true,
                    message: 'Attendance marked incomplete.',
                    data: {
                        employeeId,
                        employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
                        siteId,
                        siteName: srow?.siteName ?? null,
                        attendanceDate: day,
                        status: 'Incomplete',
                        checkInAt: dayState.checkInAt,
                        incompleteAt: new Date().toISOString(),
                        reason,
                    },
                });
            } finally {
                await releasePunchLock(employeeId);
                await releaseIncompleteLock(employeeId, day, siteId)
            }
        } catch (err: any) {
            console.error('[supervisor/mark-incomplete]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Supervisor: employee violations (report-only, immutable) ─────────────
    // A submission records an observation — it takes NO disciplinary action
    // (nothing in the system reads this table for enforcement). All ids come
    // from the session + site mappings; the client supplies only the target
    // employee, the type key and the reason.
    public async handleCreateViolation(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
            const scope = await this.supervisorScope(userId, ['employee-violations'])
            if (!scope) return res.status(403).json({ success: false, message: 'Employee violations facility is not enabled for this role.' });

            const employeeId = String(req.body?.employeeId ?? '').trim()
            if (!employeeId) return res.status(400).json({ success: false, message: 'employeeId is required' });

            const violationType = String(req.body?.violationType ?? '').trim()
            if (!VIOLATION_LABELS[violationType]) {
                return res.status(400).json({ success: false, message: 'Please select a violation type.' });
            }

            const reason = this.parseViolationReason(req.body?.reason)
            if (!reason) {
                const rawLen = String(req.body?.reason ?? '').trim().length
                return res.status(400).json({
                    success: false,
                    message: rawLen > MAX_VIOLATION_REASON
                        ? `Reason cannot exceed ${MAX_VIOLATION_REASON} characters.`
                        : 'A reason is required to report a violation.',
                });
            }

            const [emp] = await db.select({
                id: employees.id,
                firstName: employees.firstName,
                lastName: employees.lastName,
            }).from(employees).where(eq(employees.id, employeeId));
            if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

            const siteId = await this.sharedSiteId(scope.siteIds, employeeId)
            if (!siteId) return res.status(403).json({ success: false, message: 'This employee is not assigned to your site.' });

            // Double-tap guard (repeat violations against one employee stay
            // legitimate, so there is no PG unique key — this lock + the
            // disabled Submit button is the double-submit protection).
            if (!(await acquireViolationCreateLock(scope.user.id, employeeId))) {
                return res.status(409).json({ success: false, message: 'Violation submission is already being processed.' });
            }
            try {
                // Optional evidence photo (base64 JSON, same reliable path as
                // the shift group photo). Saved only when the supervisor
                // actually attached one; an unreadable/oversize attachment is a
                // 400 so they know it didn't save — the report itself is never
                // lost because nothing is written until the image decodes.
                const evidenceBase64 = this.extractBase64FromRequest(req)
                let evidenceImagePath: string | null = null
                if (evidenceBase64) {
                    try {
                        evidenceImagePath = await saveViolationEvidenceImage(employeeId, evidenceBase64)
                    } catch (e: any) {
                        return res.status(400).json({ success: false, message: `Invalid evidence photo: ${e?.message ?? 'unreadable image'}` })
                    }
                }

                const [row] = await db.insert(employeeViolations).values({
                    employeeId,
                    siteId,
                    supervisorId: scope.user.id,
                    violationType,
                    reason,
                    ...(evidenceImagePath ? { evidenceImagePath } : {}),
                }).returning()
                if (!row) throw new Error('Violation insert returned no row')

                await invalidateViolationReportCache()

                const [srow] = await db.select({ siteName: sites.siteName }).from(sites).where(eq(sites.id, siteId)).limit(1)
                return res.status(201).json({
                    success: true,
                    message: 'Violation reported successfully.',
                    data: {
                        id: row.id,
                        employeeId,
                        employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
                        siteId,
                        siteName: srow?.siteName ?? null,
                        violationType,
                        violationTypeLabel: VIOLATION_LABELS[violationType],
                        reason: row.reason,
                        evidenceImageUrl: this.violationEvidenceUrl(row.evidenceImagePath),
                        violationDate: row.violationDate,
                        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
                    },
                });
            } finally {
                await releaseViolationCreateLock(scope.user.id, employeeId)
            }
        } catch (err: any) {
            console.error('[supervisor/create-violation]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // GET /auth/supervisor/violations?date=YYYY-MM-DD (optional) — violations
    // at the supervisor's own sites, newest first. No date defaults to recent
    // history (limit 200); the admin report owns date-scoped paging.
    public async handleListViolations(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
            const scope = await this.supervisorScope(userId, ['employee-violations'])
            if (!scope) return res.status(403).json({ success: false, message: 'Employee violations facility is not enabled for this role.' });
            if (scope.siteIds.length === 0) return res.json({ success: true, data: { violations: [] } });

            let day: string | null = null
            if (req.query.date !== undefined && String(req.query.date).trim() !== '') {
                const parsed = this.parseAttendanceDate(req.query.date)
                if (!parsed) return res.status(400).json({ success: false, message: 'Invalid date. Use YYYY-MM-DD, not in the future.' })
                day = parsed
            }

            const conds = [inArray(employeeViolations.siteId, scope.siteIds)]
            if (day) conds.push(eq(employeeViolations.violationDate, day))

            const rows = await db
                .select({
                    id: employeeViolations.id,
                    violationType: employeeViolations.violationType,
                    reason: employeeViolations.reason,
                    evidenceImagePath: employeeViolations.evidenceImagePath,
                    violationDate: employeeViolations.violationDate,
                    createdAt: employeeViolations.createdAt,
                    employeeId: employees.id,
                    firstName: employees.firstName,
                    lastName: employees.lastName,
                    phone: employees.phone,
                    siteName: sites.siteName,
                })
                .from(employeeViolations)
                .innerJoin(employees, eq(employees.id, employeeViolations.employeeId))
                .innerJoin(sites, eq(sites.id, employeeViolations.siteId))
                .where(and(...conds))
                .orderBy(desc(employeeViolations.createdAt))
                .limit(200)

            return res.json({
                success: true,
                data: {
                    violations: rows.map((r, i) => ({
                        slNo: i + 1,
                        id: r.id,
                        employeeId: r.employeeId,
                        employeeName: `${r.firstName} ${r.lastName}`.trim(),
                        phone: r.phone,
                        siteName: r.siteName,
                        violationType: r.violationType,
                        violationTypeLabel: VIOLATION_LABELS[r.violationType] ?? r.violationType,
                        reason: r.reason,
                        evidenceImageUrl: this.violationEvidenceUrl(r.evidenceImagePath),
                        violationDate: r.violationDate,
                        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
                        // Reports are immutable observations, never findings.
                        status: 'Reported',
                    })),
                },
            });
        } catch (err: any) {
            console.error('[supervisor/list-violations]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // GET /auth/supervisor/violation-types — the controlled vocabulary for the
    // mobile dropdown, so labels never drift between client and server.
    public async handleViolationTypes(req: Request, res: Response) {
        return res.json({ success: true, data: { types: VIOLATION_TYPES } });
    }

    // ── Shift Attendance (Supervisor group summary, separate from Employees Attendance) ──
    // Table: shift_attendance (site + date + shift unique). PG is the source of
    // truth; Redis holds a 5-min list cache + 30s create lock. No BullMQ — this
    // is a low-frequency summary write, not the punch hot path.
    private parseShift(value: unknown): ShiftValue | null {
        const s = String(value ?? '').trim().toLowerCase()
        return (SHIFT_VALUES as readonly string[]).includes(s) ? (s as ShiftValue) : null
    }

    private parsePresentEmployees(value: unknown): number | null {
        if (typeof value === 'number') {
            if (!Number.isInteger(value)) return null
            return value
        }
        const s = String(value ?? '').trim()
        if (!/^\d+$/.test(s)) return null
        const n = Number(s)
        if (!Number.isSafeInteger(n)) return null
        return n
    }

    private parseShiftDescription(value: unknown): string | null {
        if (value === undefined || value === null) return null
        const s = String(value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim()
        if (s.length === 0) return null
        if (s.length > MAX_SHIFT_DESC) return null
        return s
    }

    /** Supervisor's site for shift writes: validated hint or first assigned site. */
    private resolveShiftSite(scopeSiteIds: string[], hint: unknown): string | null {
        if (scopeSiteIds.length === 0) return null
        const h = String(hint ?? '').trim()
        if (h && scopeSiteIds.includes(h)) return h
        return scopeSiteIds[0] ?? null
    }

    private shiftRowToJson(row: any, siteName: string | null) {
        // DB stores a relative path ("shift-attendance-images/<file>"); the
        // public URL is under the existing /uploads static mount. Older rows
        // and the mobile helper both tolerate either form — always emit the
        // absolute public path here so `${API_BASE_URL}${imageUrl}` just works.
        const stored: string | null = row.imagePath ?? null
        const imageUrl = !stored
            ? null
            : stored.startsWith('/uploads/')
                ? stored
                : stored.startsWith('/')
                    ? `/uploads${stored}`
                    : `/uploads/${stored}`
        return {
            id: row.id,
            siteId: row.siteId,
            siteName,
            attendanceDate: row.attendanceDate,
            shift: row.shift,
            presentEmployees: row.presentEmployees,
            description: row.description ?? null,
            imagePath: row.imagePath,
            // Same file served by the existing /uploads static mount; the grid
            // renders it small, the preview modal loads the same URL larger.
            imageUrl,
            createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
            updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
        }
    }

    // GET /auth/supervisor/shift-attendance?date=YYYY-MM-DD&siteId=...
    // Lists the supervisor's own sites (all when no siteId hint). Date is
    // optional; when present the per-site Redis list cache is used.
    public async handleListShiftAttendance(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
            const scope = await this.supervisorScope(userId, ['shift-attendance'])
            if (!scope) return res.status(403).json({ success: false, message: 'Shift attendance facility is not enabled for this role.' });
            if (scope.siteIds.length === 0) return res.json({ success: true, data: { records: [] } });

            let day: string | null = null
            if (req.query.date !== undefined && String(req.query.date).trim() !== '') {
                const parsed = this.parseAttendanceDate(req.query.date)
                if (!parsed) return res.status(400).json({ success: false, message: 'Invalid date. Use YYYY-MM-DD, not in the future.' })
                day = parsed
            }

            const hintSite = String((req.query as any).siteId ?? '').trim()
            const siteIds = hintSite
                ? (scope.siteIds.includes(hintSite) ? [hintSite] : null)
                : scope.siteIds
            if (!siteIds) return res.status(403).json({ success: false, message: 'Site is not assigned to you.' });

            const siteNames = new Map<string, string>()
            if (siteIds.length > 0) {
                const srows = await db.select({ id: sites.id, siteName: sites.siteName }).from(sites).where(inArray(sites.id, siteIds))
                for (const s of srows) siteNames.set(s.id, s.siteName)
            }

            // Date-filtered reads go through the 5-min Redis cache per site;
            // unfiltered history reads PG directly. Redis miss/error → PG.
            const out: any[] = []
            const missSites: string[] = []
            if (day) {
                for (const sid of siteIds) {
                    const cached = await getShiftListCached(sid, day)
                    if (cached) out.push(...cached)
                    else missSites.push(sid)
                }
            } else {
                missSites.push(...siteIds)
            }

            if (missSites.length > 0) {
                const conds = [inArray(shiftAttendance.siteId, missSites)]
                if (day) conds.push(eq(shiftAttendance.attendanceDate, day))
                const prows = await db
                    .select()
                    .from(shiftAttendance)
                    .where(and(...conds))
                    .orderBy(desc(shiftAttendance.attendanceDate), desc(shiftAttendance.createdAt))
                    .limit(200)
                const bySite = new Map<string, any[]>()
                for (const r of prows) {
                    const json = this.shiftRowToJson(r, siteNames.get(r.siteId) ?? null)
                    out.push(json)
                    if (day) {
                        const arr = bySite.get(r.siteId) ?? []
                        arr.push(json)
                        bySite.set(r.siteId, arr)
                    }
                }
                if (day) {
                    for (const [sid, arr] of bySite) await setShiftListCached(sid, day, arr)
                    for (const sid of missSites) {
                        if (!bySite.has(sid)) await setShiftListCached(sid, day, [])
                    }
                }
            }

            out.sort((a, b) => String(b.attendanceDate).localeCompare(String(a.attendanceDate)) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
            return res.json({ success: true, data: { records: out } });
        } catch (err: any) {
            console.error('[supervisor/shift-list]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // POST /auth/supervisor/shift-attendance
    // Accepts JSON { shift, present_employees, description?, image (base64), attendanceDate?, siteId? }
    // or multipart `image` file + fields. Site/supervisor/date come from auth.
    public async handleCreateShiftAttendance(req: Request, res: Response) {
        let lockSite: string | null = null
        let lockDay = ''
        let lockShift: ShiftValue | null = null
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
            const scope = await this.supervisorScope(userId, ['shift-attendance'])
            if (!scope) return res.status(403).json({ success: false, message: 'Shift attendance facility is not enabled for this role.' });

            const shift = this.parseShift(req.body?.shift)
            if (!shift) return res.status(400).json({ success: false, message: 'Please select a shift (Morning, Day, Night, General).' });

            const present = this.parsePresentEmployees(req.body?.present_employees ?? req.body?.presentEmployees)
            if (present === null || present <= 0) return res.status(400).json({ success: false, message: 'Please enter the number of employees present (positive whole number).' });
            if (present > MAX_SHIFT_PRESENT) return res.status(400).json({ success: false, message: `Present employees cannot exceed ${MAX_SHIFT_PRESENT}.` });

            const rawDesc = req.body?.description
            if (rawDesc !== undefined && rawDesc !== null && String(rawDesc).length > MAX_SHIFT_DESC + 100) {
                return res.status(400).json({ success: false, message: `Description cannot exceed ${MAX_SHIFT_DESC} characters.` });
            }
            const description = this.parseShiftDescription(rawDesc)
            if (rawDesc !== undefined && rawDesc !== null && String(rawDesc).trim().length > 0 && description === null) {
                return res.status(400).json({ success: false, message: `Description cannot exceed ${MAX_SHIFT_DESC} characters.` });
            }

            let day = this.localDateKey(new Date())
            if (req.body?.attendanceDate !== undefined && req.body?.attendanceDate !== null && String(req.body.attendanceDate).trim() !== '') {
                const parsed = this.parseAttendanceDate(req.body.attendanceDate)
                if (!parsed) return res.status(400).json({ success: false, message: 'Invalid attendanceDate. Use YYYY-MM-DD, not in the future.' })
                day = parsed
            }

            const siteId = this.resolveShiftSite(scope.siteIds, req.body?.siteId)
            if (!siteId) return res.status(400).json({ success: false, message: 'No work site assigned to your account. Please contact your administrator.' });

            const base64 = this.extractBase64FromRequest(req);
            if (!base64) return res.status(400).json({ success: false, message: 'Please capture or select a group photo.' });

            // Idempotency: second tap / retry while the first is in flight.
            if (!(await acquireShiftCreateLock(siteId, day, shift))) {
                return res.status(409).json({ success: false, message: 'Attendance submission is already being processed.' });
            }
            lockSite = siteId; lockDay = day; lockShift = shift

            // Fast duplicate check (PG unique is the final guard).
            const [dup] = await db
                .select({ id: shiftAttendance.id })
                .from(shiftAttendance)
                .where(and(
                    eq(shiftAttendance.siteId, siteId),
                    eq(shiftAttendance.attendanceDate, day),
                    eq(shiftAttendance.shift, shift),
                ))
                .limit(1)
            if (dup) {
                return res.status(409).json({ success: false, message: `${shift[0]!.toUpperCase()}${shift.slice(1)} shift attendance has already been submitted for this date.` });
            }

            let imagePath: string
            try {
                imagePath = await saveShiftAttendanceImage(siteId, day, shift, base64)
            } catch (e: any) {
                return res.status(400).json({ success: false, message: `Invalid group photo: ${e?.message ?? 'unreadable image'}` });
            }

            let row: any
            try {
                const [ins] = await db.insert(shiftAttendance).values({
                    siteId,
                    supervisorId: scope.user.id,
                    attendanceDate: day,
                    shift,
                    presentEmployees: present,
                    description,
                    imagePath,
                }).returning()
                row = ins
            } catch (e: any) {
                if (e?.code === '23505' || String(e?.cause?.code ?? '') === '23505' || /unique|duplicate/i.test(e?.message ?? '')) {
                    return res.status(409).json({ success: false, message: `${shift[0]!.toUpperCase()}${shift.slice(1)} shift attendance has already been submitted for this date.` });
                }
                throw e
            }

            // PG committed → best-effort Redis invalidation (never fails the request).
            // FO report lists cache the same rows per officer — drop those too.
            await invalidateShiftList(siteId, day)
            await invalidateFoShiftCache(siteId, day)
            await invalidateShiftReportCache()

            const [srow] = await db.select({ siteName: sites.siteName }).from(sites).where(eq(sites.id, siteId)).limit(1)
            return res.status(201).json({ success: true, message: 'Shift attendance saved successfully.', data: this.shiftRowToJson(row, srow?.siteName ?? null) });
        } catch (err: any) {
            console.error('[supervisor/shift-create]', err);
            return res.status(500).json({ success: false, message: err.message });
        } finally {
            if (lockSite && lockShift) await releaseShiftCreateLock(lockSite, lockDay, lockShift)
        }
    }

    // GET /auth/supervisor/shift-attendance/:id
    public async handleGetShiftAttendance(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
            const scope = await this.supervisorScope(userId, ['shift-attendance'])
            if (!scope) return res.status(403).json({ success: false, message: 'Shift attendance facility is not enabled for this role.' });

            const id = String((req.params as any)?.id ?? '')
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
                return res.status(400).json({ success: false, message: 'Invalid record id.' });
            }

            const [row] = await db.select().from(shiftAttendance).where(eq(shiftAttendance.id, id)).limit(1)
            if (!row) return res.status(404).json({ success: false, message: 'Shift attendance not found.' });
            if (!scope.siteIds.includes(row.siteId)) return res.status(403).json({ success: false, message: 'Not authorized for this site.' });

            const [srow] = await db.select({ siteName: sites.siteName }).from(sites).where(eq(sites.id, row.siteId)).limit(1)
            return res.json({ success: true, data: this.shiftRowToJson(row, srow?.siteName ?? null) });
        } catch (err: any) {
            console.error('[supervisor/shift-get]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // PUT /auth/supervisor/shift-attendance/:id — update shift/present/description/image.
    public async handleUpdateShiftAttendance(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
            const scope = await this.supervisorScope(userId, ['shift-attendance'])
            if (!scope) return res.status(403).json({ success: false, message: 'Shift attendance facility is not enabled for this role.' });

            const id = String((req.params as any)?.id ?? '')
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
                return res.status(400).json({ success: false, message: 'Invalid record id.' });
            }

            const [row] = await db.select().from(shiftAttendance).where(eq(shiftAttendance.id, id)).limit(1)
            if (!row) return res.status(404).json({ success: false, message: 'Shift attendance not found.' });
            if (!scope.siteIds.includes(row.siteId)) return res.status(403).json({ success: false, message: 'Not authorized for this site.' });

            const patch: Partial<{ shift: ShiftValue; presentEmployees: number; description: string | null; imagePath: string }> = {}

            if (req.body?.shift !== undefined) {
                const shift = this.parseShift(req.body.shift)
                if (!shift) return res.status(400).json({ success: false, message: 'Please select a shift (Morning, Day, Night, General).' });
                patch.shift = shift
            }
            if (req.body?.present_employees !== undefined || req.body?.presentEmployees !== undefined) {
                const present = this.parsePresentEmployees(req.body?.present_employees ?? req.body?.presentEmployees)
                if (present === null || present <= 0) return res.status(400).json({ success: false, message: 'Please enter the number of employees present (positive whole number).' });
                if (present > MAX_SHIFT_PRESENT) return res.status(400).json({ success: false, message: `Present employees cannot exceed ${MAX_SHIFT_PRESENT}.` });
                patch.presentEmployees = present
            }
            if (req.body?.description !== undefined) {
                if (req.body.description !== null && String(req.body.description).length > MAX_SHIFT_DESC + 100) {
                    return res.status(400).json({ success: false, message: `Description cannot exceed ${MAX_SHIFT_DESC} characters.` });
                }
                const d = this.parseShiftDescription(req.body.description)
                if (req.body.description !== null && String(req.body.description).trim().length > 0 && d === null) {
                    return res.status(400).json({ success: false, message: `Description cannot exceed ${MAX_SHIFT_DESC} characters.` });
                }
                patch.description = d
            }

            const base64 = this.extractBase64FromRequest(req);
            if (base64) {
                try {
                    patch.imagePath = await saveShiftAttendanceImage(row.siteId, row.attendanceDate, patch.shift ?? row.shift, base64)
                } catch (e: any) {
                    return res.status(400).json({ success: false, message: `Invalid group photo: ${e?.message ?? 'unreadable image'}` });
                }
            }

            if (Object.keys(patch).length === 0) {
                return res.status(400).json({ success: false, message: 'Provide at least one field to update (shift, present employees, description, image).' });
            }

            let updated: any
            try {
                const [u] = await db.update(shiftAttendance).set({ ...patch, updatedAt: new Date() }).where(eq(shiftAttendance.id, id)).returning()
                updated = u
            } catch (e: any) {
                if (e?.code === '23505' || String(e?.cause?.code ?? '') === '23505' || /unique|duplicate/i.test(e?.message ?? '')) {
                    const s = patch.shift ?? row.shift
                    return res.status(409).json({ success: false, message: `${String(s)[0]!.toUpperCase()}${String(s).slice(1)} shift attendance has already been submitted for this date.` });
                }
                throw e
            }

            await invalidateShiftList(row.siteId, row.attendanceDate)
            await invalidateFoShiftCache(row.siteId, row.attendanceDate)
            await invalidateShiftReportCache()
            const [srow] = await db.select({ siteName: sites.siteName }).from(sites).where(eq(sites.id, row.siteId)).limit(1)
            return res.json({ success: true, message: 'Shift attendance updated.', data: this.shiftRowToJson(updated, srow?.siteName ?? null) });
        } catch (err: any) {
            console.error('[supervisor/shift-update]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Report collector: submit daily report ────────────────────────────────
    // Multipart fields:
    //   image  — face frame for authentication (same /verify pipeline as attendance)
    //   file   — the report document (PDF / Excel / CSV) — OPTIONAL
    //   description — notes typed by the collector; required when no file is sent
    //   lat    — device GPS latitude  (optional but encouraged)
    //   lng    — device GPS longitude (optional)
    public async handleSubmitReport(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            // "Report Collector" is a facility (the client-visits page key),
            // not a role — see REPORT_COLLECTOR_FACILITY_PAGES above.
            if (!user) return res.status(404).json({ success: false, message: 'Account not found' });
            const callerRoles: string[] = user.roles && user.roles.length > 0 ? user.roles : [user.role ?? 'employee'];
            if (!(await hasReportCollectorFacility(callerRoles))) {
                return res.status(403).json({ success: false, message: 'Report Collector facility is not enabled for your role' });
            }

            if (!user.employeeId) return res.status(404).json({ success: false, message: 'Employee not linked' });

            // ── face auth ─────────────────────────────────────────────────
            const faceBase64 = this.extractBase64FromField(req, 'image');
            if (!faceBase64) return res.status(400).json({ success: false, message: 'Face image required' });

            const [emp] = await db.select().from(employees).where(eq(employees.id, user.employeeId));
            if (!emp?.hasRegisteredFace || !emp.faceEmbedding) {
                return res.status(400).json({ success: false, message: 'Face not registered. Please register first.' });
            }

            const { success, verified, distance, message, liveness } = await verifyFace(
                faceBase64,
                emp.faceEmbedding as number[],
                MATCH_THRESHOLD,
            );
            if (!success) {
                const hint =
                    liveness?.success && !liveness.is_real
                        ? ' Lighting looks too low — move to a brighter spot and try again.'
                        : '';
                return res.status(400).json({
                    success: false,
                    verified: false,
                    message: `${message || 'No face detected'}${hint}`,
                });
            }            if (!verified) {
                return res.status(401).json({
                    success: false, verified: false,
                    message: `Face does not match (distance=${distance.toFixed(3)})`,
                    data: { distance, threshold: MATCH_THRESHOLD },
                });
            }

            // ── report file ───────────────────────────────────────────────
            const reportFile = (req as any).files?.file?.[0] as Express.Multer.File | undefined;
            // A collector may report a visit as notes only, with no document. The
            // file is optional, but at least one of file / notes must carry
            // content — otherwise the row records nothing but a face match and a
            // coordinate.
            if (!reportFile?.buffer && !String(req.body?.description ?? '').trim()) {
                return res.status(400).json({ success: false, message: 'Attach a file or add notes before submitting' });
            }

            const filePath = reportFile?.buffer
                ? await saveReportFile(emp.id, reportFile.buffer, reportFile.originalname)
                : null;

            // ── GPS ───────────────────────────────────────────────────────
            const lat = req.body?.lat ? String(req.body.lat) : null;
            const lng = req.body?.lng ? String(req.body.lng) : null;

             const description = req.body?.description ? String(req.body.description).trim() : null;

            const [submission] = await db
                .insert(reportSubmissions)
                .values({
                    employeeId:   emp.id,
                    filePath,
                    originalName: reportFile?.originalname ?? null,
                    description,
                    geoLat:       lat,
                    geoLng:       lng,
                    faceDistance: distance.toFixed(4),
                })
                .returning({ id: reportSubmissions.id, submittedAt: reportSubmissions.submittedAt });

            return res.json({
                success: true,
                message: 'Report submitted successfully',
                data: {
                    id:          submission?.id,
                    submittedAt: submission?.submittedAt,
                    filePath,
                    geoLat: lat,
                    geoLng: lng,
                },
            });
        } catch (err: any) {
            console.error('[reports/submit]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Report collector: own submission history ─────────────────────────────
    // GET /auth/reports/mine — the signed-in collector's submissions, newest
    // first. Mirrors the admin list but scoped to the caller's own employeeId;
    // the description/filename columns are exactly what the Client Visits grid
    // on mobile renders.
    public async handleListMyReports(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            // "Report Collector" is a facility (the client-visits page key),
            // not a role — see REPORT_COLLECTOR_FACILITY_PAGES above.
            if (!user) return res.status(404).json({ success: false, message: 'Account not found' });
            const callerRoles: string[] = user.roles && user.roles.length > 0 ? user.roles : [user.role ?? 'employee'];
            if (!(await hasReportCollectorFacility(callerRoles))) {
                return res.status(403).json({ success: false, message: 'Report Collector facility is not enabled for your role' });
            }
            if (!user.employeeId) return res.status(404).json({ success: false, message: 'Employee not linked' });

            const rows = await db
                .select({
                    id: reportSubmissions.id,
                    description: reportSubmissions.description,
                    originalName: reportSubmissions.originalName,
                    filePath: reportSubmissions.filePath,
                    submittedAt: reportSubmissions.submittedAt,
                })
                .from(reportSubmissions)
                .where(eq(reportSubmissions.employeeId, user.employeeId))
                .orderBy(desc(reportSubmissions.submittedAt))
                .limit(200);

            // Download URL is relative to the API base; the mobile client resolves
            // it against API_BASE_URL with the bearer token attached. A notes-only
            // report has no document, so it comes back with hasFile:false and a null
            // downloadUrl — the grid then renders it without a tappable link. The
            // stored path itself is never sent to the device.
            const enriched = rows.map((row) => ({
                id: row.id,
                description: row.description,
                originalName: row.originalName,
                submittedAt: row.submittedAt,
                hasFile: !!row.filePath,
                downloadUrl: row.filePath ? `/auth/reports/${row.id}/download` : null,
            }));

            return res.json({
                success: true,
                data: { rows: enriched },
            });
        } catch (err: any) {
            console.error('[reports/mine]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // GET /auth/reports/:id/download — streams one of the collector's own files
    // back. Same disk/streaming approach as the admin endpoint, plus an
    // ownership check: the row must belong to the caller's employeeId.
    public async handleDownloadMyReport(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            // "Report Collector" is a facility (the client-visits page key),
            // not a role — see REPORT_COLLECTOR_FACILITY_PAGES above.
            if (!user) return res.status(404).json({ success: false, message: 'Account not found' });
            const callerRoles: string[] = user.roles && user.roles.length > 0 ? user.roles : [user.role ?? 'employee'];
            if (!(await hasReportCollectorFacility(callerRoles))) {
                return res.status(403).json({ success: false, message: 'Report Collector facility is not enabled for your role' });
            }
            if (!user.employeeId) return res.status(404).json({ success: false, message: 'Employee not linked' });

            const id = String(req.params?.id ?? '');
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
                return res.status(400).json({ success: false, message: 'invalid report id' });
            }

            const [submission] = await db
                .select({
                    employeeId: reportSubmissions.employeeId,
                    filePath:   reportSubmissions.filePath,
                    originalName: reportSubmissions.originalName,
                })
                .from(reportSubmissions)
                .where(eq(reportSubmissions.id, id));

            if (!submission) return res.status(404).json({ success: false, message: 'Report not found' });
            if (submission.employeeId !== user.employeeId) {
                return res.status(403).json({ success: false, message: 'Not your submission' });
            }
            // Notes-only report — there is nothing to stream.
            if (!submission.filePath) {
                return res.status(404).json({ success: false, message: 'This report was submitted without a file' });
            }

            const absPath = reportAbsolutePath(submission.filePath);
            if (!absPath || !existsSync(absPath)) {
                return res.status(404).json({ success: false, message: 'Report file is missing on disk' });
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
                console.error('[reports/my-download:stream]', err)
                res.destroy()
            })
            stream.pipe(res)
        } catch (err: any) {
            console.error('[reports/my-download]', err);
            return res.status(500).json({ success: false, message: err?.message ?? 'Internal Server Error' });
        }
    }

    // Helper: parse base64 out of either JSON body or multipart upload
    private extractBase64FromRequest(req: Request): string | null {
        // multipart/form-data path (what the mobile app sends)
        // @ts-ignore
        const file = (req as any).file;
        if (file?.buffer) {
            return file.buffer.toString('base64');
        }
        // multer with memoryStorage: req.files for multi-part, but we use single.
        // JSON path fallback (for testing with Postman)
        const json = (req.body ?? {}) as { image?: string };
        if (typeof json.image === 'string' && json.image.length > 100) {
            return json.image;
        }
        return null;
    }

    /**
     * Like extractBase64FromRequest, but targets a specific named field inside
     * req.files (multer fields() upload). Used when a request carries both an
     * image field and a file field so the two don't collide on req.file.
     */
    private extractBase64FromField(req: Request, fieldName: string): string | null {
        const files = (req as any).files as Record<string, Express.Multer.File[]> | undefined;
        const file = files?.[fieldName]?.[0];
        if (file?.buffer) return file.buffer.toString('base64');

        // JSON fallback (Postman / tests)
        const json = (req.body ?? {}) as Record<string, string>;
        const val = json[fieldName];
        if (typeof val === 'string' && val.length > 100) return val;
        return null;
    }
}

export default AuthenticationController