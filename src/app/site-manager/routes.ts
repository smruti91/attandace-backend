import express from 'express';
import type { Router } from 'express';

import SiteManagerController from './controller';
import { restrictToAuthenticatedUser, restrictToAdmin } from '../middleware/auth-middleware';

const controller = new SiteManagerController();

// ── Mobile (bearer token, site_manager role) ─────────────────────────────────
// Mounted at /auth/site-manager. Each route authenticates first; the role check
// and the assignment authorisation happen inside the controller, so the 401/403
// split stays precise (mirrors the /auth/fo router).
export const siteManagerMobileRouter: Router = express.Router();

siteManagerMobileRouter.use(restrictToAuthenticatedUser());

siteManagerMobileRouter.get('/config', controller.handleConfig.bind(controller));
siteManagerMobileRouter.get('/locations', controller.handleLocations.bind(controller));
siteManagerMobileRouter.get('/sites/:clientLocationId', controller.handleSitesByClient.bind(controller));
// Static path first, then the collection GET/POST on the same path.
siteManagerMobileRouter.post('/location-submissions', controller.handleCreateSubmission.bind(controller));
siteManagerMobileRouter.get('/location-submissions', controller.handleListSubmissions.bind(controller));

// ── Admin: Site Location Approval panel (LKS web) ────────────────────────────
// Mounted at /employee/site-manager, behind the same admin guard as the rest of
// the /employee router.
export const siteManagerAdminRouter: Router = express.Router();

siteManagerAdminRouter.use(restrictToAdmin());

siteManagerAdminRouter.get('/submissions', controller.handleAdminList.bind(controller));
siteManagerAdminRouter.get('/submissions/:id', controller.handleAdminDetail.bind(controller));
siteManagerAdminRouter.post('/submissions/:id/approve', controller.handleApprove.bind(controller));
siteManagerAdminRouter.post('/submissions/:id/reject', controller.handleReject.bind(controller));
