import { z } from 'zod';

/**
 * Request models for the officer-scoped attendance reports (Circle Officer +
 * Field Officer). The date is required so a report is never dumped unscoped;
 * locationId / siteId / shift / foUserId / status are optional narrowing
 * filters. Actual authorization (the officer's assigned sites, and for a Circle
 * Officer the Field Officers assigned to him) is enforced in the controller,
 * never trusted from these params — a filter id can only ever narrow the read,
 * never widen it.
 */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

// The four statuses the report's own SQL computes (roster + duty aggregation).
// Exported so the controller's WHERE clause and this validator can never drift
// apart on the spelling of a status.
export const REPORT_STATUSES = ['Present', 'Completed', 'Incomplete', 'Absent'] as const;

export const officerAttendanceQueryModel = z.object({
  date: dateStr,
  locationId: z.string().uuid('locationId must be a uuid').optional(),
  siteId: z.string().uuid('siteId must be a uuid').optional(),
  // Only meaningful for the Shift Attendance report; matches the site-level
  // shift_attendance vocabulary already used across the app.
  shift: z.enum(['morning', 'day', 'night', 'general']).optional(),
  // Circle Officer only: narrow the report to the sites of one assigned Field
  // Officer. A non-CO viewer sending it is refused (see controller).
  foUserId: z.string().uuid('foUserId must be a uuid').optional(),
  status: z.enum(REPORT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(200),
});

export type OfficerAttendanceQuery = z.infer<typeof officerAttendanceQueryModel>;
