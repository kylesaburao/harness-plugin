# random-sampler qualification

Verified on macOS on 2026-09-13 with Node.js 26.5.0, Codex CLI 0.154.0,
and Claude Code 2.1.270. Live samples are execution evidence, not a deterministic
routing guarantee. No production routing changes were made to force these results.

## Deterministic verification

- `node --test tests/random-sampler/*.test.js`: 12 passed, zero failed or skipped.
  [Focused output](evidence/focused-tests.txt).
- `node --test tests/inventory/*.test.js tests/shared-node/*.test.js`: 16 passed,
  zero failed or skipped.
- `python3 /Users/kyle/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/harness/skills/random-sampler`:
  exit 0, `Skill is valid!`.
- `node scripts/setup-tests.js` followed by `node scripts/run-tests.js`, with host
  access: 643 passed, zero failed or skipped. [Full gate](evidence/repository-gate.txt).
- The initial sandboxed gate failed in three existing native HEIC encoder tests.
  All three passed with host access, without media-code changes.
  [Sandbox output](evidence/sandbox-gate.txt).
- `git diff --check`: passed.
- [Direct execution records](evidence/direct.json) retain help, JSON preflight,
  choice, integer, sample, and shuffle invocations, requests, statuses, and outputs.
  All six exited 0. Random outcomes were checked against schemas and index/range
  invariants, not a particular selected result.

The integer width restriction follows the [Node 22 randomInt contract](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptorandomintmin-max-callback).
The original Node version boundary check used a test-only preload. After review,
both numeric regression tests also passed on an actual official Node.js 22.0.0
binary using `/private/tmp/node-v22.0.0-darwin-arm64/bin/node --test --test-name-pattern='candidate numeric|operation numeric' tests/random-sampler/sample.test.js`.
[Node 22 output](evidence/node22-numeric-tests.txt) reports two passed tests and
eight unselected tests, not a full-suite Node 22 pass. Fault injection also covers
unavailable crypto imports, non-callable and throwing randomInt, stdin failures,
and entropy counts. [Direct numeric results](evidence/numeric-direct.json) preserve
overflow, unsafe integer, and nested underflow candidates exactly.

## Isolation and live evidence

[Compact live records](evidence/live-cases.json) preserve each prompt, response,
completed CLI commands, returned JSON, status, and observed model. These live
sessions predate the numeric-preservation review fix and were not rerun afterward.
Successful
SKILL.md read output is omitted. Tests used fresh sessions for every prompt.

A disposable local marketplace copied the shared plugin tree. Codex installed
`harness@sampler-qualification` in a temporary CODEX_HOME. Only its existing auth
file was copied, with mode 0600. Personal configuration, plugin installations, and
capability-injected instructions were not changed. Temporary authentication was
removed after qualification. Claude used a temporary CLAUDE_CONFIG_DIR, the copied
plugin via `--plugin-dir`, and `--setting-sources ''`.

Codex's final positive runs used workspace-write in the disposable workspace,
with host access for the parent CLI. Negative runs used read-only. Both used the
host's default model, as recorded in the evidence.

| Codex prompt | Implicit skill selection and instruction read | Actual script execution | Returned result used |
| --- | --- | --- | --- |
| Random color from red, green, blue | Passed | choice, index 0, red | Red |
| Integer 1–10 inclusive | Passed | integer, bounds [1,11), value 7 | 7 |
| Shuffle A–D | Passed | shuffle, indices [1,2,3,0] | B, C, D, A |
| Coin flip | Passed | choice, index 1, tails | Tails |
| d20 | Passed | integer, bounds [1,21), value 4 | 4 |
| Draw two names without replacement | Passed | sample, indices [1,0] | Ben, Ada |

Each final positive session executed the bundled sample.mjs once and preserved
its result. All four negative prompts (best error-state color, safest database,
ranking candidates, implementation most likely to pass review) answered by
reasoning, without selecting, reading, or executing random-sampler. No routing
ambiguity appeared in this small successful set.

## Failed attempts and coverage gaps

The initial nested-sandbox Codex color session selected the skill but reported
that its shell was blocked, then announced a pseudorandom fallback and answered
Blue. No successful skill read or sampler execution was observed. This is a failed
live attempt, not cryptographic selection evidence.

With parent host access and a read-only child sandbox, all six positive prompts
read the skill but reported that zsh could not create a heredoc temporary file.
They stopped without returning random answers. Workspace-write resolved that
execution constraint. These retries qualified the environment, not a preferred
random outcome. The production instructions were unchanged.

Claude's personal profile reported authenticated status, but its disposable
profile could not authenticate. Its startup event listed `harness:random-sampler`
and the copied plugin, establishing capability visibility only. The first color
prompt returned `Not logged in · Please run /login` without model execution.
The remaining nine prompts were skipped for that unavailable profile. Claude
implicit loading, actual script execution, result usage, and negative routing
remain unqualified. Personal authentication or plugin configuration was not
modified to bypass this limitation.

## Review-fix loop

- Round 1, independent Astra high reviewer: zero Major, one Minor. R1 identified
  numeric candidate corruption through ordinary JSON parsing and serialization.
  The primary reproduced overflow becoming null, integer precision loss, and
  nested underflow becoming zero.
- A separate fixer preserved numeric tokens with Node 22 raw JSON APIs and
  validated exact integer argument meanings before conversion. Two regression
  tests cover candidate preservation and bounds/count rounding, with an older
  runtime fixture preserving unsupported-version diagnostics.
- Round 2, fresh independent Astra high reviewer: **no Major and no Minor findings**
  on the cumulative implementation and R1 fix. Reviewers received source and
  verification evidence under a no-tools, no-changes contract. The fixer and
  primary executed the tests.
- Final native gate: **643 passed, zero failed or skipped**. Manifests and installer
  files remain unchanged. The user authorized commit and push after this loop.
