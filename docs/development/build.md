# Build and distribution

[Development](README.md) / Build

`src/harness/` is the editable implementation, `.build/harness/` is the ignored development artifact, and `dist/harness/` is the last successfully published artifact. Both generated trees have the same installation layout. The root marketplace catalogs continue to select `./dist/harness`; `.build/harness/` is never a marketplace source.

## Local workflow

On macOS, prepare and test an ordinary change with:

```sh
npm ci --include=dev
npm run build
node scripts/setup-tests.js
node scripts/run-tests.js
```

Repeat `npm ci` after root dependency inputs change. Rebuild after source or build-input changes. Setup operates on an already-built artifact and is required before every complete gate because the gate removes `.venv`. On Linux/WSL2, use the corresponding `./scripts/dev` commands in the [container guide](container.md).

Ordinary commits contain source, tooling, tests, and documentation. Do not edit, regenerate, or stage `dist/`, and do not edit the release-owned `src/harness/package.json`. Source can legitimately be newer than the published artifact.

## Artifact targets and commands

The repository exposes two fixed target names. It does not accept arbitrary output paths:

| Target | Root | Purpose |
| --- | --- | --- |
| `development` | `.build/harness/` | Local builds, focused tests, pull-request checks, and read-only push verification. |
| `distribution` | `dist/harness/` | Release builds, release tests, publication validation, and explicit read-only inspection. |

The default target is `development`:

```sh
npm run build                 # reconcile .build/harness/
npm run build:check           # compare .build/harness/ without repair
npm run validate:build        # validate .build/harness/
node scripts/setup-tests.js   # set up .build/harness/ dependencies
node scripts/run-tests.js     # test .build/harness/
```

Distribution inspection is explicit:

```sh
npm run build:dist:check
npm run validate:dist
node scripts/run-tests.js --target distribution
```

`npm run build:dist` and the canonical version writer require all publication-intent conditions used by the trusted release workflow: the GitHub Actions repository, main ref, push or manual-dispatch event, and `HARNESS_RELEASE_WRITE=1`. Generic `CI=true` is not permission to write release-owned files. This guard prevents accidental use; environment variables are not authentication.

`--help` for the build, validation, setup, and test commands is read-only. Unknown, missing, duplicate, or conflicting target arguments fail with exit status 2. `HARNESS_TEST_TARGET` selects the artifact for direct test helpers only; it never redirects the builder. Its valid values are `development` and `distribution`.

## Local commit policy

Enable the repository hooks once per clone:

```sh
git config core.hooksPath .githooks
```

The `pre-commit` hook uses only POSIX shell and Git. It inspects the active index, including the temporary index used by `git commit --only`, and rejects additions, deletions, content changes, renames, type changes, or mode changes in either protected area:

```text
dist/
src/harness/package.json
```

The hook never builds, installs dependencies, fetches, restores, unstages, or changes the working tree. An unstaged protected edit therefore does not block an unrelated source-only commit, while a protected edit in the actual commit index does. There is no CI-variable bypass.

An automatic or conflict-resolved merge may inherit a protected pair only when the complete staged pair exactly matches the locally fetched `refs/remotes/origin/main`. The `pre-merge-commit` wrapper supplies the automatic-merge context; ordinary `pre-commit` recognizes a valid `MERGE_HEAD` after conflict resolution. If the remote-tracking ref is missing or stale, fetch `origin/main` explicitly and retry. The hooks never fetch or choose generated conflict hunks for you. Fast-forward updates need no exception, and source-only commits can be rebased normally onto a published release.

There is no build-time `pre-push` hook. Candidate construction and source-policy validation belong in CI. Local hooks are bypassable and per-clone; they are workflow safeguards, not server-side admission control.

## Ownership and assembly

TypeScript compiles through the locked local CLI with strict checking, NodeNext resolution, and ES2022 output. Ordinary `.ts` modules emit CommonJS `.js` under the plugin package boundary. The sampler's `.mts` emits native ESM `.mjs`. Python and Swift stay in their existing languages, and assets copy byte for byte. The canonical version is injected into both versionless source manifest templates.

Both targets use the same inventory, compilation, copying, validation, and byte-oriented reconciliation. Each invocation owns unique staging under `.build/`; it never deletes the entire directory. Writing builds use separate `.build/development.lock` and `.build/distribution.lock` directories. A check creates only private staging and neither repairs its target nor removes another build's lock or stage.

The selected artifact can retain these two opaque local overlays:

```text
skills/back-up-directories/node_modules/
skills/write-asd-ste100/scripts/__pycache__/
```

Reconciliation preserves their contents and mounted-directory ancestors. Published Git inventory must still reject tracked overlay content. Builds do not install runtime dependencies, initialize references, or compile the Swift helper. Source executable bits determine generated executable intent; a shebang alone does not make a file executable.

## CI publication boundary

Pull requests and the release workflow's read-only test job validate submitted commit history before installing dependencies or building `.build/harness/`. They then run the hosted `--skip-gif` candidate gate and verify that no tracked checkout content changed.

The publisher starts from freshly fetched `main`, validates the unreleased source range and the existing published pair, selects the bump level, and changes only the canonical version. It builds `dist/harness/`, sets up and tests that exact versioned target, performs a final no-repair comparison, stages the entire owned pair, and validates indexed bytes and modes before creating one release commit. A raced source snapshot is discarded and rebuilt, set up, tested, and validated from the new tip. No failed local reconciliation becomes visible unless the final commit passes every check and an ordinary fast-forward push succeeds.

## Failure handling

- Newer source with an older `dist/harness/` is an expected unpublished state. Build and test `.build/harness/`; do not regenerate tracked output.
- A stale development artifact is repaired with `npm run build` (inside `./scripts/dev exec` on Linux/WSL2).
- Missing candidate dependencies or `.venv` require target-aware setup after the candidate and root toolchain exist.
- A distribution freshness check can fail when source is newer. It is an explicit inspection result and must not block ordinary development.
- Compiler, inventory, or candidate validation failures leave the selected previous artifact unchanged. A reconciliation I/O failure is explicit; fix the cause and rerun the same target.
- After abnormal termination, confirm the writer stopped before removing its target-specific lock. Never remove all of `.build/` as recovery.
- A rejected commit leaves the index and working tree intact. Deliberately remove protected paths from the intended commit; do not bypass the hook or hand-edit generated output.
- Symlinks, output collisions, unsupported assets, and incompatible destination ancestors fail before publication writes.

Public component links continue to point at canonical `dist/harness/...` installation paths. Development link and inventory checks map only those installed-tree targets to the selected candidate so an unreleased skill or heading can be verified without pretending it is already installed.
