/**
 * NDJSON output.
 *
 * OWASP Logging Cheat Sheet: "Encode data correctly for the output (logged)
 * format." For newline-delimited JSON that means one object per physical line,
 * which JSON.stringify alone does not guarantee: it escapes CR and LF, but
 * leaves U+2028 and U+2029 as raw bytes in its output. A consumer that splits
 * on Unicode line terminators, or any JavaScript that evaluates the output as
 * source, sees two lines where the serializer wrote one.
 *
 * The escaping in scrub.ts already removes them from every attacker-influenced
 * field. This pass is the backstop that makes the guarantee structural rather
 * than dependent on every field having gone through the right schema.
 */

import { BUDGETS, type LogRecord } from './schema.ts'

const RAW_LINE_BREAKS = /[\u2028\u2029]/gu

const ESCAPES: Record<string, string> = {
  ['\u2028']: '\\u2028',
  ['\u2029']: '\\u2029',
}

/** Serialize one record to a single NDJSON line, without the trailing newline. */
export function toNdjson(record: LogRecord): string {
  const line = JSON.stringify(record).replace(RAW_LINE_BREAKS, (char) => ESCAPES[char] ?? '')

  if (Buffer.byteLength(line) <= BUDGETS.maxRecordBytes) return line

  // Over budget. Emit a marker rather than a truncated string that would no
  // longer parse as JSON.
  return JSON.stringify({
    ts: record.ts,
    sanitizerError: true,
    issueCount: 0,
    reason: 'record-too-large',
    bytes: Buffer.byteLength(line),
  })
}

/** True when a serialized line is safe to write to a line-oriented sink. */
export function isSingleLine(line: string): boolean {
  return !/[\r\n\u2028\u2029]/u.test(line)
}
