/**
 * Demo server.
 *
 * Every route answers with both views of the request: the naive line a plain
 * logger would write, and the sanitized record. The attack script reads those
 * back and prints them side by side.
 */

import express, { type Express, type Request } from 'express'
import { sanitizedRequestLog, viaTrustedProxy } from './middleware.ts'
import { sanitizeRequest } from './schema.ts'
import { toNdjson } from './serialize.ts'

/**
 * The vulnerable baseline this POC exists to replace.
 *
 * This is what request logging looks like in most codebases: interpolate the
 * request into a template string and hand it to the logger. Everything in it
 * is attacker-controlled and none of it is encoded.
 */
export function naiveLine(req: Request): string {
  return `${new Date().toISOString()} ${req.method} ${req.originalUrl} ua="${req.headers['user-agent'] ?? ''}" auth="${req.headers.authorization ?? ''}" query=${JSON.stringify(req.query)}`
}

export type AppOptions = {
  queryParser?: 'simple' | 'extended'
  /**
   * Whether the app trusts proxy headers from the peer.
   *
   * Off by default, which is also Express's default. With it on, `req.ip` comes
   * from `x-forwarded-for`, so any client the setting covers can assert
   * whatever source address it likes. The attack corpus fires the same payload
   * at both settings to show the difference.
   */
  trustProxy?: boolean
  /** Set to false to keep the middleware from writing NDJSON to stdout. */
  logToStdout?: boolean
}

export function createApp(options: AppOptions = {}): Express {
  const app = express()
  app.set('query parser', options.queryParser ?? 'simple')
  if (options.trustProxy) app.set('trust proxy', 'loopback')

  app.use(
    sanitizedRequestLog(
      options.logToStdout === false
        ? { sink: () => {} }
        : { sink: (record) => process.stdout.write(`${toNdjson(record)}\n`) },
    ),
  )

  const respond = (req: Request): { naive: string; sanitized: unknown } => ({
    naive: naiveLine(req),
    sanitized: sanitizeRequest(req, { viaTrustedProxy: viaTrustedProxy(req) }),
  })

  // A route with a param, so req.params is populated for the param payloads.
  app.get('/users/:id', (req, res) => {
    res.json(respond(req))
  })

  app.use((req, res) => {
    res.json(respond(req))
  })

  return app
}

function main(): void {
  const port = Number(process.env.PORT ?? 3000)
  const parser = process.env.QUERY_PARSER === 'extended' ? 'extended' : 'simple'
  const app = createApp({ queryParser: parser })

  app.listen(port, () => {
    process.stderr.write(
      `demo listening on http://127.0.0.1:${port} (query parser: ${parser})\n` +
        `try: curl -sG 'http://127.0.0.1:${port}/search' --data-urlencode 'q=a\\r\\nFAKE' | jq\n`,
    )
  })
}

if (import.meta.filename === process.argv[1]) main()
