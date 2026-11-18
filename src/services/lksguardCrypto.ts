import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM for SMS content at rest (#11/#24).
 *
 * Only ever used under the SMS_CONTENT policy — metadata-only rows store no
 * ciphertext. The key comes from the environment (`LKSGUARD_SMS_KEY`, 32 bytes
 * hex). Plaintext is never persisted and never returned by a list endpoint; only
 * the explicit, audited content-view path decrypts it.
 *
 * GCM's auth tag is what makes this tamper-evident: a ciphertext edited in the
 * database fails decryption here rather than yielding silently-wrong text.
 */

// A missing/misconfigured key is a deploy error, surfaced with an actionable
// message rather than an opaque crypto exception deep inside a request handler.
function keyBuffer(): Buffer {
    const hex = process.env.LKSGUARD_SMS_KEY
    if (!hex || hex.length !== 64) {
        throw new Error(
            'LKSGUARD_SMS_KEY must be a 64-hex-char (32-byte) key. Generate one ' +
                "with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
        )
    }
    return Buffer.from(hex, 'hex')
}

export interface EncryptedContent {
    cipher: string
    iv: string
}

/** Encrypt a plaintext SMS body. Returns base64 cipher + iv (GCM tag appended). */
export function encryptSmsContent(plaintext: string): EncryptedContent {
    const iv = randomBytes(12) // 96-bit nonce — the recommended GCM size
    const cipher = createCipheriv('aes-256-gcm', keyBuffer(), iv)
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    // The auth tag travels with the ciphertext; it is not secret.
    const withTag = Buffer.concat([enc, cipher.getAuthTag()])
    return { cipher: withTag.toString('base64'), iv: iv.toString('base64') }
}

/**
 * Decrypt back to plaintext. Throws on a bad key or a tampered ciphertext
 * (auth-tag mismatch) — callers translate that into a 500/audit note, never a
 * silently-empty body.
 */
export function decryptSmsContent(cipherB64: string, ivB64: string): string {
    const raw = Buffer.from(cipherB64, 'base64')
    const iv = Buffer.from(ivB64, 'base64')
    const tag = raw.subarray(raw.length - 16)
    const data = raw.subarray(0, raw.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', keyBuffer(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
