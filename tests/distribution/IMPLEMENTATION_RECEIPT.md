# TypeScript migration implementation receipt

## Starting checkpoint

- HEAD: `233fd2792ef598464152a52b7e96e110eacde70f`, clean working tree, matching the investigation baseline.
- Both plugin manifest versions: `3.1.5`.
- Production inventory: 79 tracked files, including 16 CommonJS JavaScript modules, one ESM module, nine Python files, one Swift file, 13 skills, and three output styles.
- Host: macOS, Node `v26.5.0`.

## Stage 0: baseline and explicit test paths

Added a test helper distinguishing authoring from distribution paths. Both initially point at the existing plugin tree. The sampler contract tests consume the distribution path without changing runtime behavior.

Executed:

- `node scripts/setup-tests.js --check`: exit 2, missing `.venv`.
- `npm_config_cache=/private/tmp/harness-ts-npm-cache node scripts/setup-tests.js`: passed. Installed backup dependencies and Python dependencies, reused the existing valid ASD bundle.
- `node scripts/run-tests.js`: exit 1, 643 passed, three failed, zero skipped. The three native HEIC tests reported the documented Core Image sandbox `nilError`.
- `node --test --test-name-pattern='native .*HEIC10' tests/extract-video-frames/lifecycle.test.js` with host access: passed, all three native HEIC tests.
- `node --test tests/random-sampler/sample.test.js`: passed, ten tests after path-helper adoption.
- `git diff --check`: passed.

The full sandbox gate and the successful focused host rerun are separate results. This is baseline evidence, not qualification of the later migration. Local raw logs are in ignored `tmp/ts-baseline-setup.log`, `tmp/ts-baseline-gate.log`, `tmp/ts-baseline-native.log`, and `tmp/ts-stage0-sampler.log`.

One fresh read-only Astra high Advisor consultation examined assembly/publication boundaries before implementation. Its recommendations were evaluated against the handoff. No production implementation has changed at this checkpoint.

## Remaining work

Stages 1 through 7 of `tmp/TS_MIGRATION_PROMPT.md` remain. No migrated build, distribution, runtime-floor, container, or live host qualification is claimed yet.

## Stage 1: complete source/distribution boundary

Moved the complete editable plugin to `src/harness/` and generated `dist/harness/`. Both marketplaces now select `./dist/harness`. The canonical version remains `3.1.5` in the source package, with versionless source manifest templates. All installed paths and package boundaries are preserved.

Exact root development pins are TypeScript `7.0.2` and `@types/node` `20.19.43`. Only `shared/node/media-result.ts` and `resolve-command.ts` are converted at this checkpoint. The remaining 15 Node modules are explicitly transitional. Python, Swift, bundled instructions and other assets retain their baseline bytes. A direct comparison against the starting Git tree verified all 75 unchanged resource/implementation files in both source and distribution.

The builder stages fresh output, validates it, and reconciles files while preserving the narrow dependency/cache overlays. Check mode detects drift without repair. Source and generated paths are explicit in tests. Setup, gate, release retry ordering, version derivation, four container volumes, public links, and contributor documentation use the new boundary.

Executed verification:

- `npm run typecheck`, `npm run build:check`, and `npm run validate:dist`: passed, 80 artifact files.
- `node --test tests/inventory/*.test.js tests/bump-version/*.test.js tests/dev/*.test.js tests/run-tests/*.test.js`: passed, 78 tests after updating intentional contracts and preparing `.venv`.
- `node --test tests/inventory/*.test.js tests/bump-version/*.test.js tests/distribution/*.test.js`: passed, 63 tests including drift, compilation failure, deletion/rename, overlays, isolated installation, canonical versions, and source/emitted links.
- Isolated installation uses a canonical temporary path with spaces and non-ASCII characters under an ESM parent. All nine CLI help paths run without checkout dependencies. Advisor contract preflight uses a version-only stub, no consultation. Python help, Swift resource presence, native ESM sampling, missing archiver diagnostics, lockfile installation and a tiny real backup pass.
- `node scripts/run-tests.js` in the sandbox: 650 passed and the same three baseline native HEIC failures.
- Focused native HEIC host rerun: three passed.
- After final source-link and release-range checks, `node scripts/run-tests.js` with host access: **655 passed, zero failed, zero skipped**. This includes both GIF backends and native HEIC execution on macOS 27.0 with Node 26.5.0.
- `git diff --check`: passed. Archived qualification evidence was not rewritten.

The isolated npm install initially failed when given macOS's symlinked `/var/folders` temporary prefix. Canonicalizing that temporary directory with `realpathSync` resolved it. No runtime dependency manifest or lockfile changed.

Docker 29.7.2 became available after the user started the engine. Container build/setup/gate qualification is in progress. Remaining migration stages 2 through 7 and final runtime-floor/live-host qualification remain open.

### Container qualification and corrections

Docker 29.7.2 toolchain build and four-volume setup passed. The container runs Node 26.8.2. A build with the backup dependency mount active preserved its directory inode and archiver package bytes, followed by a passing build check. The resulting Linux artifact also passed the macOS build check.

The first full container gate exposed two existing portability assumptions. The CRC fixture damaged a frame reached by this FFmpeg's first-frame read-ahead, producing the correct startup rejection instead of exercising a work failure. The fixture now damages frame 60 of a three-second clip, retaining strict exit-1, child-exit-0, CRC-diagnostic, and destination-preservation assertions. No converter implementation changed. The gate also tried to remove the mounted `.venv` root. Node reports that root as busy before visiting children. Cleanup now handles only `EBUSY` from `rmdir` of the exact `.venv` root, explicitly removes its children, and verifies the retained mount is empty. Child cleanup failures remain failures.

- Focused media/runner corrections on macOS: 31 passed. The final cleanup-specific runner suite passed 14 tests on macOS and Linux.
- `./scripts/dev setup`: passed after the corrections.
- `./scripts/dev exec node scripts/run-tests.js`: **passed, 596 passed, zero failed, 60 platform skips**, 8.567 seconds. Both GIF backends ran. Raw evidence: ignored `tmp/ts-stage1-container-qualified-gate.log`.
- Post-gate inspection confirmed the mounted `.venv` is empty and the archiver dependency is retained.
- `npm run typecheck`, `npm run build:check`, and `node scripts/validate-dist.js --tracked`: passed, 80 generated files tracked with correct executable intent.

The baseline Python `ste_cli.py` ends with an extra blank line. Its copied source bytes are deliberately preserved. The staged whitespace check reports that inherited line, so the otherwise clean check uses `git -c core.whitespace=-blank-at-eof diff --cached --check`. No static resource was reformatted to satisfy whitespace tooling.

Stage 1 is qualified as a boundary checkpoint. Stages 2 through 7 remain, including conversion of the 15 transitional Node modules and final runtime-floor/live-host qualification. Nothing was pushed or released.

## Stage 2: sampler and Advisor

Starting checkpoint: `5d025e4`. Converted `sample.mjs` to `sample.mts`, and both Advisor implementations to `.ts`. Their emitted filenames remain unchanged. The transitional allowlist now contains 12 modules.

The sampler has operation-discriminated requests/results, preserved raw JSON numeric values, a narrow native JSON capability interface, and a cryptographic integer-source contract. Native dynamic crypto import and top-level await remain. Advisor configuration has typed host/family/effort values, validated configuration entries, command variants, route sources, and resolved reports. Claude invocation retains its narrower effort set and captured subprocess function, with distinct preflight/consultation reports and validated external response data. The existing null-response diagnostic remains intact. No new production module split was needed.

Executed verification:

- `npm run typecheck` and `npm run build:check`: passed.
- Initial focused sampler/Advisor/distribution suite: 39 passed. After preserving the null-response contract explicitly, focused sampler/adapter coverage: 18 passed.
- Downloaded the official Node `22.0.0` macOS ARM64 archive under ignored `tmp/node-runtimes/` and verified its version. `tmp/node-runtimes/node-v22.0.0-darwin-arm64/bin/node tests/distribution/runtime-floor.js`: passed, covering native ESM, lossless large numeric tokens, actual cryptographic sampling, routing mutation/selection, and bundled-contract preflight with a version-only Claude stub.
- An initial attempt to run the entire modern sampler/Advisor test harness on Node 22.0.0 produced 25 passes and two harness failures. The sampler import-failure injector requires newer `registerHooks`. The Advisor lock-cleanup injector intercepted unrelated staging cleanup on this runtime. Narrowed that stub to the exact lock directory, preserving all original assertions. The sampler's modern preload tests remain intact and run in the Node 26 gate.
- Node `22.0.0` Advisor config/adapter tests after the stub correction: 17 passed.
- Native setup followed by `node scripts/run-tests.js` with host access: **657 passed, zero failed, zero skipped**, including real GIF and native HEIC tests.
- Container setup followed by `./scripts/dev exec node scripts/run-tests.js`: **597 passed, zero failed, 60 platform skips**.
- `git diff --check`: passed.

Local raw evidence: `tmp/ts-stage2-host-gate.log`, `tmp/ts-stage2-container-gate.log`, `tmp/ts-stage2-node22.log`, `tmp/ts-stage2-node22-advisor.log`, and the focused logs. The runtime-floor script is development-only and is not distributed. Stages 3 through 7 remain.

## Stage 3: wake tools

Starting checkpoint: `757a788`. Converted all three wake modules as a typed local graph. Raw and fully validated registries remain distinct, selected-target loading tolerates unrelated invalid entries, and extensible saved records retain their unknown properties. Management commands/results and resolved wake requests/reports are explicit types. UDP and ping callbacks retain the existing packet-sent failure boundary and monotonic scheduling. Nine transitional modules remain.

The deadline VM harness now supplies `exports` as the same object as `module.exports`, matching ordinary CommonJS execution. Its four scheduling assertions are unchanged. The distribution collision fixture now targets the still-transitional backup module, since wake no longer has a source JavaScript counterpart.

Executed verification:

- `npm run typecheck`, `npm run build`, `npm run build:check`, and `node scripts/validate-dist.js --tracked`: passed, 80 generated files.
- Initial focused wake/distribution run: 52 passed, four deadline harness failures caused by the missing CommonJS `exports` alias.
- After correcting that harness, `node --test tests/wake-desktop/*.test.js tests/distribution/*.test.js`: **56 passed, zero failed, zero skipped**.
- Native setup followed by `node scripts/run-tests.js` with host access: **657 passed, zero failed, zero skipped**.
- Container setup followed by `./scripts/dev exec node scripts/run-tests.js`: **597 passed, zero failed, 60 platform skips**.
- `git diff --check`: passed. Tests used simulated networking and isolated configuration, without real wake traffic.

Local logs: `tmp/ts-stage3-focused.log`, `tmp/ts-stage3-host-setup.log`, `tmp/ts-stage3-container-setup.log`, `tmp/ts-stage3-host-gate.log`, and `tmp/ts-stage3-container-gate.log`. Stages 4 through 7 remain.

## Stage 4: backup

Starting checkpoint: `b736cd0`. Converted backup to TypeScript and extracted the cohesive `backup-plan.ts` module for validated configuration, canonical directory identities, output-directory creation, archive naming, and replication planning. The entrypoint retains archive/copy lifecycle, locking, interruption, progress, and cleanup. It uses a narrow typed adapter around the lazily loaded named `ZipArchive` export. Runtime package metadata and lockfile remain unchanged. Eight transitional modules remain, and the distribution now contains 81 files.

Executed verification:

- `npm run typecheck`, `npm run build`, and `npm run build:check`: passed.
- `node --test tests/back-up-directories/*.test.js tests/distribution/*.test.js`: **77 passed, zero failed, zero skipped**.
- Downloaded the official Node 22.12.0 macOS ARM64 runtime under ignored `tmp/node-runtimes/`. `tmp/node-runtimes/node-v22.12.0-darwin-arm64/bin/node tests/distribution/runtime-floor.js --backup`: passed. It exercises an isolated copied backup skill beneath an ESM parent, missing-dependency diagnostics, its own lockfile installation, preflight output-directory creation, a real archive and replication, extracted file contents, byte reporting, and staging cleanup.
- The existing default runtime-floor qualification also still passed on actual Node 22.0.0 after extending the script.
- Native setup followed by `node scripts/run-tests.js` with host access: **657 passed, zero failed, zero skipped**.
- Container setup followed by `./scripts/dev exec node scripts/run-tests.js`: **597 passed, zero failed, 60 platform skips**.
- `git diff --check`: passed.

Local evidence: `tmp/ts-stage4-focused.log`, `tmp/ts-stage4-node2212.log`, `tmp/ts-stage4-host-setup.log`, `tmp/ts-stage4-container-setup.log`, `tmp/ts-stage4-host-gate.log`, and `tmp/ts-stage4-container-gate.log`. Stages 5 through 7 remain.
