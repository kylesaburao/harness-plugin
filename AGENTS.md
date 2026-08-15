# Repository architecture

This repository distributes the same Agent Skills package to Codex and Claude Code.

## Source of truth

`plugins/harness/skills/` is canonical.

Do not create separate Claude and Codex copies of a skill (e.g. `claude/skills/foo/` and `codex/skills/foo/`). One `SKILL.md` per skill, consumed directly by both harnesses.

Shared `SKILL.md` files stick to portable Agent Skills frontmatter: `name`, `description`, and optionally `license`, `compatibility`, `metadata`, `allowed-tools`. Platform-specific behavior belongs in `.claude-plugin/`, `.codex-plugin/`, hooks, agents, or configuration, not in `SKILL.md`.

Claude-only component kinds with no Codex equivalent (e.g. `plugins/harness/output-styles/`) live at the plugin root next to `skills/`. Codex ignores them since `.codex-plugin/plugin.json` pins its component list explicitly. No dual-copy concern applies here since there is nothing to keep in sync.

## Skills that run scripts

Only `plugins/harness/` is installed by the plugin. Anything a skill executes therefore lives inside that skill's own directory, never at the repository root:

```
plugins/harness/skills/<skill>/
  SKILL.md
  scripts/      executables the skill runs
  references/   long-form docs the skill reads on demand
  tests/        tests for those scripts
  package.json  only when the skill has npm dependencies
```

The no-dual-copy rule applies here too. A script has one home, under the skill that runs it, and other things point at that path rather than keeping a second copy.

Prefer no dependencies. `wake-desktop` was rewritten to build its Wake-on-LAN packet with `node:dgram` and probe with the system `ping` specifically so it runs from a plugin cache directory with nothing installed. Add a dependency only when the standard library genuinely cannot do the job, as with `archiver` in `back-up-directories`, and give that skill an `INSTALL.md`.

### Preflight contract

Every script a skill runs must let a calling agent find out whether it can work, in one call, without reading source or interpreting a stack trace. All of them implement the same contract:

- `--preflight` runs the environment and dependency checks, does no work, and exits.
- `--json` reports machine-readably. `--help` prints usage. Both are accepted everywhere.
- Exit `0` is success or a passed preflight. Exit `2` means the work never started: bad usage, a missing dependency, an unsupported platform, or invalid input. Any other non-zero status means the work started and failed. `back-up-directories` keeps its pre-existing `EXIT` values, where `3` is configuration validation, so for that script both `2` and `3` mean nothing was written.
- Failures go to stderr as `ERROR [code]: condition` followed by `Remedy: command`, or as `{"error":{"code","condition","remedy"}}` under `--json`. The `code` is a stable identifier an agent can branch on. The `remedy` is the exact thing that fixes it.
- Arguments are validated before the environment, so a typo is never reported as a missing dependency.
- A normal run performs the same preflight before touching anything, so the probe and the real run cannot disagree.
- The `SKILL.md` tells the agent to relay a preflight diagnosis verbatim instead of diagnosing independently, matching how `write-asd-ste100` handles its reference-bundle errors.

The diagnostic shape comes from `plugins/harness/skills/write-asd-ste100/scripts/ste_data.py`, which already reported a code, the failed condition, and an initialization command.

## Provenance

The `back-up-directories`, `convert-video-to-gif`, and `wake-desktop` skills came from the separate `kylesaburao/utils` repository, merged in with its history intact. That repository is no longer the home of this code.

## Versioning

No `VERSION` file, no manual version bumps, no sync script. `plugins/harness/.codex-plugin/plugin.json` carries a static `version` field that is never incremented. The git commit history on `main` is the actual update signal.

This is a deliberate deviation from a more elaborate proposal that used a synced `VERSION` file. It was tested, not assumed. See below.

**Verified, local source:** with a `codex plugin marketplace add <local-path>` install (source type `local`), re-running `codex plugin add harness@harness-plugin` after editing `skills/hello-world/SKILL.md` overwrote the cached copy under `plugins/cache/<marketplace>/<plugin>/<version>/` with the new content, even though `version` in `.codex-plugin/plugin.json` was unchanged. `codex plugin marketplace upgrade` refused on a local-source marketplace ("not configured as a Git marketplace"). That command only applies to Git-sourced marketplaces, i.e. installs done via `owner/repo` or a Git URL. Test performed in an isolated `CODEX_HOME`, not against the real user config.

**Verified, Git-hosted source:** `codex plugin marketplace add kylesaburao/harness-plugin` followed by editing `skills/hello-world/SKILL.md`, committing, pushing to `main`, then `codex plugin marketplace upgrade harness-plugin`. The cached copy picked up the new content with `version` unchanged. Confirmed by the user on a real Codex install. No CI version-stamping needed.

## Out of scope for now

`scripts/validate.py`, `scripts/sync-version.py`, `VERSION`, CI, `tests/evals/`, and platform-specific `claude/`/`codex/` subdirectories under `plugins/harness/`. Add these only when an actual need appears.
