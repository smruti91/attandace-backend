import { z } from 'zod';

/**
 * Request models for the admin "Circle Officer Management" panel. Assignments
 * are keyed by USER id (the same id `field_officer_sites` uses), because a
 * Circle Officer's reach is defined by which Field Officer accounts he supervises.
 */

// The CO table's filter. One free-text term matched against the employee name,
// the login phone and the employee id — the three things an admin actually types.
export const circleOfficerListQueryModel = z.object({
    search: z.string().trim().max(100).optional(),
});

// The assignment editor posts the COMPLETE desired set of Field Officers, like the
// existing officer site-posting editor does, so checking and unchecking boxes is
// one idempotent call.
//
// `confirmReassign` is the "no silent transfer" rule: taking an officer who is
// already under another Circle Officer is refused until the caller says it meant
// to move him. The server refuses; the panel cannot bypass it by omitting a
// dialog, and a stale browser tab cannot steal an officer by guessing ids.
export const assignFieldOfficersModel = z.object({
    foUserIds: z.array(z.string().uuid()).max(500),
    confirmReassign: z.boolean().default(false),
});

// The audit trail filter. Every key is optional — with nothing set the admin sees
// the whole history, newest first — and the rows it returns are never deletable
// through any endpoint: this panel reads, it does not rewrite history.
export const assignmentHistoryQueryModel = z.object({
    coUserId: z.string().uuid('coUserId must be a uuid').optional(),
    foUserId: z.string().uuid('foUserId must be a uuid').optional(),
    // Derived from isActive/removedAt plus whether the officer has since gone to
    // another CO — see the controller. No stored column, so it cannot drift.
    status: z.enum(['ACTIVE', 'REMOVED', 'REASSIGNED']).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
});
