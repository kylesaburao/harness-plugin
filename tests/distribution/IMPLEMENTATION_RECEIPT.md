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
