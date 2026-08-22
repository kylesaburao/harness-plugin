/**
 * The hostile request corpus.
 *
 * One table, used by the invariant tests and by the attack script, so what the
 * demo shows and what the tests assert cannot drift apart.
 *
 * Every payload is written percent-encoded, which is how it arrives on the
 * wire. Express decodes route params with `decodeURIComponent` and the query
 * parser decodes query values, so `%0d%0a` becomes a real CRLF in a JavaScript
 * string by the time any logger sees it. That decoding step is the reason the
 * query string, not the header block, is the live log-forging vector: Node's
 * llhttp rejects CR, LF and other control characters in header values before
 * Express ever runs.
 */

/** A JWT-shaped value. Not a real token, the signature segment is filler. */
export const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'

/** A high-entropy opaque credential, the shape an API key takes. */
export const FAKE_API_KEY = 'sk-Xq7Q2vN4pL9wR3tY6uI8oP0aS1dF5gH7jK2lZ4xC6vB8nM'

export type Payload = {
  name: string
  /** What the payload is trying to do to the log. */
  vector: string
  /** Raw request target, percent-encoded as it goes on the wire. */
  target: string
  headers?: Record<string, string>
  /** Set when the payload only makes sense under the `qs` query parser. */
  queryParser?: 'simple' | 'extended'
  /** Set when the payload needs an app that trusts proxy headers. */
  trustProxy?: boolean
}

export const CORPUS: readonly Payload[] = [
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
    name: 'unicode-paragraph-separator',
    vector: 'U+2029, same idea.',
    target: '/search?q=before%e2%80%a9after',
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
      'A query value far past the per-field budget. OWASP asks that log input be size-limited. Capped at 4 KiB here because Node itself refuses a request line plus headers over 16 KiB (--max-http-header-size), answering 431 before Express runs.',
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
      'The same payload against an app that trusts loopback. Express now takes req.ip from the header, so the logged identity is whatever the client claimed. The record says so via viaTrustedProxy, which is the point of carrying that flag.',
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
      'Only reachable with the qs parser, which builds real nested objects. qs discards the __proto__ branch itself (allowPrototypes defaults to false), so what you see here is defense in depth: the sanitizer never gets the chance to mishandle it. The guard in the sanitizer still matters for req.params and for any map a custom parser hands over, which schema.test.ts exercises directly.',
    target: '/search?a%5B__proto__%5D%5Bpolluted%5D=yes&a%5Bb%5D%5Bc%5D=nested',
    queryParser: 'extended',
  },
  {
    name: 'deep-nesting',
    vector: 'Nesting deeper than the walk budget.',
    target: '/search?a%5Bb%5D%5Bc%5D%5Bd%5D%5Be%5D%5Bf%5D=deep',
    queryParser: 'extended',
  },
  {
    name: 'control-chars-in-key',
    vector: 'The attacker controls key names too, and keys become JSON object keys.',
    target: '/search?bad%0d%0akey=value',
  },
]
