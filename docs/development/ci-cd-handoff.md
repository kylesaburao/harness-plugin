# CI/CD simplification and performance handoff

## Objective and baseline

Reduce CI/CD latency and maintenance overhead while retaining existing test coverage and publication guarantees.

- Worktree: `/Users/kyle/Documents/harness-plugin`
- Branch: `main`
- Baseline: `626e1f907b61b6b1a65c37e24e0d5c3ad0d03359`
- Initial reconciliation: exact baseline, clean worktree, macOS. Saved before implementation.

Read `AGENTS.md` and the [build](build.md), [testing](testing.md), [dependencies](dependencies.md), and [versioning](versioning.md) guides. Reconcile drift without discarding work. Development and PR checks test `.build/harness/`; publication tests newly generated `dist/harness/`. Testing committed distribution alone misses unpublished source changes.

Refer to [ci-cd-plan](ci-cd-plan.md) as the concrete implementation plan to follow.
This document itself serves as the ongoing work-log and handoff to maintain and update as work progresses; it is
the entry point in which Codex "/goal" is used to point the model across compactions.

The [latest successful release run inspected during planning](https://github.com/kylesaburao/harness-plugin/actions/runs/35402301978) supplied this baseline:

| Work | Observed duration |
| --- | ---: |
| Preliminary development test job | 207 seconds |
| Publication job, including distribution tests | 207 seconds |
| Development / distribution gates | 173.445 / 172.314 seconds |
| Distribution group within those gates | 170.996 / 169.853 seconds |
| Test setup | 17.551 / 15.466 seconds |
| Reference initialization | Approximately 10 seconds |
| Individual freshness checks | Approximately 0.45 seconds |

Both gates reported 590 passed, 60 platform skips, and GIF tests excluded. Group spans overlap and must not be summed. Removing preliminary release testing should eliminate approximately one three-minute gate per ordinary release; this is an estimate from that run, not a measured improvement. Publication fixtures are the next major bottleneck.

## Implementation contract

### Conditional main-branch gate

Retain workflow/job identifiers and the read-only `test` and write-enabled `bump` jobs in `.github/workflows/bump-version.yml`. After the event-range source-policy check, use a small inline Node step calling existing `inspectPublication` with `head: 'HEAD'`, current run ID/workflow SHA, and explicit manual level for dispatch (otherwise `null`). Output `test_candidate` via `GITHUB_OUTPUT`: `no eligible changes` maps to `true`; `ready` and validated `already published` map to `false`. Errors and unknown dispositions fail closed. Do not introduce another CLI or duplicate eligibility rules.

Condition Python setup, root installation, candidate build, test setup, and candidate gate on `test_candidate == 'true'`. Preserve tracked-checkout integrity checks. Preserve pinned PR integration testing. Ordinary non-release main pushes get one development gate; eligible automatic or manual publication gets only the publisher's exact-version distribution gate. Previously published reruns deduplicate on current main without rebuilding. Genuine publication races rebuild and retest.

Keep `bump` dependent on successful `test`, including its inexpensive fresh-main inspection after a non-release gate: newer unpublished source may intentionally require an additional distribution gate. Preliminary classification is not publication authority. Preserve workflow compatibility, bounded retries, freshness, working-tree/index/bytes/modes/tested-inventory/committed-tree validation, timestamps, and ordinary-push verification. Summaries must distinguish source-policy success from full gate completion. Reconfirm required-check configuration before changing check semantics.

### Publication fixture split

Extract common test-only fixture code into a helper whose name does not end in `.test.js`. Use existing process-isolated runner concurrency, without nested concurrency, a matrix, or a runner rewrite. Each process owns its seed; each scenario owns clones, bare remote, controls, logs, and cleanup. Shared compiler installation stays read-only.

| File under `tests/distribution/` | Existing scenarios |
| --- | --- |
| `publication.test.js` | Successful race/rerun; no eligible range; raced workflow change |
| `publication-recovery.test.js` | Accepted push with transport error; uncertain inspection/rerun; three-race exhaustion; rejection without advancement |
| `publication-policy.test.js` | Manual increments; invalid submitted metadata; second-parent release history; stale workflow/invalid context |
| `publication-integrity.test.js` | Post-staging mutation; failed raced gate; every publication-stage failure; unexpected source mutation |

Preserve all fifteen scenarios and every failure-matrix branch, actual workflow shell, real compilation/Git validation/commits/local pushes. Controlled setup/gate probes do not establish runtime coverage.

### PR cancellation and documentation

Add workflow-level concurrency to `.github/workflows/verify.yml`, grouped by workflow and PR number with `cancel-in-progress: true`. Preserve publication `version-bump`, `cancel-in-progress: false`, and `queue: max`. See [GitHub concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency) and [Node test runner](https://nodejs.org/api/test.html).

Update orchestration tests and development guides for conditional candidate testing, exact-distribution publication testing, and concurrent fixtures. Replace old unconditional-layout assertions with routing, permissions, ordering, and observable-outcome contracts. Update affected incoming references. No runtime API, artifact target, dependency, canonical version, or tracked distribution change is needed.

## Validation and acceptance

Routing coverage must include eligible source; non-release docs/tests/tooling; docs catching up unpublished source; manual patch/minor/major with no automatic changes; invalid history before installation; selection errors/unknown dispositions; original event still eligible after its run published; queued eligible event already published; main advancing between classification and publication, including after a non-release gate. Retain race/mutation/staging/manual/uncertain-push/idempotency coverage and all fifteen scenarios/failure branches.

On macOS from the repository root:

```sh
npm ci --include=dev
npm run build
node scripts/setup-tests.js
node --test tests/bump-version/*.test.js tests/distribution/*.test.js tests/run-tests/*.test.js
node scripts/setup-tests.js
node scripts/run-tests.js
git diff --check
```

Use documented container equivalents on Linux/WSL2. Report actual platform skips and exclusions. Measure three baseline and three changed hosted-style gates on the same machine/toolchain, repeating setup before each. Compare median full-gate duration, scenario coverage, and failures. Retain the split only with improved median and no coverage loss or instability; otherwise restore original organization and document the limitation.

Acceptance: one distribution gate for ordinary non-racing releases; one development gate for ordinary non-release main pushes; unchanged integrity/races; complete coverage; no implementation edits to `dist/` or canonical package; performance evidence separates measurement from estimates. Inspect a resulting hosted run after an otherwise authorized push/merge, but do not publish or dispatch solely for benchmarking.

## Defaults and deferred work

Retain non-release main testing and PR checks. Defer dependency/reference caching (npm approximately one second, reference initialization approximately ten seconds). Retain subsecond freshness/release checks. No path-filtered testing, shallow history, cross-job artifact promotion, new coordinator, action upgrades, or expanded hosted media/platform coverage. Preserve `.venv` cleanup and full-history eligibility.

Planning inspected repository/history/hosted logs and four real policy states (eligible original event, published main, fresh no-change request, manual without changes); all had expected dispositions. Planning ran no implementation/full local gate. Harness Advisor reviewed executor-supplied evidence without independent inspection or reproduced tests.

## Execution continuity

If paused, stop starting new work and settle task-owned processes to a safe boundary. Preserve staged/unstaged/untracked work; do not reset, stash, stage, commit, or push for handoff. Inspect the active skill catalogue for durable continuation support; if none usable, disclose this and update this file manually after reading it. Record absolute worktree, branch/HEAD, changes, completed/partial work, decisions, commands/results/failures, outstanding work, live processes, and exact next action. Read back and verify references. State whether the same worktree or transfer of uncommitted files is required. Supply an exact resume prompt naming worktree and this file, requiring drift reconciliation and checks for live writers. If saving fails, report incomplete delivery.

## Execution record

Implementation and measurements pending.
