# zod-based request log sanitization

A proof of concept for sanitizing Express request properties before they reach a log sink, with zod carrying the policy.

Run it:

```sh
npm install
npm run typecheck   # tsc --noEmit, so the inferred types are actually verified
npm test            # 59 tests, node:test, no framework
npm run attack      # fires the hostile corpus at a live server, prints both views
npm run demo        # long-lived server on :3000 if you want to poke at it
```

Node 22.18 or newer. `.nvmrc` pins 24. There is no build step: Node strips the TypeScript types natively, so `node src/demo.ts` and `node --test tests/*.test.ts` run the sources directly.

## What it does

Given `GET /search?q=cats%0d%0a2026-08-22T00:00:00Z INFO admin login succeeded` with a bearer token in the Authorization header, a typical logger writes this, and the CRLF splits it into two entries the moment it lands:

```
2026-08-22T04:26:38.412Z GET /search?q=cats%0d%0a... ua="curl/8.4" auth="Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig" query={"q":"cats
2026-08-22T00:00:00Z INFO admin login succeeded"}
```

The middleware here writes this instead, one object on one line:

```json
{"ts":"2026-08-22T04:26:38.412Z","method":"GET","path":"/search","query":{"values":{"q":"cats\\r\\n2026-08-22T00:00:00Z INFO admin login succeeded"},"droppedCount":0,"redactedCount":0,"truncated":false},"params":{"values":{},"droppedCount":0,"redactedCount":0,"truncated":false},"headers":{"values":{"host":"127.0.0.1:40321","user-agent":"curl/8.4","authorization":"[redacted] sha256:a29cefc7959bd7b8","accept":"*/*","accept-language":"*","accept-encoding":"gzip, deflate"},"droppedCount":2,"redactedCount":1,"truncated":false},"client":{"ipPrefix":"127.0.0.0/24","ipId":"sha256:a2a0c0af41b4bc07","userAgent":"curl/8.4","viaTrustedProxy":false},"outcome":null,"sanitizer":{"version":1,"redactions":1,"truncated":false}}
```

The JSON above is verbatim output from the demo server, not an illustration. The first block is the same request's naive line with its escape sequences rendered the way a plain-text sink writes them. The forged entry is still there as evidence, escaped rather than deleted. The bearer token is gone, but two requests carrying the same token still correlate through the fingerprint. The client IP is coarsened and pseudonymized. Two headers nobody allowlisted were dropped, and the count says so.

## Why zod rather than a sanitize function

Two things the schema buys that a plain function does not.

**The top-level record shape is a fail-closed allowlist.** `z.object` strips unknown keys by default, so a field nobody declared cannot reach the sink. Attach `req.user`, `req.rawBody` or `req.session` to the request and none of it appears, because there is no key for it. That is the opposite posture from `pino`'s `redact` option, which is a denylist of static paths: it is case sensitive, and anything you forgot to name goes straight into the log. `tests/schema.test.ts` asserts the key set is fixed no matter what arrives.

**`z.infer` types the sink.** `logger.info(record)` does not typecheck if someone hands it a raw Express request, so the escape hatch that leaks everything is closed at compile time rather than by convention.

Open-ended maps (headers, query, params) cannot use a key-by-key `z.object` shape, so those go through the disposition tables in `src/policy.ts` and get validated on the way out with `z.record`. Being clear about which mechanism covers which surface matters: the strip behavior protects the record shape, the tables protect the maps.

## The layers

`src/scrub.ts` does string-level work. Control characters (C0, DEL, C1, which covers ESC and therefore every ANSI sequence) become printable escapes, U+2028 and U+2029 become escapes, then the value is capped. Escaping happens before truncation, so the budget stays honest and a cut can never leave half an escape sequence behind.

`src/policy.ts` assigns one of four dispositions per key: `allow`, `redact` (marker plus a keyed fingerprint), `hash` (fingerprint only), `drop` (absent entirely). Headers default to `drop`. Query keys and route params default to `allow`, because an allowlist there would throw away the diagnostics people actually need, with `looksSecret()` covering the gap by value shape.

`src/identity.ts` treats the client IP as personal data. It emits a `/24` or `/48` prefix plus an HMAC-SHA256 pseudonym. HMAC rather than a bare digest, because the IPv4 space is 2^32 and a plain SHA-256 of an address is a lookup table away from being reversed.

`src/serialize.ts` emits NDJSON with a second escape pass for U+2028 and U+2029, and replaces any record over 8 KiB with a marker rather than truncating it into invalid JSON.

`src/schema.ts` assembles all of it. Every field carries `.catch()`, the top-level call is `safeParse`, and on failure the record is `{ts, sanitizerError: true, issueCount}` with nothing derived from the request in it.

## Requirements this implements

| Requirement | Source | Where |
|---|---|---|
| "Perform sanitization on all event data to prevent log injection attacks e.g. carriage return (CR), line feed (LF) and delimiter characters" | [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) | `escapeControls`, `escapeLineSeparators` |
| "Encode data correctly for the output (logged) format" | OWASP Logging Cheat Sheet | `toNdjson` |
| "limit the size of the user input value used to create the log message" | OWASP Logging Cheat Sheet | `truncate`, `LIMITS`, `BUDGETS` |
| Never log "Session identification values", "Access tokens", "Authentication passwords", "Encryption keys and other primary secrets" | OWASP Logging Cheat Sheet | `HEADER_POLICY`, `SENSITIVE_PARAM_KEYS`, `looksSecret` |
| "Sensitive personal data and some forms of personally identifiable information (PII)", with de-identification for the rest | OWASP Logging Cheat Sheet | `src/identity.ts` |
| 16.4.1 "Verify that all logging components appropriately encode data to prevent log injection" | [ASVS 5.0 V16](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md) | `scrub`, `toNdjson` |
| 16.2.5 sensitive data logged according to its protection level, session tokens "only be captured through hashing or masking" | ASVS 5.0 V16 | `fingerprint` |
| 16.2.1 "necessary metadata (such as when, where, who, what)" | ASVS 5.0 V16 | the record shape |
| 16.2.2 timestamps "use UTC or include an explicit time zone offset" | ASVS 5.0 V16 | `ts` as `z.iso.datetime()` |
| 16.5.3 fail securely, no fail-open past a validation failure | ASVS 5.0 V16 | `.catch()` per field, `safeParse` at the top, try/catch around the sink |
| CWE-117: "If the log is displayed as a plain text file, then new line characters can be used by a malicious user" | [CodeQL js/log-injection](https://codeql.github.com/codeql-query-help/javascript/js-log-injection/) | the whole thing |

## Three things the research changed

**Headers are the least likely CRLF vector, not the most.** Node's HTTP parser already rejects CR, LF and other control characters in header values, erroring on anything outside HTAB, SP, VCHAR and OBS_TEXT unless a lenient flag is set ([llhttp](https://github.com/nodejs/llhttp)). The live vector is the query string and route params, which Express decodes with `decodeURIComponent` and `qs` ([Express 5 request API](https://expressjs.com/en/5x/api/request/)), so `?q=a%0d%0aFAKE` becomes a real CRLF in a JavaScript string before any logger sees it. Headers are still sanitized here, because a lenient parser or a non-Node upstream can put anything in that map, but the demo's forging payloads ride in on the query string.

**`JSON.stringify` does not escape U+2028 or U+2029.** So "log JSON instead of text" is not on its own an answer to log injection, when the consumer splits on Unicode line terminators. `tests/scrub.test.ts` asserts this platform behavior directly, so the day it changes the backstop can be reconsidered rather than assumed.

**Node caps the request line plus headers at 16 KiB.** The original oversized-value payload was 16384 characters of query string, and the server answered 431 with an empty body before Express ever ran, which crashed the attack script rather than exercising truncation. That is a real defense worth knowing about, and it is also not a substitute for the per-field budget. Measured against this demo server: 16000 characters returns 200 and reaches the logger, 16384 returns 431.

## Where it gives up

`looksSecret()` is a heuristic and it is honest about being one. It catches JWTs, vendor-prefixed keys, bearer values, hex digests, and high-entropy runs that mix character classes. It does not catch a short opaque token with no prefix, because `abc123def456` is indistinguishable from an ordinary identifier. The key allowlist is what covers that case, and anything genuinely sensitive should be on it. In the other direction, an early version flagged `the-quick-brown-fox-jumps-over-the-lazy-dog`, which scores about 3.9 bits per character, higher than plenty of real API keys. Requiring character-class mixing fixed that, and a test pins it.

The fingerprint key is random per process, so values correlate within a process lifetime and cannot be linked across restarts. That is a deliberate default for a POC and a decision a real deployment has to make on purpose, with a rotation window and the key in a secret manager.

The body and cookies are out of scope. Cookies are already covered as a redacted header, but a parsed `req.cookies` map would need the same treatment as query params.

There is no benchmark. Every attacker-influenced string goes through two regex passes and a cap, and `fast-redact` (what `pino` compiles) is around 2% over `JSON.stringify` for static paths and 25-55% with wildcards, so this is not free. Whether it matters depends on request volume, and measuring it is the obvious next step.
