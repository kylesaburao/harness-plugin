import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FAKE_API_KEY, FAKE_JWT } from '../src/corpus.ts'
import { ipPrefix } from '../src/identity.ts'
import { REDACTED } from '../src/policy.ts'
import {
  BUDGETS,
  type RequestLike,
  type RequestLog,
  sanitizeRequest,
  splitTarget,
} from '../src/schema.ts'
import { setFingerprintKeyForTesting } from '../src/scrub.ts'

setFingerprintKeyForTesting(Buffer.alloc(32, 11))

/** Narrow to the success shape, failing the test if the sanitizer bailed out. */
function ok(record: ReturnType<typeof sanitizeRequest>): RequestLog {
  assert.ok(!('sanitizerError' in record), 'expected a sanitized record, got a failure record')
  return record
}

function request(overrides: Partial<RequestLike> = {}): RequestLike {
  return {
    method: 'GET',
    originalUrl: '/health',
    headers: {},
    query: {},
    params: {},
    ip: '203.0.113.5',
    ...overrides,
  }
}

test('the top-level shape is a fail-closed allowlist', () => {
  const record = ok(
    sanitizeRequest({
      ...request(),
      // Fields a future middleware might hang off the request. None are declared
      // in the schema, so z.object strips every one of them.
      ...({ user: { email: 'someone@example.test' }, rawBody: 'password=hunter2' } as object),
    }),
  )

  assert.deepEqual(Object.keys(record).sort(), [
    'client',
    'headers',
    'method',
    'outcome',
    'params',
    'path',
    'query',
    'sanitizer',
    'ts',
  ])
  assert.ok(!JSON.stringify(record).includes('someone@example.test'))
  assert.ok(!JSON.stringify(record).includes('hunter2'))
})

test('unknown headers are dropped, and only the count survives', () => {
  const record = ok(
    sanitizeRequest(
      request({
        headers: {
          host: 'api.example.test',
          'x-internal-debug': 'postgres://user:pw@10.0.0.5/prod',
          'x-another-unknown': 'whatever',
        },
      }),
    ),
  )

  assert.deepEqual(Object.keys(record.headers.values), ['host'])
  assert.equal(record.headers.droppedCount, 2)
  assert.ok(!JSON.stringify(record).includes('10.0.0.5'))
})

test('named credential headers are redacted with a correlatable fingerprint', () => {
  const record = ok(
    sanitizeRequest(
      request({
        headers: { authorization: `Bearer ${FAKE_JWT}`, cookie: 'session=abc' },
      }),
    ),
  )

  assert.match(record.headers.values.authorization ?? '', /^\[redacted\] sha256:[0-9a-f]{16}$/)
  assert.match(record.headers.values.cookie ?? '', /^\[redacted\] sha256:[0-9a-f]{16}$/)
  assert.equal(record.headers.redactedCount, 2)
  assert.ok(!JSON.stringify(record).includes(FAKE_JWT))
})

test('the same secret fingerprints the same way, different secrets do not', () => {
  const one = ok(sanitizeRequest(request({ headers: { authorization: 'Bearer aaa' } })))
  const two = ok(sanitizeRequest(request({ headers: { authorization: 'Bearer aaa' } })))
  const three = ok(sanitizeRequest(request({ headers: { authorization: 'Bearer bbb' } })))

  assert.equal(one.headers.values.authorization, two.headers.values.authorization)
  assert.notEqual(one.headers.values.authorization, three.headers.values.authorization)
})

test('set-cookie arrives as an array and is still redacted', () => {
  const record = ok(
    sanitizeRequest(request({ headers: { 'set-cookie': ['a=1', 'session=secret'] } })),
  )
  assert.match(record.headers.values['set-cookie'] ?? '', /^\[redacted\]/)
  assert.ok(!JSON.stringify(record).includes('session=secret'))
})

test('a referer keeps its origin and pathname and loses its credentials and query', () => {
  const record = ok(
    sanitizeRequest(
      request({
        headers: { referer: `https://user:pw@example.test/oauth/cb?id_token=${FAKE_JWT}` },
      }),
    ),
  )

  assert.equal(record.headers.values.referer, 'https://example.test/oauth/cb?[stripped]')
})

test('x-forwarded-for is dropped, so a client cannot write the who field', () => {
  const record = ok(
    sanitizeRequest(request({ headers: { 'x-forwarded-for': '198.51.100.7' } })),
  )
  assert.equal(record.headers.values['x-forwarded-for'], undefined)
  assert.ok(!JSON.stringify(record).includes('198.51.100.7'))
})

test('sensitive query keys are redacted by name', () => {
  const record = ok(
    sanitizeRequest(request({ query: { q: 'weather', token: 'anything-at-all' } })),
  )
  assert.equal(record.query.values.q, 'weather')
  assert.match(record.query.values.token ?? '', /^\[redacted\]/)
})

test('a secret under an unnamed key is caught by its shape', () => {
  const record = ok(sanitizeRequest(request({ query: { next: `/cb?access_token=${FAKE_JWT}` } })))
  assert.match(record.query.values.next ?? '', /^\[redacted\]/)
  assert.ok(!JSON.stringify(record).includes(FAKE_JWT))
})

test('an opaque API key in an unnamed parameter is caught too', () => {
  const record = ok(sanitizeRequest(request({ query: { ref: FAKE_API_KEY } })))
  assert.match(record.query.values.ref ?? '', /^\[redacted\]/)
})

test('route params get the same treatment as query values', () => {
  const record = ok(
    sanitizeRequest(request({ params: { id: '42\r\nINFO forged', token: 'abc' } })),
  )
  assert.equal(record.params.values.id, '42\\r\\nINFO forged')
  assert.match(record.params.values.token ?? '', /^\[redacted\]/)
})

test('__proto__ keys are dropped rather than assigned', () => {
  // qs strips this branch itself, so feed the map directly, the way a custom
  // parser or a hand-built params object would.
  const hostile = JSON.parse('{"__proto__": {"polluted": "yes"}, "safe": "value"}') as object
  const record = ok(sanitizeRequest(request({ query: hostile })))

  assert.equal(record.query.values.safe, 'value')
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.ok(!Object.keys(record.query.values).some((key) => key.includes('__proto__')))
})

test('nested query objects flatten to dotted keys and stop at the depth budget', () => {
  const record = ok(
    sanitizeRequest(request({ query: { a: { b: { c: { d: { e: 'deep' } } } } } })),
  )
  const keys = Object.keys(record.query.values)
  assert.equal(keys.length, 1)
  assert.ok(keys[0]?.startsWith('a.b.c'))
  assert.equal(record.query.values[keys[0] ?? ''], '[depth-limit]')
})

test('repeated query keys become indexed entries', () => {
  const record = ok(sanitizeRequest(request({ query: { q: ['one', 'two'] } })))
  assert.deepEqual(record.query.values, { 'q[0]': 'one', 'q[1]': 'two' })
})

test('an oversized value is capped and the record says so', () => {
  const record = ok(sanitizeRequest(request({ query: { q: 'x'.repeat(4096) } })))
  assert.match(record.query.values.q ?? '', /\.\.\.\[\+\d+\]$/)
  assert.equal(record.sanitizer.truncated, true)
})

test('too many keys stops at the budget instead of growing without bound', () => {
  const query: Record<string, string> = {}
  for (let i = 0; i < BUDGETS.maxKeys * 2; i += 1) query[`k${i}`] = 'v'

  const record = ok(sanitizeRequest(request({ query })))
  assert.ok(Object.keys(record.query.values).length <= BUDGETS.maxKeys)
  assert.equal(record.sanitizer.truncated, true)
})

test('an unknown method is reported as OTHER rather than echoed', () => {
  const record = ok(sanitizeRequest(request({ method: 'BREW\r\nINJECT' })))
  assert.equal(record.method, 'OTHER')
})

test('the query string never reaches the path field', () => {
  const record = ok(sanitizeRequest(request({ originalUrl: '/search?token=secret#frag' })))
  assert.equal(record.path, '/search')
  assert.ok(!JSON.stringify(record.path).includes('secret'))
})

test('splitTarget handles the shapes a request target comes in', () => {
  assert.deepEqual(splitTarget('/a/b'), { path: '/a/b', search: '' })
  assert.deepEqual(splitTarget('/a?b=c'), { path: '/a', search: 'b=c' })
  assert.deepEqual(splitTarget('/a#f?not=query'), { path: '/a', search: '' })
  assert.deepEqual(splitTarget(''), { path: '', search: '' })
})

test('client identity is de-identified, never logged raw', () => {
  const record = ok(sanitizeRequest(request({ ip: '198.51.100.77' })))
  assert.equal(record.client.ipPrefix, '198.51.100.0/24')
  assert.match(record.client.ipId ?? '', /^sha256:[0-9a-f]{16}$/)
  assert.ok(!JSON.stringify(record).includes('198.51.100.77'))
})

test('ipPrefix handles IPv6 and rejects junk', () => {
  assert.equal(ipPrefix('2001:db8:1234:5678::1'), '2001:db8:1234::/48')
  assert.equal(ipPrefix('::1'), '0:0:0::/48')
  assert.equal(ipPrefix('not-an-ip'), null)
})

test('a request whose getters throw still produces a record', () => {
  const hostile: RequestLike = {
    method: 'GET',
    originalUrl: '/boom',
    get headers(): never {
      throw new Error('nope')
    },
  }

  const record = sanitizeRequest(hostile)
  assert.ok('sanitizerError' in record)
  assert.equal(record.sanitizerError, true)
})

test('a completely empty request does not throw', () => {
  const record = ok(sanitizeRequest({}))
  assert.equal(record.method, 'OTHER')
  assert.equal(record.path, '')
  assert.equal(record.client.ipPrefix, null)
})

test('the outcome carries status and duration when the middleware supplies them', () => {
  const record = ok(sanitizeRequest(request(), { outcome: { status: 404, durationMs: 12.5 } }))
  assert.deepEqual(record.outcome, { status: 404, durationMs: 12.5 })
})

test('redactions are tallied across headers, query and params', () => {
  const record = ok(
    sanitizeRequest(
      request({
        headers: { authorization: 'Bearer x' },
        query: { token: 'a' },
        params: { secret: 'b' },
      }),
    ),
  )
  assert.equal(record.sanitizer.redactions, 3)
  assert.ok(JSON.stringify(record).includes(REDACTED))
})
