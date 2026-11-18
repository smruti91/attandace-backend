import express from 'express'
import type { Router } from 'express'

import LksGuardController from './controller'
import LksGuardAdminController from './admin-controller'
import { restrictToAuthenticatedUser, restrictToAdmin } from '../middleware/auth-middleware'

const controller = new LksGuardController()
const adminController = new LksGuardAdminController()

// ── Mobile (bearer token, employee identity) ─────────────────────────────────
// Mounted at /auth/lksguard. `login` is the only public route — everything else
// requires the token it issues. Password change is guarded too, since it reads
// the caller's identity to rewrite their own credential.
export const lksGuardMobileRouter: Router = express.Router()

lksGuardMobileRouter.post('/login', controller.handleLogin.bind(controller))

lksGuardMobileRouter.use(restrictToAuthenticatedUser())

lksGuardMobileRouter.get('/me', controller.handleMe.bind(controller))
lksGuardMobileRouter.post(
    '/change-password',
    controller.handleChangePassword.bind(controller)
)
lksGuardMobileRouter.post(
    '/register-device',
    controller.handleRegisterDevice.bind(controller)
)
lksGuardMobileRouter.post('/heartbeat', controller.handleHeartbeat.bind(controller))
lksGuardMobileRouter.post('/sync', controller.handleSync.bind(controller))

// ── Admin web panel (existing LKS session) ───────────────────────────────────
// Mounted at /employee/lksguard, behind the same admin guard as the rest of the
// /employee router. Granular LKSGuard perms (#25) are layered inside handlers.
export const lksGuardAdminRouter: Router = express.Router()

lksGuardAdminRouter.use(restrictToAdmin())

// Assignment screen
lksGuardAdminRouter.get(
    '/employees',
    adminController.handleListEmployees.bind(adminController)
)
lksGuardAdminRouter.post('/assign', adminController.handleAssign.bind(adminController))
lksGuardAdminRouter.get(
    '/assignments',
    adminController.handleListAssignments.bind(adminController)
)

// Devices (#21)
lksGuardAdminRouter.get('/devices', adminController.handleListDevices.bind(adminController))
lksGuardAdminRouter.put(
    '/devices/:id/status',
    adminController.handleSetDeviceStatus.bind(adminController)
)

// Records (server-paged/filtered #33). Static paths are declared before the
// param route so "content" can never be swallowed.
lksGuardAdminRouter.get('/calls', adminController.handleListCalls.bind(adminController))
lksGuardAdminRouter.get('/sms', adminController.handleListSms.bind(adminController))
lksGuardAdminRouter.get(
    '/sms/:id/content',
    adminController.handleViewSmsContent.bind(adminController)
)
lksGuardAdminRouter.get(
    '/contacts',
    adminController.handleListContacts.bind(adminController)
)

// Employee aggregate detail (#16)
lksGuardAdminRouter.get(
    '/employees/:employeeId/detail',
    adminController.handleEmployeeDetail.bind(adminController)
)

// Audit + retention
lksGuardAdminRouter.get(
    '/audit-logs',
    adminController.handleListAuditLogs.bind(adminController)
)
lksGuardAdminRouter.get(
    '/retention',
    adminController.handleGetRetention.bind(adminController)
)
lksGuardAdminRouter.put(
    '/retention',
    adminController.handlePutRetention.bind(adminController)
)
