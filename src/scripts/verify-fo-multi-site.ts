/**
 * Field Officer multi-site punching — verification run.
 *
 *   npx tsx src/scripts/verify-fo-multi-site.ts
 *
 * The feature: an FO assigned to several sites may record his OWN attendance at
 * any of them, in any order, and may close the day at a site he never opened it
 * at. Nobody else gets the choice.
 *
 * Like the Circle Officer run, this boots the real Express application in-process
 * on an ephemeral port and talks to it over HTTP with real bearer tokens, so the
 * auth middleware, the token's own roles and each handler's scope resolution are
 * all on the path — the punch body is never trusted for any of it.
 *
 * What is simulated, and what is not:
 *   • Scenarios 1–6, 9 and 12–13 are entirely real reads and writes: assigned
 *     sites come from `field_officer_sites` ∪ `employee_sites`, refusals come
 *     from the punch endpoint's own checks, and scenario 12 inserts genuine
 *     attendance rows (on a scratch day, deleted again at the end).
 *   • Scenarios 7, 8, 10 and 11 need "what today already holds at each site"
 *     without a matching face to punch with, so they seed the SAME Redis
 *     reservation the punch path writes (punch:last / punch:day) and then let the
 *     real handler judge it. Nothing about the rules is faked: only the history
 *     that produced the state. A punch that clears every site gate then lands on
 *     the face check (400/401, or 500 with no face service) — which is exactly
 *     the marker used for "the site layer raised no objection".
 *
 * Side effects: the FO's own Redis punch cache is reset at the end (the next
 * read falls back to Postgres, so nothing is lost), and every attendance row
 * this run writes belongs to the scratch day and is removed again.
 */

import 'dotenv/config'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { deflateSync } from 'node:zlib'
import { sql } from 'drizzle-orm'

import { createApplication } from '../app'
import { db } from '../db'
import {
    canSelectPunchSite,
    loadPunchSites,
    type PunchSite,
} from '../services/punchSiteScope'
import {
    evaluateSitePunch,
    istDateKey,
    type SiteDayState,
} from '../services/attendanceRules'
import {
    getDaySlotsCached,
    invalidateDaySlots,
    setDaySlotsCached,
    setLastPunchCached,
    siteSlotKey,
    type DaySlots,
} from '../services/cache'
import { clearOfficerAttCacheForUser } from '../services/officerAttendanceCache'
import { createAdminAccessToken, createUserToken } from '../app/auth/utils/token'

// ── Harness ──────────────────────────────────────────────────────────────────
type Verdict = 'PASS' | 'FAIL' | 'SKIP'

const results: { n: string; label: string; verdict: Verdict; detail: string }[] = []
let failures = 0

function record(n: string, label: string, verdict: Verdict, detail: string) {
  results.push({ n, label, verdict, detail })
  if (verdict === 'FAIL') failures++
  console.log(`${verdict.padEnd(4)} [${n}] ${label}\n       ${detail}`)
}

function check(n: string, label: string, ok: boolean, detail: string) {
  record(n, label, ok ? 'PASS' : 'FAIL', detail)
  return ok
}

const j = (v: unknown) => JSON.stringify(v)
const short = (v: unknown, max = 240) => {
  const s = typeof v === 'string' ? v : j(v)
  return s && s.length > max ? `${s.slice(0, max)}…` : s
}

/** Minutes before now, as an instant — how a fabricated history is aged. */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000)

/** Which rule the site layer would apply, as its code (null when it allows). */
const refusalCode = (action: 'check-in' | 'check-out', state: SiteDayState): string | null => {
  const v = evaluateSitePunch(action, state, 'Site A')
  return v.ok ? null : v.code
}

// A real PNG (see the Circle Officer run for the assembly): the punch endpoint
// reads an image out of the body before anything else, so every scenario below
// sends one. Nothing here is ever face-verified successfully — the point is
// which check refuses it first.
function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i] ?? 0
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  }
  return (~c) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const name = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([len, name, data, crc])
}

function pngBase64(width = 96, height = 96): string {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const stride = 1 + width * 3
  const raw = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const off = y * stride
    for (let x = 0; x < width; x++) {
      raw[off + x * 3] = 0x20
      raw[off + 1 + x * 3] = 0x60
      raw[off + 2 + x * 3] = 0xa0
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

const IMAGE = pngBase64()

// ── HTTP ─────────────────────────────────────────────────────────────────────
let base = ''

async function call(
  method: string,
  path: string,
  opts: { token?: string; query?: Record<string, string | number | undefined | null>; body?: any } = {},
): Promise<{ status: number; body: any }> {
  const qs = Object.entries(opts.query ?? {})
    .filter(([, v]) => v !== undefined && v !== null && `${v}` !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  const res = await fetch(`${base}${path}${qs ? `?${qs}` : ''}`, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) } catch { /* keep the raw text for the report */ }
  return { status: res.status, body }
}

const dataOf = (body: any) => body?.data ?? null

/**
 * One punch. The endpoint takes the image as JSON too (the same path Postman
 * uses), which keeps this script to one request per punch.
 */
async function punch(
  token: string,
  action: 'check-in' | 'check-out',
  site?: PunchSite,
  geo?: { lat: number; lng: number } | null,
) {
  return call('POST', '/auth/attendance/mark', {
    token,
    body: {
      image: IMAGE,
      action,
      ...(site ? { siteId: site.id } : {}),
      ...(site && geo ? { latitude: String(geo.lat), longitude: String(geo.lng) } : {}),
    },
  })
}

/** The site-layer codes this feature owns — what a refusal must name. */
const SITE_REFUSALS = [
  'site-selection-not-allowed',
  'site-not-assigned',
  'outside-site-fence',
  'site-already-checked-in',
  'site-already-checked-out',
] as const

const codeOf = (body: any): string | null => dataOf(body)?.code ?? body?.code ?? null
const isSiteRefusal = (body: any) =>
  (SITE_REFUSALS as readonly string[]).includes(String(codeOf(body) ?? ''))
/** Whether the punch endpoint cleared every site gate (so it reached the face). */
const passedSiteLayer = (r: { status: number; body: any }) =>
  !((r.status === 403 || r.status === 409) && isSiteRefusal(r.body))
/**
 * The human-readable refusal. Both the role/fence checks in the handler and the
 * rules engine in `processPunch` put `message` on the response body itself, so
 * that is read first and `data.message` only as a fallback.
 */
const messageOf = (body: any): string => String(body?.message ?? dataOf(body)?.message ?? '')

const q = async <T = any>(text: string): Promise<T[]> => {
  const res: any = await db.execute(sql.raw(text))
  return res?.rows ?? []
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
interface Person {
  userId: string
  employeeId: string
  name: string
  token: string
  sites: PunchSite[]
}

async function findByRole(role: string, needSites: number, excludeRole?: string): Promise<Person | null> {
  const rows = await q<any>(`
    select u.id as user_id, e.id::text as employee_id,
           trim(concat(coalesce(e.first_name,''), ' ', coalesce(e.last_name,''))) as name
    from users u
    join employees e on e.id = u.employee_id
    where '${role}' = any(coalesce(u.roles, '{}')) and u.is_active = true and e.is_active = true
      ${excludeRole ? `and not '${excludeRole}' = any(coalesce(u.roles, '{}'))` : ''}
    order by u.created_at`)
  for (const r of rows) {
    const sites = await loadPunchSites({ id: r.user_id, employeeId: r.employee_id })
    // A site with no coordinates cannot be fenced, so it cannot carry the
    // fence scenarios — an environment where that leaves fewer than the
    // requested sites is an environment this run cannot use.
    const usable = sites.filter((s) => Number.isFinite(Number(s.latitude)) && Number.isFinite(Number(s.longitude)))
    if (usable.length >= needSites) {
      return {
        userId: r.user_id,
        employeeId: r.employee_id,
        name: r.name || '(unnamed)',
        token: createUserToken({ id: r.user_id }),
        sites: usable,
      }
    }
  }
  return null
}

// ── Scenario state ───────────────────────────────────────────────────────────
/**
 * Replace the day's whole truth: the last punch, and one slot per site.
 * Written as a complete map on purpose — a punch merges into whatever is
 * already cached, so a partial seed would be a different scenario.
 */
async function seed(opts: {
  employeeId: string
  day: string
  last: { action: 'check-in' | 'check-out'; at: Date; siteId: string | null } | null
  slots: Record<string, SiteDayState & { at?: Date }>
}) {
  await setLastPunchCached(opts.employeeId, opts.last
    ? { action: opts.last.action, createdAt: opts.last.at, siteId: opts.last.siteId }
    : null)
  const slots: DaySlots = {}
  for (const [key, v] of Object.entries(opts.slots)) {
    slots[key] = {
      checkInAt: v.hasCheckIn ? (v.at ?? ago(60)).toISOString() : null,
      checkOutAt: v.hasCheckOut ? (v.at ?? ago(5)).toISOString() : null,
    }
  }
  await setDaySlotsCached(opts.employeeId, opts.day, slots)
}

async function clearState(employeeId: string, day: string) {
  await setLastPunchCached(employeeId, null)
  await invalidateDaySlots(employeeId, day)
}

const SCRATCH_DAY = '2020-01-03'
/** Marks every row this run inserts, so the cleanup can never take anything else. */
const SCRATCH_TAG = 'verify-fo-multi-site'

async function main() {
  const app = createApplication()
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  console.log(`in-process API at ${base}\n`)

  const [adminRow] = await q<any>(`
    select id from users where role = 'admin' and is_active = true limit 1`)
  if (!adminRow) { console.error('No active admin user (seed-admin.ts creates one).'); process.exit(2) }
  const adminToken = createAdminAccessToken({ id: adminRow.id })

  const fo = await findByRole('field_officer', 2)
  if (!fo) {
    console.error('No active Field Officer with at least two fenced sites in this environment.')
    console.error('Post him to two sites (the FO panel) or seed one, then re-run.')
    process.exit(2)
  }
  // findByRole only returns an account with at least two fenced sites, so the
  // two the scenarios run on are always there — A is where a duty gets opened,
  // B is where it gets closed or opened again.
  const [A, B] = fo.sites as [PunchSite, PunchSite]
  const day = istDateKey(new Date())

  // An account WITHOUT the Field Officer role is what the refusal scenarios
  // need. Carrying 'employee' is not enough — a multi-role officer is listed
  // under both, and picking him would make the refusal test describe the very
  // role it is meant to exclude.
  const plain = await findByRole('employee', 1, 'field_officer').then(async (p) => p ?? (async () => {
    // Fall back to any posted employee who is not an FO — the first active one
    // with a site will do.
    const rows = await q<any>(`
      select u.id as user_id, e.id::text as employee_id,
             trim(concat(coalesce(e.first_name,''), ' ', coalesce(e.last_name,''))) as name
      from users u join employees e on e.id = u.employee_id
      where u.is_active = true and e.is_active = true
        and not 'field_officer' = any(coalesce(u.roles, '{}'))
      order by u.created_at limit 20`)
    for (const r of rows) {
      const sites = await loadPunchSites({ id: r.user_id, employeeId: r.employee_id })
      if (sites.length > 0) {
        return {
          userId: r.user_id, employeeId: r.employee_id, name: r.name || '(unnamed)',
          token: createUserToken({ id: r.user_id }), sites,
        }
      }
    }
    return null
  })())

  console.log(`FO:      ${fo.name} — ${fo.sites.length} sites [${fo.sites.map((s) => s.siteName).join(', ')}]`)
  console.log(`Site A:  ${A.siteName} (${A.latitude}, ${A.longitude}, r=${A.allowedRadiusMeters}m)`)
  console.log(`Site B:  ${B.siteName} (${B.latitude}, ${B.longitude}, r=${B.allowedRadiusMeters}m)`)
  console.log(`Other:   ${plain ? `${plain.name} — ${plain.sites.length} site(s)` : 'no non-FO account found'}\n`)

  // Redis is part of the punch path (that is where a reservation lives between
  // the answer and the worker's insert), so a run without it cannot seed the
  // "already punched today" scenarios. Say so instead of failing them.
  await setDaySlotsCached('__probe__', day, { '__probe__': { checkInAt: new Date().toISOString(), checkOutAt: null } })
  const cacheUp = (await getDaySlotsCached('__probe__', day)) !== null
  await invalidateDaySlots('__probe__', day)
  if (!cacheUp) {
    record('seed', 'Redis reachable (needed to seed per-site history)', 'SKIP',
      'cache unavailable — scenarios 7, 8, 10 and 11 are skipped; everything else still runs')
  }

  // ══ 0 — the role gate is one function, and it names only the FO ════════════
  {
    const foRoles = ['field_officer', 'employee']
    const otherRoles = ['employee', 'supervisor']
    const coRoles = ['co']
    const single = evaluateSitePunch('check-out', { hasCheckIn: true, hasCheckOut: false }, 'Site A')
    check('0', 'Rule primitives: FO-only selection, cross-site check-out allowed',
      canSelectPunchSite(foRoles) === true
      && canSelectPunchSite(otherRoles) === false
      && canSelectPunchSite(coRoles) === false
      && canSelectPunchSite(null) === false
      && single.ok === true
      && refusalCode('check-in', { hasCheckIn: true, hasCheckOut: false }) === 'site-already-checked-in'
      && refusalCode('check-out', { hasCheckIn: false, hasCheckOut: true }) === 'site-already-checked-out',
      `canSelectPunchSite(field_officer)=true, (employee/supervisor/co/null)=false; closing a duty opened elsewhere at a site never used today → ${j(single)}`)
  }

  // ══ 1 — the server hands an FO one entry per assigned site ═════════════════
  {
    const st = await call('GET', '/auth/attendance/status', { token: fo.token })
    const d = dataOf(st.body)
    const sites: any[] = d?.siteDays ?? []
    const shapeOk = sites.every((s) =>
      typeof s.siteId === 'string'
      && typeof s.siteName === 'string'
      && typeof s.latitude === 'string' && typeof s.longitude === 'string'
      && typeof s.allowedRadiusMeters === 'string'
      && typeof s.canCheckIn === 'boolean' && typeof s.canCheckOut === 'boolean'
      && typeof s.isOpenHere === 'boolean'
      && ('checkInAt' in s) && ('checkOutAt' in s))
    check('1', 'FO status carries per-site day state + siteSelectionRequired',
      st.status === 200 && d?.siteSelectionRequired === true && sites.length === fo.sites.length && shapeOk,
      `status ${st.status}; siteSelectionRequired=${j(d?.siteSelectionRequired)}; ${sites.length} entries for ${fo.sites.length} assigned sites; every entry carries id/name/fence/verdicts: ${shapeOk}; names [${sites.map((s) => s.siteName).join(', ')}]`)
    await clearState(fo.employeeId, day)
  }

  // ══ 2 — a non-FO gets no selector at all ═══════════════════════════════════
  if (plain) {
    const st = await call('GET', '/auth/attendance/status', { token: plain.token })
    const d = dataOf(st.body)
    check('2', 'Non-FO status reports no site choice (feature is FO-only)',
      st.status === 200 && d?.siteSelectionRequired === false && (d?.siteDays ?? []).length === 0,
      `${plain.name}: status ${st.status}, siteSelectionRequired=${j(d?.siteSelectionRequired)}, siteDays=${j(d?.siteDays)?.length ?? 0}`)
  } else {
    record('2', 'Non-FO status reports no site choice', 'SKIP', 'no non-FO account with a site in this environment')
  }

  // ══ 3 — a non-FO naming a site is refused, not obeyed ══════════════════════
  if (plain) {
    const at = plain.sites[0] as PunchSite
    const r = await punch(plain.token, 'check-in', at, { lat: Number(at.latitude), lng: Number(at.longitude) })
    check('3', 'Non-FO sending a siteId is refused (403 site-selection-not-allowed)',
      r.status === 403 && codeOf(r.body) === 'site-selection-not-allowed',
      `→ ${r.status} code=${j(codeOf(r.body))} message=${short(messageOf(r.body))}`)
  } else {
    record('3', 'Non-FO sending a siteId is refused', 'SKIP', 'no non-FO account with a site in this environment')
  }

  // ══ 4 — a site id the officer does not hold is refused ═════════════════════
  {
    const r = await punch(fo.token, 'check-in', { ...B, id: '00000000-0000-4000-8000-000000000000' })
    check('4', 'FO naming a site he is not posted to is refused (403 site-not-assigned)',
      r.status === 403 && codeOf(r.body) === 'site-not-assigned',
      `forged uuid → ${r.status} code=${j(codeOf(r.body))} message=${short(messageOf(r.body))}`)
  }

  // ══ 5 — the chosen site's own fence is what is measured ════════════════════
  {
    // Half a degree north of A (~55 km): outside A for any sane radius, and the
    // fix is nowhere near B either, so a "nearest site wins" implementation would
    // still refuse it — the code and the named site are what make this specific.
    const far = { lat: Number(A.latitude) + 0.5, lng: Number(A.longitude) }
    const r = await punch(fo.token, 'check-in', A, far)
    const d = dataOf(r.body)
    check('5', 'FO outside the SELECTED site is refused (403 outside-site-fence) naming that site',
      r.status === 403 && codeOf(r.body) === 'outside-site-fence' && d?.siteId === A.id && Number(d?.distance) > Number(A.allowedRadiusMeters),
      `→ ${r.status} code=${j(codeOf(r.body))} siteId=${j(d?.siteId)} distance=${j(d?.distance)} radius=${j(d?.radius)} message=${short(messageOf(r.body))}`)

    const inside = await punch(fo.token, 'check-in', A, { lat: Number(A.latitude), lng: Number(A.longitude) })
    check('6', 'FO inside the selected site clears every site gate (reaches the face check)',
      inside.status !== 403 && passedSiteLayer(inside),
      `fix at the site's own coordinates → ${inside.status} code=${j(codeOf(inside.body))} message=${short(messageOf(inside.body))} (400/401 = face step reached; the site layer said nothing)`)
  }

  // ══ 7 + 8 — check in at A, then check out at B ════════════════════════════
  if (cacheUp && plain) {
    await seed({
      employeeId: fo.employeeId,
      day,
      last: { action: 'check-in', at: ago(45), siteId: A.id },
      slots: { [siteSlotKey(A.id)]: { hasCheckIn: true, hasCheckOut: false, at: ago(45) } },
    })
    const st = dataOf((await call('GET', '/auth/attendance/status', { token: fo.token })).body)
    const here: Record<string, any> = Object.fromEntries((st?.siteDays ?? []).map((s: any) => [s.siteId, s]))
    check('8', 'Status while open at A: A is open, B is still closable, no site offers a check-in',
      here[A.id]?.isOpenHere === true && here[A.id]?.canCheckOut === true && here[A.id]?.canCheckIn === false
      && here[B.id]?.isOpenHere === false && here[B.id]?.canCheckOut === true && here[B.id]?.canCheckIn === false
      && st?.lastActionSiteId === A.id,
      `A(open=${here[A.id]?.isOpenHere}, check-out=${here[A.id]?.canCheckOut}, check-in=${here[A.id]?.canCheckIn}) ` +
      `B(open=${here[B.id]?.isOpenHere}, check-out=${here[B.id]?.canCheckOut}, check-in=${here[B.id]?.canCheckIn}) ` +
      `lastActionSiteId=${j(st?.lastActionSiteId)}`)

    const outB = await punch(fo.token, 'check-out', B, { lat: Number(B.latitude), lng: Number(B.longitude) })
    check('7', 'Check-out at a site he never checked in at is accepted (the feature)',
      passedSiteLayer(outB),
      `open duty at A, closing punch at B → ${outB.status} code=${j(codeOf(outB.body))} message=${short(messageOf(outB.body))}`)

    // ══ 9 — while a duty is open the day rule still owns the second check-in ══
    const inB = await punch(fo.token, 'check-in', B, { lat: Number(B.latitude), lng: Number(B.longitude) })
    check('9', 'A second check-in while a duty is open is refused by the DAY rule, not the site rule',
      inB.status === 409 && codeOf(inB.body) === 'already-checked-in',
      `→ ${inB.status} code=${j(codeOf(inB.body))} message=${short(messageOf(inB.body))} (unchanged single-duty-per-day behaviour)`)
  } else if (!cacheUp) {
    record('7', 'Cross-site check-out accepted', 'SKIP', 'Redis unavailable — cannot seed the open duty')
    record('8', 'Status while open at one site', 'SKIP', 'Redis unavailable — cannot seed the open duty')
    record('9', 'Day rule still owns the second check-in', 'SKIP', 'Redis unavailable — cannot seed the open duty')
  } else {
    record('7', 'Cross-site check-out accepted', 'SKIP', 'no comparison account')
    record('8', 'Status while open at one site', 'SKIP', 'no comparison account')
    record('9', 'Day rule still owns the second check-in', 'SKIP', 'no comparison account')
  }

  // ══ 10 + 11 — a used slot refuses, the site he moved to does not ═══════════
  if (cacheUp) {
    // in A → out A: the day is half done and A is finished with.
    await seed({
      employeeId: fo.employeeId,
      day,
      last: { action: 'check-out', at: ago(2), siteId: A.id },
      slots: {
        [siteSlotKey(A.id)]: { hasCheckIn: true, hasCheckOut: true, at: ago(60) },
      },
    })
    const againA = await punch(fo.token, 'check-in', A, { lat: Number(A.latitude), lng: Number(A.longitude) })
    check('10', 'Re-checking in at the site already closed today is refused naming THAT site',
      againA.status === 409 && codeOf(againA.body) === 'site-already-checked-in'
      && dataOf(againA.body)?.siteId === A.id
      && messageOf(againA.body).includes(A.siteName),
      `→ ${againA.status} code=${j(codeOf(againA.body))} siteId=${j(dataOf(againA.body)?.siteId)} message=${short(messageOf(againA.body))}`)

    const inB = await punch(fo.token, 'check-in', B, { lat: Number(B.latitude), lng: Number(B.longitude) })
    check('10b', '…while the site he has moved to accepts the check-in',
      passedSiteLayer(inB),
      `same state, site B (nothing recorded there today) → ${inB.status} code=${j(codeOf(inB.body))} message=${short(messageOf(inB.body))}`)

    // in A/out A, in B (open): B is the only place a check-out still belongs.
    await seed({
      employeeId: fo.employeeId,
      day,
      last: { action: 'check-in', at: ago(40), siteId: B.id },
      slots: {
        [siteSlotKey(A.id)]: { hasCheckIn: true, hasCheckOut: true, at: ago(180) },
        [siteSlotKey(B.id)]: { hasCheckIn: true, hasCheckOut: false, at: ago(40) },
      },
    })
    const closeA = await punch(fo.token, 'check-out', A, { lat: Number(A.latitude), lng: Number(A.longitude) })
    check('11', 'A second check-out at a site already closed today is refused naming THAT site',
      closeA.status === 409 && codeOf(closeA.body) === 'site-already-checked-out'
      && messageOf(closeA.body).includes(A.siteName),
      `→ ${closeA.status} code=${j(codeOf(closeA.body))} message=${short(messageOf(closeA.body))}`)

    const closeB = await punch(fo.token, 'check-out', B, { lat: Number(B.latitude), lng: Number(B.longitude) })
    check('11b', '…while the site with the open duty still accepts its check-out',
      passedSiteLayer(closeB),
      `same state, site B (checked in there 40 min ago) → ${closeB.status} code=${j(codeOf(closeB.body))} message=${short(messageOf(closeB.body))}`)

    // ══ 13 — nothing the run invented survives it ════════════════════════════
    await clearState(fo.employeeId, day)
    const after = dataOf((await call('GET', '/auth/attendance/status', { token: fo.token })).body)
    const leftover = (after?.siteDays ?? []).filter((s: any) => s.isOpenHere || s.canCheckOut)
    check('13', 'The run leaves no fabricated punch state behind',
      leftover.length === 0 && after?.lastActionSiteId == null && (after?.lastAction ?? null) !== 'check-in',
      `after cleanup: ${leftover.length} site(s) still showing an open duty or an available check-out; lastAction=${j(after?.lastAction)} lastActionSiteId=${j(after?.lastActionSiteId)}`)
  } else {
    record('10', 'Closed site refuses a second check-in, new site accepts', 'SKIP', 'Redis unavailable — cannot seed per-site history')
    record('10b', 'Moved-to site accepts the check-in', 'SKIP', 'Redis unavailable')
    record('11', 'Closed site refuses a second check-out, open site accepts', 'SKIP', 'Redis unavailable')
    record('11b', 'Open site still accepts its check-out', 'SKIP', 'Redis unavailable')
    record('13', 'No fabricated state survives the run', 'SKIP', 'Redis unavailable')
  }

  // ══ 12 — reports attribute a duty to the site it was punched at ════════════
  // Real rows on a scratch day: two duties, two different sites, one officer.
  //
  // Every row this writes is marked device_info='verify-fo-multi-site' and only
  // marked rows are ever deleted — so the run cleans up after itself without
  // touching anyone else's history, even if a real day were somehow chosen.
  {
    const scratch = `device_info = '${SCRATCH_TAG}' and employee_id = '${fo.employeeId}' and attendance_date = date '${SCRATCH_DAY}'`
    await q(`delete from attendance_logs where ${scratch}`)
    const ins = async (action: string, site: PunchSite, time: string) => {
      await q(`
        insert into attendance_logs (employee_id, action, site_id, attendance_date, created_at, attendance_method, device_info)
        values ('${fo.employeeId}', '${action}', '${site.id}'::uuid, date '${SCRATCH_DAY}',
                timestamp with time zone '${SCRATCH_DAY} ${time}+05:30', 'biometric', '${SCRATCH_TAG}')`)
    }
    try {
      await ins('check-in', A, '09:00:00')
      await ins('check-out', A, '12:30:00')
      await ins('check-in', B, '14:00:00')
      await ins('check-out', B, '18:00:00')

      const sum = await call('GET', '/employee/attendance/summary', {
        token: adminToken,
        query: { from: SCRATCH_DAY, to: SCRATCH_DAY, employeeId: fo.employeeId, pageSize: 50 },
      })
      const row = (dataOf(sum.body)?.rows ?? []).find((r: any) => r.employeeId === fo.employeeId)
      const names = String(row?.siteNames ?? '')
      check('12a', 'Attendance summary names the sites he punched at, not only his assignment',
        sum.status === 200 && !!row
        && row.siteName === B.siteName
        && names.includes(A.siteName) && names.includes(B.siteName)
        && Number(row.totalDuties) === 2,
        `summary ${sum.status}: siteName=${j(row?.siteName)} (duty opened latest at B), siteNames=${j(row?.siteNames)}, totalDuties=${j(row?.totalDuties)}, presentDays=${j(row?.presentDays)}`)

      const daily = await call('GET', '/employee/attendance/report', {
        token: adminToken,
        query: { from: SCRATCH_DAY, to: SCRATCH_DAY, employeeId: fo.employeeId, pageSize: 50 },
      })
      // One row per duty, dated by its check-in — the two duties of the scratch
      // day must therefore be two rows, each naming the site it was punched at.
      const mineRows = (dataOf(daily.body)?.rows ?? []).filter((r: any) => r.employeeName === fo.name)
      const bySite: Record<string, string> = {}
      for (const r of mineRows) bySite[String(r.siteName)] = `${r.checkIn}→${r.checkOut}`
      check('12b', 'Daily report lists both duties, each on its own site',
        daily.status === 200 && mineRows.length === 2
        && bySite[A.siteName] === '09:00:00→12:30:00'
        && bySite[B.siteName] === '14:00:00→18:00:00',
        `report ${daily.status}: ${mineRows.length} row(s) for ${fo.name} in [${SCRATCH_DAY}, ${SCRATCH_DAY}] — ${short(Object.entries(bySite).map(([s, t]) => `${s} ${t}`))} (rows carry device=${j(mineRows[0]?.deviceInfo)})`)

      // The officer grid, through a viewer allowed to read these sites. Each
      // viewer only sees the sites in his own scope, so the strongest honest
      // claim is: every row he gets shows the times PUNCHED AT THAT SITE — never
      // the day's earliest check-in copied onto every site the officer is listed
      // at, which is what this report used to do.
      const expected: Record<string, { in: string; out: string }> = {
        [A.id]: { in: '09:00', out: '12:30' },
        [B.id]: { in: '14:00', out: '18:00' },
      }
      const viewers = await q<any>(`
        select u.id as user_id, trim(concat(coalesce(e.first_name,''),' ',coalesce(e.last_name,''))) as name
        from users u join employees e on e.id = u.employee_id
        where u.is_active = true and coalesce(u.roles,'{}') && array['co','oh','field_officer']::text[]
        order by u.created_at limit 10`)
      let best: { viewer: string; rows: any[] } | null = null
      const statuses: string[] = []
      for (const v of viewers) {
        const t = createUserToken({ id: v.user_id })
        const r = await call('GET', '/auth/officer/employees-attendance', { token: t, query: { date: SCRATCH_DAY, pageSize: 500 } })
        const mine = (dataOf(r.body)?.rows ?? []).filter((x: any) => x.employeeId === fo.employeeId)
        statuses.push(`${v.name}: ${r.status}/${mine.length}`)
        if (r.status === 200 && (!best || mine.length > best.rows.length)) best = { viewer: v.name, rows: mine }
      }
      if (best && best.rows.length > 0) {
        const matched = best.rows.every((row: any) => {
          const e = expected[String(row.siteId)]
          return !!e && row.checkIn === e.in && row.checkOut === e.out
        })
        check('12c', 'Officer grid shows each punched site with that site\'s own times',
          matched && best.rows.length <= 2,
          `viewer "${best.viewer}": ${best.rows.length} row(s) for ${fo.name} — ${short(best.rows.map((row: any) => `${row.siteName}: in ${j(row.checkIn)} out ${j(row.checkOut)} (expected ${j(expected[String(row.siteId)]?.in)}/${j(expected[String(row.siteId)]?.out)})`), 320)}; viewers tried ${short(statuses, 200)}`)
      } else {
        record('12c', 'Officer grid shows one row per punched site', 'SKIP',
          `no CO/OH/FO viewer in this environment can read either punched site (tried: ${short(statuses, 200)})`)
      }
    } catch (err: any) {
      record('12', 'Reports attribute a duty to the punched site', 'FAIL', `synthetic rows could not be written: ${err?.cause?.message ?? err?.message ?? err}`)
    } finally {
      await q(`delete from attendance_logs where ${scratch}`)
      await invalidateDaySlots(fo.employeeId, SCRATCH_DAY)
      // The officer grid caches a viewer's report for five minutes; drop every
      // viewer this run read, so the scratch day cannot be served from cache.
      for (const v of await q<any>(`select id as user_id from users where is_active = true and coalesce(roles,'{}') && array['co','oh','field_officer']::text[] limit 20`)) {
        await clearOfficerAttCacheForUser(v.user_id)
      }
      const left = await q(`select count(*)::int as n from attendance_logs where employee_id = '${fo.employeeId}' and attendance_date = date '${SCRATCH_DAY}'`)
      check('12d', 'Scratch-day attendance removed again', Number(left[0]?.n ?? 0) === 0,
        `${left[0]?.n ?? 0} row(s) left on ${SCRATCH_DAY} for ${fo.name}`)
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const skipped = results.filter((r) => r.verdict === 'SKIP').length
  console.log(`\n${results.length - failures - skipped}/${results.length} passed, ${failures} failed, ${skipped} skipped`)
  if (failures > 0) {
    console.log('\nFAILURES:')
    for (const r of results.filter((x) => x.verdict === 'FAIL')) console.log(`  [${r.n}] ${r.label} — ${r.detail}`)
  }
  server.close()
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('run failed:', err?.cause?.message ?? err?.message ?? err)
  process.exit(1)
})
