import { randomBytes } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Persists manually captured attendance photos under `attendance-images/`.
 *
 * Mirrors faceImageStore/reportStore conventions:
 * - Files live outside the DB; only the relative path is stored in
 *   `attendance_logs.image_path` (e.g. "attendance-images/<file>").
 * - Unique filename per capture: `<employeeId>_<YYYYMMDD>_<HHMMSS>_<rand>.jpg`
 *   so previous days are never overwritten (spec example:
 *   "attendance-images/EMP001_20260916_084530.jpg").
 * - Served via the existing `express.static(UPLOAD_ROOT)` mount at /uploads
 *   (same as faces/ and reports/) — no new static route needed.
 */

const UPLOAD_ROOT = process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads')
const ATTENDANCE_DIR = path.join(UPLOAD_ROOT, 'attendance-images')

export const ATTENDANCE_PUBLIC_PREFIX = 'attendance-images'

// Mobile compresses to JPEG/WebP before upload; accept what the device sends.
const MAX_BYTES = 5 * 1024 * 1024

function extensionFor(buffer: Buffer, fallback = 'jpg'): string {
  if (buffer.length >= 4) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'webp'
  }
  return fallback
}

function stamp(d = new Date()): { day: string; time: string } {
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return {
    day: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
  }
}

/** Safe employee token for filenames (uuids contain dashes — keep them, strip the rest). */
function safeEmployeeToken(employeeId: string): string {
  const s = String(employeeId ?? '').replace(/[^A-Za-z0-9-]/g, '')
  return s.length > 0 ? s : 'EMP'
}

/**
 * Writes the (already device-compressed) manual capture and returns the
 * DB-relative path. Throws on empty/oversize payloads.
 */
export async function saveAttendanceImage(
  employeeId: string,
  attendanceDate: string, // YYYY-MM-DD (validated by caller)
  base64: string,
): Promise<string> {
  const raw = base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
  const buffer = Buffer.from(raw, 'base64')
  if (buffer.length === 0) throw new Error('Attendance image is empty')
  if (buffer.length > MAX_BYTES) throw new Error('Attendance image exceeds 5 MB limit')

  const ext = extensionFor(buffer)
  const { day, time } = stamp()
  const dateToken = (attendanceDate ?? '').replace(/-/g, '') || day
  const fileName = `${safeEmployeeToken(employeeId)}_${dateToken}_${time}_${randomBytes(4).toString('hex')}.${ext}`

  await mkdir(ATTENDANCE_DIR, { recursive: true })
  await writeFile(path.join(ATTENDANCE_DIR, fileName), buffer)

  return `${ATTENDANCE_PUBLIC_PREFIX}/${fileName}`
}

/**
 * Removes a previously stored manual capture — used when the DB-affecting step
 * fails after the image was written, so a failed check-in never leaves an
 * orphaned photo behind. Best-effort: a missing file is the desired end state.
 */
export async function deleteAttendanceImage(publicPath: string | null | undefined): Promise<void> {
    if (!publicPath || !publicPath.startsWith(`${ATTENDANCE_PUBLIC_PREFIX}/`)) return

    // Only the basename is used, so a stored value containing `../` cannot walk
    // out of the attendance-images directory even if one ever got written.
    const fileName = path.basename(publicPath)
    try {
        await unlink(path.join(ATTENDANCE_DIR, fileName))
    } catch {
        // Already gone, or never written. Nothing to do.
    }
}

export const ATTENDANCE_UPLOAD_ROOT = UPLOAD_ROOT
