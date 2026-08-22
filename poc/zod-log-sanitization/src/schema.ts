/**
 * The request log record, defined as a zod schema.
 *
 * Two things the schema buys that a hand-rolled sanitizer function does not:
 *
 * 1. `z.object` strips unknown keys by default, so the top-level shape of the
 *    record is a fail-closed allowlist. A future middleware that hangs
 *    `req.user`, `req.rawBody` or `req.session` off the request cannot leak it
 *    into the log by accident, because there is no key for it.
 * 2. `z.infer` gives the sink a static type. `logger.info(record)` will not
 *    typecheck if someone hands it a raw Express request.
 *
 * Open-ended maps (headers, query, params) cannot use key-by-key `z.object`
 * shapes, so those use the disposition tables in policy.ts, validated on the
 * way out with `z.record`.
 */

import { z } from 'zod'
import { ClientSchema, buildClient } from './identity.ts'
import {
  headerDisposition,
  headerLimit,
  headerValueSchema,
  isForbiddenKey,
  paramDisposition,
  paramValueSchema,
} from './policy.ts'
import { LIMITS, safeString, scrub, scrubWithMeta } from './scrub.ts'

export const SANITIZER_VERSION = 1

/** Structural budgets, so a hostile request cannot produce an unbounded record. */
export const BUDGETS = {
  maxKeys: 64,
  maxDepth: 4,
  maxArrayItems: 16,
  /** Serialized record ceiling, in bytes. */
  maxRecordBytes: 8192,
} as const

const UNPARSEABLE = '[unparseable]'

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

const MethodSchema = z.enum(METHODS).catch('OTHER')

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

/** Null-prototype accumulator, so a `__proto__` key cannot reach Object.prototype. */
function emptyMap(): Record<string, string> {
  return Object.create(null) as Record<string, string>
}

/**
 * Flatten whatever the query parser produced into `[path, leafKey, value]`.
 *
 * Express 5 defaults to the `simple` parser (`node:querystring`), which yields
 * `string | string[]`. Under `app.set('query parser', 'extended')` it is `qs`,
 * which yields arbitrarily nested objects and arrays, so this walks them with a
 * depth cap and reports nested keys in dotted form.
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
      out.push([`${prefix}[...]`, leafOf(prefix), `[+${input.length - BUDGETS.maxArrayItems} items]`])
    }
    return
  }

  if (typeof input === 'object') {
    for (const key of Object.keys(input as object)) {
      if (isForbiddenKey(key)) continue
      const child = (input as Record<string, unknown>)[key]
      flatten(child, prefix === '' ? key : `${prefix}.${key}`, depth + 1, out)
    }
    return
  }

  out.push([prefix, leafOf(prefix), `[${typeof input}]`])
}

function leafOf(path: string): string {
  const withoutIndex = path.replace(/\[\d+\]$/, '')
  const dot = withoutIndex.lastIndexOf('.')
  return dot === -1 ? withoutIndex : withoutIndex.slice(dot + 1)
}

/**
 * Apply the header disposition table.
 *
 * Unknown header names are dropped, and only the count survives, so a reviewer
 * can see that something was there without the value or the name reaching the
 * sink.
 */
function applyHeaderPolicy(raw: unknown): MapResult {
  const values = emptyMap()
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
    if (disposition === 'drop' || isForbiddenKey(name)) {
      droppedCount += 1
      continue
    }

    const rawValue = (raw as Record<string, unknown>)[rawKey]
    // set-cookie arrives as an array. Everything else is a string, but a proxy
    // or a test double can produce anything, so coerce defensively.
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

/** Apply the param disposition rules to query strings and route params alike. */
function applyParamPolicy(raw: unknown): MapResult {
  const values = emptyMap()
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
    if (isForbiddenKey(leaf) || isForbiddenKey(path)) {
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
  .catch({ values: {}, droppedCount: 0, redactedCount: 0, truncated: true })

const ParamMapSchema = z
  .unknown()
  .transform(applyParamPolicy)
  .pipe(MapResultSchema)
  .catch({ values: {}, droppedCount: 0, redactedCount: 0, truncated: true })

/**
 * The record.
 *
 * Every field carries `.catch()`, so one malformed value degrades that field
 * instead of losing the whole entry. ASVS 5.0 V16.5.3 asks the application to
 * fail securely rather than continue past a validation failure, and for a
 * logging path failing securely means emitting a placeholder, never the raw
 * input and never an exception into the request lifecycle.
 */
export const RequestLogSchema = z.object({
  /** ASVS 5.0 V16.2.2: UTC or an explicit offset. */
  ts: z.iso.datetime().catch(() => new Date().toISOString()),
  method: MethodSchema,
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

export type RequestLog = z.infer<typeof RequestLogSchema>

export const SanitizerFailureSchema = z.object({
  ts: z.iso.datetime(),
  sanitizerError: z.literal(true),
  issueCount: z.int().nonnegative(),
})

export type SanitizerFailure = z.infer<typeof SanitizerFailureSchema>

export type LogRecord = RequestLog | SanitizerFailure

/** The subset of an Express request this POC reads. Keeps the tests free of a real server. */
export type RequestLike = {
  method?: string | undefined
  originalUrl?: string | undefined
  url?: string | undefined
  headers?: unknown
  query?: unknown
  params?: unknown
  ip?: string | undefined
}

/** Split the request target without letting a malformed one throw. */
export function splitTarget(target: string): { path: string; search: string } {
  const hashIndex = target.indexOf('#')
  const withoutHash = hashIndex === -1 ? target : target.slice(0, hashIndex)
  const queryIndex = withoutHash.indexOf('?')
  return queryIndex === -1
    ? { path: withoutHash, search: '' }
    : { path: withoutHash.slice(0, queryIndex), search: withoutHash.slice(queryIndex + 1) }
}

/**
 * Build a sanitized record. Never throws, never returns anything derived from
 * the request when parsing fails.
 */
export function sanitizeRequest(
  req: RequestLike,
  options: {
    outcome?: { status: number; durationMs: number } | undefined
    viaTrustedProxy?: boolean | undefined
  } = {},
): LogRecord {
  const now = new Date().toISOString()
  try {
    const target = req.originalUrl ?? req.url ?? ''
    const headers = (req.headers ?? {}) as Record<string, unknown>
    const userAgent = headers['user-agent']

    const draft = {
      ts: now,
      method: (req.method ?? '').toUpperCase(),
      path: splitTarget(target).path,
      query: req.query ?? {},
      params: req.params ?? {},
      headers,
      client: buildClient({
        ip: req.ip,
        userAgent: typeof userAgent === 'string' ? userAgent : undefined,
        viaTrustedProxy: options.viaTrustedProxy ?? false,
      }),
      outcome: options.outcome ?? null,
      sanitizer: { version: SANITIZER_VERSION, redactions: 0, truncated: false },
    }

    const parsed = RequestLogSchema.safeParse(draft)
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

/** Rolls the per-map counters up into the record-level summary. */
function tally(record: RequestLog): RequestLog {
  const redactions =
    record.headers.redactedCount + record.query.redactedCount + record.params.redactedCount
  const truncated = record.headers.truncated || record.query.truncated || record.params.truncated
  return { ...record, sanitizer: { ...record.sanitizer, redactions, truncated } }
}
