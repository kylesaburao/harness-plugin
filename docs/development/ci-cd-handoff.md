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

### Reconciliation and implementation, 2026-09-20

- Worktree: `/home/kyle/harness-plugin`, Linux development container, branch `main`, HEAD `c50866c4e2571c4792062edea8633c5baca71ecc`. Initially clean. The only drift from the planning baseline was the two planning documents (`5293743`, `c50866c`); no implementation was present.
- GitHub read-only checks: `gh api repos/kylesaburao/harness-plugin/branches/main/protection` returned `Branch not protected` (404); `gh api repos/kylesaburao/harness-plugin/rules/branches/main` returned `[]`. No required checks need migration. The sandbox initially could not reach Docker/GitHub; authorized access succeeded, without configuration changes.
- Read the required build, testing, dependency, versioning, and container guides, plus the current GitHub concurrency and Node test-runner documentation. Harness Advisor supplied the final source review recorded below.
- Installed the locked root toolchain and built `.build/harness/` using `./scripts/dev exec`. Container versions: Node 26.8.2, npm 11.19.1. The existing runner selected four Node workers.
- Prepared changes outside the checkout while measuring the unmodified baseline, then applied conditional main-job routing, candidate/publication summaries, PR cancellation, the four-file publication split with a process-local fixture helper, routing coverage, and development-guide updates. Production policy and runner code are unchanged. Setup and gate probes in publication fixtures remain controlled; compilation and Git operations remain real.

### Baseline measurements

Each trial ran `node scripts/setup-tests.js`, then `node scripts/run-tests.js --skip-gif`, sequentially in the same development container. Gate timing includes prerequisites and scheduling, excludes setup and container startup, and does not sum overlapping group spans.

| Trial | Full hosted-style gate | Distribution group | Outcome |
| --- | ---: | ---: | --- |
| Baseline 1 | 140.434 s | 138.429 s | 590 passed, 60 platform skips, 0 failures |
| Baseline 2 | 147.574 s | 145.293 s | 590 passed, 60 platform skips, 0 failures |
| Baseline 3 | 149.404 s | 147.047 s | 590 passed, 60 platform skips, 0 failures |

Median baseline gate: **147.574 s**. All trials excluded GIF tests/preflights and do not establish native macOS coverage. Local raw logs are retained under `.build/ci-cd-evidence/baseline-{1,2,3}.log`, with separate setup logs. These ignored logs require this worktree or explicit transfer; the measurements above are durable.

### Changed measurements and fixture decision

The same container/toolchain and four-worker pool ran three changed hosted-style gates, each after setup:

| Trial | Full hosted-style gate | Distribution group | Outcome |
| --- | ---: | ---: | --- |
| Split candidate 1 | 164.924 s | 162.782 s | 599 passed, 60 platform skips, 0 failures |
| Split candidate 2 | 169.794 s | 167.419 s | 599 passed, 60 platform skips, 0 failures |
| Split candidate 3 | 170.794 s | 168.279 s | 599 passed, 60 platform skips, 0 failures |

Median changed gate: **169.794 s**, 22.220 s above the baseline median. Nine new tests account for the increase from 590 to 599 passes; no original scenario was removed. This whole-change comparison includes the additional routing coverage and is not an isolated estimate of the split's cost. It does not demonstrate the required improved median, so the specified fallback was applied: all fifteen original publication scenarios are again together in `publication.test.js`. The common helper remains extracted for reuse by routing tests. No runner changes, nested concurrency, or matrix were introduced. The three split-only scenario files were removed.

All fifteen original scenario bodies were compared against HEAD and retained verbatim, including all five build/setup/test/check/commit failure branches. The shared helper still gives every process its own seed, every scenario its own clones/remote/control/log/cleanup, and only read-only access to the shared compiler installation.

Raw changed/setup logs are in `.build/ci-cd-evidence/changed-{1,2,3}.log` and `changed-setup-{1,2,3}.log`. All six timing trials excluded GIF tests/preflights and report Linux platform skips. The planning estimate of eliminating a preliminary hosted release gate remains an estimate; no new hosted release duration was measured.

### Verification and next action

- Focused verification after setup: `./scripts/dev exec sh -c 'node --test tests/bump-version/*.test.js tests/distribution/*.test.js tests/run-tests/*.test.js'` passed **109 tests**, with no failures/skips (`focused.log`).
- Complete local gate after setup, before reverting the scenario split: `./scripts/dev exec node scripts/run-tests.js` passed **730 tests**, with **60 platform skips**, no failures, and no excluded groups (`full.log`). Both GIF backends/preflights ran; native macOS execution remains unavailable on Linux.
- The first full gate after restoring the grouping finished with **728 passed, 2 failed, 60 skipped** (`final-full.log`). All CI/publication checks passed. Unchanged GIF tests failed while reading a work directory concurrently removed by cleanup and while asserting that a signaled process PID was gone. An unchanged focused retry of the three relevant cache/preflight cases passed (`gif-recheck.log`); this retry alone did not resolve the timing weaknesses.
- Fixed the two existing GIF test fixtures without changing runtime code or their behavioral assertions: tolerate only `ENOENT` between the parent and work-directory listings while still requiring all five caches, successful conversion, and cleanup; write the probe parent's PID before spawning its child and atomically publish the child's readiness/PID file before signaling. The latter prevents an interrupted empty PID write from being interpreted as PID 0. The original process failure did not retain the PID contents, so that cause is a supported race diagnosis, not an independently captured failing PID value. These small post-review test repairs are outside the Advisor's inspected snapshot.
- Final verification: both repaired GIF test files passed **33 tests**, with no failures/skips (`gif-fixed-focused.log`). After fresh setup, the complete gate on the final restored arrangement passed **730 tests**, with **60 platform skips**, **0 failures**, and **no excluded groups**, in **200.439 s** (`final-fixed-full.log`). All 131 GIF tests and both converter preflights ran. This full-gate duration includes GIF coverage and is not comparable to the hosted-style timing table.
- All task-owned test commands and the Advisor consultation have exited. Implementation is complete locally, with changes intentionally left unstaged and uncommitted. No pushes, release dispatches, or protected-file edits were performed. Hosted inspection remains conditional on a later otherwise-authorized push/merge; none was triggered solely for this benchmark.

### Advisor review and invariants

One fresh Harness Advisor consultation requested `gpt-6-astra` at `high` effort, using the resolved Codex/Astra built-in `fresh-review` route. The host has no Node executable, so the exact loaded helper's bytes were evaluated with container Node; both host configuration absence and the helper's built-in result were checked. No routing preference was changed. Task-local accounting: epoch 1, `automatic_calls=1`, `user_requested_calls=0`, `same_family_automatic_calls=1`, reason `FINAL_REVIEW` after implementation and primary testing.

The Advisor reported inspection of the workflows, policy imports/functions, changed tests/helpers, handoff/plan, and guides, with no concrete correctness defect established. Its recommendations were to test the restored arrangement and replace stale progress statements in this record. Inspection was instruction-bound through inherited tools, not an independently enforced read-only sandbox; execution results and required-check configuration remained primary-supplied. The primary verified unchanged HEAD and SHA-256 content hashes for all twelve changed/untracked files before and after review. This is content-stability evidence, not proof against all possible external writers.

Primary comparisons independently verified that the publisher job is byte-identical to HEAD apart from the three completed-gate accounting lines, the PR workflow differs only by concurrency, and all fifteen original scenario bodies remain verbatim. Source-policy, release-policy, builder, runner, dependency manifests, runtime source, canonical version, and tracked distribution are unchanged.

### Completion audit

| Requirement | Current evidence |
| --- | --- |
| Conditional candidate selection, fail-closed errors/unknown results, permissions, ordering, and unchanged check identifiers | [Workflow contracts](../../tests/run-tests/workflow.test.js), [transaction ordering](../../tests/run-tests/run-tests.test.js), and inspected workflow diff; final gate passed. |
| Eligible source, non-release docs/tests/tooling, unpublished-source catch-up, manual patch/minor/major, invalid history before installation, old-event reruns, queued published events, and advancement after both selection paths | Six [routing scenarios](../../tests/distribution/routing.test.js) execute workflow shell against real local Git histories; final gate passed. Gate probes establish routing counts, not runtime coverage. |
| Publication transaction, races, uncertain pushes, staging/mutation protections, timestamps, and idempotency | Fifteen original [publication scenarios](../../tests/distribution/publication.test.js) remain verbatim, including every failure-matrix branch; all passed alongside release-policy/build tests. Publisher implementation is unchanged except reporting. |
| Fixture ownership and performance fallback | [Shared fixture](../../tests/distribution/publication-fixture.js) owns process/scenario state as required. Three baseline and three split-candidate gates completed without failure; the non-improving median triggered restoration of the original scenario grouping. |
| PR cancellation and pinned integration testing | PR workflow differs only by workflow/PR concurrency. Publication `version-bump`, `cancel-in-progress: false`, `queue: max`, read/write job boundaries, and unconditional fresh-main inspection remain intact. Required-check configuration was reconfirmed before edits. |
| Documentation, implementation scope, and verification | Build/testing/versioning guides and this handoff describe final behavior and measurement limits. Locked toolchain installation, candidate build, focused checks, setup before each gate, full final gate, and `git diff --check` completed. Runtime source, dependencies, canonical package, and tracked distribution have no edits. |

Local evidence logs remain under `.build/ci-cd-evidence/`; uncommitted implementation requires this worktree or explicit transfer of its changes. There are no live task-owned writers or pending local implementation steps. A later authorized push can supply hosted verification without a benchmark-only release.
