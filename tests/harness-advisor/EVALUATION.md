# Advisor evaluation, 2026-09-14

## Current implementation and scope

HEAD is `d6bc9c31db7588b89eaa5eed3ed916bf36b7745e` (version 3.1.7).
The starting worktree and index were clean and matched the handoff baseline.
Delivery changes only Advisor source/contracts, its tests and qualification,
related human/dependency documentation, and regenerated Advisor distribution.
Routing/configuration implementation and activation templates are unchanged.
No commits, pushes, version bumps, installed-cache changes, user routing changes,
credential changes, or live consultations were performed.

The Claude workspace branch selects documented restricted file tools and parses
successful host Read metadata separately from discovery, failures, missing
metadata, review coverage, and enforcement. Evidence-only omission is retained.
Codex's actual ordinary spawn schema supplies no per-child permission controls,
so its current route remains evidence-only. No role or alternate adapter was added.
Independent Git observation is unavailable on these routes. Primary-captured
changed-path inventories and state comparisons remain supplied evidence.

## Current verification

- Passed: `npm ci --include=dev` and `npm run build`.
- Passed baseline: `node --test tests/harness-advisor/*.test.js tests/inventory/*.test.js`, 29/29.
- The handoff command including `tests/install-harness-plugin-capabilities/*.test.js`
  could not expand because that directory now contains qualification documentation
  only. Native precedence is covered by retained Advisor policy tests, and installed
  artifact behavior by the full distribution suite. No missing suite was called passed.
- Passed final focused tests: the same focused command, 36/36.
- Passed: `node tests/harness-advisor/qualification-fixture.js`, with its generated
  Git status checked for staged main, unstaged dependency, and untracked source.
- Passed: setup with `HOME="$PWD/tmp/advisor-validation/home" node scripts/setup-tests.js`.
  Initialization data stayed in the task's temporary home. Setup initially rejected
  stale distribution after a source edit, then passed after the required build.
- First full sandbox gate: 694 passed, 3 failed, 0 skipped. All three failures were
  native HEIC `nilError` cases documented in the testing guide.
- Passed with host access: `node --test --test-name-pattern='native .*HEIC10' tests/extract-video-frames/lifecycle.test.js`, 3/3.
- Passed final full host gate: `HOME="$PWD/tmp/advisor-validation/home" node scripts/run-tests.js`, 699 passed, 0 failed, 0 skipped, no excluded groups.
- Passed: `npm run build:check` and `git diff --check`.
- Passed against the intended staged delivery: `node scripts/validate-dist.js --tracked`, 87 files.
- Passed: `git diff --cached --check`. All 17 intended files are staged, with no unstaged changes. HEAD remains the baseline above.

Raw command logs are executor artifacts under `tmp/advisor-validation/`, not shipped
plugin data or persisted Advisor transcripts. Tests use synthetic hosts and temporary
homes. Deterministic tests establish parsing, arguments, cleanup, error propagation,
configuration behavior, and policy declarations, not host enforcement or model adherence.

## Host evidence and limits

Checked `claude --version` and `claude --help`: local Claude Code 2.1.270 exposes
restricted and safe mode. The actual built adapter's workspace `--preflight --json`
passed and explicitly returned `runtime_controls: "unverified"`. Version/preflight
success establishes neither authentication nor enforcement of the invocation.

Official sources consulted on 2026-09-14:

- [Claude CLI controls](https://code.claude.com/docs/en/cli-reference), restricted
  mode, safe mode, explicit tools, working-directory scope, managed-policy limits.
- [Claude permissions](https://code.claude.com/docs/en/permissions).
- [Structured CLI output](https://code.claude.com/docs/en/headless).
- [SDK message and tool output schemas](https://code.claude.com/docs/en/agent-sdk/typescript),
  fetched as Markdown, including SDKAssistantMessage, SDKUserMessage.tool_use_result,
  FileReadOutput, GlobOutput, and GrepOutput. No source-text event parsing is used.
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents),
  considered alongside the actual active collaboration.spawn_agent schema.

Skipped: live Claude inference, model/effort enforcement, read-scope/escape denial,
mutation/tool denial, and automatic-instruction isolation qualification. No paid
consultation was authorized. No authentication change or permissive retry occurred.
Skipped: live behavioral evaluation of the 15 cases. Their reproducible inputs,
expected observations, and separate grading dimensions are in
[QUALIFICATION.md](QUALIFICATION.md), with a runnable synthetic fixture generator.
Codex inspection is unavailable on the observed spawn surface. Neither fixtures,
help, nor primary reports are relabeled as live enforcement evidence.

## Acceptance mapping

| Handoff sections | Delivered evidence |
| --- | --- |
| 1, 4, 9 | Shared contract and SKILL distinguish sourced records, supplied claims, observed state, approvals, gaps, and scoped outcomes. Adapter reports requested tools separately from observation metadata. |
| 2, 3 | Baseline above, unchanged configuration/activation implementation, retained configuration/accounting/native tests, policy version 2, no commits or global changes. |
| 5 | Volatile target includes dirty work, inventory, baseline, exclusions, writer pause, content comparison and mixed-state invalidation. Git capture remains supplied. |
| 6 | Contract requires proportional dependency discovery beyond supplied paths and forbids Advisor runtime execution. Unresolved premises narrow conclusions. |
| 7, 8 | Claude workspace validation, restrictive args/settings, canonical system prompt, fresh empty cwd, one attempt, successful event correlation, bounded transport and cleanup. Codex explicitly degrades. |
| 10 | Source and generated Advisor tree, tests, human/dependency guide, and qualification updated. Installer references inspected, no contradictory unconditional tool prohibition remained. |
| 11 | Fake-host positive/negative events, missing/partial metadata, malformed streams, mismatched IDs/sessions, source-text spoofing, no-use, cleanup and compatibility tests. Runnable host procedure and 15 behavioral cases, live runs skipped as above. |
| 12, 13 | Build, focused tests, setup, full gate, distribution/index validation, and final scope audit recorded here. |

The following September 13 record is historical. Its counts and live-access
statements are not current implementation results.

---

# Advisor evaluation, 2026-09-13

This is repository-only implementation evidence, not part of the installed plugin.

## Implementation checks

- Passed: all three changed executables pass `node --check`.
- Passed: `node --test tests/harness-advisor/*.test.js tests/install-harness-plugin-capabilities/*.test.js tests/inventory/*.test.js`, 32/32 tests.
- Passed: both changed Skills pass the skill-creator `quick_validate.py` validator.
- Passed: `node scripts/run-tests.js` with host media-service access, 633 passed,
  0 failed, 0 skipped.
- Passed: `git diff --check`.

The initial sandboxed full gate reported 630 passed and three native HEIC failures
with Core Image `nilError`. The same three tests reproduced in isolation. The
full gate then passed with host media-service access, including all 132 frame
tests. No frame-extraction code was changed.

The independent fake Claude CLI accepts a supported option omitted from help,
rejects a genuinely unsupported option, and simulates authentication and model
failures. Assertions cover exact canonical contract transmission, empty setting
sources, stdin task content, an empty fresh working directory and its cleanup,
native-absence attestation, all retained restrictive arguments, no success report
on failure, and exactly one inference attempt. Missing/empty contracts and a
missing CLI fail before inference. These fixtures establish adapter behavior,
not Claude runtime enforcement.

Installer tests run with neither CLI on PATH and cover one-file publication,
no-write preflight, block convergence, unrelated bytes/settings and file modes,
no-op modification times, preserved legacy roles, malformed markers, and Codex
override-file conflicts. Configuration tests retain deterministic independent
writer contention, lock-free reads/preflight, interrupted-lock recovery, no-op
preservation, and publication/cleanup diagnostics.

## Context policy walkthroughs

These are checks against the written policy, not live-agent adherence measurements.
The policy assertions in `policy.test.js` preserve these rules.

| Scenario | Policy check |
| --- | --- |
| Relevant evidence exceeds retired thresholds | Passed: retain it when actual capacity allows. |
| Short ledger contains obsolete assumptions | Passed: compact and correct it despite its small size. |
| Necessary evidence exceeds an actual limit | Passed: report the limitation and material omissions. |
| Telemetry is unavailable | Passed: do not invent a universal ceiling. |
| Compaction follows exhausted automatic calls | Passed: preserve counters and prohibit another automatic call. |

Explicit requirements, necessary evidence, unresolved contradictions, accepted
decisions, useful failures, and accurate stable serialization remain relevant
carryover. Automatic and user call accounting remain separate. Compaction does
not reset same-family restrictions or failed-attempt accounting. Native Claude
availability still suppresses Harness fallback, including after native errors.

## Historical evidence and live limits

The user-supplied implementation handoff reports that a Codex Astra/high Advisor
reviewed the approach and accepted the correction for Claude default-agent
isolation. This records the prior approach review, not a new review of the final
implementation or proof of runtime enforcement.

The handoff also reports previous Claude startup observations. Those observations
are bounded startup evidence only and establish neither authentication nor
successful inference. No additional startup details or enforcement results are
inferred from them.

Claude CLI is installed but not logged in, a known user-supplied constraint.
No live Claude prompt, login, credential change, or permissive retry was attempted
during this implementation.

- Skipped: Claude is not logged in, successful Claude inference.
- Skipped: Claude is not logged in, actual model/effort enforcement.
- Skipped: Claude is not logged in, full runtime qualification.

The final Codex instructions use ordinary fresh subagents with explicit
model/effort and the canonical no-tools contract. Written instructions are not
enforced child permissions. Additional controls apply only when available.
Claude settings isolation excludes saved user/project/local settings, including
authentication helpers that depend on them. Such configurations need separate
qualification, and managed policy remains authoritative.

No commits, pushes, version edits, global installation, legacy-role deletion,
or caching benchmark are part of this evaluation.
