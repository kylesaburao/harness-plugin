---
name: random-sampler
description: "Make explicitly random choices, pick random integers or samples, shuffle or randomly order items, roll dice, and flip coins using system cryptographic randomness. Not for reasoned recommendations, rankings, optimization, or plain selection without requested randomness."
---

# Random sampler

Define the complete sampling space before execution: candidates, exclusions, bounds,
and label mappings. Random selection does not establish semantic completeness.
Each original array position is a distinct outcome. Preserve duplicates:
`["A","A","B"]` gives A probability 2/3. Clarify accidental duplication only when
the intended distribution is unclear.

## Bundled path authority

Use the current host’s path for this loaded `SKILL.md`. Claude Code supplies this path through `${CLAUDE_SKILL_DIR}`. Expand any catalog root alias using its supplied mapping. Set `<SKILL_DIR>` to the absolute directory containing that exact file and retain it for this invocation. Replace `<SKILL_DIR>` in commands with that directory, keeping paths quoted. Resolve bundled scripts and skill-root resource paths from this directory. Resolve Markdown-relative links from the file containing the link, within the same installed skill instance. Preserve the caller’s working directory and existing input/output path semantics.

If the host-provided path is unavailable or a bundled file is missing, report the supplied skill path, attempted resource path, and actual failure. Other installations may be inspected for diagnosis, but use a replacement only when the host or user explicitly selects it. Do not infer the skill directory from conventional locations or select another copy by version, timestamp, or search order.

## Dispatch

Requires Node.js **22.0.0 or newer**, with built-in `node:crypto`. Execution is local,
with no npm dependencies, persistent state, files written, or network access.

Invoke the bundled `scripts/sample.mjs` directly. Dispatch the normal operation without
a separate probe. Reserve standalone `--preflight --json` for explicit readiness checks.

Serialize one complete JSON request through stdin, using a tool's direct stdin
facility or a quoted heredoc whose delimiter is absent from the serialized payload.
Never generate sampling code or interpolate candidate strings into shell code.
Replace `<SKILL_DIR>` as specified above:

```sh
node "<SKILL_DIR>/scripts/sample.mjs" --json <<'SAMPLER_REQUEST'
{"op":"choice","values":["heads","tails"]}
SAMPLER_REQUEST
```

| Operation | Request fields besides `op` | Result fields besides `op` |
| --- | --- | --- |
| `integer` | `min`, `maxExclusive` | `value` |
| `boolean` | None | Boolean `value` |
| `choice` | Nonempty `values` array | Original `index`, `value` |
| `sample` | `values` array, `count` | Ordered original `indices`, corresponding `values` |
| `shuffle` | `values` array | Permuted original `indices`, corresponding `values` |

Only these fields are accepted. Array entries may be arbitrary JSON values.
Integer endpoints must be safe integers with `0 < maxExclusive - min < 2^48`.
`sample` requires a safe integer count in `0..values.length` and draws without
replacement, preserving draw order. Full samples still randomize order. Empty
samples and empty shuffles are valid. Forced outcomes still check the runtime,
but draw no entropy.

Normalize inclusive 1–100 to `[1,101)`, and d20 to `[1,21)` with `integer`.
A coin uses `choice` over `["heads","tails"]`. Draws without replacement use
`sample`. Independent repeated rolls use separate invocations.

## Accept the result

Normal success is exactly one JSON object plus newline, always including `op`.
Accept the returned values and original indices exactly. Never remap, substitute,
reorder, or preference-reroll after selection. Another draw requires task semantics
or a user request. Do not silently replace the sampling space after the draw.

Use only the executable's system cryptographic randomness. Never use simulated
randomness, token variation, `Math.random()`, incidental timestamps or hashes, or
inference fallbacks. Do not claim direct hardware provenance. This skill does not
provide seeds, weighted sampling, floating-point sampling, or secret generation.

Exit 0 means success. Exit 2 means work never started because of CLI, input, or
runtime validation. Exit 1 means sampling failed after validation and preflight.
`--json` selects stderr diagnostics shaped as
`{"error":{"code":"...","condition":"...","remedy":"..."}}`.
Without it, stderr is `ERROR [code]: condition` followed by `Remedy: ...`.
Relay diagnostics verbatim and stop on failure. Never automatically retry or
independently replace the diagnosis. If Node cannot start, report the actual command
failure, not invented structured diagnostics or a random answer.
`--help` prints human-readable usage without reading stdin or drawing randomness.
