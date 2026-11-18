import express from 'express'
import type { Router } from 'express'
import multer from 'multer'

import AuthenticationController from './controller'
import AdminAuthController from './admin-controller'
import { restrictToAuthenticatedUser, restrictToAdmin } from '../middleware/auth-middleware'

const authenticationController = new AuthenticationController()
const adminAuthController = new AdminAuthController()

// Multer in-memory storage — we only need the buffer to convert to base64.
// 8 MB limit covers even large front-camera JPEGs.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
})

export const authRouter: Router = express.Router()

// authRouter.post('/sign-up', authenticationController.handleSignup.bind(authenticationController))
authRouter.post('/sign-in', authenticationController.handleSignin.bind(authenticationController))
authRouter.post('/register-phone', authenticationController.registerByPhone.bind(authenticationController))

// ── Face routes ──────────────────────────────────────────────────────────────
// Both require a valid bearer token. Multer parses the multipart "image" field,
// then the controller converts it to base64 and runs face-api on it.
authRouter.post(
    '/register-face',
    restrictToAuthenticatedUser(),
    upload.single('image'),
    authenticationController.handleRegisterFace.bind(authenticationController)
)

// Attendance is mounted under auth so the mobile app can reach it at the same base URL.
authRouter.post(
    '/attendance/mark',
    restrictToAuthenticatedUser(),
    upload.single('image'),
    authenticationController.handleMarkAttendance.bind(authenticationController)
)

// Current check-in state + whether the minimum-gap rule has released check-out.
// The app calls this on launch so its buttons reflect the server, not whatever
// was in component state when it was last closed.
authRouter.get(
    '/attendance/status',
    restrictToAuthenticatedUser(),
    authenticationController.handleAttendanceStatus.bind(authenticationController)
)

authRouter.get(
    '/attendance-history',
    restrictToAuthenticatedUser(),
    authenticationController.handleAttendanceHistory.bind(authenticationController)
)

// The same punches, classified for one calendar month (present / partial /
// absent) with the site and duty length behind each day. Status is derived on
// the server so the mobile calendar and the LKS reports read one rule.
authRouter.get(
    '/attendance-calendar',
    restrictToAuthenticatedUser(),
    authenticationController.handleAttendanceCalendar.bind(authenticationController)
)

authRouter.get('/me', restrictToAuthenticatedUser(), authenticationController.handleMe.bind(authenticationController))

// ── Change Password ──────────────────────────────────────────────────────────
// Every authenticated user, whatever their roles: this is deliberately NOT a
// role_pages facility, so no assignment can hide it and an account can never be
// locked out of its own credential. The target account comes from the bearer
// token (restrictToAuthenticatedUser), never from the body.
authRouter.post(
    '/change-password',
    restrictToAuthenticatedUser(),
    authenticationController.handleChangePassword.bind(authenticationController)
)

// ── Forgot Password (public) ─────────────────────────────────────────────────
// No bearer token: an employee who cannot sign in is by definition not signed in.
// The handler answers with one fixed sentence for every accepted phone, so this
// route cannot be used to find out whether a number is registered, and it is
// rate-limited inside the handler (services/cache) rather than by a middleware —
// the limits are per phone AND per IP, which is information only the body has.
// It creates a request for an admin to act on; it never changes a password.
authRouter.post(
    '/forgot-password',
    authenticationController.handleForgotPassword.bind(authenticationController)
)

// ── Password Reset Requests (admin panel) ────────────────────────────────────
// The admin half of the same workflow. restrictToAdmin() is the authorization:
// hiding the menu in the web panel is presentation, not security, and an employee
// token reaching these URLs is refused by role on the server (403) before the
// handler runs. /count is declared before the :id routes purely for tidiness —
// no method/path collision exists.
authRouter.get(
    '/admin/password-reset-requests/count',
    restrictToAdmin(),
    authenticationController.handlePasswordResetRequestCount.bind(authenticationController)
)
authRouter.get(
    '/admin/password-reset-requests',
    restrictToAdmin(),
    authenticationController.handleListPasswordResetRequests.bind(authenticationController)
)
authRouter.post(
    '/admin/password-reset-requests/:id/reset',
    restrictToAdmin(),
    authenticationController.handleAdminResetPassword.bind(authenticationController)
)
authRouter.post(
    '/admin/password-reset-requests/:id/reject',
    restrictToAdmin(),
    authenticationController.handleAdminRejectResetRequest.bind(authenticationController)
)

// ── Role → page assignment (admin panel) ─────────────────────────────────────
// Which mobile-app pages each role sees. The app reads its own set from the
// sign-in / /me responses; these endpoints let the admin panel view and edit
// the assignment per role.
authRouter.get('/role-pages', restrictToAdmin(), authenticationController.handleListRolePages.bind(authenticationController))
authRouter.put('/role-pages', restrictToAdmin(), authenticationController.handleUpsertRolePages.bind(authenticationController))

// The employee's assigned sites and their geofences. The app refreshes these on
// launch so an admin's change to a radius or posting takes effect without the
// employee having to sign out and back in.
authRouter.get(
    '/my-sites',
    restrictToAuthenticatedUser(),
    authenticationController.handleMySites.bind(authenticationController)
)

// ── Admin panel auth (web) ───────────────────────────────────────────────────
// sign-in / refresh / sign-out are public: they authenticate via credentials or
// the httpOnly refresh cookie, not via a bearer token. Only /me is guarded.
authRouter.post('/admin/sign-in', adminAuthController.handleSignIn.bind(adminAuthController))
authRouter.post('/admin/refresh', adminAuthController.handleRefresh.bind(adminAuthController))
authRouter.post('/admin/sign-out', adminAuthController.handleSignOut.bind(adminAuthController))
authRouter.get('/admin/me', restrictToAdmin(), adminAuthController.handleMe.bind(adminAuthController))


// ── Supervisor / cross-device attendance routes ──────────────────────────────
// Authorization is enforced inside the handlers via supervisorScope(): no role
// name is hard-coded — a caller's roles are resolved through role_pages and the
// cross-device endpoints require the CROSS_DEVICE_ATTENDANCE facility (the
// 'take-attendance' / 'employees-attendance' page keys). 403 otherwise, so no
// separate middleware is needed.

// GET /auth/supervisor/employee-by-phone?phone=09xxxxxxxxx
// Returns name + designation + hasRegisteredFace for the target employee.
authRouter.get(
    '/supervisor/employee-by-phone',
    restrictToAuthenticatedUser(),
    authenticationController.handleEmployeeByPhone.bind(authenticationController)
)

// POST /auth/supervisor/register-face
// Multipart: employeePhone (text) + image (file). Requires the register-employee
// facility (role_pages page key — Supervisor and HO by default); registers the
// employee's face on behalf of the caller — no face-check of the caller, but the
// target must share a site with them.
authRouter.post(
    '/supervisor/register-face',
    restrictToAuthenticatedUser(),
    upload.single('image'),
    authenticationController.handleSupervisorRegisterFace.bind(authenticationController)
)

// GET /auth/supervisor/search-employee?q=<phone | name>
// Requires the cross-device facility. Finds employees by phone or (first/last/full) name for the
// "Take Employee Attendance" flow, each match carrying its live punch state.
authRouter.get(
    '/supervisor/search-employee',
    restrictToAuthenticatedUser(),
    authenticationController.handleSearchEmployee.bind(authenticationController)
)

// POST /auth/supervisor/mark-attendance
// Requires the cross-device facility. JSON: { image, employeeId, action }. The frame is verified
// against the TARGET employee's stored embedding, then their punch is logged.
authRouter.post(
    '/supervisor/mark-attendance',
    restrictToAuthenticatedUser(),
    upload.single('image'),
    authenticationController.handleSupervisorMarkAttendance.bind(authenticationController)
)

// ── Employees Attendance (Supervisor team grid with day filter) ─────────────
// GET /auth/supervisor/team?date=YYYY-MM-DD — only employees on the
// supervisor's own sites, with backend-derived Present/Absent for the day.
authRouter.get(
    '/supervisor/team',
    restrictToAuthenticatedUser(),
    authenticationController.handleSupervisorTeam.bind(authenticationController)
)

// POST /auth/supervisor/manual-attendance
// Requires the cross-device facility. JSON { employeeId, attendanceDate? } — no
// camera image. `upload.single('image')` stays so older builds that still send a
// photo keep working (it is stored under attendance-images/ when present).
// Enqueued as method=manual through the same BullMQ pipeline as biometric.
authRouter.post(
    '/supervisor/manual-attendance',
    restrictToAuthenticatedUser(),
    upload.single('image'),
    authenticationController.handleSupervisorManualAttendance.bind(authenticationController)
)

// POST /auth/supervisor/checkout
// Supervisor-only. { employeeId, attendanceDate? }. No image — identity was
// fixed at check-in. Same queue, refuses double checkout.
authRouter.post(
    '/supervisor/checkout',
    restrictToAuthenticatedUser(),
    authenticationController.handleSupervisorCheckout.bind(authenticationController)
)

// POST /auth/supervisor/mark-incomplete
// Supervisor-only. { employeeId, attendanceDate?, reason }. Closes a PRESENT
// day as INCOMPLETE (no faked checkout); reason is mandatory, max 500 chars.
authRouter.post(
    '/supervisor/mark-incomplete',
    restrictToAuthenticatedUser(),
    authenticationController.handleMarkIncomplete.bind(authenticationController)
)

// ── Employee Violations (Supervisor report-only, immutable) ────────────────
// POST /auth/supervisor/violations — { employeeId, violationType, reason }.
// Site + supervisor + date all derived server-side; no images, no edits.
authRouter.post(
    '/supervisor/violations',
    restrictToAuthenticatedUser(),
    authenticationController.handleCreateViolation.bind(authenticationController)
)

// GET /auth/supervisor/violations?date=YYYY-MM-DD (optional) — reports at the
// supervisor's own sites, newest first.
authRouter.get(
    '/supervisor/violations',
    restrictToAuthenticatedUser(),
    authenticationController.handleListViolations.bind(authenticationController)
)

// GET /auth/supervisor/violation-types — controlled vocabulary for the dropdown.
authRouter.get(
    '/supervisor/violation-types',
    restrictToAuthenticatedUser(),
    authenticationController.handleViolationTypes.bind(authenticationController)
)

// ── Shift Attendance (Supervisor group summary — separate from Employees Attendance)
// GET /auth/supervisor/shift-attendance?date=YYYY-MM-DD&siteId=...
authRouter.get(
    '/supervisor/shift-attendance',
    restrictToAuthenticatedUser(),
    authenticationController.handleListShiftAttendance.bind(authenticationController)
)

// POST /auth/supervisor/shift-attendance
// JSON { shift, present_employees, description?, image (base64), attendanceDate?, siteId? }
// or multipart `image` file + fields. Site/supervisor/date derived server-side.
authRouter.post(
    '/supervisor/shift-attendance',
    restrictToAuthenticatedUser(),
    upload.single('image'),
    authenticationController.handleCreateShiftAttendance.bind(authenticationController)
)

// GET /auth/supervisor/shift-attendance/:id
authRouter.get(
    '/supervisor/shift-attendance/:id',
    restrictToAuthenticatedUser(),
    authenticationController.handleGetShiftAttendance.bind(authenticationController)
)

// PUT /auth/supervisor/shift-attendance/:id — update shift/present/description/image.
authRouter.put(
    '/supervisor/shift-attendance/:id',
    restrictToAuthenticatedUser(),
    upload.single('image'),
    authenticationController.handleUpdateShiftAttendance.bind(authenticationController)
)

// ── Report collector routes ──────────────────────────────────────────────────
// POST /auth/reports/submit
// Multipart: image (face frame) + file (report doc, optional) + lat + lng +
// description. A submission with no file is a notes-only report, but the
// handler requires at least one of the two.
// Verifies the submitter's face before saving the report.
authRouter.post(
    '/reports/submit',
    restrictToAuthenticatedUser(),
    upload.fields([
        { name: 'image', maxCount: 1 },
        { name: 'file',  maxCount: 1 },
    ]),
    authenticationController.handleSubmitReport.bind(authenticationController)
)

// GET /auth/reports/mine — the signed-in collector's own submission history
// for the mobile Client Visits grid. Declared before :id/download so "mine"
// is never swallowed by the id param.
authRouter.get(
    '/reports/mine',
    restrictToAuthenticatedUser(),
    authenticationController.handleListMyReports.bind(authenticationController)
)

// GET /auth/reports/:id/download — streams one of the collector's own report
// files back (ownership-checked inside the controller).
authRouter.get(
    '/reports/:id/download',
    restrictToAuthenticatedUser(),
    authenticationController.handleDownloadMyReport.bind(authenticationController)
)