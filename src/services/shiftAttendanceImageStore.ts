import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Persists Shift Attendance group photos under `shift-attendance-images/`.
 *
 * Mirrors attendanceImageStore/reportStore conventions:
 * - Files live outside the DB; only the relative path is stored in
 *   `shift_attendance.image_path` (e.g. "shift-attendance-images/<file>").
 * - Unique filename per submission: `<site>_<YYYYMMDD>_<shift>_<HHMMSS>_<rand>.jpg`
 *   so resubmissions never overwrite each other.
 * - Served via the existing `express.static(UPLOAD_ROOT)` mount at /uploads
 *   (same as faces/reports/attendance-images) — no new static route needed.
 */

const UPLOAD_ROOT = process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads')
const SHIFT_DIR = path.join(UPLOAD_ROOT, 'shift-attendance-images')

export const SHIFT_PUBLIC_PREFIX = 'shift-attendance-images'

// Group photos are wider scenes than single faces; still cap well above the
// device-compressed size (~1600px JPEG ≈ 300–600 KB).
const MAX_BYTES = 8 * 1024 * 1024

const ALLOWED_EXT = new Set(['jpg', 'png', 'webp'])

function extensionFor(buffer: Buffer): string | null {
  if (buffer.length < 4) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'webp'
  return null
}

function safeToken(s: string, fallback: string): string {
  const t = String(s ?? '').replace(/[^A-Za-z0-9-]/g, '')
  return t.length > 0 ? t : fallback
}

/**
 * Writes the (already device-compressed) group photo and returns the
 * DB-relative path. Throws on empty/oversize/non-image payloads — the caller
 * maps this to a 400 with a friendly message.
 */
export async function saveShiftAttendanceImage(
  siteId: string,
  attendanceDate: string, // YYYY-MM-DD (validated by caller)
  shift: string, // morning|day|night|general (validated by caller)
  base64: string,
): Promise<string> {
  const raw = base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
  const buffer = Buffer.from(raw, 'base64')
  if (buffer.length === 0) throw new Error('Group photo is empty')
  if (buffer.length > MAX_BYTES) throw new Error('Group photo exceeds 8 MB limit')

  const ext = extensionFor(buffer)
  if (!ext || !ALLOWED_EXT.has(ext)) throw new Error('Group photo must be a JPEG, PNG or WebP image')

  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const dateToken = (attendanceDate ?? '').replace(/-/g, '') || `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  const timeToken = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const fileName = `${safeToken(siteId, 'site').slice(0, 8)}_${dateToken}_${safeToken(shift, 'shift')}_${timeToken}_${randomBytes(4).toString('hex')}.${ext}`

  await mkdir(SHIFT_DIR, { recursive: true })
  await writeFile(path.join(SHIFT_DIR, fileName), buffer)

  return `${SHIFT_PUBLIC_PREFIX}/${fileName}`
}

export const SHIFT_UPLOAD_ROOT = UPLOAD_ROOT
