import { z } from 'zod'

// ── The mobile number, and the wording that goes with it ─────────────────────
// Sign-in (handset and web panel), account creation and the forgot-password
// request all identify an account by the same ten digits HR seeded, so they
// share one rule instead of three near-misses. "10 to 15 characters" let a
// pasted "+91 700-832-8096" through validation and then answer "user does not
// exist" for a number that is perfectly well known — while a genuinely short
// typo was refused with `body validation failed`, which names no field.
//
// So: strip the separators and any country/trunk prefix first, then demand the
// real number. Nothing is loosened — what reaches a lookup is always the
// canonical ten digits.
const MOBILE_RE = /^[6-9]\d{9}$/

export function normalizeMobileNumber(raw: string): string {
    const digits = raw.replace(/\D/g, '')
    // 14 digits opening with 0091 or 12 with 91 = the country code, dialled or
    // pasted; 11 opening with 0 = the national trunk prefix. Anything else is
    // taken as typed and judged on its own.
    if (digits.length === 14 && digits.startsWith('0091')) return digits.slice(4)
    if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
    if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1)
    return digits
}

/**
 * `label` is the word the screen should use, because zod's own message for an
 * absent value ("expected string, received undefined") describes the parser
 * rather than what the person forgot to type.
 */
const mobileNumberField = (label: string) =>
    z
        .string({ error: `${label} is required` })
        .transform((v) => normalizeMobileNumber(v))
        .pipe(z.string().regex(MOBILE_RE, `Enter a valid 10-digit ${label.toLowerCase()}`))

// 5, not the strong-policy minimum: this is what a person types to get IN, and
// accounts seeded with the default password are legitimately five characters.
// The policy for a NEW password lives in services/passwordPolicy.
const passwordField = (label = 'Password') =>
    z.string({ error: `${label} is required` }).min(5, `${label} must be at least 5 characters`)

/**
 * The sentence a 400 carries. Every rule above is written as instructions to
 * the person who tripped it, so the issues are joined rather than translated.
 */
export function describeBodyIssues(issues: z.ZodIssue[]): string {
    const sentences = issues.map((issue) => issue.message).filter(Boolean)
    return sentences.length ? sentences.join('. ') : 'Please check the details entered.'
}

export const signupPayloadModel = z.object({
    firstName: z.string().min(2),
    lastName: z.string().nullable().optional(),
    phone: mobileNumberField('Phone number'),
    password: passwordField()
})

export const signinPayloadModel = z.object({
    phone: mobileNumberField('Phone number'),
    password: passwordField()
})

export const registerByPhoneModel = z.object({
  phone: mobileNumberField('Phone number'),
});

export const adminSignInModel = z.object({
  phone: mobileNumberField('Phone number'),
  password: passwordField(),
});

// POST /auth/change-password — this model only bounds the two fields. The strong
// password policy itself lives in services/passwordPolicy and is applied by the
// handler, because it needs per-rule messages to send back (and the min(5) used by
// sign-in is not it: a legacy 5-character password is a perfectly valid CURRENT
// password, while a NEW one has to clear the policy).
//
// 512 is a payload guard, not the policy: it keeps an absurd body away from the
// HMAC without pre-empting the 72-character message the handler returns, which is
// the one the screen can show usefully.
export const changePasswordModel = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(512, 'Password is too long'),
  newPassword: z.string().min(1, 'New password is required').max(512, 'Password is too long'),
})

// POST /auth/forgot-password — public. Same phone shape as /auth/register-phone,
// because it is the same identifier the employee already types to sign in and the
// same one HR seeded. It is only a lookup key here; whether that number has an
// account is answered by a fixed sentence in the handler, never by this model or
// by the status code.
export const forgotPasswordModel = z.object({
  phone: mobileNumberField('Phone number'),
})

// GET /auth/admin/password-reset-requests — the admin queue's query string.
// 'APPROVED' is accepted for symmetry with the table's CHECK; nothing writes it
// yet, so filtering on it simply returns an empty page.
export const resetRequestsQueryModel = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'COMPLETED', 'REJECTED']).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

// POST /auth/admin/password-reset-requests/:id/reject — the reason is optional
// per the spec but capped, and it lands in `remarks` beside the admin's id so the
// queue shows why an ask was turned down.
export const rejectResetRequestModel = z.object({
  remarks: z.string().trim().max(500).optional(),
})

// PUT /auth/role-pages — assign the mobile-app pages a role may see. Page keys
// must match the app's PAGE_REGISTRY ('home', 'profile', 'register-employee', …);
// unknown keys are harmless (the old app build simply skips them).
export const rolePagesPayloadModel = z.object({
  role: z.string().min(2).max(30).regex(/^[a-z0-9_]+$/, 'Role must be snake_case'),
  pages: z.array(z.string().min(1).max(50)).max(100),
});


