import express from 'express';
import type { Router } from 'express';

import OfficerAttendanceController from './controller';
import { restrictToAuthenticatedUser } from '../middleware/auth-middleware';

const controller = new OfficerAttendanceController();

// ── Mobile (bearer token; CO / Field Officer / OH) ───────────────────────────
// Mounted at /auth/officer. Each route authenticates first; the role check and
// the per-user site authorization happen inside the controller, so a viewer can
// only ever read attendance for the sites they are personally posted to.
export const officerAttendanceMobileRouter: Router = express.Router();

officerAttendanceMobileRouter.use(restrictToAuthenticatedUser());

// Assigned sites — the dropdown source for both reports. For a Circle Officer
// the list is derived from his Field Officers and each site carries the officers
// covering it, so the screens never have to test a role themselves.
officerAttendanceMobileRouter.get('/sites', controller.handleSites.bind(controller));
// The Circle Officer's own Field Officers (filter dropdown + assignment review).
officerAttendanceMobileRouter.get(
    '/field-officers',
    controller.handleFieldOfficers.bind(controller)
);
// Read-only per-employee attendance for the viewer's assigned sites.
officerAttendanceMobileRouter.get(
    '/employees-attendance',
    controller.handleEmployeeAttendance.bind(controller)
);
// Same rows plus site-level shift context and a byShift summary; supports an
// optional shift filter.
officerAttendanceMobileRouter.get(
    '/shift-attendance',
    controller.handleShiftAttendance.bind(controller)
);
