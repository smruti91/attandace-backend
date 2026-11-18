import express from 'express';
import type { Router } from 'express';

import CircleOfficerAdminController from './controller';
import { restrictToAdmin } from '../middleware/auth-middleware';

const controller = new CircleOfficerAdminController();

// ── Admin web (LKS "Circle Officer Management") ──────────────────────────────
// Mounted at /employee/circle-officer, behind the same admin guard as the rest of
// the /employee router: this panel hands out supervisory visibility, so only an
// admin may change it. The Circle Officer's own reads live on the mobile
// /auth/officer/* and /auth/fo/* endpoints and never touch this surface.
export const circleOfficerAdminRouter: Router = express.Router();

circleOfficerAdminRouter.use(restrictToAdmin());

// Static paths first, so a literal like "history" can never be captured by
// /circle-officers/:coId.
circleOfficerAdminRouter.get('/field-officers', controller.handleListFieldOfficers.bind(controller));
circleOfficerAdminRouter.get('/history', controller.handleHistory.bind(controller));

// The management table.
circleOfficerAdminRouter.get('/circle-officers', controller.handleListCircleOfficers.bind(controller));
circleOfficerAdminRouter.get('/circle-officers/:coId', controller.handleCircleOfficerDetail.bind(controller));

// Assignment editing. PUT takes the complete desired set (the same shape the
// officer site-posting editor uses) and refuses an in-flight transfer without an
// explicit confirmReassign; DELETE releases a single officer. Neither ever
// removes a history row.
circleOfficerAdminRouter.put(
    '/circle-officers/:coId/field-officers',
    controller.handleAssignFieldOfficers.bind(controller)
);
circleOfficerAdminRouter.delete(
    '/circle-officers/:coId/field-officers/:foUserId',
    controller.handleRemoveFieldOfficer.bind(controller)
);
