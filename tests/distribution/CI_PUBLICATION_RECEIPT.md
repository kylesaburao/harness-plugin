# CI-owned distribution implementation receipt

Recorded September 15, 2026. This records implementation and local verification before delivery; it is not a production release receipt. After these checks, the user separately authorized committing and pushing the implementation.

## Baseline and protected output

The checkout, fetched `origin/main`, and specification baseline were all `a9fa2a2da74c866b6a180e8c102632d0f635634a`, on `main`, with plugin version **3.1.9**. The baseline did not advance. Existing partial changes were reviewed and completed after the user instructed that they should be treated as stale work.

The implementation leaves the published pair unchanged. These host commands passed with exit 0:

```sh
git diff --quiet HEAD -- dist src/harness/package.json
git diff --cached --quiet
git diff --quiet HEAD -- package-lock.json Dockerfile .agents/plugins/marketplace.json .claude-plugin/marketplace.json
git diff --check
```

The baseline `dist` tree is `ddf687b765166284f49939265bf75b9aa7869d0c`; the canonical package blob is `b149f06ade55bbaefefb99632bd710b846acd127`. Both marketplace catalogs still select `./dist/harness`. No production skill source, dependency version, or runtime requirement changed. These checks preceded staging and committing the implementation.

## Delivered behavior

- **Build and packaging:** fixed `development` and `distribution` targets share assembly and validation. The default writes only `.build/harness`; checks do not repair output. Explicit publication context and per-command write intent guard the distribution builder and canonical version writer. Target-specific locks and private staging preserve retained dependency/cache overlays.
- **Development and tests:** setup requires an existing fresh selected artifact and a separately installed root toolchain. Node, Python, benchmarks, prerequisites, nested test processes, inventories, links, and isolated installation checks use the selected candidate. The Docker launcher mounts backup dependencies beneath `.build/harness` and builds before cold setup.
- **Commit policy:** shell/Git-only pre-commit and pre-merge hooks inspect the active index, protect all of `dist/` and the canonical package, and permit exact fetched-pair inheritance during genuine merges. The old freshness pre-push hook is removed. Timestamp amendments preserve partial-commit trees.
- **Source and release policy:** incoming history is inspected before generation. Complete unreleased ranges drive conservative eligibility and highest automatic subject tags; manual dispatch uses its exact chosen increment. Structural release records, workflow compatibility, raw indexed bytes/modes, whole-checkout scope, and final commit metadata are validated.
- **Publication:** the workflow tests the actual versioned distribution, stages the entire owned pair, validates the index and commit, and pushes without force. A source race starts a fresh attempt, up to three attempts. Stable run trailers resolve reruns and accepted pushes with lost responses. Unreadable post-push state reports uncertainty.
- **Documentation:** active repository instructions and development guides describe source-only authoring, candidate preparation, publication ownership, hook setup, and recovery. Historical qualification records retain their original evidence.

## Executed verification

Development commands ran on Linux through `./scripts/dev`. The real container used Node **26.8.2**, npm **11.19.1**, Python **3.13.5**, and Git **2.47.3**. Host Git was **2.53.0**. Temporary Git fixture operations ran inside the container; contributor Git operations remained on the host.

All commands below completed with exit 0. Shell redirections only captured logs under ignored `tmp/`.

| Command | Target and observed result |
| --- | --- |
| `./scripts/dev build` | Real development image built successfully. |
| `./scripts/dev setup` | Real cold setup installed locked root tools, built the development candidate, and prepared candidate dependencies and Python. Reference initialization used the isolated Docker home volume. |
| `./scripts/dev exec node scripts/run-tests.js --skip-gif` | Development candidate: **541 passed, 60 platform skips, 0 failed**. GIF tests and converter preflights explicitly excluded. |
| `./scripts/dev exec node scripts/run-tests.js` | Complete local development gate: **672 passed, 60 platform skips, 0 failed**, including 131 GIF tests. Setup was repeated first. |
| `./scripts/dev exec node tmp/verify-isolated-development.js` | Fresh temporary clone plus the intended working patch: `npm ci --include=dev`, `npm run build`, `node scripts/setup-tests.js`, then the complete gate. **679 passed, 60 platform skips, 0 failed**. Before/after index entries and all **313 tracked files' bytes and modes** matched. The temporary clone was removed. |
| `./scripts/dev exec sh -c 'node --test tests/bump-version/release-policy.test.js tests/distribution/candidate-paths.test.js tests/distribution/build.test.js tests/run-tests/run-tests.test.js tests/inventory/*.test.js && npm run build:check && npm run validate:build'` | Final focused candidate/policy checks: **64 passed**, no failures; development comparison and validation passed for **87 files**. |
| `./scripts/dev exec sh -c 'node scripts/setup-tests.js && node --test tests/run-tests/*.test.js tests/git-hooks/*.test.js tests/dev/launcher.test.js tests/inventory/*.test.js'` | Final local review: **74 passed**, no failures or skips. Includes actual nested Node/Python target propagation and real Git hooks. |
| `./scripts/dev exec sh -c 'node --test tests/distribution/publication.test.js tests/bump-version/release-policy.test.js tests/bump-version/derive-bump-level.test.js'` | Final workflow and policy review: **46 passed**, no failures or skips. Includes actual assembly, generated deletion, local push races, and rerun deduplication. |
| `./scripts/dev exec sh -c '.venv/bin/python -m unittest discover -s tests/write-asd-ste100 -v && .venv/bin/python tests/write-asd-ste100/benchmark_prose_mask.py --variant implementation --repeats 1'` | Direct development-candidate Python: **142 tests passed**. The benchmark entrypoint ran four workload sizes with one repetition each. |
| `./scripts/dev exec node tmp/verify-mounted-development.js` | Real rebuild with a populated Docker backup dependency mount: mount device/inode/UID and dependency SHA-256 unchanged. |

Later focused checks cover changes made after the complete gate, including workflow shell readability, additional policy edge cases, generated deletions, and final documentation. The complete-gate counts above describe their actual snapshots rather than a claim that every later assertion ran in those earlier gates.

Initial fixture failures were corrected before the successful reruns: Git's index cache refresh required comparing staged entries rather than opaque index-file bytes; a synthetic seed needed to exclude its toolchain symlink; nested Node test invocations needed to clear `NODE_TEST_CONTEXT`; and one assertion needed the consolidated canonical-mode error code. No production runtime behavior or test exclusion was changed to obtain a pass.

## Acceptance coverage

The IDs below refer to the implementation specification's regression matrix.

| Cases | Evidence |
| --- | --- |
| B01–B12 | [Build tests](build.test.js): deterministic default candidate, no-repair drift checks, explicit distribution guard, invalid selectors, additions/deletions/renames/modes, compiler and path failures, overlays, lock ownership, Python/Swift/CommonJS/ESM resources. Real populated-mount rebuild supplements the fixtures. |
| T01–T12 | [Candidate-only paths](candidate-paths.test.js), [installation](installation.test.js), [runner tests](../run-tests/run-tests.test.js), [process gate](../run-tests/gate.test.js), Python tests and complete/partial gates. A new skill, heading, and executable exist only in source/candidate; invalid targets and broken links fail. Isolated full-pipeline signatures prove tracked-state preservation. |
| H01–H18 | [Local commit fixtures](../git-hooks/local-commit.test.js) and [timestamp fixtures](../git-hooks/post-commit.test.js): real automatic/conflict merges, linked worktrees, temporary partial-commit indexes, staged/unstaged disagreement, protected changes including unusual names and types, missing Git objects, fast-forward/rebase, and hook replacement. Git/shell-only PATH proves commits need no Docker or host compiler. |
| P01–P16 | [Range derivation](../bump-version/derive-bump-level.test.js) and [release policy](../bump-version/release-policy.test.js): exact inputs, merged subjects/resolutions, deletions/modes/reverts, range catch-up, older PR bases, edit-then-restore rejection, malformed nearest anchors, legacy 3.1.9, invalid history, and filename/subject separation. |
| R01–R20 | [Publication transactions](publication.test.js), release-policy tests, and raw-index build tests: actual compiler output and local bare-remote pushes, generated addition/deletion, stale index bytes/modes, forbidden inventory, source/package mutation, stage failures, raced retesting, manual increments, accepted-push transport errors, uncertain inspection/rerun, bounded rejection, workflow mismatch, and final trailers/identity/timestamps. |
| C01–C06 | [Launcher fixtures](../dev/launcher.test.js), real cold setup, populated-mount rebuild, and Git/shell-only hook fixtures. Nested paths are created as the invoking UID; retained volumes are reused. |

Publication fixtures extract and execute the publisher shell from the actual workflow in disposable clones and local bare remotes. Artifact assembly, TypeScript compilation, version changes, structural validation, index validation, commits, and pushes are real. Fixture setup/gate commands are controlled probes that record the consumed source SHA; root dependency installation reuses the locked local toolchain. The separate complete gates provide runtime coverage. These fixtures are not a live GitHub Actions run.

An independent Harness Advisor review examined source policy, publication binding, races, and idempotency. Its suggested edge cases were tested, including stale raced workflows, failed remote inspection, and release history moved onto second-parent ancestry. First-parent release continuity remains the specified contract and is documented in the [versioning guide](../../docs/development/versioning.md).

## Everyday commands and operational limits

Install local hooks once per clone on the host:

```sh
git config core.hooksPath .githooks
```

On Linux/WSL2:

```sh
./scripts/dev setup
# After source edits:
./scripts/dev exec npm run build
./scripts/dev exec node scripts/setup-tests.js
./scripts/dev exec node scripts/run-tests.js
```

On macOS, run `npm ci --include=dev`, `npm run build`, `node scripts/setup-tests.js`, and `node scripts/run-tests.js` directly. Setup is required before each complete gate because the gate removes `.venv`. Commit intended source, tooling, tests, and documentation; publication owns the canonical package and `dist/`.

At this verification boundary, no GitHub release, production push, workflow dispatch, repository settings change, live plugin-cache installation, or host user-level skill-data modification had been performed. Real GitHub runner execution had not been authorized, so hosted credentials, queue activation, and GitHub service behavior are not established by this receipt. Subsequent authorization to push can trigger the release workflow; its outcome must be reported separately. The configured Ubuntu 24.04/Python 3.12 jobs were not reproduced exactly by the local container. Native macOS was unavailable; the 60 platform skips remain explicit. Local benchmark execution is an entrypoint check, not a performance qualification.

Local hooks are bypassable and require per-clone setup. Post-push CI cannot provide pre-admission enforcement on an unrestricted branch. Hosted `--skip-gif` coverage excludes GIF and native macOS execution. Run-ID deduplication depends on retaining release records on first-parent history; rewritten history requires explicit operator recovery.
