import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  escapeControls,
  escapeLineSeparators,
  fingerprint,
  looksSecret,
  scrub,
  scrubWithMeta,
  setFingerprintKeyForTesting,
  shannonEntropy,
  truncate,
} from '../src/scrub.ts'

setFingerprintKeyForTesting(Buffer.alloc(32, 7))

test('escapeControls neutralizes CR and LF', () => {
  assert.equal(escapeControls('a\r\nb'), 'a\\r\\nb')
  assert.equal(escapeControls('a\nb'), 'a\\nb')
  assert.equal(escapeControls('a\rb'), 'a\\rb')
})

test('escapeControls neutralizes ESC, so ANSI sequences cannot reach a terminal', () => {
  assert.equal(escapeControls('\u001b[2J\u001b[1;31mALERT'), '\\e[2J\\e[1;31mALERT')
})

test('escapeControls covers NUL, DEL and the C1 range', () => {
  assert.equal(escapeControls('a\u0000b'), 'a\\x00b')
  assert.equal(escapeControls('a\u007fb'), 'a\\x7fb')
  assert.equal(escapeControls('a\u0085b'), 'a\\u0085b')
  assert.equal(escapeControls('a\u009bb'), 'a\\x9bb')
})

test('escapeControls leaves ordinary text alone', () => {
  const text = 'GET /users/42?q=hello world & more'
  assert.equal(escapeControls(text), text)
})

test('escapeLineSeparators covers the two JSON.stringify misses', () => {
  assert.equal(escapeLineSeparators('a\u2028b'), 'a\\u2028b')
  assert.equal(escapeLineSeparators('a\u2029b'), 'a\\u2029b')
})

test('JSON.stringify really does pass U+2028 through, which is why the pass exists', () => {
  // If this ever fails, the platform changed and the backstop in serialize.ts
  // can be reconsidered. Until then it is doing real work.
  assert.ok(JSON.stringify({ a: 'x\u2028y' }).includes('\u2028'))
  assert.ok(!JSON.stringify({ a: 'x\ny' }).includes('\n'))
})

test('truncate reports how much it dropped', () => {
  assert.equal(truncate('abcdef', 3), 'abc...[+3]')
  assert.equal(truncate('abc', 3), 'abc')
})

test('scrub escapes before it truncates, so no escape sequence is ever cut in half', () => {
  // Four raw CRLF pairs become sixteen characters once escaped.
  const result = scrub('\r\n\r\n\r\n\r\n', 8)
  assert.equal(result, '\\r\\n\\r\\n...[+8]')
  assert.ok(!/[\r\n]/.test(result))
})

test('scrubWithMeta reports whether the budget bit', () => {
  assert.deepEqual(scrubWithMeta('abc', 10), { value: 'abc', truncated: false })
  assert.equal(scrubWithMeta('abcdef', 3).truncated, true)
})

test('looksSecret catches JWTs wherever they sit in the value', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop'
  assert.equal(looksSecret(jwt), true)
  assert.equal(looksSecret(`/callback?access_token=${jwt}`), true)
})

test('looksSecret catches vendor-prefixed keys and bearer values', () => {
  assert.equal(looksSecret('Bearer abc123def456'), true)
  assert.equal(looksSecret('ghp_16C7e42F292c6912E7710c838347Ae178B4a'), true)
  assert.equal(looksSecret('AKIAIOSFODNN7EXAMPLE'), true)
})

test('looksSecret catches long high-entropy runs with no recognizable prefix', () => {
  assert.equal(looksSecret('9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a'), true)
})

test('looksSecret leaves ordinary values alone', () => {
  for (const value of [
    'hello world',
    '/users/42/settings',
    // A long hyphenated slug scores about 3.9 bits per character, higher than
    // some real keys. Character-class mixing is what keeps it out.
    'the-quick-brown-fox-jumps-over-the-lazy-dog',
    'users/42/settings/notifications/email-digest',
    'application/json; charset=utf-8',
    '2026-08-22T00:00:00Z',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  ]) {
    assert.equal(looksSecret(value), false, `expected ${value} to read as ordinary`)
  }
})

test('looksSecret is a heuristic, and the README says where it gives up', () => {
  // A short opaque token with no prefix and no class mixing is indistinguishable
  // from an ordinary identifier. The key allowlist is what covers this case.
  assert.equal(looksSecret('abc123def456'), false)
})

test('shannonEntropy separates repetitive from random', () => {
  assert.equal(shannonEntropy('aaaaaaaa'), 0)
  assert.ok(shannonEntropy('9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c') > 3.5)
})

test('fingerprint is stable, keyed, and never contains the input', () => {
  const secret = 'hunter2-is-the-password'
  const first = fingerprint(secret)
  assert.equal(first, fingerprint(secret))
  assert.notEqual(first, fingerprint(`${secret}!`))
  assert.match(first, /^sha256:[0-9a-f]{16}$/)
  assert.ok(!first.includes('hunter2'))
})
