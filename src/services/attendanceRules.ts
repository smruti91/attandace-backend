/**
 * The rules that decide whether a punch is allowed, independent of Express and
 * the database so they can be exercised directly.
 *
 * These live on the server because that is the only place they mean anything.
 * The app also greys out the button, but a disabled button is a courtesy, not a
 * rule — anyone with the token can post to /auth/attendance/mark.
 */

/**
 * A check-out this soon after checking in is a mis-tap or a double capture, not
 * a shift. Sites that genuinely need shorter turnarounds should have this raised
 * deliberately rather than have every stray punch accepted.
 */
export const MIN_CHECKOUT_GAP_MINUTES = 30

export type AttendanceAction = 'check-in' | 'check-out'

/**
 * A check-in older than this can no longer be checked out of. A duty left open
 * past its window (e.g. someone checked in at 08:00 and never returned) is a
 * stale record that only an admin correction should close — re-enabling
 * check-out a day later would let a worker back-date a 24-hour shift.
 */
export const MAX_CHECKOUT_WINDOW_MINUTES = 12 * 60

/**
 * The employee's most recent punch, or null if they have never punched.
 *
 * `siteId` is the site that punch was recorded at (null for a self punch made
 * without choosing one, and for every row written before a punch could carry a
 * site). Optional rather than always-present because the cached copy of an older
 * punch has no way to supply it: readers must treat absent and null alike.
 */
export type LastPunch = { action: string; createdAt: Date; siteId?: string | null } | null

export type RuleVerdict =
    | { ok: true }
    | {
          ok: false
          code:
              | 'already-checked-in'
              | 'not-checked-in'
              | 'too-soon'
              | 'window-expired'
              | 'duty-ended'
          message: string
          minutesRemaining?: number
      }

/** Whole minutes elapsed, rounded down — 29.9 minutes is not yet 30. */
function minutesBetween(from: Date, to: Date): number {
    return Math.floor((to.getTime() - from.getTime()) / 60_000)
}

/**
 * Calendar date (YYYY-MM-DD) of an instant in Asia/Kolkata — the zone the
 * attendance day is kept in, whatever the server process or the phone thinks.
 * en-CA formats as ISO YYYY-MM-DD.
 */
export function istDateKey(instant: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(instant)
}

/** 23:59:00 local (IST, +05:30 — no DST) for a YYYY-MM-DD day, as a UTC instant. */
export function istDayEnd(dateKey: string): Date {
    return new Date(`${dateKey}T23:59:00+05:30`)
}

/**
 * When a duty opened at `checkedInAt` ends: its OWN day's 23:59 IST. A working
 * day ends at midnight, so everything the day's Face Check-In opened ends with
 * it — the same instant the end-of-day sweep writes (services/autoCheckout.ts),
 * which is why both live here rather than in two places.
 */
export function dutyEndsAt(checkedInAt: Date): Date {
    return istDayEnd(istDateKey(checkedInAt))
}

/** Whether the duty opened at `checkedInAt` is already over as of `now`. */
export function isDutyEnded(checkedInAt: Date, now: Date): boolean {
    return now.getTime() >= dutyEndsAt(checkedInAt).getTime()
}

/** '2026-11-03' as the employee reads it: '3 Nov'. */
function istDayLabel(instant: Date): string {
    return instant.toLocaleDateString('en-GB', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
    })
}

/** When check-out becomes available for a check-in at `checkedInAt`. */
export function checkoutAvailableAt(checkedInAt: Date): Date {
    return new Date(checkedInAt.getTime() + MIN_CHECKOUT_GAP_MINUTES * 60_000)
}
/** When the check-out window closes for a check-in at `checkedInAt`. */
export function checkoutClosesAt(checkedInAt: Date): Date {
    return new Date(checkedInAt.getTime() + MAX_CHECKOUT_WINDOW_MINUTES * 60_000)
}
/**
 * Great-circle distance in metres, between two WGS-84 points. Same formula the
 * mobile geofence uses (demo/src/services/geofenceMath.ts) and the same one the
 * tracking engine already keeps its own copy of, so the punch fence and the
 * site-visit fence can never disagree about where a phone is standing.
 */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000
    const dLat = ((lat2 - lat1) * Math.PI) / 180
    const dLon = ((lon2 - lon1) * Math.PI) / 180
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** The radius a site row falls back to when its own is unusable. Mirrors
 * FALLBACK_RADIUS_M in the app (demo/src/services/geofenceMath.ts) so the two
 * halves of the same fence answer identically — `sites.allowed_radius_meters` is
 * NOT NULL with a `> 0` check, so this only covers a corrupted row. */
export const FALLBACK_RADIUS_METERS = 100

/** The three fence columns of a `sites` row. Numerics come back as strings from
 * Postgres, which is why they are not typed as numbers here. */
export type SiteFence = {
    latitude: string | number | null
    longitude: string | number | null
    allowedRadiusMeters: string | number | null
}

export type FenceVerdict =
    | { ok: true; distance: number; radius: number }
    | {
          ok: false
          code: 'site-has-no-coordinates' | 'outside-site-fence'
          /** Metres from the site centre; null when there were no coordinates to
           * measure against. */
          distance: number | null
          radius: number | null
      }

/**
 * One GPS fix against one site's own fence — the server-side half of the check
 * the app already runs before it even opens the camera.
 *
 * The app's verdict is a courtesy: a punched position is client-supplied data, so
 * the endpoint re-measures it. Called only when a fix was actually sent, because
 * a phone that could not read its GPS still has to be able to punch honestly
 * (the app has always allowed that, and the face check is the real gate).
 */
export function evaluateSiteFence(site: SiteFence, lat: number, lng: number): FenceVerdict {
    const siteLat = Number(site.latitude)
    const siteLng = Number(site.longitude)
    if (!Number.isFinite(siteLat) || !Number.isFinite(siteLng) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return { ok: false, code: 'site-has-no-coordinates', distance: null, radius: null }
    }
    const parsed = Number(site.allowedRadiusMeters)
    const radius = Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_RADIUS_METERS
    const distance = distanceMeters(lat, lng, siteLat, siteLng)
    if (distance > radius) return { ok: false, code: 'outside-site-fence', distance, radius }
    return { ok: true, distance, radius }
}

/**
 * What one employee has already recorded AT ONE SITE on one attendance day.
 *
 * A Field Officer's day is now a sequence of duties, each opened at the site he
 * selected, so the day-wide `evaluateAction` verdict alone is not enough:
 *
 *   • he may check in again the moment his previous duty is closed — at a site
 *     he has not already used today;
 *   • he may check out at a DIFFERENT site from the one that opened the duty,
 *     because that is what happens when he travels — which is why this state
 *     never asks for a check-in at the site being closed, only for that site's
 *     check-out slot to be free;
 *   • he may never record the same action twice at one site in one day.
 *
 * The partial unique indexes on attendance_logs (one check-in and one check-out
 * per employee + day + site) are the guarantee; this is the friendly answer that
 * gets read before the punch is accepted, because the row itself lands in
 * Postgres asynchronously and a refusal must not be discovered after the phone
 * was told "done".
 */
export type SiteDayState = {
    hasCheckIn: boolean
    hasCheckOut: boolean
}

export type SiteRuleVerdict =
    | { ok: true }
    | {
          ok: false
          code: 'site-already-checked-in' | 'site-already-checked-out'
          message: string
      }

/** Whether a check-in may still be recorded at this site today. */
export function allowsCheckInAtSite(state: SiteDayState): boolean {
    return !state.hasCheckIn
}

/** Whether a check-out may still be recorded at this site today. */
export function allowsCheckOutAtSite(state: SiteDayState): boolean {
    return !state.hasCheckOut
}

/**
 * Judges one action against what the same site already holds for the same day.
 * `siteName` only appears in the refusal text, so the officer is told which site
 * blocked him rather than being told to retry the same punch.
 */
export function evaluateSitePunch(
    action: AttendanceAction,
    state: SiteDayState,
    siteName: string
): SiteRuleVerdict {
    if (action === 'check-in' && state.hasCheckIn) {
        return {
            ok: false,
            code: 'site-already-checked-in',
            message: `You have already checked in at ${siteName} today. Each site holds one check-in per day — check in at the site you have moved to.`,
        }
    }
    if (action === 'check-out' && state.hasCheckOut) {
        return {
            ok: false,
            code: 'site-already-checked-out',
            message: `Check-out at ${siteName} is already recorded for today. Select the site you are actually leaving from.`,
        }
    }
    return { ok: true }
}

/**
 * Evaluates an action against the employee's last punch.
 *
 * `now` is a parameter rather than read inside so the caller controls the clock
 * — the same instant is used for the verdict and for the row that follows.
 */
export function evaluateAction(action: AttendanceAction, last: LastPunch, now: Date): RuleVerdict {
    const openDuty = last?.action === 'check-in'
    // A duty does not survive its own day: once that day's 23:59 IST has passed
    // it is ended, whether or not the sweep has managed to write the row yet (a
    // day that already carries a check-out cannot take a second one — the
    // one-check-out-per-employee-per-day index — so an evening re-check-in has
    // nothing to close it). Judging today by yesterday's check-in is what made
    // an employee "already checked in" at 08:00 the next morning, forcing a
    // meaningless Check Out punch first — which then landed on the wrong day.
    const ended = openDuty && isDutyEnded(last!.createdAt, now)
    // A check-in older than the 12-hour window is treated as auto-closed too: the
    // employee can check in again without supervisor intervention, but the stale
    // duty itself can still only be closed by an admin correction.
    const windowExpired = openDuty && minutesBetween(last!.createdAt, now) >= MAX_CHECKOUT_WINDOW_MINUTES
    const isCheckedIn = openDuty && !ended

    if (action === 'check-in') {
        if (isCheckedIn && !windowExpired) {
            return {
                ok: false,
                code: 'already-checked-in',
                message: 'You are already checked in. Check out first.',
            }
        }
        return { ok: true }
    }

    // check-out
    if (ended) {
        return {
            ok: false,
            code: 'duty-ended',
            message: `Your duty of ${istDayLabel(last!.createdAt)} ended at 23:59 that day and is already closed, so there is nothing to check out here. Tap Check In for today instead.`,
        }
    }
    if (!isCheckedIn) {
        return {
            ok: false,
            code: 'not-checked-in',
            message: 'You are not checked in, so there is nothing to check out of.',
        }
    }

    const elapsed = minutesBetween(last!.createdAt, now)
    if (elapsed < MIN_CHECKOUT_GAP_MINUTES) {
        // Round up what's left: with 29 whole minutes elapsed there is still part
        // of the 30th to wait, and "0 minutes left" while the button stays locked
        // is the more confusing answer.
        const minutesRemaining = Math.max(
            1,
            Math.ceil((checkoutAvailableAt(last!.createdAt).getTime() - now.getTime()) / 60_000)
        )
        return {
            ok: false,
            code: 'too-soon',
            message: `You checked in ${elapsed} minute${elapsed === 1 ? '' : 's'} ago. Check-out is available ${MIN_CHECKOUT_GAP_MINUTES} minutes after check-in — please try again in ${minutesRemaining} minute${minutesRemaining === 1 ? '' : 's'}.`,
            minutesRemaining,
        }
    }

    if (elapsed >= MAX_CHECKOUT_WINDOW_MINUTES) {
        const hours = MAX_CHECKOUT_WINDOW_MINUTES / 60
        return {
            ok: false,
            code: 'window-expired',
            message: `You checked in ${Math.floor(elapsed / 60)} hours ago. Check-out closes ${hours} hours after check-in, so this duty must be closed by your supervisor.`,
        }
    }

    return { ok: true }
}
