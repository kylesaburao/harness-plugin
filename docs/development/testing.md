# Testing

[Development](README.md) / Testing

Run commands from the repository root. Tests live in `tests/<skill-name>/`, with repository-wide checks in `tests/inventory/`.

## Setup

After editing source, run `npm ci --include=dev` and `npm run build`. Setup and the gate reject stale distribution instead of repairing it. Runtime tests execute `dist/harness/`.

Install the host tools in [dependencies](dependencies.md) first. On macOS, run:

```sh
node scripts/setup-tests.js
```

Setup installs the root locked build toolchain, checks that the tracked distribution matches a fresh build, installs backup npm dependencies, creates `.venv`, installs `pypdfium2`, and initializes ASD-STE100 references. It does not install host runtimes or media executables. To check an existing environment without installation, use `node scripts/setup-tests.js --check`.

On Linux, including WSL2, use [container setup](container.md). Run development commands through `./scripts/dev exec <command> [args...]` and keep Git on the host.

## Full gate

On macOS:

```sh
node scripts/run-tests.js
```

On Linux/WSL2, after `./scripts/dev setup`:

```sh
./scripts/dev exec node scripts/run-tests.js
```

The gate checks fresh compilation/assembly and static artifact validity before behavioral tests, and validates existing dependencies and does not install them. After all test processes finish, it removes the repository `.venv`. Run setup before each gate. Backup `node_modules` and user-level reference bundles remain. A parent shell may still display `(.venv)` until deactivated or closed.

Use `--skip-gif` for a partial gate that omits GIF tests and both converter preflights. Report that exclusion. Linux platform skips do not establish native macOS frame-extraction coverage.

In a Codex sandbox, the three native HEIC tests can fail with `heic_encode_failed` and `nilError` because real Core Image encoding needs host access. The [lifecycle tests](../../tests/extract-video-frames/lifecycle.test.js) record this limitation. If that signature occurs, rerun the focused command with authorized host access and report both results separately:

```sh
node --test --test-name-pattern='native .*HEIC10' tests/extract-video-frames/lifecycle.test.js
```

## Focused checks

Use the relevant subset while editing:

```sh
node --test tests/inventory/*.test.js
node --test tests/back-up-directories/*.test.js
node --test tests/create-discord-emoji-gif/*.test.js
node --test tests/extract-video-frames/*.test.js
node --test tests/bump-version/*.test.js
node --test tests/git-hooks/*.test.js
.venv/bin/python -m unittest discover -s tests/write-asd-ste100 -v
```

Backup and Python checks require setup dependencies. Media checks also need their host tools. The inventory group checks the public catalog against shipped files and validates local links in repository entry points and `docs/`. Use the container wrapper on Linux, with `sh -c` when shell glob expansion is needed inside the container.

## Interpret results

Prerequisites run first and stop the gate on failure. Python tests overlap the dedicated full GIF search, then remaining Node files share a process-isolated pool sized to available parallelism. Tests that change process-global state remain sequential within their files.

Test failures do not stop other groups. The terminal report includes wall time, concurrency, prerequisite timings, group counts and elapsed spans, aggregate counts, slow tests, and failure locations. Group spans overlap, so do not sum them. Excluded groups, groups that never started, and framework-skipped tests are distinct. No report files are written.

Exit status is 0 on success, the failed prerequisite's status, 1 after test failures, or 128 plus the signal number on interruption. The gate timer includes prerequisites and scheduling, but excludes Node startup and an external container wrapper.

See [run-tests.js](../../scripts/run-tests.js) for scheduling details and [validation records](validation.md) for historical platform coverage and limitations.
