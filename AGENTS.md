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

## User-level persistence

A skill never writes inside `plugins/harness/`. Installing the plugin copies the whole plugin directory into the harness's version-keyed plugin cache, neither Claude Code nor Codex supports excluding files from that copy, and the next plugin upgrade replaces the cached tree. Anything a skill writes into its own installed directory is therefore per-harness and destroyed on upgrade.

Everything a skill needs to persist across invocations or across plugin upgrades goes under a single user-level root instead:

```
~/.harness-plugin/<skill-name>/
```

`<skill-name>` is the skill's directory name under `plugins/harness/skills/`, so the mapping is mechanical. Codex and Claude Code share this root, so both harnesses read and write the same state. A skill owns exactly its own subtree and never touches another skill's. Nothing under the root is needed for plugin installation or skill discovery — only for a skill to actually run — which is what keeps installation hermetic.

`write-asd-ste100` is the first skill to use this. Its generated ASD-STE100 dictionary bundle lives at `~/.harness-plugin/write-asd-ste100/bundles/<source-config-sha256>/`.

### Two artifact classes

The root holds two kinds of thing, and they have different contracts.

**Initialization artifacts** are data a skill cannot work without, generated once and expensive to rebuild — the ASD dictionary bundle is the example. A missing, incomplete, stale, or modified artifact is a hard failure, reported through the `### Preflight contract` shape below: exit status 2, a stable error code, the failed condition, the absolute path to the generated data, and the exact initialization command. The `SKILL.md` tells the agent to relay that diagnosis rather than diagnose independently.

**Configuration and stored arguments** are settings a user chose to save — predefined options, predefined command arguments. Absence is normal and never an error. A skill falls back to its defaults and runs correctly on a machine where the root does not exist at all. Precedence is explicit arguments, then stored configuration, then defaults. No skill consumes stored configuration yet; when one does, JSON with a `schema_version` field is the default format, matching the precedent in `plugins/harness/skills/write-asd-ste100/references/source-config.json` and `scripts/initialize_references.py`. This is deliberately not the `plugin-dev:plugin-settings` `.claude/<name>.local.md` pattern, which is project-scoped and Claude-specific where this root is user-scoped and harness-neutral.

### Keying and durability

Key a directory by a hash of whatever determines its contents, not by plugin version. `write-asd-ste100` keys its bundle by the SHA-256 of the tracked `references/source-config.json` (`plugins/harness/skills/write-asd-ste100/scripts/ste_data.py:58`), so a plain version bump reuses the existing bundle and two bundles for differing configurations coexist. Replacement is atomic: stage a new copy beside the destination, validate the staged copy, then `os.replace` it into place, so a failed run leaves installed state untouched (`initialize_references.py`, `replace_generated`). An artifact carries a manifest binding its files to their source with hashes and byte counts, so validation is self-contained.

Nothing prunes stale entries. Changing `source-config.json` orphans the previous bundle indefinitely. The whole root is safe to delete — a skill regenerates its initialization artifacts or falls back to defaults. No secrets or credentials belong here; these are plain unencrypted files in the user's home directory.

The pre-existing in-tree location `plugins/harness/skills/write-asd-ste100/references/generated/` is where the bundle lived before it moved to the user-level root. It is now valid only as an `--import-from` source, and an imported bundle is validated against the current source configuration before it is copied (`initialize_references.py`, `validate_import_source`).

## Plugin contents catalog

`README.md`'s "Plugin contents" section is the canonical, human-scannable catalog of what the plugin ships - skills and output styles, each with a one-line purpose. Adding, removing, or renaming a skill or output style requires updating that table in the same commit; `tests/inventory/readme-inventory.test.js` enforces it.

## Tests

Tests live at the repository root, in `tests/<skill-name>/`, never inside the skill. The one exception is a whole-tree invariant test that isn't scoped to a single skill, such as `tests/inventory/`, which checks `README.md` against the plugin tree itself.

Tests, fixtures, benchmarks, and development-only helpers remain at repository root and never ship. Installing a plugin copies the whole plugin directory into the harness's plugin cache, and neither Claude Code nor Codex supports excluding files from that copy. Anything under `plugins/harness/` is therefore shipped to every install. Tests reach their subject by relative path, and they run from a clone, where both trees exist.

Documentation-restatement tests are intentionally retained. Test stable public behavior at the lowest useful layer, plus a small consumer integration test. Remove runtime parity tests when the obsolete runtime is removed. Remove implementation-detail tests when retained observable tests cover the contract. Treat performance comparisons as execution evidence, not permanent timing tests, unless timing is already a public contract.

```sh
node --test tests/back-up-directories/*.test.js
node --test tests/create-discord-emoji-gif/*.test.js
node --test tests/extract-video-frames/*.test.js
node --test tests/bump-version/*.test.js
node --test tests/git-hooks/*.test.js
node --test tests/inventory/*.test.js
python3 -m unittest discover -s tests/write-asd-ste100 -v
```

The backup tests need that skill's dependency installed first (`npm install --omit=dev --prefix plugins/harness/skills/back-up-directories`). The others need nothing.

The same reasoning applies to anything else that only exists to develop the code. If it never runs for someone who installed the plugin, it does not belong under `plugins/harness/`. Repo-root `scripts/` is where that development tooling lives, `bump-version.js` and `derive-bump-level.js` among it.

Prefer no dependencies. Add a dependency only when the standard library genuinely cannot do the job, as with `archiver` in `back-up-directories`, and give that skill an `INSTALL.md`.

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
