# R1–R5 implementation results

Implemented R1–R5 in TypeScript source and regenerated the installed distribution. Native qualification passed. Container qualification is Skipped because the Docker daemon is unavailable, so complete cross-platform qualification is not claimed.

## Scope and checkout

- Repository: `/Users/kyle/Documents/harness-plugin`.
- Starting HEAD: `5f551dae552fa5b318cc1d162d33a69957b987cf`, initially clean (`git status --short`, `git rev-parse HEAD`).
- Host: macOS 27.0, build 26A428, arm64. Development Node: 26.5.0.
- No dependencies, runtime floors, versions, or architecture changed. No commit, push, release, or host plugin reinstall.
- Wake tests use temporary homes and simulated networking. No real wake registry changes or wake traffic.
- Concurrent work owns `DIST_FRESHNESS_IMPLEMENTATION_PLAN.md` and `tmp/dist-freshness-underway.md`. Both are preserved and excluded from this delivery. The observed plan SHA-256 is `29c23349e3a91ec1dab49db1d4041c1f10c6e19fc329a16880b8b54ca7c341fa`.

## Changes

| Finding | Implemented behavior | Regression evidence |
| --- | --- | --- |
| R1 | Complete startup error fields and valid nonzero status, default 2. Preserve explicit statuses including 3. Unexpected archiver loading failures use `dependency_load_failed`, retain the cause, and quote the installed dependency command. | `tests/back-up-directories/startup-failure.test.js`, copied CLI with SyntaxError and Error dependencies, JSON/plain and preflight/normal dispatch, no output or copies. Existing dependency and configuration tests retained. |
| R2 | Lock before fresh configuration read, hold through operation and atomic save, release only matching filesystem identity. No-op operations lock without rewriting. Contention/acquisition errors exit 2. Cleanup/ownership failures exit 1 and disclose saved configuration or preceding operation failure. | `tests/wake-desktop/target-lock.test.js` and `target-lock-preload.cjs`, real process barriers for register/register and remove/update, explicit contention then retry, unknown properties, read-only commands, no-op inode/mtime preservation, exceptions, SIGKILL recovery, ownership mismatch, acquisition and release failures. Existing target tests updated only where lock semantics supersede historical behavior. |
| R3 | Validate each raw record with JSON.parse, recover unsafe integer tokens only for top-level timestamp/duration keys, decode escaped keys and preserve duplicate ordering. Reject unsafe direct JS numbers. Streaming, cancellation, descriptor cleanup and two replay passes retained. | `tests/extract-video-frames/integer-tokens.test.js`, literal JSON tokens at positive/negative safe boundaries, both duration fields, large durations and bigint inclusive point windows, tiny chunks, strings, escaped/duplicate keys, nested lookalikes, malformed JSON, direct unsafe numbers. Existing spool/lifecycle tests retained. |
| R4 | Clear temporary ownership only after successful deletion or rename. Failed immediate deletion retains the path for existing runner retry and cleanup reporting. | `tests/create-discord-emoji-gif/failure-reporting.test.js`, verification/rename failure, exact temporary deletion failure, successful/persistent outer retry, JSON/plain original cause and cleanup evidence, existing destination and unrelated file preservation. |
| R5 | Require executable regular file, following symlinks, before returning canonical path. Continue PATH search after unsuitable candidates. | `tests/shared-node/resolve-command.test.js`, directory and symlink-to-directory ahead of executable, existing symlink/file/permission/precedence/canonical/relative PATH tests. |

Wake contention and manual recovery are documented in the shipped skill and existing human guide. The obsolete statement that mutations had no locks was removed.

## Verification commands and results

All commands below run from the repository root unless a path is explicit. Logs are retained under `tmp/` and remain unstaged. Test results describe these invocations and do not qualify concurrent changes made afterward.

| Status | Command | Result and evidence |
| --- | --- | --- |
| Passed | `npm run build` | Generated artifact assembled, latest log `tmp/final-build.log`. Source was built before emitted-code tests. |
| Passed | `node scripts/setup-tests.js` | Locked toolchain, backup dependencies, Python environment and reference initialization ready, latest log `tmp/final-setup.log`. |
| Failed, corrected | Initial focused new-regression command | 48 passed, 2 failed because test expectations used `message` where existing cleanup reports use `condition`. Corrected assertions, no production behavior changed for these failures. `tmp/focused-new.log`. |
| Passed | `node --test tests/back-up-directories/*.test.js tests/wake-desktop/*.test.js tests/extract-video-frames/*.test.js tests/create-discord-emoji-gif/*.test.js tests/shared-node/*.test.js` | 412 passed, zero failures/skips. `tmp/focused-all.log`. |
| Passed | `node --test tests/wake-desktop/target-lock.test.js tests/wake-desktop/targets.test.js tests/inventory/*.test.js` | Final acquisition-classification correction and documentation verified. `tmp/final-focused.log`. |
| Passed | `npm run typecheck` | Final strict typecheck passed, `tmp/final-typecheck.log`. |
| Passed | `npm run build:check` | Final generated output matches fresh assembly, `tmp/final-build-check.log`. |
| Passed | `node --test tests/distribution/installation.test.js` | 1 passed, isolated artifact under an ESM parent with installed backup dependencies. `tmp/installation.log`. Also passed in final full gate. |
| Passed | `node scripts/setup-tests.js`, then `node scripts/run-tests.js` | Final full gate: **683 passed, 0 failed, 0 skipped, 0 cancelled, 0 todo**, GIF group included. `tmp/final-setup.log`, `tmp/final-full-native.log`. Earlier full gate had 682 passes before adding the obstructed-parent regression, `tmp/full-native.log`. |
| Skipped | Container/media gate, availability probe `docker info --format '{{.ServerVersion}}'` | Daemon socket `/Users/kyle/.docker/run/docker.sock` does not exist. Container guide was read. No Linux gate executed and no Linux result inferred from native tests. |

The final full gate ran actual native HEIC and GIF backend tests with host access. It does not establish the declared macOS 26 platform floor, because the available native host runs macOS 27.

## Actual Node runtime floors

Official darwin-arm64 binaries were used directly. Node 22.0.0 already existed under `/private/tmp`. Node 20.6.0, 22.12.0, and 26.0.0 were downloaded from their versioned `https://nodejs.org/dist/vVERSION/node-vVERSION-darwin-arm64.tar.gz` locations to `/private/tmp`. No host runtime selection was changed.

| Status | Exact command | Result |
| --- | --- | --- |
| Passed | `/private/tmp/node-v20.6.0-darwin-arm64/bin/node --test tests/extract-video-frames/integer-tokens.test.js tests/extract-video-frames/frame-spool.test.js tests/shared-node/resolve-command.test.js` | 21 passed, zero failures/skips. `tmp/floor-20.6.log`. |
| Passed | `/private/tmp/node-v22.0.0-darwin-arm64/bin/node --test tests/create-discord-emoji-gif/failure-reporting.test.js` | 18 passed, zero failures/skips. `tmp/floor-22.0.log`. Publication and reporting use test injection, actual backend tests ran in the native gate on Node 26.5. |
| Passed | `/private/tmp/node-v22.12.0-darwin-arm64/bin/node --test tests/back-up-directories/startup-failure.test.js` | 4 passed, zero failures/skips. `tmp/floor-22.12.log`. |
| Passed | `/private/tmp/node-v22.12.0-darwin-arm64/bin/node tests/distribution/runtime-floor.js --backup` | Existing harness passed real isolated backup installation, preflight, archive and replication. `tmp/floor-backup.log`. |
| Passed | `/private/tmp/node-v26.0.0-darwin-arm64/bin/node --test tests/wake-desktop/target-lock.test.js tests/wake-desktop/targets.test.js` | Final 19 passed, zero failures/skips. `tmp/final-floor-26.0.log`. |

## Review and limits

- Passed: Harness Advisor routing resolved to built-in Astra high, fresh review. One automatic review used `gpt-6-astra`, high effort, with curated code and test evidence. The child was instructed to use no tools, make no changes, and perform no delegation. No enforced child sandbox is claimed. Cache metrics were unavailable.
- The Advisor established no concrete major/minor defect in the supplied implementation. Its evidence included the 412-test focused pass, with full-gate and floor results still pending at dispatch. Primary inspection subsequently corrected parent-directory acquisition failures being classified as contention, removed contradictory legacy lock wording, and reran focused, floor and full-gate checks.
- R3 qualification establishes exact raw integer JSON recovery. Unsafe decimal/exponent representations are not claimed lossless. Native FFmpeg behavior at arbitrary 64-bit timestamp origins remains outside this qualification.
- Docker/Linux qualification remains Skipped due to the unavailable daemon.

## Staged delivery

- Passed: `npm run build:check` after staging, `tmp/staged-build-check.log`.
- Passed: `node scripts/validate-dist.js --tracked`, 87 distribution files, `tmp/staged-validation.log`.
- Passed: `git diff --cached --check` and staged diff inspection.
- Passed: exact index inventory compared with `tmp/r1-r5-staged-paths.txt`, 25 intended files, no extra or missing staged paths.
- Passed: `git diff --name-only -- <the 25 intended paths>` is empty, all intended source, generated output, tests, documentation and this record are staged.
- Passed: HEAD remains `5f551dae552fa5b318cc1d162d33a69957b987cf`, no commit created.
- Passed: the concurrent distribution-freshness plan retains its observed SHA-256. Its notice and unstaged `scripts/validate-dist.js` changes are excluded from this delivery. Checks are observations of the live checkout, not qualification of the other worker's evolving changes.
- Raw logs and task scripts remain under ignored `tmp/`, with only this requested results record force-added to the index.
