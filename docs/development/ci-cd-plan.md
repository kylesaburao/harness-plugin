A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent,
re-read files as needed, and carry the work through implementation and verification.

# CI/CD simplification and performance handoff

## Objective and baseline

Reduce CI/CD latency and maintenance overhead while retaining existing test coverage and publication guarantees.

Repository: `/Users/kyle/Documents/harness-plugin`
Branch: `main`
Baseline: `626e1f907b61b6b1a65c37e24e0d5c3ad0d03359`

**Intended handoff file:** `docs/development/ci-cd-handoff.md`. This document has **not been saved** because the current Plan mode prohibits file writes. The
worktree remains clean. Once file writes are permitted, save and verify this document before implementation.

Before implementation, read `AGENTS.md` and the build, testing, dependencies, and versioning guides under `docs/development/`. Reconcile baseline drift
without discarding work.

The tests already execute compiled, installation-shaped artifacts. Development and PR checks use `.build/harness/`; publication uses newly generated `dist/
harness/`. Testing the existing committed `dist/` alone would miss unpublished changes.

The [latest successful release run](https://github.com/kylesaburao/harness-plugin/actions/runs/35402301978) supplies this baseline:

| Work | Observed duration |
|---|---:|
| Preliminary development test job | 207 seconds |
| Publication job, including distribution tests | 207 seconds |
| Development / distribution test gates | 173.445 / 172.314 seconds |
| Distribution test group within those gates | 170.996 / 169.853 seconds |
| Test setup | 17.551 / 15.466 seconds |
| Reference initialization within setup | Approximately 10 seconds |
| Individual freshness checks | Approximately 0.45 seconds |

Both gates reported **590 passed, 60 platform skips, and GIF tests excluded**. Group spans overlap and must not be summed.

Removing preliminary release testing should eliminate approximately one three-minute gate per ordinary release. That is an estimate based on this run, not a
measured improvement. Publication fixtures are the next major bottleneck.

## Implementation changes

### 1. Run one ordinary main-branch gate

Retain the existing read-only `test` job and write-enabled `bump` job in `.github/workflows/bump-version.yml`.

After the existing event-range source-policy check, add a small Node selection step that calls the existing `inspectPublication` function with:

- `head: 'HEAD'` for the checked-out event snapshot.
- The current workflow run ID and workflow SHA.
- The explicit manual level for `workflow_dispatch`; otherwise `null`.

Expose one internal step output, `test_candidate`, through `GITHUB_OUTPUT`. Map `no eligible changes` to `true`; map `ready` and a validated `already
published` result to `false`. Fail on errors or unexpected dispositions. Reuse existing policy logic without introducing another CLI or duplicating
eligibility rules.

Condition Python setup, root dependency installation, candidate build, test setup, and candidate gate on `test_candidate == 'true'`. Retain tracked-checkout
integrity checks.

| Situation | Required behavior |
|---|---|
| Pull request | Continue testing the pinned integration candidate. |
| Automatic push with no pending release inputs | Run one development-candidate gate. |
| Automatic push with pending release inputs | Skip the preliminary candidate gate; test the versioned distribution in the publisher. |
| Manual publication | Skip the preliminary candidate gate; publisher tests the explicitly selected version increment. |
| Previously published workflow rerun | Let the publisher’s current-main run-ID lookup exit without rebuilding. |
| Genuine publication race | Rebuild and retest the newly selected source, as today. |

Keep `bump` dependent on successful completion of `test`, and **retain its inexpensive current-main inspection even after a non-release candidate gate**.
This preserves the existing opportunity to catch newer unpublished changes. If that inspection selects a different source requiring publication, its
additional distribution gate is intentional.

Do not use the preliminary selection as publication authority. Preserve the publisher’s existing transaction, including fresh selection, workflow
compatibility, bounded retries, post-test freshness, working-tree validation, indexed bytes and modes, tested inventory, committed-tree equality, timestamps,
and ordinary push verification.

Preserve workflow and job identifiers. Update step summaries to distinguish source-policy success from completion of a full gate. GitHub currently reports no
required checks on `main`; reconfirm this before changing any check semantics.

### 2. Divide publication tests across the existing worker pool

The fifteen publication scenarios currently execute synchronously in one file. Extract their common fixture code into a test-only helper that does not end in
`.test.js`, then distribute the existing scenarios across four files under `tests/distribution/`:

| File | Existing scenarios |
|---|---|
| `publication.test.js` | Successful race and rerun; no eligible range; raced workflow change |
| `publication-recovery.test.js` | Accepted push with transport error; uncertain inspection and rerun; three-race exhaustion; rejection without advancement |
| `publication-policy.test.js` | Manual increments; invalid submitted metadata; second-parent release history; stale workflow and invalid context |
| `publication-integrity.test.js` | Post-staging mutation; failed raced gate; every publication-stage failure; unexpected source mutation |

Use the runner’s existing process-isolated worker pool. Do not add nested concurrency, a GitHub matrix, or an asynchronous runner rewrite. Node supports
concurrency across test files through its existing test-runner interface. [Node test-runner documentation](https://nodejs.org/api/test.html)

Each process must own its seed repository. Each scenario must own its clones, bare remote, control files, logs, and cleanup. The shared compiler installation
remains read-only.

Preserve every scenario and failure-matrix branch, actual workflow-shell execution, real compilation, Git validation, commits, and local pushes. Keep the
current controlled setup/gate probes clearly distinguished from runtime test coverage.

### 3. Cancel obsolete PR verification

Add workflow-level concurrency to `.github/workflows/verify.yml`, grouped by workflow and PR number, with `cancel-in-progress: true`.

Keep publication concurrency unchanged: `version-bump`, `cancel-in-progress: false`, and `queue: max`. GitHub does not permit combining the latter two queue/
cancellation settings differently without changing semantics. [GitHub concurrency documentation](https://docs.github.com/en/actions/reference/workflows-and-
actions/workflow-syntax#concurrency)

### 4. Update contracts and documentation

Update orchestration tests and the development testing/versioning guides to explain conditional candidate testing, exact-distribution publication testing,
and concurrent publication fixtures. Update other incoming references if affected.

Replace assertions that freeze the old unconditional workflow layout with checks of routing, permissions, ordering, and observable outcomes.

No plugin runtime API, artifact target, dependency, canonical version, or tracked distribution changes are required.

## Validation and acceptance

Add routing coverage for:

- Eligible source changes, non-release documentation/tests/tooling changes, and documentation pushes that catch up an earlier unpublished source change.
- Manual patch/minor/major publication without pending automatic changes.
- Invalid source history failing before dependency installation.
- Selection failure and unknown disposition failing closed.
- An original event still appearing eligible after its workflow already published; the publisher must deduplicate against current main.
- A queued eligible event whose changes have since been published.
- Main advancing between classification and publication, including after a non-release candidate gate.

Retain all existing race, mutation, staging, manual-level, uncertain-push, and idempotency tests. Confirm that all fifteen publication scenarios and every
failure-matrix branch still execute.

From the repository root on macOS:

```sh
npm ci --include=dev
npm run build
node scripts/setup-tests.js
node --test tests/bump-version/*.test.js tests/distribution/*.test.js tests/run-tests/*.test.js
node scripts/setup-tests.js
node scripts/run-tests.js
git diff --check
```

On Linux/WSL2, use the documented development-container equivalents. Preserve and report actual platform skips and exclusions.

Measure the fixture split using three baseline and three changed hosted-style gates on the same machine and toolchain, repeating setup before each gate.
Compare median full-gate duration, scenario coverage, and failures. Retain the split only if it improves median duration without coverage loss or
instability; otherwise retain the original fixture organization and document the measured limitation.

Acceptance requires:

- One distribution gate for an ordinary, non-racing release, with no preliminary development gate.
- One development gate for an ordinary non-release main push.
- Unchanged publication integrity and race behavior.
- Complete retained scenario coverage.
- No implementation edits to `dist/` or the release-owned canonical package.
- Recorded performance evidence that separates measurements from estimates.

After an otherwise authorized push or merge, inspect the resulting hosted run to verify routing, durations, and publication outcome. Do not publish or
dispatch releases solely to benchmark this analysis.

The user explicitly chose to retain main-branch testing for non-release pushes. PR checks also remain enabled.
seconds, but substantially smaller than duplicate testing and serial publication fixtures. Reassess after measuring the primary changes.

Retain subsecond freshness and release-validation checks. Some inspections overlap, but they protect different stages; their removal offers little
demonstrated benefit.

Do not introduce path-filtered test selection, shallow history, artifact promotion between jobs, a new release coordinator, action-version upgrades, or
expanded hosted media/platform coverage in this change. Preserve `.venv` cleanup and existing full-history release eligibility.

Planning validation consisted of repository inspection, hosted job/log inspection, and read-only checks of four actual policy states: eligible original
event, published current main, fresh no-change request, and manual release without changes. All four returned the expected disposition. No implementation or
full local gate has run.

A Harness Advisor supplied a separate reasoning review of the provided evidence. It did not independently inspect the repository or reproduce tests.

## Execution continuity

If execution is paused or handed off, stop starting new work and settle only task-owned activity to the nearest safe boundary. Preserve staged, unstaged, and
untracked work; do not reset, stash, stage, commit, or push merely for handoff.

Inspect the active skill catalogue for a suitable durable continuation capability. If none is usable, disclose that limitation and manually update this
Markdown handoff after inspecting its existing contents. Record the absolute worktree, branch/HEAD, local changes, completed and partial work, decisions,
commands and results, failures, outstanding work, in-flight processes, and exact next action.

Read the saved handoff back and verify its references. Explain whether resumption requires the same worktree or transfer of uncommitted files. Provide an
exact resume prompt naming the actual worktree and handoff path, requiring drift reconciliation and checks for still-running writers, then stop. If writing
fails, report the handoff as incomplete rather than claiming durable delivery.
