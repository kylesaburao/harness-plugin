/**
 * Express middleware.
 *
 * The record is built on `res.on('finish')` rather than at request entry, for
 * two reasons: the status and duration are only known then, and `req.params`
 * is empty until the router has matched a route.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { LogRecord } from './schema.ts'
import { sanitizeRequest } from './schema.ts'
import { toNdjson } from './serialize.ts'

export type Sink = (record: LogRecord) => void

export const stdoutSink: Sink = (record) => {
  process.stdout.write(`${toNdjson(record)}\n`)
}

export type Options = {
  sink?: Sink
}

/**
 * Whether `req.ip` came from a proxy header the app was configured to trust.
 *
 * Express only consults `x-forwarded-for` when `trust proxy` is set, so the
 * presence of the header alone proves nothing: any client can send it. The
 * record carries this flag so a reader can tell whether the logged identity is
 * the socket peer or something an upstream asserted.
 */
export function viaTrustedProxy(req: Request): boolean {
  const trustSetting: unknown = req.app?.get('trust proxy')
  const trusted = trustSetting !== undefined && trustSetting !== false
  return trusted && req.headers['x-forwarded-for'] !== undefined
}

export function sanitizedRequestLog(options: Options = {}): RequestHandler {
  const sink = options.sink ?? stdoutSink

  return function sanitizedRequestLogMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const startedAt = process.hrtime.bigint()

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6

      // A logging middleware must never take the request down with it. The
      // sanitizer already swallows its own failures, this guards the sink.
      try {
        sink(
          sanitizeRequest(req, {
            outcome: { status: res.statusCode, durationMs },
            viaTrustedProxy: viaTrustedProxy(req),
          }),
        )
      } catch {
        // Deliberately silent. An error here is a bug in the sink, and a
        // second write attempt would most likely fail the same way.
      }
    })

    next()
  }
}
