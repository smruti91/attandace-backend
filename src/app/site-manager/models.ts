import { z } from 'zod';

/**
 * Request models for the Site Manager location-submission flow. The mobile app
 * is never trusted for assignment or coordinate sanity: every submission is
 * re-validated here (shape/range) and then re-authorised in the controller
 * against the caller's own `employee_sites`. The DB CHECK constraints and the
 * partial-unique "one PENDING per site" index back this up as the final word.
 */

// ── Mobile: submit a site location for approval ──────────────────────────────
export const createSubmissionModel = z.object({
    clientLocationId: z.string().uuid('clientLocationId must be a uuid'),
    siteId: z.string().uuid('siteId must be a uuid'),
    latitude: z.coerce.number().min(-90, 'latitude must be between -90 and 90').max(90, 'latitude must be between -90 and 90'),
    longitude: z.coerce.number().min(-180, 'longitude must be between -180 and 180').max(180, 'longitude must be between -180 and 180'),
    // Optional GPS accuracy in metres. Bounded well above any phone fix so a
    // typo (metres vs kilometres) is rejected rather than silently trusted.
    accuracy: z.coerce.number().min(0).max(100000).nullish(),
});

// ── Admin: reject (reason required) ──────────────────────────────────────────
export const rejectSubmissionModel = z.object({
    reason: z.string().trim().min(1, 'A rejection reason is required').max(2000),
});

// ── Admin: submission list filter ────────────────────────────────────────────
export const adminSubmissionsQueryModel = z.object({
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
});
