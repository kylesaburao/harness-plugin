/**
 * End to end, through a real Express app on a real socket.
 *
 * The unit tests build request objects by hand. These prove the same behavior
 * holds against what Express actually hands a middleware, including its own
 * decoding of query values and route params.
 */

import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import express from 'express'
import { CORPUS, FAKE_JWT } from '../src/corpus.ts'
import { sanitizedRequestLog } from '../src/middleware.ts'
import type { LogRecord, RequestLog } from '../src/schema.ts'
import { isSingleLine, toNdjson } from '../src/serialize.ts'
import { setFingerprintKeyForTesting } from '../src/scrub.ts'

setFingerprintKeyForTesting(Buffer.alloc(32, 17))

type Harness = {
  baseUrl: string
  records: LogRecord[]
  close: () => Promise<void>
}

async function start(options: { queryParser?: 'simple' | 'extended' } = {}): Promise<Harness> {
  const records: LogRecord[] = []
  const app = express()
  app.set('query parser', options.queryParser ?? 'simple')
  app.use(sanitizedRequestLog({ sink: (record) => records.push(record) }))
  app.get('/users/:id', (_req, res) => {
    res.json({ ok: true })
  })
  app.use((_req, res) => {
    res.status(404).json({ ok: false })
  })

  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    records,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const harness = await start()
after(() => harness.close())

/** Wait for the sink, which runs on the response finish event. */
async function request(target: string, headers: Record<string, string> = {}): Promise<LogRecord> {
  const before = harness.records.length
  await fetch(`${harness.baseUrl}${target}`, { headers })
  for (let attempt = 0; attempt < 50 && harness.records.length === before; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  const record = harness.records.at(-1)
  assert.ok(record !== undefined, `no record emitted for ${target}`)
  return record
}

function ok(record: LogRecord): RequestLog {
  assert.ok(!('sanitizerError' in record), 'expected a sanitized record')
  return record
}

test('the middleware records status and duration from the finished response', async () => {
  const record = ok(await request('/users/42'))
  assert.equal(record.outcome?.status, 200)
  assert.ok((record.outcome?.durationMs ?? -1) >= 0)
  assert.equal(record.method, 'GET')
  assert.equal(record.path, '/users/42')
})

test('route params are populated, which is why the record is built on finish', async () => {
  const record = ok(await request('/users/42'))
  assert.equal(record.params.values.id, '42')
})

test('a CRLF payload Express decoded is neutralized end to end', async () => {
  const record = ok(await request('/search?q=cats%0d%0aFORGED%20ENTRY'))
  assert.equal(record.query.values.q, 'cats\\r\\nFORGED ENTRY')
  assert.ok(isSingleLine(toNdjson(record)))
})

test('a CRLF payload in a route param is neutralized end to end', async () => {
  const record = ok(await request('/users/42%0d%0aFORGED'))
  assert.equal(record.params.values.id, '42\\r\\nFORGED')
})

test('credentials sent as real headers are redacted end to end', async () => {
  const record = ok(await request('/users/1', { authorization: `Bearer ${FAKE_JWT}` }))
  assert.match(record.headers.values.authorization ?? '', /^\[redacted\]/)
  assert.ok(!toNdjson(record).includes(FAKE_JWT))
})

test('a 404 is logged with its status', async () => {
  const record = ok(await request('/nope'))
  assert.equal(record.outcome?.status, 404)
})

test('the whole corpus goes through a live server without breaking a line', async () => {
  const simple = CORPUS.filter((payload) => payload.queryParser !== 'extended')
  for (const payload of simple) {
    const record = await request(payload.target, payload.headers ?? {})
    const line = toNdjson(record)
    assert.ok(isSingleLine(line), `${payload.name} broke the line`)
    JSON.parse(line)
  }
})

test('the extended query parser is covered too', async () => {
  const extended = await start({ queryParser: 'extended' })
  try {
    for (const payload of CORPUS.filter((p) => p.queryParser === 'extended')) {
      const before = extended.records.length
      await fetch(`${extended.baseUrl}${payload.target}`)
      for (let attempt = 0; attempt < 50 && extended.records.length === before; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      const record = extended.records.at(-1)
      assert.ok(record !== undefined)
      assert.ok(isSingleLine(toNdjson(record)), `${payload.name} broke the line`)
    }
  } finally {
    await extended.close()
  }
})

test('a sink that throws does not take the response down with it', async () => {
  const app = express()
  app.use(
    sanitizedRequestLog({
      sink: () => {
        throw new Error('sink is broken')
      },
    }),
  )
  app.use((_req, res) => {
    res.json({ ok: true })
  })

  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo

  try {
    const response = await fetch(`http://127.0.0.1:${port}/anything`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
