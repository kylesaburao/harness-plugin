# Repository architecture

This repository distributes the same Agent Skills package to Codex and Claude Code.

## Source of truth

`plugins/harness/skills/` is canonical.

Do not create separate Claude and Codex copies of a skill (e.g. `claude/skills/foo/` and `codex/skills/foo/`). One `SKILL.md` per skill, consumed directly by both harnesses.

Shared `SKILL.md` files stick to portable Agent Skills frontmatter: `name`, `description`, and optionally `license`, `compatibility`, `metadata`, `allowed-tools`. Platform-specific behavior belongs in `.claude-plugin/`, `.codex-plugin/`, hooks, agents, or configuration, not in `SKILL.md`.

Claude-only component kinds with no Codex equivalent (e.g. `plugins/harness/output-styles/`) live at the plugin root next to `skills/`. Codex ignores them since `.codex-plugin/plugin.json` pins its component list explicitly. No dual-copy concern applies here since there is nothing to keep in sync.

## Skills that run scripts

Only `plugins/harness/` is installed by the plugin. Skill entrypoints and skill-specific deterministic code live under `plugins/harness/skills/<skill>/`:

```
plugins/harness/skills/<skill>/
  SKILL.md
  scripts/      executables the skill runs
  references/   long-form docs the skill reads on demand
  package.json  only when the skill has npm dependencies
```

A deterministic module used by two or more production skills can live under `plugins/harness/shared/` only when it implements the same non-trivial operation, has a narrow API, and all consumers need coordinated changes. Every imported production module remains under `plugins/harness/` so plugin installation includes it. Do not create a shared module for superficial structural similarity.

Shared production code does not relax the requirement that every `SKILL.md` contains its own complete instructions and contract. The GIF runner is skill-local because only one skill consumes it. The backup helper is test-only because production never imports it.

New skill executables use Node.js by default. Use the oldest supported Node.js version that
provides the required standard-library APIs, and document that minimum in the skill. Use
Bash, Python, or another runtime only when a concrete platform API, maintained library, or
existing artifact makes Node materially worse, and document that reason in the skill. Do
not rewrite an existing executable only to make its runtime match this default.

## Tests

Tests live at the repository root, in `tests/<skill-name>/`, never inside the skill.

Tests, fixtures, benchmarks, and development-only helpers remain at repository root and never ship. Installing a plugin copies the whole plugin directory into the harness's plugin cache, and neither Claude Code nor Codex supports excluding files from that copy. Anything under `plugins/harness/` is therefore shipped to every install. Tests reach their subject by relative path, and they run from a clone, where both trees exist.

Documentation-restatement tests are intentionally retained. Test stable public behavior at the lowest useful layer, plus a small consumer integration test. Remove runtime parity tests when the obsolete runtime is removed. Remove implementation-detail tests when retained observable tests cover the contract. Treat performance comparisons as execution evidence, not permanent timing tests, unless timing is already a public contract.

```sh
node --test tests/back-up-directories/*.test.js
node --test tests/wake-desktop/*.test.js
node --test tests/create-discord-emoji-gif/*.test.js
node --test tests/bump-version/*.test.js
node --test tests/git-hooks/*.test.js
python3 -m unittest discover -s tests/write-asd-ste100 -v
```

The backup tests need that skill's dependency installed first (`npm install --omit=dev --prefix plugins/harness/skills/back-up-directories`). The others need nothing.

The same reasoning applies to anything else that only exists to develop the code. If it never runs for someone who installed the plugin, it does not belong under `plugins/harness/`. Repo-root `scripts/` is where that development tooling lives, `bump-version.js` and `derive-bump-level.js` among it.

Prefer no dependencies. `wake-desktop` builds its Wake-on-LAN packet with `node:dgram` and probes with the system `ping` so it runs from a plugin cache directory with nothing installed. Add a dependency only when the standard library genuinely cannot do the job, as with `archiver` in `back-up-directories`, and give that skill an `INSTALL.md`.

### Preflight contract

Every script a skill runs must let a calling agent find out whether it can work, in one call, without reading source or interpreting a stack trace. All of them implement the same contract:

- `--preflight` runs the environment and dependency checks, does no work, and exits.
- `--json` reports machine-readably. `--help` prints usage. Both are accepted everywhere.
- Exit `0` is success or a passed preflight. Exit `2` means the work never started: bad usage, a missing dependency, an unsupported platform, or invalid input. Any other non-zero status means the work started and failed. `back-up-directories` keeps its pre-existing `EXIT` values, where `3` is configuration validation, so for that script both `2` and `3` mean nothing was written.
- Failures go to stderr as `ERROR [code]: condition` followed by `Remedy: command`, or as `{"error":{"code","condition","remedy"}}` under `--json`. The `code` is a stable identifier an agent can branch on. The `remedy` is the exact thing that fixes it.
- Arguments are validated before the environment, so a typo is never reported as a missing dependency.
- A normal run performs the same preflight before touching anything, so the probe and the real run cannot disagree.
  - Because of that, a calling agent dispatches the real command directly by default, not `--preflight` first. A failure from the real run carries the identical diagnosis `--preflight` would have given, so relay it rather than re-running `--preflight` to double-check. A `SKILL.md` gives `--preflight` its own dispatch only for a concrete reason it names, such as the real run being user-interactive and unanswerable on the user's behalf (`back-up-directories`), or the real run being materially expensive or side-effecting to attempt blind.
- The `SKILL.md` tells the agent to relay a failure diagnosis verbatim, from whichever call produced it, instead of diagnosing independently, matching how `write-asd-ste100` handles its reference-bundle errors.
- The same rule applies to the success path: a script that produces an artifact prints a metadata report on stdout describing that artifact as actually published (not a pre-publication intermediate), `--json` makes it machine-readable, and the `SKILL.md` tells the agent to relay the report's fields rather than re-measuring the artifact with another command. `create-discord-emoji-gif`'s converters follow this: their `Report:` block and `checks` already contain everything `ffprobe`, `stat`, or a hash tool would tell an agent, so the `SKILL.md` forbids running any of those again after a successful dispatch.

The diagnostic shape matches `plugins/harness/skills/write-asd-ste100/scripts/ste_data.py`, which reports a code, the failed condition, and an initialization command.

## Versioning

`plugins/harness/.codex-plugin/plugin.json` and `plugins/harness/.claude-plugin/plugin.json` both carry a `version` field, and the two are always kept equal. `scripts/bump-version.js` is the only thing that changes them: `--bump-major`, `--bump-minor`, or `--bump-patch`, where bumping a higher-priority value resets the lower-priority ones to 0. Never edit either `version` field by hand, except to recover from a `VERSION_MISMATCH` the script reports.

A push to `main` runs `.github/workflows/bump-version.yml`, which bumps the patch version automatically. `scripts/derive-bump-level.js` scans every commit since the last `chore: bump version to X.Y.Z` commit, not just the newest one, so a `[bump:minor]` or `[bump:major]` tag survives a batched push. The workflow's own bump commits are excluded from re-triggering itself, and its push step retries against freshly-fetched state so a race with another push to `main` doesn't lose a bump.

The version tracks what ships, not what lands, so the bump is gated on paths. A run bumps only if some commit in that range touched `plugins/`, `.claude-plugin/`, or `.agents/plugins/` — the plugin tree itself and the two marketplace manifests. A push that only edits `tests/`, `scripts/`, `.github/`, `.githooks/`, or the root docs changes nothing observable to someone who installed the plugin, so it derives `none` and the workflow exits without committing.

Paths decide *whether* to bump; subjects still decide *how much*. Once any commit in the range is relevant, the level comes from every subject in it, so a `[bump:minor]` tag is honored even sitting on a docs commit — the tag is a deliberate statement about release size and the path gate must not quietly downgrade it. Gating in the script rather than in the workflow's `on: push:` is what preserves the catch-up behavior above: a docs-only push still runs, still sees an earlier un-bumped `plugins/` commit in its range, and still bumps it, where a `paths:` filter would skip that run and strand the bump. `workflow_dispatch` is ungated — a human choosing a level is asking for it directly.

## Commit timestamps

Every commit in this repository, author and committer date alike, uses the fixed instant `1999-12-31T23:59:00-08:00`. Both dates must be set together: `git commit --date=` alone sets only the author date, and on `git commit --amend` even `GIT_AUTHOR_DATE` is silently ignored unless `--date=` is passed explicitly (amend preserves the original author date otherwise). Never use `git commit --date=` on its own for this.

- CI: `.github/workflows/bump-version.yml` exports `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` before its `git commit`.
- Local commits: `.githooks/post-commit` amends HEAD to the fixed date if it doesn't already match, then exits without amending once it does (this is what stops it recursing on its own re-invocation). It only fires if enabled once per clone: `git config core.hooksPath .githooks`. This does not survive a fresh clone, so re-run it after cloning.
