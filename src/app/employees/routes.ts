import express from 'express'
import type { Router } from 'express'
import EmployeesController from './controller'
import { restrictToAdmin } from '../middleware/auth-middleware'

const employeeController = new EmployeesController();

export const empRouter:Router = express.Router()

// Admin-only. These are back-office operations — creating employees, defining
// client locations, assigning them — and were previously reachable by anyone with
// the URL. Verified that neither the mobile app nor the web app called them before
// this guard was added, so nothing existing breaks.
empRouter.use(restrictToAdmin())

empRouter.post('/register-face', employeeController.handleRegisterFace.bind(employeeController) )
empRouter.get('/employees', employeeController.listEmployees.bind(employeeController) )
// Admin dashboard snapshot — real aggregate figures for the landing page, in one
// round trip. Read-only, admin-guarded like the rest of this router.
empRouter.get('/dashboard', employeeController.dashboardSummary.bind(employeeController) )
empRouter.post('/register-employee', employeeController.handleEployeeRegister.bind(employeeController) )
empRouter.patch('/employees/:id', employeeController.updateEmployee.bind(employeeController) )
empRouter.patch('/employees/:id/roles', employeeController.updateEmployeeRoles.bind(employeeController) )
// Refused once the employee has attendance history — deactivate instead.
empRouter.delete('/employees/:id', employeeController.deleteEmployee.bind(employeeController) )
// Locations group sites; sites carry the geofence. Creating a location no longer
// accepts coordinates — add a site under it and give the coordinates there.
empRouter.get('/client-locations', employeeController.listClientLocations.bind(employeeController) )
empRouter.post('/add-client-location', employeeController.createClientLocation.bind(employeeController) )
empRouter.patch('/client-location/:id', employeeController.updateClientLocation.bind(employeeController) )
// Refused while the location still has sites — deleting it would cascade them
// away, and their attendance history with them.
empRouter.delete('/client-location/:id', employeeController.deleteClientLocation.bind(employeeController) )
empRouter.post('/add-site', employeeController.createSite.bind(employeeController) )
empRouter.get('/sites', employeeController.listSites.bind(employeeController) )
empRouter.patch('/site/:id', employeeController.updateSite.bind(employeeController) )
empRouter.delete('/site/:id', employeeController.deleteSite.bind(employeeController) )
empRouter.post('/assign-site', employeeController.assignSiteToEmployee.bind(employeeController) )
empRouter.post('/attendance/mark', employeeController.handleattendanceMark.bind(employeeController) )
empRouter.get('/attendance/report', employeeController.attendanceReport.bind(employeeController) )
empRouter.get('/attendance/summary', employeeController.attendanceSummaryReport.bind(employeeController) )
// Per-day drill-down behind the summary's "View" button — one status per
// calendar day for a single employee.
empRouter.get('/attendance/summary/days', employeeController.attendanceDayDetails.bind(employeeController) )
// Shift attendance report for the web panel — one row per employee per site
// for a single date, with a full-set summary. Same admin guard.
empRouter.get('/shift-attendance/report', employeeController.shiftAttendanceReport.bind(employeeController) )
// Employee violations report — one row per violation report in scope, newest
// first. Read-only; violations are immutable by design. Same admin guard.
empRouter.get('/violations/report', employeeController.violationsReport.bind(employeeController) )
// Collection report — the files report collectors have submitted, with the
// description they wrote. Read-only back-office data, so it lives behind the
// same admin guard as the rest of this router. The download route is keyed by
// submission id (never the file path) so files can't be guessed or wandered into.
empRouter.get('/reports/submissions', employeeController.listReportSubmissions.bind(employeeController) )
empRouter.get('/reports/:id/download', employeeController.downloadReport.bind(employeeController) )