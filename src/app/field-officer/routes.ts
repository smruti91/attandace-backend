import express from 'express';
import type { Router } from 'express';

import FieldOfficerController from './controller';
import { restrictToAuthenticatedUser, restrictToAdmin } from '../middleware/auth-middleware';

const controller = new FieldOfficerController();

// ── Mobile (bearer token) ────────────────────────────────────────────────────
// Mounted at /auth/fo. Each route authenticates first; the role check happens
// inside the controller so the 401/403 split stays precise. The two GET reports
// below take the read-only viewer guard (Field Officer, OH or Circle Officer);
// every write route still requires the tracking role, so a CO can reach the
// reports and nothing else.
export const foMobileRouter: Router = express.Router();

foMobileRouter.use(restrictToAuthenticatedUser());

foMobileRouter.get('/config', controller.handleConfig.bind(controller));
foMobileRouter.get('/my-sites', controller.handleMySites.bind(controller));
// Read-only shift-attendance report over the Supervisor's shift_attendance
// rows, scoped to the viewer's authorized sites (for a Circle Officer, the sites
// of the Field Officers assigned to him). Static path, no param conflicts.
foMobileRouter.get('/shift-attendance', controller.handleFoShiftAttendance.bind(controller));
// Verify-only face gate for check-in / check-out. Declared before the
// :visitId routes so "verify-face" can't be swallowed by the param.
foMobileRouter.post('/verify-face', controller.handleVerifyFace.bind(controller));

// ── Tracking sessions: Face Check-In opens the day, Face Check-Out closes ──
// it; site entries/exits in between are auto-detected from the GPS stream.
foMobileRouter.post('/sessions/start', controller.handleStartSession.bind(controller));
// Static path before :sessionId so it can't be swallowed by the param route.
foMobileRouter.get('/sessions/active', controller.handleActiveSession.bind(controller));
// The caller's own day track, for the mobile path plot. Static path, declared
// with the other statics so it can never be captured by /sessions/:sessionId.
foMobileRouter.get('/sessions/track', controller.handleMyTrack.bind(controller));
// The caller's own site visits for one day (mobile "Field Visits" date filter).
// Static path, next to /sessions/track for the same reason.
foMobileRouter.get(
    '/sessions/site-visits',
    controller.handleMySiteVisits.bind(controller)
);
foMobileRouter.post(
    '/sessions/:sessionId/locations',
    controller.handleSessionLocations.bind(controller)
);
foMobileRouter.post(
    '/sessions/:sessionId/end',
    controller.handleEndSession.bind(controller)
);

// Static paths before :visitId so they can't be swallowed by the param route.
foMobileRouter.get('/visits/active', controller.handleActiveVisit.bind(controller));
foMobileRouter.get('/visits/recent', controller.handleRecentVisits.bind(controller));
foMobileRouter.post('/visits/check-in', controller.handleCheckIn.bind(controller));
foMobileRouter.post(
    '/visits/:visitId/check-out',
    controller.handleCheckOut.bind(controller)
);
foMobileRouter.post(
    '/visits/:visitId/locations',
    controller.handleUploadLocations.bind(controller)
);

// ── Admin / Operational Head web panel ───────────────────────────────────────
// Mounted at /employee/field-officer, behind the same admin guard as the rest
// of the /employee router.
export const foAdminRouter: Router = express.Router();

foAdminRouter.use(restrictToAdmin());

foAdminRouter.get('/officers', controller.handleListOfficers.bind(controller));
foAdminRouter.get('/visits', controller.handleListVisits.bind(controller));
foAdminRouter.get('/visits/:visitId/locations', controller.handleVisitTrack.bind(controller));

// Site postings for one officer — the LKS "Field Officers" page. The :userId
// routes sit under /officers so they can never collide with /visits.
foAdminRouter.get('/officers/:userId/sites', controller.handleOfficerSites.bind(controller));
foAdminRouter.put('/officers/:userId/sites', controller.handleReplaceOfficerSites.bind(controller));

// Session timeline for the OH panel.
foAdminRouter.get('/sessions', controller.handleListSessions.bind(controller));

// OH attendance report (LKS "OH Employee Attendance"): server-filtered grid
// of 'oh' users with their day state, and the per-employee full-day detail
// (attendance summary + travel path). The :userId route is scoped by the
// static prefix, so it can never collide with the other listings.
foAdminRouter.get('/oh-attendance', controller.handleOhAttendanceList.bind(controller));
foAdminRouter.get(
    '/oh-attendance/:userId',
    controller.handleOhAttendanceDetail.bind(controller)
);
// All-officers rollup for one date (visit count + total duty) — the overview
// table's data. Static path; declared with the other statics, before any
// :sessionId route on this router.
foAdminRouter.get('/day-summary', controller.handleDaySummary.bind(controller));
// Manual trigger for the 10-hour max-duty sweep (the scheduler runs the same
// function every 15 minutes). Static path before :sessionId.
foAdminRouter.post(
    '/sessions/auto-checkout',
    controller.handleTriggerAutoCheckout.bind(controller)
);
foAdminRouter.get('/sessions/:sessionId/track', controller.handleSessionTrack.bind(controller));
