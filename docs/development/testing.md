# Testing

[Development](README.md) / Testing

Run commands from the repository root. Tests live in `tests/<skill-name>/`, with repository-wide checks in `tests/inventory/`. Runtime tests execute compiled JavaScript and copied resources from the selected installation-shaped artifact, not directly from `src/`.

## Setup

Install the host tools in [dependencies](dependencies.md) first. On macOS, prepare an ordinary development checkout explicitly:

```sh
npm ci --include=dev
npm run build
node scripts/setup-tests.js
```

The root `npm ci` step is separate from test setup. `npm run build` creates or refreshes `.build/harness/`. Setup first checks that this selected artifact is fresh, then installs its backup npm dependencies, creates `.venv`, installs `pypdfium2`, and initializes the existing user-level ASD-STE100 reference bundle. It does not build either artifact, install root dependencies, install host runtimes or media executables, compile the Swift helper, or modify the published distribution.

Use `node scripts/setup-tests.js --check` to check prerequisites and selected-root dependency resolution without installing, initializing, or building. On Linux/WSL2, use [container setup](container.md), and keep Git operations on the host.

## Selecting the test artifact

Development is the default for setup, the full runner, direct Node tests, Python tests, benchmarks, inventory checks, links, and isolated-installation checks:

```text
development  -> .build/harness/
distribution -> dist/harness/
```

Use `--target distribution` only for release testing or explicit inspection:

```sh
node scripts/setup-tests.js --target distribution
node scripts/run-tests.js --target distribution
```

The runner's explicit target overrides any inherited test-target setting and propagates one authoritative `HARNESS_TEST_TARGET` value to every prerequisite, Node worker, GIF process, Python reporter, Python test, and relevant nested child. Direct focused commands default to `development`; to inspect the published artifact explicitly, set `HARNESS_TEST_TARGET=distribution`. Any other supplied value fails instead of falling back to source or another artifact.

Backup's `archiver` dependency must resolve from the selected artifact's own `skills/back-up-directories/node_modules/`. A dependency in the root or the other artifact cannot satisfy that boundary.

## Full gate

On macOS, after setup:

```sh
node scripts/run-tests.js
```

On Linux/WSL2, after `./scripts/dev setup`:

```sh
./scripts/dev exec node scripts/run-tests.js
```

The gate checks selected-artifact freshness and static validity before behavioral tests. It validates existing dependencies and does not install them. After all test processes finish, it removes the repository `.venv`; run setup before each complete gate. Backup `node_modules` and user-level reference bundles remain. A parent shell may still display `(.venv)` until deactivated or closed.

Use `--skip-gif` for a hosted-style partial gate that omits GIF tests and both converter preflights. Report that exclusion. Linux platform skips do not establish native macOS frame-extraction coverage, and the hosted subset is not the complete local gate.

In a Codex sandbox, the three native HEIC tests can fail with `heic_encode_failed` and `nilError` because real Core Image encoding needs host access. If that signature occurs, rerun the focused command with authorized host access and report both results separately:

```sh
node --test --test-name-pattern='native .*HEIC10' tests/extract-video-frames/lifecycle.test.js
```

## Focused checks

Build the candidate first, then use the relevant subset while editing:

```sh
node --test tests/inventory/*.test.js
node --test tests/back-up-directories/*.test.js
node --test tests/create-discord-emoji-gif/*.test.js
node --test tests/extract-video-frames/*.test.js
node --test tests/bump-version/*.test.js
node --test tests/git-hooks/*.test.js
.venv/bin/python -m unittest discover -s tests/write-asd-ste100 -v
```

Backup and Python checks require setup dependencies. Media checks also need their host tools. Use the container wrapper on Linux, with `sh -c` when wildcard expansion must happen inside the container.

Inventory and documentation-link checks resolve public `dist/harness/...` links against the selected artifact while preserving the literal public destinations. They therefore cover source/candidate-only skills and headings without weakening path-escape, fragment, resource-classification, or published-shape checks. Installation tests copy the selected artifact without dependency/cache overlays and retain the ESM-parent, spaces/non-ASCII, CLI-help, and runtime smoke cases.

The Git-hook suite uses real temporary repositories, active and temporary indexes, linked worktrees, and local bare remotes. It covers protected content/mode/type changes, partial commits, automatic and conflict-resolved merge inheritance, stale or mixed published pairs, and the tree-preserving timestamp amendment. These tests require Git and shell only and do not establish live Docker behavior.

Release-policy and distribution tests use synthetic local histories and Git indexes. They cover source-only range enforcement, validated legacy/new release records, exact input eligibility, staged blob/mode disagreement, complete owned-path staging, races, uncertain pushes, and workflow-run idempotency. Publication fixtures execute the actual workflow shell, real compilation, Git validation, commits, and ordinary pushes to scenario-local bare remotes. Setup and runtime gates inside these fixtures are controlled probes; the outer selected-artifact gate supplies runtime coverage. No fixture pushes to GitHub.

The fifteen publication scenarios remain together in `tests/distribution/publication.test.js`. A four-file split was measured and reverted under the handoff's performance acceptance rule; see the [execution record](ci-cd-handoff.md#execution-record). The shared `publication-fixture.js` owns one seed per process; every scenario owns its clones, remote, controls, logs, and cleanup. Only the compiler installation is shared read-only. The failure matrix still covers build, setup, test, freshness check, and commit failures. `routing.test.js` exercises event classification and fresh-main publication together, while the workflow contracts under `tests/run-tests/` cover conditional steps and fail-closed selection. These files use the existing process-isolated worker pool, with no nested concurrency.

For CI orchestration changes, after build and setup run:

```sh
node --test tests/bump-version/*.test.js tests/distribution/*.test.js tests/run-tests/*.test.js
```

Use `./scripts/dev exec sh -c 'node --test tests/bump-version/*.test.js tests/distribution/*.test.js tests/run-tests/*.test.js'` on Linux/WSL2. Repeat setup before the complete gate. PR verification always tests its pinned integration candidate and cancels older runs for the same PR. Main's read-only job runs a development gate only when publication selection reports no eligible work. The dependent publisher still inspects fresh main and tests every newly selected versioned distribution; reruns resolve a validated existing release without rebuilding. Ordinary releases and non-release pushes each run one gate, with additional exact-distribution gates when source advances or a push race occurs.

The default build/setup/test sequence must leave all tracked files, including `dist/` and `src/harness/package.json`, unchanged. Candidate validation intentionally does not use `--tracked`, because new generated files in `.build/harness/` are ignored. Publication combines a fresh distribution comparison with indexed byte/mode validation; neither check substitutes for the other.

## Interpret results

Prerequisites run first and stop the gate on failure. Python tests overlap the dedicated full GIF search, then remaining Node files share a process-isolated pool sized to available parallelism. Tests that change process-global state remain sequential within their files.

Test failures do not stop other groups. The terminal report includes wall time, concurrency, prerequisite timings, group counts and elapsed spans, aggregate counts, slow tests, and failure locations. Group spans overlap, so do not sum them. Excluded groups, groups that never started, and framework-skipped tests are distinct. No report files are written.

Exit status is 0 on success, 2 for bad usage, the failed prerequisite's status, 1 after test failures, or 128 plus the signal number on interruption. The gate timer includes prerequisites and scheduling but excludes Node startup and an external container wrapper.

See [run-tests.js](../../scripts/run-tests.js) for scheduling details and [validation records](validation.md) for historical platform coverage and limitations. Historical records describe the workflow that existed when they were captured; they do not override the current candidate-based contract.

The [CI publication implementation receipt](../../tests/distribution/CI_PUBLICATION_RECEIPT.md) records candidate, hook, index, Docker, and local publication-transaction verification for this migration.
