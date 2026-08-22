/**
 * Dispositions and the tables that assign them.
 *
 * Header handling is an allowlist: anything not named here is dropped. A
 * denylist (the shape `pino`'s `redact` option takes) fails open, so every
 * header a future middleware or upstream proxy invents lands in the log until
 * someone notices. An allowlist fails closed, which is the behavior the OWASP
 * exclusion list ("Session identification values", "Access tokens",
 * "Authentication passwords", "Encryption keys and other primary secrets")
 * actually asks for.
 */

import { z } from 'zod'
import { LIMITS, fingerprint, looksSecret, safeString, scrub } from './scrub.ts'

export type Disposition =
  /** Sanitized value goes in the log. */
  | 'allow'
  /** Value replaced by a marker plus a keyed fingerprint, so two requests carrying the same secret still correlate. */
  | 'redact'
  /** Value replaced by the fingerprint alone, for identifiers you want to join on. */
  | 'hash'
  /** Key does not appear at all. */
  | 'drop'

export const REDACTED = '[redacted]'

/**
 * Keys that poison an object literal. Relevant because
 * `app.set('query parser', 'extended')` restores `qs`, which happily produces
 * `?a[__proto__][x]=1`.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Node lowercases incoming header names, so these are compared lowercased. */
export const HEADER_POLICY: ReadonlyMap<string, Disposition> = new Map([
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
  ['tracestate', 'allow'],

  // Client-supplied and forgeable. Identity comes from req.ip, which honors
  // the app's trust proxy setting, so logging the raw header would let any
  // client write whatever it likes into the "who" field.
  ['x-forwarded-for', 'drop'],
  ['x-real-ip', 'drop'],
])

/** Query and route-param keys that are sensitive regardless of their value. */
export const SENSITIVE_PARAM_KEYS: ReadonlySet<string> = new Set([
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

/** Per-header value budget. User-agent gets a tighter one, it is long and low value. */
export function headerLimit(name: string): number {
  return name === 'user-agent' ? LIMITS.userAgent : LIMITS.headerValue
}

export function headerDisposition(name: string): Disposition {
  return HEADER_POLICY.get(name) ?? 'drop'
}

/**
 * Params default to `allow`, unlike headers. A route param or query key is
 * usually the most useful thing in the log line, and the key space is open, so
 * an allowlist would drop the diagnostics people actually need. The value-level
 * `looksSecret` check below is what covers the gap.
 */
export function paramDisposition(key: string, value: string): Disposition {
  if (FORBIDDEN_KEYS.has(key)) return 'drop'
  if (SENSITIVE_PARAM_KEYS.has(key.toLowerCase())) return 'redact'
  if (looksSecret(value)) return 'redact'
  return 'allow'
}

/**
 * A referer carries a full URL, which routinely carries credentials in its
 * userinfo or a token in its query. Keep origin and pathname, drop the rest.
 */
export function scrubUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // Not absolute, so there is no origin to preserve. Treat it as a path.
    return scrub(value, LIMITS.headerValue)
  }
  const rebuilt = `${url.protocol}//${url.host}${url.pathname}`
  const suffix = url.search === '' ? '' : '?[stripped]'
  return scrub(rebuilt + suffix, LIMITS.headerValue)
}

/** The value schemas, one per disposition. Each is a zod schema, not a bare function. */
const redactSchema = z.string().transform((value) => `${REDACTED} ${fingerprint(value)}`)
const hashSchema = z.string().transform((value) => fingerprint(value))

/**
 * Build the schema that applies to one header's value.
 *
 * Returning a schema rather than a string keeps the policy declarative: the
 * disposition table decides which schema runs, and the schema decides what the
 * output looks like.
 */
export function headerValueSchema(name: string): z.ZodType<string> {
  switch (headerDisposition(name)) {
    case 'redact':
      return redactSchema
    case 'hash':
      return hashSchema
    case 'allow':
      return name === 'referer' ? z.string().transform(scrubUrl) : safeString(headerLimit(name))
    case 'drop':
      // Never reached, dropped keys are skipped before a value schema is chosen.
      return z.string().transform(() => REDACTED)
  }
}

export function paramValueSchema(key: string, value: string): z.ZodType<string> {
  switch (paramDisposition(key, value)) {
    case 'redact':
      return redactSchema
    case 'hash':
      return hashSchema
    default:
      return safeString(LIMITS.queryValue)
  }
}

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key)
}
