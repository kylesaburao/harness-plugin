# Versioning and commits

[Development](README.md) / Versioning

`src/harness/package.json` owns the canonical plugin version, but publication owns changes to that file. Developers do not bump it locally. Source host manifests remain versionless templates, and the independent backup-skill package remains normally editable.

The release workflow changes only the canonical `version`, builds the complete `dist/harness/` artifact, and commits the canonical package and generated distribution together. The distribution package and both generated host manifests must all carry the same new version.

## Automatic eligibility and bump level

A push to `main` runs `.github/workflows/bump-version.yml`. Automatic publication is eligible when any commit after the most recent validated first-parent release record touches one of these inputs:

```text
src/harness/
.claude-plugin/
.agents/plugins/
scripts/build.js
scripts/artifact-paths.js
tsconfig.json
package.json
package-lock.json
.gitattributes
.github/workflows/bump-version.yml
```

Directory matches use path boundaries and file matches are exact. `dist/` is not an input: direct output modification is a policy violation rather than a reason to rebuild it. Tests, documentation, local hooks, other workflows, and test-only tooling do not independently make a range eligible.

The range covers every commit since the validated release anchor, including merged commits and merge-resolution changes. Deletions, mode changes, and moves out of an input directory count. A reverted input change remains conservatively eligible. This range catch-up allows a later documentation-only push to publish an earlier source change whose release did not complete.

For an eligible automatic range, the highest subject tag wins:

```text
[bump:major] -> major
[bump:minor] -> minor
otherwise    -> patch
```

Once a range is eligible, tags in any subject in that range count, including a documentation commit. A tag alone does not make an otherwise irrelevant range eligible.

## Manual publication

Use the `Bump version` workflow's `workflow_dispatch` input on `main` for a deliberate manual patch, minor, or major release. Manual dispatch bypasses automatic input eligibility and uses exactly the selected level, even when no source change is pending or commit tags suggest another level. Do not run `scripts/bump-version.js` as a local release recipe.

The workflow validates its event, repository, ref, run ID, selected source history, and executed workflow definition before writing. Its `test` job builds the development candidate with read-only permissions. The publisher separately bumps, builds, sets up, and runs the hosted gate against the exact versioned distribution selected on each attempt.

## Publication transaction

Each successful publication creates one single-parent commit with this shape:

```text
src/harness/package.json   version change only
dist/harness/**           complete generated additions, changes, deletions, and modes
```

The subject remains `chore: bump version to X.Y.Z`. New publisher commits record the selected parent and workflow run ID in `Harness-Source` and `Harness-Release-Run` trailers. The source trailer equals the commit's parent. The run ID makes rerunning the same workflow request idempotent; the attempt number is not a release identity. The existing 3.1.9 release remains a valid legacy anchor without those newer trailers.

Release anchors and run identities are discovered on `main`'s first-parent history. A merge that moves a release onto second-parent ancestry fails the unreleased source-range policy and needs explicit operator recovery; the publisher does not guess another baseline. Removing published history also removes the evidence needed for run-ID deduplication.

Before committing, the workflow verifies source/package/manifest consistency, the selected increment, the complete working checkout, and the raw bytes and modes in the active Git index. It stages only the canonical package and all of `dist/`, sets both required timestamps for the new commit, validates that commit, and pushes without force, merge, or rebase.

The publisher retries at most three genuine push races. Every newer source snapshot gets a new version decision and a complete build/setup/test/validation cycle. Remote inspection confirms publication after a successful push or an uncertain transport result. A rerun that finds the same run's valid release reports `already published` without creating another version. Permission or policy rejection with an unchanged remote, stale executed workflow content, an unreadable remote outcome, or exhausted races fails explicitly.

Automatic runs with no pending eligible work report `no eligible changes`. Concurrency uses one `version-bump` group, keeps running work, and queues ordinary bursts; the finite queue is not a durable release-request log, so range catch-up remains authoritative.

The [version writer](../../scripts/bump-version.js), [level derivation](../../scripts/derive-bump-level.js), [release policy](../../scripts/release-policy.js), and [workflow](../../.github/workflows/bump-version.yml) implement this policy.

## Hook installation and merge synchronization

Run this once per clone:

```sh
git config core.hooksPath .githooks
```

This enables the lightweight `pre-commit`, `pre-merge-commit`, and timestamp `post-commit` hooks. The commit guards use only POSIX shell and Git; committing does not require Node, Python, Docker, dependency installation, or network access.

Ordinary commits reject staged changes anywhere under `dist/` or to the complete `src/harness/package.json` blob. The guard reads the active index and never rebuilds, fetches, restores, unstages, or edits it. There is no generic CI bypass.

A genuine merge can inherit an existing release only when the complete staged protected pair exactly matches the locally available `refs/remotes/origin/main`. Fetch that branch explicitly before retrying a merge when the reference is missing or stale. A fast-forward simply incorporates the existing release commit. Rebase source-only work onto it; do not recreate, amend, or manually combine generated release commits.

These hooks are local and bypassable, and fresh clones require explicit installation. Pull-request and push checks detect prohibited submitted history, but on an unrestricted branch post-push CI is not pre-admission enforcement. Publication validation is rigorous without being cryptographic proof of who controls a Git repository.

## Commit timestamps

Every commit in this repository, author and committer date alike, uses the fixed instant `1999-12-31T23:59:00-08:00`. Both dates must be set together: `git commit --date=` alone sets only the author date, and amend otherwise preserves the original author date.

- CI exports `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` before its release commit.
- Locally, `.githooks/post-commit` amends a newly created commit only when its timestamps differ. Its tree-preserving `--only --amend` does not absorb unrelated staged content from a partial commit, and the hook terminates when both timestamps already match.

Hook configuration does not survive a fresh clone, so run the installation command again after cloning.
