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
