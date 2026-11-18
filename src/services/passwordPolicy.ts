/**
 * The strong-password rule set, in one place.
 *
 * `POST /auth/change-password` enforces every rule below before a hash is
 * written, and the mobile screen renders the same list as a live checklist
 * while the user types (demo/src/config/passwordPolicy.ts mirrors it — the
 * client copy is UX only and this module stays the authority; keep both in step
 * when a rule changes).
 *
 * Why a rule list instead of one regex: the UI has to say WHICH requirement is
 * unmet, and a single mega-regex cannot. Each rule is a predicate, so the
 * checklist and the validator read the same source.
 */

export const PASSWORD_MIN_LENGTH = 8;
/**
 * Upper bound, not a courtesy: the hash is HMAC-SHA256 over the raw password and
 * the column holds a 64-char digest, so length itself is harmless — but an
 * unbounded form field is a free memory/DoS vector on the request body. 72 is
 * the bound the existing LKSGuard password model already uses.
 */
export const PASSWORD_MAX_LENGTH = 72;

export type PasswordRuleKey =
    | 'length'
    | 'uppercase'
    | 'lowercase'
    | 'digit'
    | 'special'
    | 'noWhitespace';

export interface PasswordRule {
    key: PasswordRuleKey;
    /** User-facing wording — shown both as a requirement and as an error. */
    label: string;
    test: (password: string) => boolean;
}

export const PASSWORD_RULES: PasswordRule[] = [
    {
        key: 'length',
        label: `At least ${PASSWORD_MIN_LENGTH} characters`,
        test: (pw) => pw.length >= PASSWORD_MIN_LENGTH,
    },
    { key: 'uppercase', label: 'One uppercase letter (A–Z)', test: (pw) => /[A-Z]/.test(pw) },
    { key: 'lowercase', label: 'One lowercase letter (a–z)', test: (pw) => /[a-z]/.test(pw) },
    { key: 'digit', label: 'One number (0–9)', test: (pw) => /[0-9]/.test(pw) },
    {
        // Any printable character that is neither a letter nor a digit, so the
        // rule covers @ # $ % ! and everything else the user reaches for.
        // Whitespace is deliberately excluded from "special" — the next rule
        // bans it outright, so "abc def123 " must not pass on its spaces.
        key: 'special',
        label: 'One special character (e.g. @, #, $, %)',
        test: (pw) => /[^A-Za-z0-9\s]/.test(pw),
    },
    {
        key: 'noWhitespace',
        label: 'No spaces or line breaks',
        test: (pw) => !/\s/.test(pw),
    },
];

/** The rules `password` fails, in checklist order. Empty means it satisfies the policy. */
export function passwordRuleFailures(password: string): PasswordRule[] {
    return PASSWORD_RULES.filter((rule) => !rule.test(password));
}

export function isPasswordStrong(password: string): boolean {
    return passwordRuleFailures(password).length === 0;
}

/** Sentences the API returns for a rejected new password, in checklist order. */
export function passwordPolicyMessages(password: string): string[] {
    return passwordRuleFailures(password).map((rule) => rule.label);
}

/**
 * The one rule that cannot be judged from the new password alone. Kept here so
 * the handler and the screen phrase it identically.
 */
export const SAME_AS_CURRENT_MESSAGE =
    'New password must be different from the current password.';

export const TOO_LONG_MESSAGE = `Password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`;
