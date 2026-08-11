# Repository architecture

This repository distributes the same Agent Skills package to Codex and Claude Code.

## Source of truth

`plugins/harness/skills/` is canonical.

Do not create separate Claude and Codex copies of a skill (e.g. `claude/skills/foo/` and `codex/skills/foo/`). One `SKILL.md` per skill, consumed directly by both harnesses.

Shared `SKILL.md` files stick to portable Agent Skills frontmatter: `name`, `description`, and optionally `license`, `compatibility`, `metadata`, `allowed-tools`. Platform-specific behavior belongs in `.claude-plugin/`, `.codex-plugin/`, hooks, agents, or configuration, not in `SKILL.md`.

Claude-only component kinds with no Codex equivalent (e.g. `plugins/harness/output-styles/`) live at the plugin root next to `skills/`. Codex ignores them since `.codex-plugin/plugin.json` pins its component list explicitly. No dual-copy concern applies here since there is nothing to keep in sync.

## Versioning

No `VERSION` file, no manual version bumps, no sync script. `plugins/harness/.codex-plugin/plugin.json` carries a static `version` field that is never incremented. The git commit history on `main` is the actual update signal.

This is a deliberate deviation from a more elaborate proposal that used a synced `VERSION` file. It was tested, not assumed. See below.

**Verified, local source:** with a `codex plugin marketplace add <local-path>` install (source type `local`), re-running `codex plugin add harness@harness-plugin` after editing `skills/hello-world/SKILL.md` overwrote the cached copy under `plugins/cache/<marketplace>/<plugin>/<version>/` with the new content, even though `version` in `.codex-plugin/plugin.json` was unchanged. `codex plugin marketplace upgrade` refused on a local-source marketplace ("not configured as a Git marketplace"). That command only applies to Git-sourced marketplaces, i.e. installs done via `owner/repo` or a Git URL. Test performed in an isolated `CODEX_HOME`, not against the real user config.

**Verified, Git-hosted source:** `codex plugin marketplace add kylesaburao/harness-plugin` followed by editing `skills/hello-world/SKILL.md`, committing, pushing to `main`, then `codex plugin marketplace upgrade harness-plugin`. The cached copy picked up the new content with `version` unchanged. Confirmed by the user on a real Codex install. No CI version-stamping needed.

## Out of scope for now

`scripts/validate.py`, `scripts/sync-version.py`, `VERSION`, CI, `tests/evals/`, and platform-specific `claude/`/`codex/` subdirectories under `plugins/harness/`. Add these only when an actual need appears.
