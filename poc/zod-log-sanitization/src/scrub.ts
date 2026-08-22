/**
 * String-level sanitization primitives.
 *
 * Every function here is a pure string -> string (or string -> boolean) so the
 * tests can hit it directly, and each one is also wrapped as a zod schema so
 * the policy layer stays declarative.
 *
 * OWASP Logging Cheat Sheet: "Perform sanitization on all event data to prevent
 * log injection attacks e.g. carriage return (CR), line feed (LF) and delimiter
 * characters" and "limit the size of the user input value used to create the
 * log message".
 */

import { createHmac, randomBytes } from 'node:crypto'
import { z } from 'zod'

/** Per-field truncation budgets, in characters. */
export const LIMITS = {
  path: 2048,
  headerValue: 1024,
  queryValue: 512,
  userAgent: 256,
  key: 128,
} as const

/** Escapes that read better than a hex code when someone greps the log. */
const NAMED_ESCAPES = new Map<string, string>([
  ['\r', '\\r'],
  ['\n', '\\n'],
  ['\t', '\\t'],
  ['\u001b', '\\e'],
  ['\u2028', '\\u2028'],
  ['\u2029', '\\u2029'],
  ['\u0085', '\\u0085'],
])

/**
 * C0 controls, DEL, and C1 controls. ESC (0x1b) falls in this range, so
 * escaping it neutralizes every ANSI/CSI sequence at its introducer and no
 * separate CSI grammar is needed.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/gu

/**
 * Unicode line terminators that are not C0/C1. These matter because
 * JSON.stringify leaves them raw in its output, so a JSON log line can still
 * be split by a consumer that treats them as line breaks. U+0085 is a C1
 * control and is already covered by CONTROL_CHARS.
 */
const UNICODE_LINE_SEPARATORS = /[\u2028\u2029]/gu

function hexEscape(char: string): string {
  const named = NAMED_ESCAPES.get(char)
  if (named !== undefined) return named
  const code = char.codePointAt(0) ?? 0
  return `\\x${code.toString(16).padStart(2, '0')}`
}

/**
 * Replace control characters with a printable escape rather than deleting them,
 * so the log still records that an injection attempt happened.
 */
export function escapeControls(value: string): string {
  return value.replace(CONTROL_CHARS, hexEscape)
}

/** Escape the Unicode line terminators that JSON.stringify passes through. */
export function escapeLineSeparators(value: string): string {
  return value.replace(UNICODE_LINE_SEPARATORS, hexEscape)
}

/** Cap a value and record how much was dropped. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}...[+${value.length - max}]`
}

/**
 * Full string pipeline: neutralize, then cap.
 *
 * Order matters. Escaping grows the string, so truncating last is what keeps
 * the budget honest, and it can never split an escape sequence in a way that
 * reintroduces a raw control character.
 */
export function scrub(value: string, max: number): string {
  return truncate(escapeLineSeparators(escapeControls(value)), max)
}

/** Same pipeline, reporting whether the budget actually bit. */
export function scrubWithMeta(value: string, max: number): { value: string; truncated: boolean } {
  const escaped = escapeLineSeparators(escapeControls(value))
  return { value: truncate(escaped, max), truncated: escaped.length > max }
}

/** A reusable zod schema for any attacker-influenced string. */
export function safeString(max: number) {
  return z.string().transform((value) => scrub(value, max))
}

const SECRET_PREFIXES = [
  'bearer ',
  'basic ',
  'sk-',
  'sk_live_',
  'sk_test_',
  'rk_live_',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'github_pat_',
  'xoxb-',
  'xoxp-',
  'akia',
  'asia',
  'aiza',
  'glpat-',
  'npm_',
]

/** Three base64url segments separated by dots, i.e. a JWT. */
const JWT_SHAPE = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/

/** A long unbroken token-ish run, the shape most opaque credentials take. */
const HIGH_ENTROPY_RUN = /[A-Za-z0-9_\-+/=]{32,}/g

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

/**
 * Value-level secret detection, independent of the key it arrived under.
 *
 * This is the second line of defense for the case a key allowlist cannot
 * cover: a credential smuggled through a parameter nobody thought to name,
 * such as `?next=/callback?access_token=eyJ...`.
 */
export function looksSecret(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 8) return false

  const lower = trimmed.toLowerCase()
  if (SECRET_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true

  for (const segment of trimmed.split(/[^A-Za-z0-9._-]+/)) {
    if (JWT_SHAPE.test(segment)) return true
  }

  for (const run of trimmed.match(HIGH_ENTROPY_RUN) ?? []) {
    if (isCredentialShaped(run)) return true
  }

  return false
}

/**
 * Whether a long unbroken run looks like a credential rather than prose.
 *
 * Entropy alone is not enough. A long hyphenated slug such as
 * `the-quick-brown-fox-jumps-over-the-lazy-dog` scores about 3.9 bits per
 * character, higher than plenty of real API keys, because English has plenty
 * of distinct letters. What separates a credential is character-class mixing:
 * generated tokens draw from upper, lower and digits at once, while
 * human-written identifiers usually pick one case and stick to it.
 */
function isCredentialShaped(run: string): boolean {
  // A hex digest or hex-encoded key. Bounded above because past a few hundred
  // characters it is no longer a credential, and an unbounded rule flags things
  // like a long run of the letter A, which is valid hex and obviously not a key.
  if (/^[0-9a-f]{32,512}$/i.test(run)) return true

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((pattern) => pattern.test(run)).length
  if (classes >= 3 && shannonEntropy(run) >= 3.5) return true

  // Very high entropy is credential-shaped whatever the classes look like.
  return shannonEntropy(run) >= 4.8
}

/**
 * Per-process HMAC key. Rotating on restart is a deliberate tradeoff: values
 * correlate within a process lifetime and cannot be linked across restarts or
 * back to the original input. A real deployment picks a rotation window on
 * purpose and stores the key in a secret manager.
 */
let fingerprintKey: Uint8Array = randomBytes(32)

/** Test seam. Never call this from application code. */
export function setFingerprintKeyForTesting(key: Uint8Array): void {
  fingerprintKey = key
}

/**
 * A stable, non-reversible stand-in for a secret.
 *
 * ASVS 5.0 V16.2.5 allows sensitive values to be "captured through hashing or
 * masking approaches". Keyed rather than a bare digest, because a plain
 * SHA-256 over a low-cardinality input (the IPv4 space is 2^32) is one lookup
 * table away from being reversed.
 */
export function fingerprint(value: string): string {
  const digest = createHmac('sha256', fingerprintKey).update(value).digest('hex')
  return `sha256:${digest.slice(0, 16)}`
}
