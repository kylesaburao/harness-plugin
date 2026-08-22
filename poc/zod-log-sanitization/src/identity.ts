/**
 * Client identity, treated as PII rather than as a free field.
 *
 * The OWASP Logging Cheat Sheet lists "Sensitive personal data and some forms
 * of personally identifiable information (PII)" among the things not to log,
 * and notes that non-sensitive personal data may still need de-identification.
 * A raw client IP is personal data under GDPR, so it gets two derived forms
 * instead: a coarse network prefix for abuse and geo work, and a keyed
 * pseudonym for correlation.
 */

import { isIPv4, isIPv6 } from 'node:net'
import { z } from 'zod'
import { LIMITS, fingerprint, safeString } from './scrub.ts'

/**
 * Truncate to the smallest block that is still useful operationally.
 *
 * IPv4 goes to /24 and IPv6 to /48, the conventional boundaries: a /24 is the
 * smallest routable IPv4 block, and a /48 is the standard single-site IPv6
 * allocation. Both keep network-level attribution without identifying a host.
 */
export function ipPrefix(ip: string): string | null {
  if (isIPv4(ip)) {
    const octets = ip.split('.')
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`
  }
  if (isIPv6(ip)) {
    // Node normalizes to the compressed form, so expand enough to take 3 groups.
    const groups = expandIPv6(ip).split(':').slice(0, 3)
    return `${groups.join(':')}::/48`
  }
  return null
}

function expandIPv6(ip: string): string {
  const [head = '', tail = ''] = ip.split('::')
  if (!ip.includes('::')) return ip
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === '' ? [] : tail.split(':')
  const missing = 8 - headGroups.length - tailGroups.length
  return [...headGroups, ...Array(missing).fill('0'), ...tailGroups].join(':')
}

export const ClientSchema = z.object({
  /** Coarse network block. Null when req.ip is absent or unparseable. */
  ipPrefix: z.string().nullable(),
  /** Keyed pseudonym of the full address. Correlates within a process lifetime, does not reverse. */
  ipId: z.string().nullable(),
  userAgent: safeString(LIMITS.userAgent).nullable(),
  /** Whether req.ip came from a proxy header the app was configured to trust. */
  viaTrustedProxy: z.boolean(),
})

export type Client = z.infer<typeof ClientSchema>

export function buildClient(input: {
  ip: string | undefined
  userAgent: string | undefined
  viaTrustedProxy: boolean
}): unknown {
  return {
    ipPrefix: input.ip === undefined ? null : ipPrefix(input.ip),
    ipId: input.ip === undefined ? null : fingerprint(input.ip),
    userAgent: input.userAgent ?? null,
    viaTrustedProxy: input.viaTrustedProxy,
  }
}
