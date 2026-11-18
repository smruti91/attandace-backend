import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Persists optional evidence photos attached to an employee-violation report.
 *
 * Mirrors shiftAttendanceImageStore / faceImageStore conventions:
 * - Files live outside the DB; only the relative path is stored in
 *   `employee_violations.evidence_image_path` (e.g. "violation-evidence-images/<file>").
 * - Unique filename per submission so two reports never overwrite each other.
 * - Served via the existing `express.static(UPLOAD_ROOT)` mount at /uploads
 *   (same as faces/reports/shift-attendance-images) — no new static route needed.
 *
 * The evidence photo is optional: the caller only reaches this when the
 * supervisor actually attached an image. Reports stay immutable, so there is no
 * delete path — a re-submitted violation is a new row with its own file.
 */

const UPLOAD_ROOT = process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads')
const EVIDENCE_DIR = path.join(UPLOAD_ROOT, 'violation-evidence-images')

export const VIOLATION_PUBLIC_PREFIX = 'violation-evidence-images'

// Well above anything a device-compressed capture (~1600px JPEG ≈ 300–600 KB)
// produces, so anything larger is a client bug or probing — cheaper to reject
// than to write to disk.
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
 * Writes the (already device-compressed) evidence photo and returns the
 * DB-relative path. Throws on empty/oversize/non-image payloads — the caller
 * maps this to a 400 with a friendly message.
 */
export async function saveViolationEvidenceImage(
  employeeId: string,
  base64: string,
): Promise<string> {
  const raw = base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
  const buffer = Buffer.from(raw, 'base64')
  if (buffer.length === 0) throw new Error('Evidence photo is empty')
  if (buffer.length > MAX_BYTES) throw new Error('Evidence photo exceeds 8 MB limit')

  const ext = extensionFor(buffer)
  if (!ext || !ALLOWED_EXT.has(ext)) throw new Error('Evidence photo must be a JPEG, PNG or WebP image')

  const fileName = `${safeToken(employeeId, 'emp').slice(0, 8)}_${Date.now()}_${randomBytes(4).toString('hex')}.${ext}`

  await mkdir(EVIDENCE_DIR, { recursive: true })
  await writeFile(path.join(EVIDENCE_DIR, fileName), buffer)

  return `${VIOLATION_PUBLIC_PREFIX}/${fileName}`
}

export const VIOLATION_UPLOAD_ROOT = UPLOAD_ROOT
