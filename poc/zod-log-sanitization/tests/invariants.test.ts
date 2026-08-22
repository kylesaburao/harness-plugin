/**
 * Corpus-wide properties.
 *
 * The per-case tests in schema.test.ts say what each rule does. These say what
 * holds across every payload at once, which is the claim that actually matters:
 * no matter what comes in, nothing that reaches the sink can forge a log line,
 * carry a credential, or introduce a field nobody declared.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CORPUS, FAKE_API_KEY, FAKE_JWT, type Payload } from '../src/corpus.ts'
import { REDACTED } from '../src/policy.ts'
import { type RequestLike, sanitizeRequest, splitTarget } from '../src/schema.ts'
import { isSingleLine, toNdjson } from '../src/serialize.ts'
import { setFingerprintKeyForTesting } from '../src/scrub.ts'

setFingerprintKeyForTesting(Buffer.alloc(32, 13))

/**
 * Turn a corpus payload into a request, decoding the way Express does.
 *
 * `req.query` and `req.params` reach middleware already decoded, which is the
 * whole reason percent-encoded control characters are a live vector. Reproducing
 * that here keeps these tests honest without needing a server.
 */
function toRequest(payload: Payload): RequestLike {
  const { path, search } = splitTarget(payload.target)
  const query: Record<string, string | string[]> = {}

  for (const [key, value] of new URLSearchParams(search)) {
    const existing = query[key]
    if (existing === undefined) query[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else query[key] = [existing, value]
  }

  // The one route with a param in the demo app is /users/:id.
  const params = path.startsWith('/users/')
    ? { id: decodeURIComponent(path.slice('/users/'.length)) }
    : {}

  return {
    method: 'GET',
    originalUrl: payload.target,
    headers: { host: 'api.example.test', 'user-agent': 'corpus/1.0', ...payload.headers },
    query,
    params,
    ip: '198.51.100.42',
  }
}

const records = CORPUS.map((payload) => ({
  payload,
  line: toNdjson(sanitizeRequest(toRequest(payload))),
}))

test('the corpus is not accidentally empty', () => {
  assert.ok(records.length >= 20, `expected a real corpus, got ${records.length}`)
})

test('invariant: no payload survives as a line break', () => {
  for (const { payload, line } of records) {
    assert.ok(isSingleLine(line), `${payload.name} produced a line break`)
    assert.equal(line.split('\n').length, 1, `${payload.name} produced more than one line`)
  }
})

test('invariant: no payload survives as a control character', () => {
  for (const { payload, line } of records) {
    for (const char of line) {
      const code = char.codePointAt(0) ?? 0
      const isControl = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
      assert.ok(
        !isControl,
        `${payload.name} left U+${code.toString(16).padStart(4, '0')} in the output`,
      )
    }
  }
})

test('invariant: every line parses back as exactly one JSON object', () => {
  for (const { payload, line } of records) {
    const parsed: unknown = JSON.parse(line)
    assert.equal(typeof parsed, 'object', `${payload.name} did not parse as an object`)
    assert.ok(parsed !== null)
  }
})

test('invariant: no known secret survives anywhere in the output', () => {
  const secrets = [
    FAKE_JWT,
    FAKE_API_KEY,
    '8f14e45fceea167a5a36dedd4bea2543',
    'hunter2',
    'user:pass',
  ]

  for (const { payload, line } of records) {
    for (const secret of secrets) {
      assert.ok(!line.includes(secret), `${payload.name} leaked ${secret.slice(0, 12)}...`)
    }
  }
})

test('invariant: a secret planted in every field comes back redacted, not echoed', () => {
  const sentinel = `sk-${'Zx9Qw7Ev2Rt5Yu8Io1Pa4Sd6Fg3Hj0Kl'}`
  const record = sanitizeRequest({
    method: 'GET',
    originalUrl: `/x?token=${sentinel}&other=${sentinel}`,
    headers: { authorization: sentinel, cookie: sentinel, 'x-api-key': sentinel },
    query: { token: sentinel, other: sentinel },
    params: { id: sentinel },
    ip: '198.51.100.42',
  })

  const line = toNdjson(record)
  assert.ok(!line.includes(sentinel), 'the sentinel reached the output')
  assert.ok(line.includes(REDACTED), 'nothing was marked as redacted')
})

test('invariant: the record key set is fixed, whatever arrives on the request', () => {
  const expected = [
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

  for (const payload of CORPUS) {
    const record = sanitizeRequest({
      ...toRequest(payload),
      ...({ session: 'abc', user: { id: 1 }, rawBody: 'x', cookies: { a: 'b' } } as object),
    })
    assert.deepEqual(Object.keys(record).sort(), expected, `${payload.name} changed the key set`)
  }
})

test('invariant: every record fits the size budget', () => {
  for (const { payload, line } of records) {
    assert.ok(
      Buffer.byteLength(line) <= 8192,
      `${payload.name} produced ${Buffer.byteLength(line)} bytes`,
    )
  }
})

test('a record that would blow the budget is replaced, not truncated into invalid JSON', () => {
  const query: Record<string, string> = {}
  for (let i = 0; i < 64; i += 1) query[`key${i}`] = 'y'.repeat(512)

  const line = toNdjson(
    sanitizeRequest({ method: 'GET', originalUrl: '/big', headers: {}, query, params: {} }),
  )

  const parsed = JSON.parse(line) as Record<string, unknown>
  assert.equal(parsed.reason, 'record-too-large')
  assert.ok(Buffer.byteLength(line) < 8192)
})
