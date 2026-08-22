/**
 * Sanitizing Express request properties for logging, with zod as the policy engine.
 *
 * Written for Node 26, which strips TypeScript types natively. No build step,
 * no tsconfig, no test framework. Run it directly:
 *
 *     npm install zod express
 *     node zod-log-sanitization-poc.mts
 *
 * express is optional. Without it the script still runs everything against
 * synthesized request objects and says so. zod is required.
 *
 * Flags: --quiet skips the per-payload dump, --raw prints the naive log lines
 * unescaped so you can watch the ANSI payload take over your terminal.
 *
 * Note that `npm install` here leaves a package.json and a package-lock.json
 * next to the script. node_modules is already gitignored in this repo, those
 * two are not, so delete them if you do not want them committed.
 *
 * ---------------------------------------------------------------------------
 * The problem
 * ---------------------------------------------------------------------------
 *
 * Express hands middleware request properties that are already decoded.
 * req.params goes through decodeURIComponent and query values go through the
 * query parser, so `?q=a%0d%0aFAKE` is a real CRLF in a JavaScript string
 * before any logger sees it. Interpolate that into a log line and the attacker
 * has written a second entry. CWE-117.
 *
 * Worth knowing, and the opposite of the usual assumption: headers are the
 * least likely vector here. Node's HTTP parser (llhttp) rejects CR, LF and
 * other control characters in header values, erroring on anything outside
 * HTAB, SP, VCHAR and OBS_TEXT unless a lenient flag is set. They are still
 * sanitized below, because a lenient parser or a non-Node upstream can put
 * anything in that map, but the live vector is the query string.
 *
 * ---------------------------------------------------------------------------
 * What the rules come from
 * ---------------------------------------------------------------------------
 *
 * OWASP Logging Cheat Sheet
 * https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
 *   "Perform sanitization on all event data to prevent log injection attacks
 *    e.g. carriage return (CR), line feed (LF) and delimiter characters"
 *   "Encode data correctly for the output (logged) format"
 *   "limit the size of the user input value used to create the log message"
 *   Never log: "Session identification values", "Access tokens",
 *   "Authentication passwords", "Encryption keys and other primary secrets",
 *   "Sensitive personal data and some forms of personally identifiable
 *    information (PII)"
 *
 * OWASP ASVS 5.0, V16 Security Logging and Error Handling
 * https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md
 *   16.4.1 "Verify that all logging components appropriately encode data to
 *          prevent log injection."
 *   16.2.5 sensitive data logged per its protection level, session tokens
 *          "only be captured through hashing or masking approaches"
 *   16.2.1 "necessary metadata (such as when, where, who, what)"
 *   16.2.2 timestamps "use UTC or include an explicit time zone offset"
 *   16.5.3 fail securely, no fail-open past a validation failure
 *
 * CWE-117 via CodeQL js/log-injection
 * https://codeql.github.com/codeql-query-help/javascript/js-log-injection/
 *   "If the log is displayed as a plain text file, then new line characters
 *    can be used by a malicious user."
 *
 * ---------------------------------------------------------------------------
 * Why zod rather than a sanitize() function
 * ---------------------------------------------------------------------------
 *
 * 1. z.object strips unknown keys by default, which makes the record shape a
 *    fail-closed allowlist. Hang req.user or req.rawBody off the request and
 *    none of it reaches the sink, because there is no key for it. Compare
 *    pino's `redact`, a denylist of static paths that is case sensitive and
 *    silently passes anything you forgot to name.
 * 2. z.infer types the sink, so logger.info(record) will not typecheck if
 *    someone hands it a raw Express request.
 *
 * Open-ended maps (headers, query, params) cannot use a key-by-key z.object
 * shape, so those go through the disposition tables below and are validated on
 * the way out with z.record. The strip behavior protects the record shape, the
 * tables protect the maps.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'
import { z } from 'zod'

// ===========================================================================
// Budgets
// ===========================================================================

const LIMITS = {
  path: 2048,
  headerValue: 1024,
  queryValue: 512,
  userAgent: 256,
  key: 128,
} as const

const BUDGETS = {
  maxKeys: 64,
  maxDepth: 4,
  maxArrayItems: 16,
  /** Serialized record ceiling, in bytes. */
  maxRecordBytes: 8192,
} as const

const SANITIZER_VERSION = 1
const REDACTED = '[redacted]'
const UNPARSEABLE = '[unparseable]'

// ===========================================================================
// String primitives
// ===========================================================================

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
 * control and is already covered above.
 */
const UNICODE_LINE_SEPARATORS = /[\u2028\u2029]/gu

function hexEscape(char: string): string {
  const named = NAMED_ESCAPES.get(char)
  if (named !== undefined) return named
  const code = char.codePointAt(0) ?? 0
  return `\\x${code.toString(16).padStart(2, '0')}`
}

/**
 * Replace control characters with a printable escape rather than deleting
 * them, so the log still records that an injection attempt happened.
 */
function escapeControls(value: string): string {
  return value.replace(CONTROL_CHARS, hexEscape)
}

/** Escape the Unicode line terminators that JSON.stringify passes through. */
function escapeLineSeparators(value: string): string {
  return value.replace(UNICODE_LINE_SEPARATORS, hexEscape)
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}...[+${value.length - max}]`
}

/**
 * Neutralize, then cap.
 *
 * Order matters. Escaping grows the string, so truncating last is what keeps
 * the budget honest, and a cut can never split an escape sequence in a way
 * that puts a raw control character back.
 */
function scrub(value: string, max: number): string {
  return truncate(escapeLineSeparators(escapeControls(value)), max)
}

/** Same pipeline, reporting whether the budget actually bit. */
function scrubWithMeta(value: string, max: number): { value: string; truncated: boolean } {
  const escaped = escapeLineSeparators(escapeControls(value))
  return { value: truncate(escaped, max), truncated: escaped.length > max }
}

/** A reusable zod schema for any attacker-influenced string. */
function safeString(max: number) {
  return z.string().transform((value) => scrub(value, max))
}

// ===========================================================================
// Secret detection by value shape
// ===========================================================================

const SECRET_PREFIXES = [
  'bearer ',
  'basic ',
  'sk-',
  'sk_live_',
  'sk_test_',
  'ghp_',
  'gho_',
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

function shannonEntropy(value: string): number {
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
 * Whether a long unbroken run looks like a credential rather than prose.
 *
 * Entropy alone is not enough. A long hyphenated slug such as
 * `the-quick-brown-fox-jumps-over-the-lazy-dog` scores about 3.9 bits per
 * character, higher than plenty of real API keys, because English has plenty
 * of distinct letters. What separates a credential is character-class mixing:
 * generated tokens draw from upper, lower and digits at once, while
 * human-written identifiers usually pick one case and stay there.
 */
function isCredentialShaped(run: string): boolean {
  // A hex digest or hex-encoded key. Bounded above because past a few hundred
  // characters it is not a credential, and an unbounded rule flags things like
  // a long run of the letter A, which is valid hex and obviously not a key.
  if (/^[0-9a-f]{32,512}$/i.test(run)) return true

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((pattern) => pattern.test(run)).length
  if (classes >= 3 && shannonEntropy(run) >= 3.5) return true

  return shannonEntropy(run) >= 4.8
}

/**
 * Value-level secret detection, independent of the key it arrived under.
 *
 * This is the second line of defense for what a key allowlist cannot cover: a
 * credential smuggled through a parameter nobody thought to name, such as
 * `?next=/callback?access_token=eyJ...`.
 *
 * It is a heuristic and it misses things. A short opaque token with no prefix
 * (`abc123def456`) is indistinguishable from an ordinary identifier. The key
 * table below is what covers that case.
 */
function looksSecret(value: string): boolean {
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
 * Per-process HMAC key. Rotating on restart is a deliberate tradeoff: values
 * correlate within a process lifetime and cannot be linked across restarts or
 * back to the original input. A real deployment picks a rotation window on
 * purpose and keeps the key in a secret manager.
 */
const fingerprintKey = randomBytes(32)

/**
 * A stable, non-reversible stand-in for a secret.
 *
 * ASVS 16.2.5 allows sensitive values to be "captured through hashing or
 * masking approaches". Keyed rather than a bare digest, because a plain
 * SHA-256 over a low-cardinality input (the IPv4 space is 2^32) is one lookup
 * table away from being reversed.
 */
function fingerprint(value: string): string {
  return `sha256:${createHmac('sha256', fingerprintKey).update(value).digest('hex').slice(0, 16)}`
}

// ===========================================================================
// Policy: what happens to each key
// ===========================================================================

type Disposition =
  /** Sanitized value goes in the log. */
  | 'allow'
  /** Value replaced by a marker plus a keyed fingerprint, so two requests carrying the same secret still correlate. */
  | 'redact'
  /** Value replaced by the fingerprint alone, for identifiers you want to join on. */
  | 'hash'
  /** Key does not appear at all. */
  | 'drop'

/**
 * Keys that poison an object literal. Relevant because the `qs` query parser
 * (Express 4's default, and opt-in in Express 5 via
 * `app.set('query parser', 'extended')`) builds real nested objects.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Headers are an allowlist: anything not named is dropped.
 *
 * A denylist, which is the shape pino's `redact` takes, fails open. Every
 * header a future middleware or upstream proxy invents lands in the log until
 * somebody notices. An allowlist fails closed. Node lowercases incoming header
 * names, so these are compared lowercased.
 */
const HEADER_POLICY = new Map<string, Disposition>([
  // Credentials and session material. OWASP exclusion list, ASVS 16.2.5.
  ['authorization', 'redact'],
  ['proxy-authorization', 'redact'],
  ['www-authenticate', 'redact'],
  ['authentication-info', 'redact'],
  ['cookie', 'redact'],
  ['set-cookie', 'redact'],
  ['x-api-key', 'redact'],
  ['x-auth-token', 'redact'],
  ['x-csrf-token', 'redact'],
  ['x-xsrf-token', 'redact'],
  ['x-amz-security-token', 'redact'],

  // Operationally useful and not sensitive.
  ['host', 'allow'],
  ['accept', 'allow'],
  ['accept-encoding', 'allow'],
  ['accept-language', 'allow'],
  ['content-type', 'allow'],
  ['content-length', 'allow'],
  ['user-agent', 'allow'],
  ['referer', 'allow'],
  ['origin', 'allow'],
  ['x-request-id', 'allow'],
  ['traceparent', 'allow'],

  // Client-supplied and forgeable. Identity comes from req.ip, which honors
  // the app's trust proxy setting, so logging the raw header would let any
  // client write whatever it likes into the "who" field.
  ['x-forwarded-for', 'drop'],
  ['x-real-ip', 'drop'],
])

/** Query and route-param keys that are sensitive regardless of their value. */
const SENSITIVE_PARAM_KEYS = new Set([
  'access_token',
  'apikey',
  'api_key',
  'auth',
  'client_secret',
  'code',
  'id_token',
  'key',
  'password',
  'passwd',
  'pwd',
  'refresh_token',
  'secret',
  'session',
  'sessionid',
  'sig',
  'signature',
  'state',
  'token',
])

function headerDisposition(name: string): Disposition {
  return HEADER_POLICY.get(name) ?? 'drop'
}

/** User-agent gets a tighter budget than other headers, it is long and low value. */
function headerLimit(name: string): number {
  return name === 'user-agent' ? LIMITS.userAgent : LIMITS.headerValue
}

/**
 * Params default to `allow`, unlike headers.
 *
 * A route param or query key is usually the most useful thing in the log line
 * and the key space is open, so an allowlist would throw away the diagnostics
 * people actually need. looksSecret() is what covers the gap.
 */
function paramDisposition(key: string, value: string): Disposition {
  if (FORBIDDEN_KEYS.has(key)) return 'drop'
  if (SENSITIVE_PARAM_KEYS.has(key.toLowerCase())) return 'redact'
  if (looksSecret(value)) return 'redact'
  return 'allow'
}

/**
 * A referer carries a full URL, which routinely carries credentials in its
 * userinfo or a token in its query. Keep origin and pathname, drop the rest.
 */
function scrubUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // Not absolute, so there is no origin to preserve. Treat it as a path.
    return scrub(value, LIMITS.headerValue)
  }
  const suffix = url.search === '' ? '' : '?[stripped]'
  return scrub(`${url.protocol}//${url.host}${url.pathname}${suffix}`, LIMITS.headerValue)
}

// The value schemas, one per disposition. Each is a zod schema, not a bare
// function, so the disposition table decides which schema runs and the schema
// decides what the output looks like.
const redactSchema = z.string().transform((value) => `${REDACTED} ${fingerprint(value)}`)
const hashSchema = z.string().transform((value) => fingerprint(value))

function headerValueSchema(name: string): z.ZodType<string> {
  switch (headerDisposition(name)) {
    case 'redact':
      return redactSchema
    case 'hash':
      return hashSchema
    case 'allow':
      return name === 'referer' ? z.string().transform(scrubUrl) : safeString(headerLimit(name))
    case 'drop':
      // Never reached: dropped keys are skipped before a value schema is chosen.
      return z.string().transform(() => REDACTED)
  }
}

function paramValueSchema(key: string, value: string): z.ZodType<string> {
  switch (paramDisposition(key, value)) {
    case 'redact':
      return redactSchema
    case 'hash':
      return hashSchema
    default:
      return safeString(LIMITS.queryValue)
  }
}

// ===========================================================================
// Client identity, treated as PII
// ===========================================================================

function expandIPv6(ip: string): string {
  if (!ip.includes('::')) return ip
  const [head = '', tail = ''] = ip.split('::')
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === '' ? [] : tail.split(':')
  const missing = 8 - headGroups.length - tailGroups.length
  return [...headGroups, ...Array(missing).fill('0'), ...tailGroups].join(':')
}

/**
 * Truncate to the smallest block that is still useful operationally.
 *
 * IPv4 to /24 and IPv6 to /48, the conventional boundaries: a /24 is the
 * smallest routable IPv4 block and a /48 is the standard single-site IPv6
 * allocation. Both keep network-level attribution without identifying a host.
 */
function ipPrefix(ip: string): string | null {
  if (isIPv4(ip)) {
    const [a, b, c] = ip.split('.')
    return `${a}.${b}.${c}.0/24`
  }
  if (isIPv6(ip)) return `${expandIPv6(ip).split(':').slice(0, 3).join(':')}::/48`
  return null
}

const ClientSchema = z.object({
  /** Coarse network block. Null when req.ip is absent or unparseable. */
  ipPrefix: z.string().nullable(),
  /** Keyed pseudonym of the full address. Correlates within a process lifetime, does not reverse. */
  ipId: z.string().nullable(),
  userAgent: safeString(LIMITS.userAgent).nullable(),
  /** Whether req.ip came from a proxy header the app was configured to trust. */
  viaTrustedProxy: z.boolean(),
})

// ===========================================================================
// The record schema
// ===========================================================================

/** A closed set. Anything else is an unknown verb and says so rather than echoing it. */
const METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'TRACE',
  'CONNECT',
  'OTHER',
] as const

type MapResult = {
  values: Record<string, string>
  droppedCount: number
  redactedCount: number
  truncated: boolean
}

const MapResultSchema = z.object({
  values: z.record(z.string().max(LIMITS.key + 32), z.string()),
  droppedCount: z.int().nonnegative(),
  redactedCount: z.int().nonnegative(),
  truncated: z.boolean(),
})

const EMPTY_MAP: MapResult = { values: {}, droppedCount: 0, redactedCount: 0, truncated: true }

/** Null-prototype accumulator, so a `__proto__` key cannot reach Object.prototype. */
function emptyValues(): Record<string, string> {
  return Object.create(null) as Record<string, string>
}

function leafOf(path: string): string {
  const withoutIndex = path.replace(/\[\d+\]$/, '')
  const dot = withoutIndex.lastIndexOf('.')
  return dot === -1 ? withoutIndex : withoutIndex.slice(dot + 1)
}

/**
 * Flatten whatever the query parser produced into `[path, leafKey, value]`.
 *
 * Express 5 defaults to the `simple` parser (node:querystring), which yields
 * `string | string[]`. Under `app.set('query parser', 'extended')` it is `qs`,
 * which yields arbitrarily nested objects and arrays, so this walks them with
 * a depth cap and reports nested keys in dotted form.
 */
function flatten(
  input: unknown,
  prefix: string,
  depth: number,
  out: Array<[string, string, string]>,
): void {
  if (out.length >= BUDGETS.maxKeys) return

  if (input === null || input === undefined) {
    out.push([prefix, leafOf(prefix), ''])
    return
  }
  if (typeof input === 'string') {
    out.push([prefix, leafOf(prefix), input])
    return
  }
  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
    out.push([prefix, leafOf(prefix), String(input)])
    return
  }
  if (depth >= BUDGETS.maxDepth) {
    out.push([prefix, leafOf(prefix), '[depth-limit]'])
    return
  }
  if (Array.isArray(input)) {
    for (const [index, item] of input.slice(0, BUDGETS.maxArrayItems).entries()) {
      flatten(item, `${prefix}[${index}]`, depth + 1, out)
    }
    if (input.length > BUDGETS.maxArrayItems) {
      const extra = input.length - BUDGETS.maxArrayItems
      out.push([`${prefix}[...]`, leafOf(prefix), `[+${extra} items]`])
    }
    return
  }
  if (typeof input === 'object') {
    for (const key of Object.keys(input as object)) {
      if (FORBIDDEN_KEYS.has(key)) continue
      const child = (input as Record<string, unknown>)[key]
      flatten(child, prefix === '' ? key : `${prefix}.${key}`, depth + 1, out)
    }
    return
  }

  out.push([prefix, leafOf(prefix), `[${typeof input}]`])
}

/**
 * Apply the header disposition table.
 *
 * Unknown header names are dropped and only the count survives, so a reviewer
 * can see something was there without the name or value reaching the sink.
 */
function applyHeaderPolicy(raw: unknown): MapResult {
  const values = emptyValues()
  let droppedCount = 0
  let redactedCount = 0
  let truncated = false

  if (raw === null || typeof raw !== 'object') {
    return { values, droppedCount, redactedCount, truncated }
  }

  for (const rawKey of Object.keys(raw as object)) {
    if (Object.keys(values).length >= BUDGETS.maxKeys) {
      truncated = true
      break
    }

    const name = rawKey.toLowerCase()
    const disposition = headerDisposition(name)
    if (disposition === 'drop' || FORBIDDEN_KEYS.has(name)) {
      droppedCount += 1
      continue
    }

    // set-cookie arrives as an array. Everything else is a string, but a proxy
    // or a test double can produce anything, so coerce defensively.
    const rawValue = (raw as Record<string, unknown>)[rawKey]
    const joined = Array.isArray(rawValue)
      ? rawValue.slice(0, BUDGETS.maxArrayItems).map(String).join(', ')
      : String(rawValue)

    const parsed = headerValueSchema(name).safeParse(joined)
    values[scrub(name, LIMITS.key)] = parsed.success ? parsed.data : UNPARSEABLE
    if (disposition === 'redact' || disposition === 'hash') redactedCount += 1
    if (disposition === 'allow' && scrubWithMeta(joined, headerLimit(name)).truncated) {
      truncated = true
    }
  }

  return { values, droppedCount, redactedCount, truncated }
}

/** Apply the param rules to query strings and route params alike. */
function applyParamPolicy(raw: unknown): MapResult {
  const values = emptyValues()
  let droppedCount = 0
  let redactedCount = 0
  let truncated = false

  if (raw === null || typeof raw !== 'object') {
    return { values, droppedCount, redactedCount, truncated }
  }

  const flattened: Array<[string, string, string]> = []
  flatten(raw, '', 0, flattened)
  if (flattened.length >= BUDGETS.maxKeys) truncated = true

  for (const [path, leaf, value] of flattened) {
    if (FORBIDDEN_KEYS.has(leaf) || FORBIDDEN_KEYS.has(path)) {
      droppedCount += 1
      continue
    }

    const disposition = paramDisposition(leaf, value)
    if (disposition === 'drop') {
      droppedCount += 1
      continue
    }
    if (disposition === 'redact' || disposition === 'hash') redactedCount += 1
    if (disposition === 'allow' && scrubWithMeta(value, LIMITS.queryValue).truncated) {
      truncated = true
    }

    const parsed = paramValueSchema(leaf, value).safeParse(value)
    values[scrub(path, LIMITS.key)] = parsed.success ? parsed.data : UNPARSEABLE
  }

  return { values, droppedCount, redactedCount, truncated }
}

const HeaderMapSchema = z
  .unknown()
  .transform(applyHeaderPolicy)
  .pipe(MapResultSchema)
  .catch(EMPTY_MAP)

const ParamMapSchema = z.unknown().transform(applyParamPolicy).pipe(MapResultSchema).catch(EMPTY_MAP)

/**
 * The record.
 *
 * Every field carries .catch(), so one malformed value degrades that field
 * instead of losing the whole entry. ASVS 16.5.3 asks the application to fail
 * securely rather than continue past a validation failure, and for a logging
 * path that means emitting a placeholder, never the raw input and never an
 * exception into the request lifecycle.
 */
const RequestLogSchema = z.object({
  /** ASVS 16.2.2: UTC or an explicit offset. */
  ts: z.iso.datetime().catch(() => new Date().toISOString()),
  method: z.enum(METHODS).catch('OTHER'),
  /** Pathname only. The query string is parsed separately, never logged raw. */
  path: safeString(LIMITS.path).catch(UNPARSEABLE),
  query: ParamMapSchema,
  params: ParamMapSchema,
  headers: HeaderMapSchema,
  client: ClientSchema.catch({
    ipPrefix: null,
    ipId: null,
    userAgent: null,
    viaTrustedProxy: false,
  }),
  outcome: z
    .object({
      status: z.int().min(100).max(599).catch(0),
      durationMs: z.number().nonnegative().catch(-1),
    })
    .nullable()
    .catch(null),
  sanitizer: z.object({
    version: z.literal(SANITIZER_VERSION),
    redactions: z.int().nonnegative(),
    truncated: z.boolean(),
  }),
})

type RequestLog = z.infer<typeof RequestLogSchema>
type SanitizerFailure = { ts: string; sanitizerError: true; issueCount: number }
type LogRecord = RequestLog | SanitizerFailure

/** The subset of an Express request this reads. Keeps it testable without a server. */
type RequestLike = {
  method?: string | undefined
  originalUrl?: string | undefined
  url?: string | undefined
  headers?: unknown
  query?: unknown
  params?: unknown
  ip?: string | undefined
}

/** Split the request target without letting a malformed one throw. */
function splitTarget(target: string): { path: string; search: string } {
  const hashIndex = target.indexOf('#')
  const withoutHash = hashIndex === -1 ? target : target.slice(0, hashIndex)
  const queryIndex = withoutHash.indexOf('?')
  return queryIndex === -1
    ? { path: withoutHash, search: '' }
    : { path: withoutHash.slice(0, queryIndex), search: withoutHash.slice(queryIndex + 1) }
}

/** Roll the per-map counters up into the record-level summary. */
function tally(record: RequestLog): RequestLog {
  const redactions =
    record.headers.redactedCount + record.query.redactedCount + record.params.redactedCount
  const truncated = record.headers.truncated || record.query.truncated || record.params.truncated
  return { ...record, sanitizer: { ...record.sanitizer, redactions, truncated } }
}

/**
 * Build a sanitized record. Never throws, and never returns anything derived
 * from the request when parsing fails.
 */
function sanitizeRequest(
  req: RequestLike,
  options: {
    outcome?: { status: number; durationMs: number } | undefined
    viaTrustedProxy?: boolean | undefined
  } = {},
): LogRecord {
  const now = new Date().toISOString()
  try {
    const headers = (req.headers ?? {}) as Record<string, unknown>
    const userAgent = headers['user-agent']
    const ip = req.ip

    const parsed = RequestLogSchema.safeParse({
      ts: now,
      method: (req.method ?? '').toUpperCase(),
      path: splitTarget(req.originalUrl ?? req.url ?? '').path,
      query: req.query ?? {},
      params: req.params ?? {},
      headers,
      client: {
        ipPrefix: ip === undefined ? null : ipPrefix(ip),
        ipId: ip === undefined ? null : fingerprint(ip),
        userAgent: typeof userAgent === 'string' ? userAgent : null,
        viaTrustedProxy: options.viaTrustedProxy ?? false,
      },
      outcome: options.outcome ?? null,
      sanitizer: { version: SANITIZER_VERSION, redactions: 0, truncated: false },
    })

    if (!parsed.success) {
      return { ts: now, sanitizerError: true, issueCount: parsed.error.issues.length }
    }
    return tally(parsed.data)
  } catch {
    // A getter on the request throwing, a proxy object, an exotic prototype.
    // The record still gets emitted, just with nothing derived from the input.
    return { ts: now, sanitizerError: true, issueCount: 1 }
  }
}

// ===========================================================================
// NDJSON output
// ===========================================================================

const RAW_LINE_BREAKS = /[\u2028\u2029]/gu
const LINE_BREAK_ESCAPES: Record<string, string> = {
  ['\u2028']: '\\u2028',
  ['\u2029']: '\\u2029',
}

/**
 * Serialize one record to a single NDJSON line.
 *
 * "Encode data correctly for the output (logged) format." For newline-delimited
 * JSON that means one object per physical line, which JSON.stringify alone does
 * not guarantee: it escapes CR and LF but leaves U+2028 and U+2029 as raw bytes.
 * A consumer that splits on Unicode line terminators sees two lines where the
 * serializer wrote one.
 *
 * The escaping above already removes them from every attacker-influenced field.
 * This pass is the backstop that makes the guarantee structural rather than
 * dependent on every field having gone through the right schema.
 */
function toNdjson(record: LogRecord): string {
  const line = JSON.stringify(record).replace(
    RAW_LINE_BREAKS,
    (char) => LINE_BREAK_ESCAPES[char] ?? '',
  )
  if (Buffer.byteLength(line) <= BUDGETS.maxRecordBytes) return line

  // Over budget. Emit a marker rather than a truncated string that would no
  // longer parse as JSON.
  return JSON.stringify({
    ts: record.ts,
    sanitizerError: true,
    reason: 'record-too-large',
    bytes: Buffer.byteLength(line),
  })
}

/** True when a serialized line is safe to write to a line-oriented sink. */
function isSingleLine(line: string): boolean {
  return !/[\r\n\u2028\u2029]/u.test(line)
}

// ===========================================================================
// Express middleware
// ===========================================================================

type MinimalRequest = RequestLike & {
  app?: { get(name: string): unknown } | undefined
}
type MinimalResponse = { statusCode: number; on(event: string, listener: () => void): unknown }

/**
 * Build the record on the response finish event, not at request entry.
 *
 * Two reasons: status and duration are only known then, and req.params is
 * empty until the router has matched a route.
 */
function sanitizedRequestLog(options: { sink?: (record: LogRecord) => void } = {}) {
  const sink = options.sink ?? ((record: LogRecord) => process.stdout.write(`${toNdjson(record)}\n`))

  return function middleware(req: MinimalRequest, res: MinimalResponse, next: () => void): void {
    const startedAt = process.hrtime.bigint()

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      // A logging middleware must never take the request down with it. The
      // sanitizer swallows its own failures, this guards the sink.
      try {
        sink(
          sanitizeRequest(req, {
            outcome: { status: res.statusCode, durationMs },
            viaTrustedProxy: viaTrustedProxy(req),
          }),
        )
      } catch {
        // A throw here is a bug in the sink, and retrying would fail the same way.
      }
    })

    next()
  }
}

/**
 * Whether req.ip came from a proxy header the app was configured to trust.
 *
 * Express only consults x-forwarded-for when `trust proxy` is set, so the
 * header's presence proves nothing on its own: any client can send it. The
 * record carries this flag so a reader can tell whether the logged identity is
 * the socket peer or something an upstream asserted.
 */
function viaTrustedProxy(req: MinimalRequest): boolean {
  const setting = req.app?.get('trust proxy')
  const trusted = setting !== undefined && setting !== false
  return trusted && (req.headers as Record<string, unknown> | undefined)?.['x-forwarded-for'] !== undefined
}

// ===========================================================================
// The hostile corpus
// ===========================================================================

/** A JWT-shaped value. Not a real token, the signature segment is filler. */
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'

/** A high-entropy opaque credential, the shape an API key takes. */
const FAKE_API_KEY = 'sk-Xq7Q2vN4pL9wR3tY6uI8oP0aS1dF5gH7jK2lZ4xC6vB8nM'

type Payload = {
  name: string
  /** What the payload is trying to do to the log. */
  vector: string
  /** Raw request target, percent-encoded as it goes on the wire. */
  target: string
  headers?: Record<string, string>
  /** Set when the payload needs the qs parser, which builds real nested objects. */
  extendedQuery?: boolean
  /** Set when the payload needs an app that trusts proxy headers. */
  trustProxy?: boolean
}

const CORPUS: readonly Payload[] = [
  {
    name: 'crlf-in-query',
    vector: 'Decoded CRLF forges a second log line. CWE-117, the classic case.',
    target: '/search?q=cats%0d%0a2026-08-22T00%3A00%3A00Z%20INFO%20admin%20login%20succeeded',
  },
  {
    name: 'crlf-in-route-param',
    vector: 'Same forging, through a route param Express decodes for you.',
    target: '/users/42%0d%0aINFO%20account%20deleted',
  },
  {
    name: 'lone-lf',
    vector: 'A bare LF splits the line just as well as a full CRLF.',
    target: '/search?q=a%0aFAKE%20ENTRY',
  },
  {
    name: 'ansi-escape',
    vector: 'ESC[2J clears the terminal of anyone tailing the log, then recolors the forged text.',
    target: '/search?q=%1b%5b2J%1b%5b1%3b31mCRITICAL%20breach%1b%5b0m',
  },
  {
    name: 'unicode-line-separator',
    vector: 'U+2028. JSON.stringify leaves it raw, so JSON output alone does not stop this one.',
    target: '/search?q=before%e2%80%a8after',
  },
  {
    name: 'next-line-c1',
    vector: 'U+0085 NEL, a C1 control some viewers treat as a line break.',
    target: '/search?q=before%c2%85after',
  },
  {
    name: 'null-byte',
    vector: 'NUL truncates the entry in any C-based log consumer downstream.',
    target: '/search?q=visible%00hidden',
  },
  {
    name: 'control-chars-in-key',
    vector: 'The attacker controls key names too, and keys become JSON object keys.',
    target: '/search?bad%0d%0akey=value',
  },
  {
    name: 'named-secret-query-key',
    vector: 'A token under a key the policy names. Redacted by key.',
    target: `/callback?code=abc123&token=${encodeURIComponent(FAKE_JWT)}`,
  },
  {
    name: 'smuggled-secret-value',
    vector:
      'A token under a key nobody put on a list, hidden inside a redirect target. Caught by value shape, not by key name.',
    target: `/login?next=${encodeURIComponent(`/cb?access_token=${FAKE_JWT}`)}`,
  },
  {
    name: 'api-key-in-query',
    vector: 'High-entropy credential in an unnamed parameter.',
    target: `/search?q=weather&ref=${encodeURIComponent(FAKE_API_KEY)}`,
  },
  {
    name: 'credentials-in-headers',
    vector: 'Authorization and Cookie. The OWASP exclusion list names both.',
    target: '/account',
    headers: {
      authorization: `Bearer ${FAKE_JWT}`,
      cookie: 'session=8f14e45fceea167a5a36dedd4bea2543; theme=dark',
      'x-api-key': FAKE_API_KEY,
    },
  },
  {
    name: 'unknown-header',
    vector: 'A header nobody allowlisted. Dropped, with only the count kept.',
    target: '/account',
    headers: { 'x-internal-debug': 'db=postgres://user:hunter2@10.0.0.5:5432/prod' },
  },
  {
    name: 'referer-with-token',
    vector: 'A referer carrying a token in its query string, plus userinfo credentials.',
    target: '/page',
    headers: { referer: `https://user:pass@example.test/oauth?id_token=${FAKE_JWT}` },
  },
  {
    name: 'oversized-value',
    vector:
      'A query value far past the per-field budget. Capped at 4 KiB here because Node refuses a request line plus headers over 16 KiB (--max-http-header-size) and answers 431 before Express runs.',
    target: `/search?q=${'x'.repeat(4096)}`,
  },
  {
    name: 'spoofed-forwarded-for',
    vector:
      'A client asserting someone else as the source address. With trust proxy off, Express ignores the header and req.ip stays the socket peer.',
    target: '/account',
    headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' },
  },
  {
    name: 'spoofed-forwarded-for-trusted',
    vector:
      'The same payload against an app that trusts loopback. req.ip now comes from the header, so the logged identity is whatever the client claimed, and viaTrustedProxy says so.',
    target: '/account',
    headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' },
    trustProxy: true,
  },
  {
    name: 'repeated-query-key',
    vector: 'Repeated keys become an array even under the Express 5 simple parser.',
    target: '/search?q=one&q=two&q=three',
  },
  {
    name: 'prototype-pollution',
    vector:
      'qs discards the __proto__ branch itself (allowPrototypes defaults to false), so this is defense in depth. The guard still matters for req.params and any map a custom parser hands over, which the checks below exercise directly.',
    target: '/search?a%5B__proto__%5D%5Bpolluted%5D=yes&a%5Bb%5D%5Bc%5D=nested',
    extendedQuery: true,
  },
  {
    name: 'deep-nesting',
    vector: 'Nesting deeper than the walk budget.',
    target: '/search?a%5Bb%5D%5Bc%5D%5Bd%5D%5Be%5D%5Bf%5D=deep',
    extendedQuery: true,
  },
]

// ===========================================================================
// Running it
// ===========================================================================

/**
 * The vulnerable baseline this exists to replace.
 *
 * This is what request logging looks like in most codebases: interpolate the
 * request into a template string and hand it to the logger. Everything in it
 * is attacker-controlled and none of it is encoded.
 */
function naiveLine(req: RequestLike): string {
  const headers = (req.headers ?? {}) as Record<string, unknown>
  return `${new Date().toISOString()} ${req.method} ${req.originalUrl} ua="${headers['user-agent'] ?? ''}" auth="${headers.authorization ?? ''}" query=${JSON.stringify(req.query)}`
}

/**
 * Build a request the way Express would hand it to a middleware.
 *
 * Used when express is not installed. Decoding matters: req.query and
 * req.params arrive already decoded, which is why percent-encoded control
 * characters are a live vector.
 */
function synthesizeRequest(payload: Payload): RequestLike {
  const { path, search } = splitTarget(payload.target)
  const query: Record<string, string | string[]> = {}

  for (const [key, value] of new URLSearchParams(search)) {
    const existing = query[key]
    if (existing === undefined) query[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else query[key] = [existing, value]
  }

  const params = path.startsWith('/users/')
    ? { id: decodeURIComponent(path.slice('/users/'.length)) }
    : {}

  return {
    method: 'GET',
    originalUrl: payload.target,
    headers: { host: 'api.example.test', 'user-agent': 'corpus/1.0', ...payload.headers },
    query,
    params,
    ip: payload.trustProxy ? '203.0.113.9' : '198.51.100.42',
  }
}

type Sample = { payload: Payload; naive: string; record: LogRecord; line: string }

/** Run the corpus against a real Express server, if express is installed. */
async function collectViaExpress(): Promise<Sample[] | null> {
  // @types/express uses `export =`, so the module namespace is the callable
  // factory itself and the ESM default is that same value.
  let express: typeof import('express')
  try {
    express = (await import('express')).default
  } catch {
    return null
  }

  const build = (opts: { extended?: boolean; trustProxy?: boolean }) => {
    const app = express()
    app.set('query parser', opts.extended ? 'extended' : 'simple')
    if (opts.trustProxy) app.set('trust proxy', 'loopback')

    // The route with a param, so req.params is populated for the param payloads.
    const handler = (req: import('express').Request, res: import('express').Response): void => {
      res.json({
        naive: naiveLine(req),
        record: sanitizeRequest(req, { viaTrustedProxy: viaTrustedProxy(req) }),
      })
    }
    app.get('/users/:id', handler)
    app.use(handler)
    return app
  }

  const listen = async (app: ReturnType<typeof build>) => {
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
  }

  const plain = await listen(build({}))
  const extended = await listen(build({ extended: true }))
  const trusting = await listen(build({ trustProxy: true }))

  try {
    const samples: Sample[] = []
    for (const payload of CORPUS) {
      const target = payload.trustProxy ? trusting : payload.extendedQuery ? extended : plain
      const response = await fetch(`${target.url}${payload.target}`, {
        headers: { 'user-agent': 'corpus/1.0', ...payload.headers },
      })
      const body = await response.text()
      if (body === '') {
        // Node can reject a request before Express sees it, for instance a
        // request line over --max-http-header-size, which answers 431 empty.
        throw new Error(`${payload.name}: empty body, HTTP ${response.status}`)
      }
      const parsed = JSON.parse(body) as { naive: string; record: LogRecord }
      samples.push({ payload, ...parsed, line: toNdjson(parsed.record) })
    }
    return samples
  } finally {
    await plain.close()
    await extended.close()
    await trusting.close()
  }
}

/** Same corpus, no server. */
function collectSynthesized(): Sample[] {
  return CORPUS.map((payload) => {
    const req = synthesizeRequest(payload)
    const record = sanitizeRequest(req, { viaTrustedProxy: payload.trustProxy ?? false })
    return { payload, naive: naiveLine(req), record, line: toNdjson(record) }
  })
}

// ---------------------------------------------------------------------------
// Checks. These are the claim: not that each payload is handled, but that no
// payload can break a line, leak a credential, or add a field to the record.
// ---------------------------------------------------------------------------

let failures = 0

function check(name: string, assertion: () => void): void {
  try {
    assertion()
    console.log(`  ok    ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL  ${name}\n        ${(error as Error).message}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function runChecks(samples: Sample[]): void {
  check('no payload survives as a line break', () => {
    for (const { payload, line } of samples) {
      assert(isSingleLine(line), `${payload.name} produced a line break`)
      assert(line.split('\n').length === 1, `${payload.name} produced more than one line`)
    }
  })

  check('no payload survives as a control character', () => {
    for (const { payload, line } of samples) {
      for (const char of line) {
        const code = char.codePointAt(0) ?? 0
        const isControl = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
        assert(!isControl, `${payload.name} left U+${code.toString(16).padStart(4, '0')} in output`)
      }
    }
  })

  check('every line parses back as exactly one JSON object', () => {
    for (const { payload, line } of samples) {
      const parsed: unknown = JSON.parse(line)
      assert(typeof parsed === 'object' && parsed !== null, `${payload.name} did not parse`)
    }
  })

  check('no known secret survives anywhere in the output', () => {
    const secrets = [FAKE_JWT, FAKE_API_KEY, '8f14e45fceea167a5a36dedd4bea2543', 'hunter2', 'user:pass']
    for (const { payload, line } of samples) {
      for (const secret of secrets) {
        assert(!line.includes(secret), `${payload.name} leaked ${secret.slice(0, 12)}...`)
      }
    }
  })

  check('every record fits the size budget', () => {
    for (const { payload, line } of samples) {
      const bytes = Buffer.byteLength(line)
      assert(bytes <= BUDGETS.maxRecordBytes, `${payload.name} produced ${bytes} bytes`)
    }
  })

  const EXPECTED_KEYS = [
    'client',
    'headers',
    'method',
    'outcome',
    'params',
    'path',
    'query',
    'sanitizer',
    'ts',
  ]

  check('the record key set is fixed, whatever arrives on the request', () => {
    for (const payload of CORPUS) {
      // Fields a future middleware might hang off the request. None are
      // declared in the schema, so z.object strips every one of them.
      const record = sanitizeRequest({
        ...synthesizeRequest(payload),
        ...({ user: { email: 'someone@example.test' }, rawBody: 'password=hunter2' } as object),
      })
      assert(
        JSON.stringify(Object.keys(record).sort()) === JSON.stringify(EXPECTED_KEYS),
        `${payload.name} changed the key set to ${Object.keys(record).sort().join(',')}`,
      )
      assert(!toNdjson(record).includes('someone@example.test'), `${payload.name} leaked req.user`)
    }
  })

  check('a secret planted in every field comes back redacted, not echoed', () => {
    const sentinel = 'sk-Zx9Qw7Ev2Rt5Yu8Io1Pa4Sd6Fg3Hj0Kl'
    const line = toNdjson(
      sanitizeRequest({
        method: 'GET',
        originalUrl: `/x?token=${sentinel}`,
        headers: { authorization: sentinel, cookie: sentinel, 'x-api-key': sentinel },
        query: { token: sentinel, other: sentinel },
        params: { id: sentinel },
        ip: '198.51.100.42',
      }),
    )
    assert(!line.includes(sentinel), 'the sentinel reached the output')
    assert(line.includes(REDACTED), 'nothing was marked as redacted')
  })

  check('the same secret fingerprints alike, different secrets do not', () => {
    const of = (value: string) => {
      const record = sanitizeRequest({ headers: { authorization: value } }) as RequestLog
      return record.headers.values.authorization
    }
    assert(of('Bearer aaa') === of('Bearer aaa'), 'fingerprint is not stable')
    assert(of('Bearer aaa') !== of('Bearer bbb'), 'two secrets share a fingerprint')
  })

  check('__proto__ keys are dropped rather than assigned', () => {
    // qs strips this branch itself, so feed the map directly, the way a custom
    // parser or a hand-built params object would.
    const hostile = JSON.parse('{"__proto__": {"polluted": "yes"}, "safe": "value"}') as object
    const record = sanitizeRequest({ query: hostile }) as RequestLog
    assert(record.query.values.safe === 'value', 'the safe key was lost')
    assert(({} as Record<string, unknown>).polluted === undefined, 'Object.prototype was polluted')
  })

  check('the query string never reaches the path field', () => {
    const record = sanitizeRequest({ originalUrl: '/search?token=secret#frag' }) as RequestLog
    assert(record.path === '/search', `path was ${record.path}`)
  })

  check('an unknown method is reported as OTHER rather than echoed', () => {
    const record = sanitizeRequest({ method: 'BREW\r\nINJECT' }) as RequestLog
    assert(record.method === 'OTHER', `method was ${record.method}`)
  })

  check('client identity is de-identified, never logged raw', () => {
    const record = sanitizeRequest({ ip: '198.51.100.77' }) as RequestLog
    assert(record.client.ipPrefix === '198.51.100.0/24', `prefix was ${record.client.ipPrefix}`)
    assert(/^sha256:[0-9a-f]{16}$/.test(record.client.ipId ?? ''), 'ipId is not a fingerprint')
    assert(!toNdjson(record).includes('198.51.100.77'), 'the raw address reached the output')
    assert(ipPrefix('2001:db8:1234:5678::1') === '2001:db8:1234::/48', 'IPv6 prefix is wrong')
    assert(ipPrefix('not-an-ip') === null, 'junk was accepted as an address')
  })

  check('a request whose getters throw still produces a record', () => {
    const record = sanitizeRequest({
      method: 'GET',
      get headers(): never {
        throw new Error('nope')
      },
    })
    assert('sanitizerError' in record, 'expected a failure record')
  })

  check('a record over the byte budget is replaced, not cut into invalid JSON', () => {
    const query: Record<string, string> = {}
    for (let i = 0; i < 64; i += 1) query[`key${i}`] = 'y'.repeat(512)
    const line = toNdjson(sanitizeRequest({ originalUrl: '/big', query }))
    const parsed = JSON.parse(line) as Record<string, unknown>
    assert(parsed.reason === 'record-too-large', 'the oversized record was not replaced')
  })

  check('looksSecret does not flag ordinary values', () => {
    for (const value of [
      'hello world',
      '/users/42/settings',
      // Scores about 3.9 bits per character, higher than some real API keys.
      // Character-class mixing is what keeps it out.
      'the-quick-brown-fox-jumps-over-the-lazy-dog',
      'application/json; charset=utf-8',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    ]) {
      assert(!looksSecret(value), `flagged ${value}`)
    }
  })

  check('JSON.stringify really does leave U+2028 raw, which is why the second pass exists', () => {
    assert(JSON.stringify({ a: 'x\u2028y' }).includes('\u2028'), 'the platform changed')
    assert(!JSON.stringify({ a: 'x\ny' }).includes('\n'), 'LF handling changed')
  })
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const showRaw = process.argv.includes('--raw')
  const quiet = process.argv.includes('--quiet')

  const viaExpress = await collectViaExpress()
  const samples = viaExpress ?? collectSynthesized()

  const zodVersion = z.core?.version
  console.log(
    `node ${process.version}, zod ${zodVersion ? `${zodVersion.major}.${zodVersion.minor}.${zodVersion.patch}` : 'unknown'}`,
  )
  console.log(
    viaExpress === null
      ? 'express is not installed, so the corpus ran against synthesized request objects.\n' +
          'Install it (npm install express) to run the same payloads through a real server.'
      : 'corpus ran through a live Express server on loopback.',
  )

  if (!quiet) {
    for (const [index, { payload, naive, line }] of samples.entries()) {
      console.log(`\n${'='.repeat(78)}`)
      console.log(`[${index + 1}/${samples.length}] ${payload.name}`)
      console.log(payload.vector)
      console.log(`\n  target   ${payload.target.slice(0, 120)}`)
      if (payload.headers) {
        console.log(`  headers  ${JSON.stringify(payload.headers).slice(0, 160)}`)
      }
      // Printed through JSON.stringify by default, so control characters show
      // as escapes rather than being interpreted by your terminal. A real
      // plain-text logger writes the raw bytes, which is the whole problem.
      console.log(`\n  a naive logger writes:\n    ${showRaw ? naive : JSON.stringify(naive)}`)
      console.log(`\n  this writes:\n    ${line}`)
    }
  }

  console.log(`\n${'='.repeat(78)}\nchecks\n`)
  runChecks(samples)

  console.log(
    failures === 0
      ? `\nall checks passed across ${samples.length} payloads.`
      : `\n${failures} check(s) failed.`,
  )
  if (!showRaw && !quiet) console.log('re-run with --raw to see the naive lines unescaped.')
  process.exitCode = failures === 0 ? 0 : 1
}

await main()
