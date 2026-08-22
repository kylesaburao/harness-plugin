/**
 * Fire the corpus at the demo server and print both views of each request.
 *
 * The naive line is printed through JSON.stringify by default, so the control
 * characters show up as escapes instead of being interpreted by your terminal.
 * That is the opposite of what a real plain-text logger does, which is the
 * whole problem. Pass --raw to see what the unescaped bytes actually do.
 */

import type { AddressInfo } from 'node:net'
import { CORPUS, type Payload } from './corpus.ts'
import { createApp } from './demo.ts'

const raw = process.argv.includes('--raw')

type Result = { naive: string; sanitized: unknown }

async function run(payload: Payload, baseUrl: string): Promise<Result> {
  const response = await fetch(`${baseUrl}${payload.target}`, {
    headers: { 'user-agent': 'attack-corpus/1.0', ...payload.headers },
  })
  const body = await response.text()
  if (body === '') {
    // Node can reject a request before Express sees it, for instance a request
    // line over --max-http-header-size, which answers 431 with no body.
    return { naive: `<no body, HTTP ${response.status}>`, sanitized: null }
  }
  return JSON.parse(body) as Result
}

function heading(payload: Payload, index: number): string {
  return `\n${'='.repeat(78)}\n[${index + 1}/${CORPUS.length}] ${payload.name}\n${payload.vector}`
}

type Server = { baseUrl: string; close: () => Promise<void> }

async function serve(parser: 'simple' | 'extended', trustProxy = false): Promise<Server> {
  const app = createApp({ queryParser: parser, trustProxy, logToStdout: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function main(): Promise<void> {
  const simple = await serve('simple')
  const extended = await serve('extended')
  const trusting = await serve('simple', true)

  const pick = (payload: Payload): Server => {
    if (payload.trustProxy) return trusting
    return payload.queryParser === 'extended' ? extended : simple
  }

  try {
    for (const [index, payload] of CORPUS.entries()) {
      const result = await run(payload, pick(payload).baseUrl)

      console.log(heading(payload, index))
      console.log(`\n  target   ${payload.target.slice(0, 140)}`)
      if (payload.headers) console.log(`  headers  ${JSON.stringify(payload.headers).slice(0, 200)}`)

      console.log('\n  naive logger writes:')
      console.log(`    ${raw ? result.naive : JSON.stringify(result.naive)}`)

      console.log('\n  sanitized record:')
      console.log(
        JSON.stringify(result.sanitized, null, 2)
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n'),
      )
    }
  } finally {
    await simple.close()
    await extended.close()
    await trusting.close()
  }

  console.log(`\n${'='.repeat(78)}`)
  console.log(`${CORPUS.length} payloads. Every sanitized record above is one JSON object on one`)
  console.log('line once serialized, with no control characters and no credentials in it.')
  if (!raw) console.log('Re-run with --raw to see the naive lines unescaped.')
}

await main()
