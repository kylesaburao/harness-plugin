# Versioning and commits

[Development](README.md) / Versioning

`src/harness/package.json` owns the only editable plugin version. `scripts/bump-version.js` changes it with `--bump-major`, `--bump-minor`, or `--bump-patch`. Run `npm run build` afterward to inject that version into both generated host manifests. Source host manifests contain no version field. The backup package version is independent.

A push to `main` runs `.github/workflows/bump-version.yml`. When the path gate below finds a shipped change, the default bump is patch. `scripts/derive-bump-level.js` scans every commit since the last `chore: bump version to X.Y.Z` commit on first-parent ancestry, including merged commits in that range, so a `[bump:minor]` or `[bump:major]` subject tag survives a batched push. The workflow's own bump commits do not trigger another bump. Its push step retries against freshly fetched state to handle concurrent pushes.

The version tracks what ships, not what lands, so the bump is gated on paths. A run bumps only if some commit in that range touched `dist/`, `.claude-plugin/`, or `.agents/plugins/`, the plugin tree itself and the two marketplace manifests. A push that only edits `tests/`, `scripts/`, `.github/`, `.githooks/`, or documentation changes nothing observable to someone who installed the plugin, so it derives `none` and the workflow exits without committing.

Paths decide whether to bump. Subjects decide the level, with major taking priority over minor and patch. Once any commit in the range is relevant, tags in every subject count, including tags on documentation commits.

The path gate runs inside the derivation script. A documentation-only push can therefore catch an earlier shipped change that has not yet received a bump. A workflow path filter would miss that case. Manual `workflow_dispatch` bypasses the path gate and uses the requested level.

## Manual bump

Run one of these from the repository root when a manual bump is needed:

```sh
node scripts/bump-version.js --bump-patch
node scripts/bump-version.js --bump-minor
node scripts/bump-version.js --bump-major
```

Choose one command, then run `npm run build`, setup, and the required gate. Commit the canonical package and generated output together. Each automated push retry reinstalls the locked toolchain, validates fresh main, bumps the source version, rebuilds, and tests the versioned artifact before staging its owned changes. The resulting bump commit completes a release. Same-version cache refresh before that commit is not guaranteed.

The [bump script](../../scripts/bump-version.js), [level derivation](../../scripts/derive-bump-level.js), and [workflow](../../.github/workflows/bump-version.yml) implement this policy.

## Hook installation

Run `git config core.hooksPath .githooks` once per clone. This enables the timestamp
`post-commit` hook and the distribution freshness `pre-push` hook. The latter checks
outgoing committed snapshots with isolated locked build dependencies, so pushes can
require network access and the platform's development environment. See the
[push contract](build.md#before-pushing). Local hooks can be bypassed, and installation
does not survive a fresh clone. CI retains its freshness checks.

## Commit timestamps

Every commit in this repository, author and committer date alike, uses the fixed instant `1999-12-31T23:59:00-08:00`. Both dates must be set together: `git commit --date=` alone sets only the author date, and on `git commit --amend` even `GIT_AUTHOR_DATE` is silently ignored unless `--date=` is passed explicitly (amend preserves the original author date otherwise). Never use `git commit --date=` on its own for this.

- CI: `.github/workflows/bump-version.yml` exports `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` before its `git commit`.
- Local commits: `.githooks/post-commit` amends HEAD to the fixed date if it doesn't already match, then exits without amending once it does (this is what stops it recursing on its own re-invocation). It only fires if enabled once per clone: `git config core.hooksPath .githooks`. This does not survive a fresh clone, so re-run it after cloning.
