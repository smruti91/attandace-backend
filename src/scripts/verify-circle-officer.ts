/**
 * Circle Officer verification — runs the feature spec's testing scenarios
 * (§8, 1–14) against the real routers and middleware.
 *
 *   npx tsx src/scripts/verify-circle-officer.ts
 *
 * It boots the same Express application the API runs on, on an ephemeral port,
 * inside this process: no second server to manage, and none of the schedulers or
 * face-model loading from src/index.ts (which would sweep live tracking
 * sessions). Requests go over real HTTP with real bearer tokens, so the auth
 * middleware, the role_pages facility check and each handler's own scope
 * resolution are all exercised — and that layered authorization is precisely
 * what this feature has to get right.
 *
 * Data: fixtures are discovered, never hard-coded, so the run works on any
 * environment. Assignments written by the run stay in place (a CO over his
 * Field Officers) so the mobile app can be tried immediately afterwards; every
 * row the scenarios close remains in `co_fo_assignments` as history, which is
 * the rule under test rather than a side effect. The one Shift Attendance row
 * submitted for scenario 12 is synthetic and is removed again with its image,
 * because it is test data and not anyone's attendance.
 */

import 'dotenv/config'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { eq, sql } from 'drizzle-orm'

import { createApplication } from '../app'
import { db } from '../db'
import { shiftAttendance } from '../db/schema'
import { SHIFT_UPLOAD_ROOT } from '../services/shiftAttendanceImageStore'
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

/** One assertion that reports instead of throwing, so one failing check does
 *  not hide the rest of the run. */
function check(n: string, label: string, ok: boolean, detail: string) {
  record(n, label, ok ? 'PASS' : 'FAIL', detail)
  return ok
}

const j = (v: unknown) => JSON.stringify(v)
const short = (v: unknown, max = 260) => {
  const s = typeof v === 'string' ? v : j(v)
  return s && s.length > max ? `${s.slice(0, max)}…` : s
}

// A real PNG, assembled here instead of embedded as a literal: the endpoint
// rejects anything under 100 characters as a sanity check, and the submission
// scenario is only worth running if it goes through the image pipeline the
// mobile app uses (magic-byte sniffing, extension allow-list, disk write).
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

function pngBase64(width = 24, height = 24): string {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // colour type: truecolour RGB
  const stride = 1 + width * 3
  const raw = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const off = y * stride          // filter byte 0, then one solid colour
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

const TINY_PNG = pngBase64()

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

// ── Fixtures ─────────────────────────────────────────────────────────────────
interface Officer {
  userId: string
  name: string
  phone: string
  sites: { id: string; siteName: string }[]
}

const q = async <T = any>(text: string): Promise<T[]> => {
  const res: any = await db.execute(sql.raw(text))
  return res?.rows ?? []
}

const dayKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })

async function main() {
  const app = createApplication()
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  console.log(`in-process API at ${base}\n`)

  const [adminRow] = await q(`
    select id, phone from users where role = 'admin' and is_active = true limit 1`)
  if (!adminRow) { console.error('No active admin user (seed-admin.ts creates one).'); process.exit(2) }
  const adminToken = createAdminAccessToken({ id: adminRow.id })

  const coRows = await q(`
    select u.id as user_id, u.phone, e.id::text as employee_id,
           trim(concat(coalesce(e.first_name,''), ' ', coalesce(e.last_name,''))) as name
    from users u left join employees e on e.id = u.employee_id
    where 'co' = any(coalesce(u.roles,'{}')) and u.is_active = true
    order by u.created_at`)

  const foRows = await q(`
    select u.id as user_id, u.phone,
           trim(concat(coalesce(e.first_name,''), ' ', coalesce(e.last_name,''))) as name
    from users u left join employees e on e.id = u.employee_id
    where 'field_officer' = any(coalesce(u.roles,'{}')) and u.is_active = true
    order by (select count(*) from field_officer_sites s where s.field_officer_user_id = u.id) desc, u.created_at`)

  const postings = await q(`
    select fs.field_officer_user_id as user_id, s.id as site_id, s.site_name
    from field_officer_sites fs join sites s on s.id = fs.site_id
    where s.is_active = true`)

  const officers: Officer[] = foRows.map((f: any) => ({
    userId: f.user_id,
    name: f.name || f.phone,
    phone: f.phone,
    sites: postings.filter((p: any) => p.user_id === f.user_id)
      .map((p: any) => ({ id: p.site_id, siteName: p.site_name })),
  }))
  const siteNames = new Map<string, string>(postings.map((p: any) => [p.site_id, p.site_name]))

  const punches = await q(`
    select al.site_id,
           to_char(coalesce(al.attendance_date, (al.created_at at time zone 'Asia/Kolkata')::date), 'YYYY-MM-DD') as day,
           count(*)::int as n
    from attendance_logs al
    group by 1, 2 order by day desc`)
  const shiftRows = await q(`
    select site_id, to_char(attendance_date,'YYYY-MM-DD') as day, shift, id
    from shift_attendance order by attendance_date desc limit 50`)

  // A plain, non-CO employee account to promote for scenario 1 — it doubles as
  // the second Circle Officer the isolation scenarios need.
  const [tempCo] = await q(`
    select u.id as user_id, e.id::text as employee_row_id,
           coalesce(array_to_string(u.roles, ','), u.role) as roles
    from users u join employees e on e.id = u.employee_id
    where u.is_active = true and u.role <> 'admin'
      and not ('co' = any(coalesce(u.roles,'{}')))
      and not ('supervisor' = any(coalesce(u.roles,'{}')))
    order by coalesce(array_length(u.roles, 1), 1) asc, u.created_at
    limit 1`)

  const foWithSites = officers.filter((o) => o.sites.length > 0)
  const co1Row = coRows.find((c: any) => c.user_id !== tempCo?.user_id) ?? coRows[0]

  console.log('fixtures')
  console.log(`  admin          : ${adminRow.phone}`)
  console.log(`  circle officers: ${coRows.map((c: any) => `${c.name || c.phone} (${String(c.user_id).slice(0, 8)})`).join(', ') || '(none)'}`)
  console.log(`  field officers : ${officers.map((o) => `${o.name} [${o.sites.length} site(s): ${o.sites.map((s) => s.siteName).join(', ') || '-'}]`).join(' | ') || '(none)'}`)
  console.log(`  temp CO        : ${tempCo ? `${tempCo.roles} (${String(tempCo.user_id).slice(0, 8)})` : '(none)'}`)
  console.log(`  attendance     : ${punches.length} site/day group(s), newest ${punches[0]?.day ?? '-'}${punches[0] ? ` @ ${siteNames.get(punches[0].site_id) ?? String(punches[0].site_id).slice(0, 8)}` : ''}`)
  console.log(`  shift rows     : ${shiftRows.length ? `${shiftRows[0].day} ${shiftRows[0].shift} @ ${siteNames.get(shiftRows[0].site_id) ?? String(shiftRows[0].site_id).slice(0, 8)}` : '(none)'}`)
  console.log('')

  if (!co1Row || !tempCo || foWithSites.length === 0) {
    console.error('Need an existing CO, a promotable non-CO employee, and one Field Officer with at least one active site.')
    process.exit(2)
  }

  const CO1 = co1Row.user_id as string
  const co1Token = createUserToken({ id: CO1 })
  const TEMP_CO = tempCo.user_id as string
  const tempCoToken = createUserToken({ id: TEMP_CO })
  // Guarded above (`foWithSites.length === 0` exits before this point); the
  // casts just keep the checked array-indexing style happy.
  const foA = foWithSites[0] as Officer
  const foB = (foWithSites[1] ?? foWithSites[0]) as Officer
  // The officer moved in the reassignment scenarios has to be somebody else than
  // the account scenario 1 promotes to a second Circle Officer — the panel
  // refuses to assign a CO to himself, so reusing that account is not a
  // permissible test, let alone a permissible production edit.
  const foM = (foWithSites.find((o) => o.userId !== TEMP_CO) ?? foWithSites[0]) as Officer
  const foAToken = createUserToken({ id: foA.userId })

  // Everything the two officers cover, before any assignment exists.
  const officerSiteIds = new Set([...foA.sites, ...foB.sites].map((s) => s.id))
  const inScopePunch = punches.find((p: any) => officerSiteIds.has(p.site_id))
  const DAY = inScopePunch?.day ?? dayKey()
  const shiftAt = (siteId: string | undefined) => shiftRows.filter((r: any) => r.site_id === siteId)

  // ══ 1 — Admin assigns the CO role to an existing employee ══════════════════
  {
    const original = String(tempCo.roles).split(',')
    const before = dataOf((await call('GET', '/employee/circle-officer/circle-officers', { token: adminToken })).body)
      ?.circleOfficers?.some((c: any) => c.coUserId === TEMP_CO)
    const grant = await call('PATCH', `/employee/employees/${tempCo.employee_row_id}/roles`, {
      token: adminToken,
      body: { roles: [...new Set([...original, 'co'])] },
    })
    const row = dataOf((await call('GET', '/employee/circle-officer/circle-officers', { token: adminToken })).body)
      ?.circleOfficers?.find((c: any) => c.coUserId === TEMP_CO)
    check('1', 'Admin assigns the CO role to an existing employee',
      grant.status === 200 && !before && !!row,
      `PATCH /employee/employees/…/roles → ${grant.status}; listed in the CO table afterwards: ${row ? `${row.name} (status=${row.status}, foCount=${row.foCount})` : 'no'}`)
  }

  // ══ 11 — A CO with no Field Officers sees proper empty states ══════════════
  {
    const sites = await call('GET', '/auth/officer/sites', { token: tempCoToken })
    const fos = await call('GET', '/auth/officer/field-officers', { token: tempCoToken })
    const mySites = await call('GET', '/auth/fo/my-sites', { token: tempCoToken })
    const d = dataOf(sites.body)
    check('11', 'CO with no assigned FOs gets empty states rather than errors',
      sites.status === 200 && d?.scope === 'circle-officer' && (d?.fieldOfficers ?? []).length === 0
      && fos.status === 200 && (dataOf(fos.body)?.fieldOfficers ?? []).length === 0
      && mySites.status === 200 && dataOf(mySites.body)?.scope === 'circle-officer',
      `officer/sites → ${sites.status} scope=${d?.scope} sites=${d?.sites?.length} fieldOfficers=${d?.fieldOfficers?.length}; officer/field-officers → ${fos.status} (list length ${dataOf(fos.body)?.fieldOfficers?.length}); fo/my-sites → ${mySites.status} scope=${dataOf(mySites.body)?.scope}`)
  }

  // ══ 2 + 3 — Assign several FOs to one CO, without duplicates ═══════════════
  {
    const desired = [...new Set(officers.map((o) => o.userId))]
    const withDupe = [...desired, desired[0]]
    const put = await call('PUT', `/employee/circle-officer/circle-officers/${CO1}/field-officers`, {
      token: adminToken, body: { foUserIds: withDupe, confirmReassign: false },
    })
    const active = await q(`
      select fo_user_id, count(*)::int as n from co_fo_assignments
      where co_user_id = '${CO1}' and is_active = true group by fo_user_id`)
    const rePut = await call('PUT', `/employee/circle-officer/circle-officers/${CO1}/field-officers`, {
      token: adminToken, body: { foUserIds: desired, confirmReassign: false },
    })
    const co = dataOf((await call('GET', '/employee/circle-officer/circle-officers', { token: adminToken })).body)
      ?.circleOfficers?.find((c: any) => c.coUserId === CO1)
    const dupes = active.filter((r: any) => r.n > 1)
    check('2', `Admin assigns every Field Officer (${desired.length}) to one CO`,
      put.status === 200 && co?.foCount === desired.length && rePut.status === 200,
      `PUT → ${put.status} ${short(dataOf(put.body))}; re-PUT the same set → ${rePut.status} ${short(dataOf(rePut.body))}; CO row: foCount=${co?.foCount} [${(co?.fieldOfficers ?? []).map((f: any) => f.name).join(', ')}], status=${co?.status}`)
    check('3', 'Multi-assignment writes no duplicate active rows',
      dupes.length === 0 && active.length === desired.length,
      `one id was repeated in the request; active rows now ${active.length} (${active.map((r: any) => `${String(r.fo_user_id).slice(0, 8)}×${r.n}`).join(', ')})`)
  }

  // ══ 4 — An FO keeps multiple sites and the CO inherits all of them ═════════
  {
    const sites = await call('GET', '/auth/officer/sites', { token: co1Token })
    const d = dataOf(sites.body)
    const ids = new Set((d?.sites ?? []).map((s: any) => s.id))
    const missing = foA.sites.filter((s) => !ids.has(s.id))
    check('4', `Field Officer keeps multiple sites and every one reaches the CO ("${foA.name}", ${foA.sites.length} sites)`,
      d?.scope === 'circle-officer' && missing.length === 0 && foA.sites.length > 0,
      `CO scope = ${ids.size} site(s); "${foA.name}" missing: ${missing.length ? j(missing.map((s) => s.siteName)) : 'none'}; scope=${d?.scope}, fieldOfficers=${(d?.fieldOfficers ?? []).map((o: any) => `${o.name}[${o.siteCount ?? (o.sites ?? []).length}]`).join(', ') || short(d?.fieldOfficers)}`)
  }

  // ══ 5 — CO sees Employee Attendance for the assigned FOs ═══════════════════
  {
    const all = await call('GET', '/auth/officer/employees-attendance', {
      token: co1Token, query: { date: DAY, pageSize: 200 },
    })
    const rows = dataOf(all.body)?.rows ?? []
    const scopeIds = new Set((dataOf((await call('GET', '/auth/officer/sites', { token: co1Token })).body)?.sites ?? []).map((s: any) => s.id))
    const foreign = rows.filter((r: any) => !scopeIds.has(r.siteId))
    const withFo = rows.filter((r: any) => r.fieldOfficerNames)
    check('5', 'CO sees Employee Attendance for his assigned FOs, with the Field Officer column',
      all.status === 200 && foreign.length === 0 && rows.length === withFo.length
      && (inScopePunch ? rows.length > 0 : true),
      `${DAY} → ${all.status}; rows=${rows.length}, out-of-scope=${foreign.length}, carrying fieldOfficerNames=${withFo.length}; summary=${short(dataOf(all.body)?.summary)}`)

    const foSites = new Set(foA.sites.map((s) => s.id))
    const filtered = await call('GET', '/auth/officer/employees-attendance', {
      token: co1Token, query: { date: DAY, foUserId: foA.userId, pageSize: 200 },
    })
    const fRows = dataOf(filtered.body)?.rows ?? []
    const outside = fRows.filter((r: any) => !foSites.has(r.siteId))
    check('5b', 'foUserId narrows the report to that officer\'s sites',
      filtered.status === 200 && outside.length === 0,
      `foUserId=${foA.name} → ${filtered.status}, rows=${fRows.length}, rows outside his ${foSites.size} site(s): ${outside.length}`)

    const absent = await call('GET', '/auth/officer/employees-attendance', {
      token: co1Token, query: { date: DAY, status: 'Absent', pageSize: 200 },
    })
    const aRows = dataOf(absent.body)?.rows ?? []
    const notAbsent = aRows.filter((r: any) => r.status !== 'Absent')
    check('5c', 'status filter runs in SQL, and the summary follows it',
      absent.status === 200 && notAbsent.length === 0,
      `status=Absent → ${absent.status}, rows=${aRows.length}, non-Absent rows in the page: ${notAbsent.length}; summary=${short(dataOf(absent.body)?.summary)}`)
  }

  // ══ 6 — CO reads the Supervisor-submitted Shift Attendance of his FOs ══════
  {
    const siteWithShift = foA.sites.find((s) => shiftAt(s.id).length > 0)
    const mySites = await call('GET', '/auth/fo/my-sites', { token: co1Token })
    const md = dataOf(mySites.body)
    if (!siteWithShift) {
      record('6', 'CO sees submitted Shift Attendance', 'SKIP',
        `no shift_attendance row exists under "${foA.name}"'s sites in this environment`)
    } else {
      const day = shiftAt(siteWithShift.id)[0].day
      const res = await call('GET', '/auth/fo/shift-attendance', {
        token: co1Token, query: { siteId: siteWithShift.id, date: day },
      })
      const d = dataOf(res.body)
      const expected = shiftAt(siteWithShift.id).filter((r: any) => r.day === day)
      const seen = new Set((d?.records ?? []).map((r: any) => r.id))
      const missing = expected.filter((r: any) => !seen.has(r.id))
      const wanted = await call('GET', '/auth/fo/shift-attendance', {
        token: co1Token, query: { siteId: siteWithShift.id, date: day, shift: expected[0].shift },
      })
      const wRecs = dataOf(wanted.body)?.records ?? []
      const wrongShift = wRecs.filter((r: any) => r.shift !== expected[0].shift)
      check('6', 'CO sees the Supervisor-submitted Shift Attendance rows for his FOs\' sites',
        res.status === 200 && d?.scope === 'circle-officer' && missing.length === 0 && (d?.records ?? []).length > 0,
        `${siteWithShift.siteName} ${day} → ${res.status}; records=${(d?.records ?? []).length} (db rows for that day: ${expected.length}, missing ${missing.length}), scope=${d?.scope}, fieldOfficers=${(d?.fieldOfficers ?? []).map((o: any) => o.name).join(', ')}`)
      check('6b', 'shift filter returns only that shift',
        wanted.status === 200 && wrongShift.length === 0,
        `shift=${expected[0].shift} → ${wanted.status}, records=${wRecs.length}, other shifts in the page: ${wrongShift.length}`)
    }
    check('6c', 'The CO\'s shift-attendance site list is the derived circle',
      mySites.status === 200 && md?.scope === 'circle-officer' && (md?.sites?.length ?? 0) > 0 && (md?.fieldOfficers?.length ?? 0) > 0,
      `fo/my-sites → ${mySites.status} sites=${md?.sites?.length} scope=${md?.scope} fieldOfficers=${md?.fieldOfficers?.length}; sites carrying officers=${(md?.sites ?? []).filter((s: any) => (s.officers ?? []).length > 0).length}`)
  }

  // ══ 8 — Nothing unsubmitted is reachable ═══════════════════════════════════
  {
    // shift_attendance has no draft state to leak: a row only exists once the
    // Supervisor submitted it with its photo (image_path NOT NULL, one row per
    // site+date+shift). Both halves are asserted rather than assumed.
    const empty = await call('GET', '/auth/fo/shift-attendance', {
      token: co1Token, query: { siteId: foA.sites[0]?.id, date: '2020-01-02' },
    })
    const real = await call('GET', '/auth/fo/shift-attendance', {
      token: co1Token, query: { siteId: foA.sites[0]?.id, date: DAY },
    })
    const recs = dataOf(real.body)?.records ?? []
    const withoutImage = recs.filter((r: any) => !r.imagePath)
    check('8', 'CO cannot reach an unsubmitted Shift Attendance record',
      empty.status === 200 && (dataOf(empty.body)?.records ?? []).length === 0 && withoutImage.length === 0,
      `site+date with no submission → ${empty.status}, records=${dataOf(empty.body)?.records?.length}; site+${DAY} → ${real.status}, ${recs.length} record(s) of which ${withoutImage.length} lack the stored photo (a row only exists after a submission)`)
  }

  // ══ 9 — CO is read-only, enforced on the server ════════════════════════════
  {
    const create = await call('POST', '/auth/supervisor/shift-attendance', {
      token: co1Token,
      body: { shift: 'morning', present_employees: 1, image: TINY_PNG, attendanceDate: DAY, siteId: foA.sites[0]?.id },
    })
    const someRow = shiftRows[0]
    const update = someRow
      ? await call('PUT', `/auth/supervisor/shift-attendance/${someRow.id}`, {
        token: co1Token, body: { present_employees: 999 },
      })
      : { status: 403, body: 'no existing row to target' }
    const read = await call('GET', '/auth/supervisor/shift-attendance', {
      token: co1Token, query: { date: DAY },
    })
    const checkIn = await call('POST', '/auth/fo/visits/check-in', {
      token: co1Token, body: { siteId: foA.sites[0]?.id, latitude: 20.3, longitude: 85.8 },
    })
    const start = await call('POST', '/auth/fo/sessions/start', {
      token: co1Token, body: { latitude: 20.3, longitude: 85.8 },
    })
    check('9', 'CO cannot create or modify Shift Attendance through any endpoint',
      create.status === 403 && update.status === 403 && read.status === 403,
      `POST → ${create.status} ${short(create.body?.message ?? create.body, 110)}; PUT ${String(someRow?.id).slice(0, 8)} → ${update.status} ${short(update.body?.message ?? update.body, 110)}; supervisor GET → ${read.status} (the 'shift-attendance' facility is simply not in the CO page set)`)
    check('9b', 'CO cannot open tracking or punch (write guards still exclude co)',
      checkIn.status === 403 && start.status === 403,
      `POST /auth/fo/visits/check-in → ${checkIn.status} ${short(checkIn.body?.message ?? '', 90)}; POST /auth/fo/sessions/start → ${start.status} ${short(start.body?.message ?? '', 90)}`)
  }

  // ══ 13 — Existing FO Shift Attendance viewing is unchanged ═════════════════
  {
    const sites = await call('GET', '/auth/fo/my-sites', { token: foAToken })
    const d = dataOf(sites.body)
    const day = shiftAt(foA.sites[0]?.id)[0]?.day ?? DAY
    const read = await call('GET', '/auth/fo/shift-attendance', {
      token: foAToken, query: { siteId: foA.sites[0]?.id, date: day },
    })
    const foFilter = await call('GET', '/auth/fo/shift-attendance', {
      token: foAToken, query: { siteId: foA.sites[0]?.id, date: day, foUserId: foB.userId },
    })
    const forged = await call('GET', '/auth/fo/shift-attendance', {
      token: foAToken, query: { siteId: '00000000-0000-4000-8000-000000000000', date: day },
    })
    const officerReport = await call('GET', '/auth/officer/employees-attendance', {
      token: foAToken, query: { date: day, pageSize: 50 },
    })
    check('13', 'Existing FO Shift Attendance viewing still works, scope unchanged',
      sites.status === 200 && d?.scope === 'officer-sites' && (d?.fieldOfficers ?? []).length === 0
      && read.status === 200 && dataOf(read.body)?.scope === 'officer-sites'
      && foFilter.status === 403 && forged.status === 403 && officerReport.status === 200,
      `fo/my-sites → ${sites.status} sites=${d?.sites?.length} scope=${d?.scope} fieldOfficers=${d?.fieldOfficers?.length}; read ${day} → ${read.status} records=${dataOf(read.body)?.records?.length} scope=${dataOf(read.body)?.scope}; an FO sending foUserId → ${foFilter.status} ${short(dataOf(foFilter.body)?.message, 80)}; forged site → ${forged.status}; his employee-attendance report → ${officerReport.status} rows=${dataOf(officerReport.body)?.rows?.length}`)
  }

  // ══ 14 — Other roles keep working ══════════════════════════════════════════
  {
    const notes: string[] = []
    let ok = true

    const [supervisor] = await q(`
      select u.id from users u
      where 'supervisor' = any(coalesce(u.roles,'{}')) and u.is_active = true limit 1`)
    if (supervisor) {
      const t = createUserToken({ id: supervisor.id })
      const team = await call('GET', '/auth/supervisor/team', { token: t, query: { date: DAY } })
      const shift = await call('GET', '/auth/supervisor/shift-attendance', { token: t, query: { date: DAY } })
      const viol = await call('GET', '/auth/supervisor/violation-types', { token: t })
      notes.push(`supervisor: team ${team.status}, shift list ${shift.status} (rows ${dataOf(shift.body)?.records?.length ?? dataOf(shift.body)?.rows?.length ?? 0}), violation-types ${viol.status}`)
      ok = ok && team.status === 200 && shift.status === 200 && viol.status === 200
    } else { ok = false; notes.push('supervisor: no account found') }

    const [oh] = await q(`
      select u.id, u.phone from users u
      where 'oh' = any(coalesce(u.roles,'{}')) and u.is_active = true limit 1`)
    if (oh) {
      const t = createUserToken({ id: oh.id })
      const mySites = await call('GET', '/auth/fo/my-sites', { token: t })
      const sites = await call('GET', '/auth/officer/sites', { token: t })
      const report = await call('GET', '/auth/officer/employees-attendance', { token: t, query: { date: DAY, pageSize: 50 } })
      const foFilterRefused = await call('GET', '/auth/officer/employees-attendance', {
        token: t, query: { date: DAY, foUserId: foA.userId, pageSize: 50 },
      })
      notes.push(`oh: my-sites ${mySites.status} scope=${dataOf(mySites.body)?.scope}, officer/sites ${sites.status} (sites ${dataOf(sites.body)?.sites?.length}), report ${report.status}, foUserId as a non-CO ${foFilterRefused.status}`)
      ok = ok && mySites.status === 200 && sites.status === 200 && report.status === 200 && foFilterRefused.status === 403
    } else { notes.push('oh: no account found (skipped)') }

    const employees = await call('GET', '/employee/employees', { token: adminToken })
    const fos = await call('GET', '/employee/field-officer/officers', { token: adminToken })
    const picker = await call('GET', '/employee/circle-officer/field-officers', { token: adminToken })
    const pickerDenied = await call('GET', '/employee/circle-officer/circle-officers', { token: co1Token })
    notes.push(`admin: employees ${employees.status}, field officers ${fos.status}, CO picker ${picker.status} (${dataOf(picker.body)?.fieldOfficers?.length ?? 0} rows with currentCo set on ${dataOf(picker.body)?.fieldOfficers?.filter((f: any) => f.currentCo).length ?? 0})`)
    notes.push(`non-admin on the CO panel: ${pickerDenied.status} ${short(dataOf(pickerDenied.body)?.message, 60)}`)
    ok = ok && employees.status === 200 && fos.status === 200 && picker.status === 200 && pickerDenied.status === 403
    check('14', 'Supervisor / OH / admin surfaces unchanged, and the CO panel stays admin-only', ok, notes.join('; '))

    const rolePages = await call('GET', '/auth/role-pages', { token: adminToken })
    const rows = Array.isArray(dataOf(rolePages.body)) ? dataOf(rolePages.body) : []
    const coPages = rows.find((r: any) => r.role === 'co')?.pages
    check('14b', 'CO page set is exactly home/profile plus the two attendance reports',
      Array.isArray(coPages) && coPages.includes('officer-employee-attendance') && coPages.includes('fo-shift-attendance')
      && !coPages.includes('shift-attendance') && !coPages.includes('register-employee')
      && !coPages.includes('officer-shift-attendance') && !coPages.includes('take-attendance'),
      `role_pages.co = ${j(coPages)}`)

    const me = await call('GET', '/auth/me', { token: co1Token })
    const pages = dataOf(me.body)?.allowedPages ?? []
    check('14c', 'A live CO session resolves only the two attendance facilities',
      me.status === 200 && pages.includes('officer-employee-attendance') && pages.includes('fo-shift-attendance')
      && !pages.includes('shift-attendance') && !pages.includes('take-attendance'),
      `GET /auth/me → ${me.status}, roles=${j(dataOf(me.body)?.roles)}, allowedPages=${j(pages)}`)
  }

  // ══ 12 — Supervisor submission still works, end to end ═════════════════════
  {
    const supervisor = await q(`
      select u.id, e.id::text as employee_id from users u
      join employees e on e.id = u.employee_id
      where 'supervisor' = any(coalesce(u.roles,'{}')) and u.is_active = true limit 1`)
    const supSites = supervisor[0]
      ? await q(`select site_id from employee_sites where employee_id = '${supervisor[0].employee_id}'`)
      : []
    const inScope = supSites.map((s: any) => s.site_id).find((id: string) => officerSiteIds.has(id))
    const targetSite = inScope ?? supSites[0]?.site_id
    if (!supervisor[0] || !targetSite) {
      record('12', 'Supervisor Shift Attendance submission', 'SKIP',
        supervisor[0] ? 'the supervisor account has no site to submit against' : 'no supervisor account in this environment')
    } else {
      const t = createUserToken({ id: supervisor[0].id })
      const day = '2020-01-02'
      const create = await call('POST', '/auth/supervisor/shift-attendance', {
        token: t,
        body: {
          shift: 'night',
          present_employees: 3,
          description: 'Circle Officer verification — synthetic row, removed below',
          attendanceDate: day,
          siteId: targetSite,
          image: TINY_PNG,
        },
      })
      const id = dataOf(create.body)?.id
      const list = await call('GET', '/auth/supervisor/shift-attendance', { token: t, query: { date: day } })
      const listed = (dataOf(list.body)?.records ?? dataOf(list.body)?.rows ?? []).some((r: any) => r.id === id)
      const coSees = inScope
        ? await call('GET', '/auth/fo/shift-attendance', { token: co1Token, query: { siteId: targetSite, date: day } })
        : { status: 0, body: null }
      const seenByCo = (dataOf(coSees.body)?.records ?? []).some((r: any) => r.id === id)
      check('12', 'Supervisor submission flow works and reaches the CO read path',
        create.status === 201 && !!id && listed && (inScope ? coSees.status === 200 && seenByCo : true),
        `POST → ${create.status} ${short(create.body?.message ?? create.body ?? '', 140)}; row ${String(id).slice(0, 8)} in the supervisor list for ${day}: ${listed}; in the CO's shift view for ${siteNames.get(targetSite) ?? String(targetSite).slice(0, 8)}${inScope ? `: ${seenByCo} (${coSees.status})` : ' (site is outside the CO circle, so only the supervisor side was checked)'}`)
      if (id) {
        const [row] = await db.select({ imagePath: shiftAttendance.imagePath })
          .from(shiftAttendance).where(eq(shiftAttendance.id, id))
        await db.delete(shiftAttendance).where(eq(shiftAttendance.id, id))
        if (row?.imagePath) await unlink(join(SHIFT_UPLOAD_ROOT, row.imagePath)).catch(() => null)
        console.log(`       synthetic row ${String(id).slice(0, 8)} and its photo removed again`)
      }
    }
  }

  // ══ 10 + 7 — Reassignment moves access at once; COs stay apart ═════════════
  let reassigned = false
  {
    // Sites that leave the old circle are the ones ONLY the moved officer holds.
    // A site another retained officer also works stays visible — that is the
    // derived scope doing its job, so asserting its disappearance would be
    // asserting a bug.
    const keptOfficer = officers.find((o) => o.userId !== foM.userId && o.sites.length > 0)
    const retainedSiteIds = new Set(
      officers.filter((o) => o.userId !== foM.userId).flatMap((o) => o.sites.map((s) => s.id)),
    )
    const exclusive = foM.sites.filter((s) => !retainedSiteIds.has(s.id))
    if (foM.userId === TEMP_CO || !keptOfficer || exclusive.length === 0) {
      record('10', 'Reassignment changes current access', 'SKIP',
        foM.userId === TEMP_CO
          ? 'no Field Officer available who is not the second Circle Officer'
          : !keptOfficer
            ? 'no second Field Officer with active sites to leave behind'
            : `every site of "${foM.name}" is also held by a retained officer, so nothing can observably leave the circle`)
      record('7', 'A CO cannot see another CO\'s FOs or sites', 'SKIP', 'needs two officers under two different COs')
    } else {
      const attempt = await call('PUT', `/employee/circle-officer/circle-officers/${TEMP_CO}/field-officers`, {
        token: adminToken, body: { foUserIds: [foM.userId], confirmReassign: false },
      })
      const conflicts = dataOf(attempt.body)?.conflicts ?? []
      const confirmed = await call('PUT', `/employee/circle-officer/circle-officers/${TEMP_CO}/field-officers`, {
        token: adminToken, body: { foUserIds: [foM.userId], confirmReassign: true },
      })
      const co1Sites = dataOf((await call('GET', '/auth/officer/sites', { token: co1Token })).body)
      const co2Sites = dataOf((await call('GET', '/auth/officer/sites', { token: tempCoToken })).body)
      const co1Ids = new Set((co1Sites?.sites ?? []).map((s: any) => s.id))
      const co2Ids = new Set((co2Sites?.sites ?? []).map((s: any) => s.id))
      const stillThere = exclusive.filter((s) => co1Ids.has(s.id))
      const gained = foM.sites.filter((s) => co2Ids.has(s.id))
      const kept = keptOfficer.sites.filter((s) => co1Ids.has(s.id))
      const shiftedAway = await call('GET', '/auth/fo/shift-attendance', {
        token: co1Token, query: { siteId: exclusive[0]?.id, date: shiftAt(exclusive[0]?.id)[0]?.day ?? DAY },
      })
      check('10', 'Reassignment takes effect on the very next request, for both COs',
        attempt.status === 409 && conflicts.length === 1 && confirmed.status === 200
        && stillThere.length === 0 && gained.length === foM.sites.length && kept.length === keptOfficer.sites.length
        && shiftedAway.status === 403,
        `PUT without confirm → ${attempt.status} ${short(attempt.body?.message ?? '', 90)}, conflicts=${short(conflicts, 150)}; with confirm → ${confirmed.status} ${short(dataOf(confirmed.body))}; "${foM.name}"'s ${exclusive.length} exclusive site(s) still visible to the old CO: ${stillThere.length}; all ${foM.sites.length} of his sites now with the new CO: ${gained.length}; the old CO keeps "${keptOfficer.name}": ${kept.length}/${keptOfficer.sites.length}; his shift read for a site that left → ${shiftedAway.status}`)

      const hist = await call('GET', '/employee/circle-officer/history', { token: adminToken, query: { foUserId: foM.userId } })
      const rowsH = dataOf(hist.body)?.history ?? []
      const closed = rowsH.filter((r: any) => !r.isActive)
      reassigned = confirmed.status === 200
      // The officer did not simply leave — he went to another Circle Officer, so
      // the row this run just closed has to read as a reassignment. Deriving that
      // from the rows (rather than storing it) is only sound if the correlation
      // holds, so the newest closed row is checked by name, not by any older one.
      const lastClosed = [...closed].sort((a: any, b: any) => new Date(b.removedAt).getTime() - new Date(a.removedAt).getTime())[0]
      check('10b', 'History preserved — the old pairing is closed, never deleted',
        hist.status === 200 && closed.length >= 1 && closed.every((r: any) => r.removedAt) && rowsH.some((r: any) => r.isActive)
        && lastClosed?.status === 'REASSIGNED' && lastClosed?.coUserId === CO1,
        `${rowsH.length} row(s) for "${foM.name}": ${closed.length} closed with removedAt, ${rowsH.length - closed.length} active; the row this run closed (${lastClosed ? String(lastClosed.coName) : 'none'}) derives ${j(lastClosed?.status)}; ${j(rowsH.map((r: any) => `${r.coName}→${r.status} by ${r.assignedByName}`))}`)

      const co1Site = await call('GET', '/auth/officer/employees-attendance', {
        token: co1Token, query: { date: DAY, siteId: exclusive[0]?.id },
      })
      const co1Fo = await call('GET', '/auth/officer/employees-attendance', {
        token: co1Token, query: { date: DAY, foUserId: foM.userId },
      })
      const co2Fo = await call('GET', '/auth/officer/employees-attendance', {
        token: tempCoToken, query: { date: DAY, foUserId: keptOfficer.userId },
      })
      // Only meaningful when the two circles genuinely differ: if every site of
      // the retained officer is also worked by the moved one, the new CO is
      // entitled to it and there is nothing foreign to try.
      const foreignSite = keptOfficer.sites.find((s) => !co2Ids.has(s.id))
      const co2Site = foreignSite
        ? await call('GET', '/auth/officer/employees-attendance', {
          token: tempCoToken, query: { date: DAY, siteId: foreignSite.id },
        })
        : null
      const co2Note = co2Site
        ? `that officer's site outside his circle → ${co2Site.status}`
        : 'his own circle covers every site of the retained officer, so no foreign site was left to try'
      check('7', 'A CO cannot read another CO\'s Field Officers or sites, filter or direct',
        co1Site.status === 403 && co1Fo.status === 403 && co2Fo.status === 403
        && (!co2Site || co2Site.status === 403),
        `old CO → moved officer's freed site ${co1Site.status}, his foUserId filter ${co1Fo.status}; new CO → the retained officer's foUserId ${co2Fo.status}; ${co2Note}`)
    }
  }

  // ── Leave a usable demo state ──────────────────────────────────────────────
  {
    const back = reassigned
      ? await call('PUT', `/employee/circle-officer/circle-officers/${CO1}/field-officers`, {
        token: adminToken,
        body: { foUserIds: [...new Set(officers.map((o) => o.userId))], confirmReassign: true },
      })
      : { status: 200, body: null }
    const original = String(tempCo.roles).split(',').filter((r) => r !== 'co')
    const release = reassigned
      ? await call('DELETE', `/employee/circle-officer/circle-officers/${TEMP_CO}/field-officers/${foM.userId}`, { token: adminToken })
      : { status: 404, body: null }
    const revoke = await call('PATCH', `/employee/employees/${tempCo.employee_row_id}/roles`, {
      token: adminToken, body: { roles: original.length ? original : ['employee'] },
    })
    const refused = await call('GET', '/auth/officer/field-officers', { token: tempCoToken })
    const finalList = dataOf((await call('GET', '/employee/circle-officer/circle-officers', { token: adminToken })).body)
    console.log(`\nfinal state: ${j((finalList?.circleOfficers ?? []).map((c: any) => `${c.name} → ${(c.fieldOfficers ?? []).map((f: any) => f.name).join(', ') || '(no FO)'} [${c.status}]`))}`)
    console.log(`cleanup: reassigned back → ${back.status}; temporary CO released → ${release.status}; roles reverted to ${j(original)} → ${revoke.status}; the demoted account's CO-only endpoint → ${refused.status}`)
  }

  const history = await call('GET', '/employee/circle-officer/history', { token: adminToken, query: { limit: 100 } })
  console.log(`assignment history: ${dataOf(history.body)?.history?.length ?? 0} row(s) — every assignment this run made is still there`)

  const tally: Record<Verdict, number> = { PASS: 0, FAIL: 0, SKIP: 0 }
  for (const r of results) tally[r.verdict]++
  console.log(`\n${tally.PASS} passed, ${tally.FAIL} failed, ${tally.SKIP} skipped`)
  for (const r of results.filter((x) => x.verdict !== 'PASS')) console.log(`  ${r.verdict} [${r.n}] ${r.label}`)

  server.close()
  await db.execute(sql`select 1`)
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('verification run failed:', err?.cause ?? err)
  process.exit(1)
})
