# Repository architecture

This repository distributes the same Agent Skills package to Codex and Claude Code.

## Source of truth

`src/harness/` is the editable source of truth for plugin implementation and bundled resources. Production Node implementation is TypeScript.

`dist/harness/` is the complete generated installation artifact, tracked in Git and installed directly by both marketplaces. Never manually edit generated implementation. Follow this procedure to deliver implementation changes:

1. Edit `src/harness/`. Install the locked root toolchain with `npm ci --include=dev` on first setup or after dependency changes.
2. Run `npm run build` after changes to source implementation, resources, manifest templates, canonical version, compiler configuration, or build tooling. This explicitly compiles TypeScript, copies assets, and injects the source version into both generated host manifests.
3. Run `node scripts/setup-tests.js`, then `node scripts/run-tests.js`. Build before setup, focused runtime tests, or local marketplace testing. Setup and the gate expect an existing current distribution and reject drift without rebuilding it. Setup is required before each full gate because the gate removes `.venv`.
4. Stage intended source and generated distribution together. Run `npm run build:check` and `node scripts/validate-dist.js --tracked` against the staged delivery, inspect the staged diff, then commit both together before pushing. Build check compares the working artifact with a fresh candidate without repairing it. Tracked validation checks the index inventory and modes, so also confirm no intended changes remain unstaged.

On macOS run development commands directly. On Linux/WSL2 use `./scripts/dev exec` for development commands and keep Git operations on the host. Read the [build workflow](docs/development/build.md) for assembly and recovery details.

Both marketplace catalogs select `./dist/harness`. Claude Code and Codex consume that committed tree without root npm installation or a build. Runtime tests and skill setup commands execute its installed paths. CI verifies the checked-in artifact instead of repairing ordinary source changes. The release workflow is the explicit exception: after changing the canonical source version, it builds and tests the versioned artifact before committing it, repeating from fresh source on each push retry. A fresh checkout must therefore already contain usable distribution output. Building does not install skill runtime dependencies, initialize user reference data, or compile the Swift helper.

Do not create separate Claude and Codex copies of a skill (e.g. `claude/skills/foo/` and `codex/skills/foo/`). One `SKILL.md` per skill, consumed directly by both harnesses.

Shared `SKILL.md` files stick to portable Agent Skills frontmatter: `name`, `description`, and optionally `license`, `compatibility`, `metadata`, `allowed-tools`. Platform-specific behavior belongs in `.claude-plugin/`, `.codex-plugin/`, hooks, agents, or configuration, not in `SKILL.md`.

Exception limited to `demonstrate-workflow`: its shared frontmatter may contain `disable-model-invocation: true`. Codex 0.154.0 accepts this Claude extension alongside `agents/openai.yaml` with `policy.allow_implicit_invocation: false`. Codex registers `$harness:demonstrate-workflow` and can load its instructions from quoted mentions. Loading is permitted, but formalization still requires explicit user invocation. Claude behavior is unqualified and outside the current validation scope. Every other shared-frontmatter restriction remains unchanged. See `tests/demonstrate-workflow/QUALIFICATION.md` for evidence.

Claude-only component kinds with no Codex equivalent (e.g. `src/harness/output-styles/`) live at the plugin root next to `skills/`. Codex ignores them since `.codex-plugin/plugin.json` pins its component list explicitly. No dual-copy concern applies here since there is nothing to keep in sync.

## Skills that run scripts

Only `dist/harness/` is installed by the plugin. Skill entrypoints and skill-specific deterministic code live under `src/harness/skills/<skill>/`:

```
src/harness/skills/<skill>/
  SKILL.md
  scripts/      executables the skill runs
  references/   long-form docs the skill reads on demand
  package.json  only when the skill has npm dependencies
```

A deterministic module used by two or more production skills can live under `src/harness/shared/` only when it implements the same non-trivial operation, has a narrow API, and all consumers need coordinated changes. Every imported production module remains under `src/harness/` so plugin installation includes it. Do not create a shared module for superficial structural similarity.

Shared production code does not relax the requirement that every `SKILL.md` contains its own complete instructions and contract. The GIF runner is skill-local because only one skill consumes it. The backup helper is test-only because production never imports it.

## Bundled resource paths

The exact `SKILL.md` instance loaded by the host is authoritative for its bundled resources. A resource-bearing skill must tell the agent to resolve scripts, references, assets, and sibling documents from the host-supplied path for that exact file. Claude Code exposes this directory through `${CLAUDE_SKILL_DIR}` substitution. Expand a catalog root alias only through the mapping supplied with that loaded instance. Preserve the caller's working directory and the skill's existing input and output path semantics.

Use the quoted `<SKILL_DIR>` substitution placeholder in agent-facing bundled executable examples, for example `node "<SKILL_DIR>/scripts/tool.js"`. The placeholder is not a presumed environment variable. Do not infer a skill directory from a conventional Claude or Codex location. Do not select another installed copy by version, timestamp, or search order. Another installation can be used only when the host or user explicitly selects it.

Keep the complete `## Bundled path authority` contract inline in every resource-bearing `SKILL.md`. Loading a shared contract would depend on the same path resolution it governs. `tests/inventory/bundled-path-authority.test.js` discovers the affected tracked skills and enforces the shared wording.

New skill executables use Node.js by default. Use the oldest supported Node.js version that
provides the required standard-library APIs, and document that minimum in the skill. Use
Bash, Python, or another runtime only when a concrete platform API, maintained library, or
existing artifact makes Node materially worse, and document that reason in the skill. Do
not rewrite an existing executable only to make its runtime match this default.

## User-level persistence

A skill never writes inside its installed plugin directory (`dist/harness/` in a checkout). Installing the plugin copies the whole plugin directory into the harness's version-keyed plugin cache, neither Claude Code nor Codex supports excluding files from that copy, and the next plugin upgrade replaces the cached tree. Anything a skill writes into its own installed directory is therefore per-harness and destroyed on upgrade.

Everything a skill needs to persist across invocations or across plugin upgrades goes under a single user-level root instead:

```
~/.harness-plugin/<skill-name>/
```

`<skill-name>` is the skill's directory name under `src/harness/skills/`, so the mapping is mechanical. Codex and Claude Code share this root, so both harnesses read and write the same state. A skill owns exactly its own subtree and never touches another skill's. Nothing under the root is needed for plugin installation or skill discovery — only for a skill to actually run — which is what keeps installation hermetic.

`write-asd-ste100` is the first skill to use this. Its generated ASD-STE100 dictionary bundle lives at `~/.harness-plugin/write-asd-ste100/bundles/<source-config-sha256>/`.

### Two artifact classes

The root holds two kinds of thing, and they have different contracts.

**Initialization artifacts** are data a skill cannot work without, generated once and expensive to rebuild — the ASD dictionary bundle is the example. A missing, incomplete, stale, or modified artifact is a hard failure, reported through the `### Preflight contract` shape below: exit status 2, a stable error code, the failed condition, the absolute path to the generated data, and the exact initialization command. The `SKILL.md` tells the agent to relay that diagnosis rather than diagnose independently.

**Configuration and stored arguments** are settings a user chose to save. JSON with a `schema_version` field is the default format. `wake-desktop` is the first consumer, storing named addresses at `~/.harness-plugin/wake-desktop/config.json`. Its skill-local `manage-targets.js` owns configuration reads and atomic writes. Agents use that CLI rather than editing JSON. `wake-desktop.js` is read-only and reads configuration only with `--target`. An unnamed wake works without the file. Registration and listing treat absence as an empty registry, while an explicitly requested saved target must exist. Named wakes use explicit addresses, then saved addresses, ignoring address environment variables. Unnamed wakes use explicit addresses, then environment variables. Timeout remains explicit, then environment, then default and is never stored. This root is user-scoped and harness-neutral, unlike project-scoped Claude-specific settings.

### Keying and durability

Key a directory by a hash of whatever determines its contents, not by plugin version. `write-asd-ste100` keys its bundle by the SHA-256 of the tracked `references/source-config.json` (`src/harness/skills/write-asd-ste100/scripts/ste_data.py:58`), so a plain version bump reuses the existing bundle and two bundles for differing configurations coexist. Valid installed bundles are immutable, including during `--force`: build and validate a stage, then revalidate the destination under an exclusive-create sibling publication lock. Retain a valid destination unchanged. An absent destination is published with one rename. Only invalid data is moved aside, with attempted rollback on publication failure (`initialize_references.py`, `publish_validated`). A killed publisher can leave a lock and invalid backup for explicit manual recovery. Cleanup and rollback failures report retained paths. An artifact carries a manifest binding its files to their source with hashes and byte counts, so validation is self-contained.

Nothing prunes stale entries. Changing `source-config.json` orphans the previous bundle indefinitely. The whole root is safe to delete — a skill regenerates its initialization artifacts or falls back to defaults. No secrets or credentials belong here; these are plain unencrypted files in the user's home directory.

The historical in-tree location `plugins/harness/skills/write-asd-ste100/references/generated/` is where the bundle lived before it moved to the user-level root. It is now valid only as an `--import-from` source, and an imported bundle is validated against the current source configuration before it is copied (`initialize_references.py`, `validate_import_source`).

## Documentation architecture

`README.md` is the project landing page: introduction, installation, a short discovery-oriented inventory, and navigation. Keep per-skill operating manuals out of it.

`docs/README.md` routes readers by intent. Substantial human usage and configuration guides belong under `docs/`, and contributor documentation belongs under `docs/development/` unless it has a specific repository-entry-point role. Create a guide only for a coherent topic that needs one.

`AGENTS.md` owns repository architecture, development invariants, and instructions for agents modifying this repository. Authored `src/harness/skills/*/SKILL.md` files (installed from `dist/harness/`) own behavioral contracts and agent execution instructions. Existing skill-local `INSTALL.md` files own their setup instructions.

Summarize at each entry point and link downward to authoritative detail. Do not duplicate complete skill contracts in human guides or keep full copies at old and new paths.

Keep each shipped skill and output style discoverable through a README link to its canonical file, with a one-line purpose. Update the catalog when adding, removing, or renaming a component. `tests/inventory/readme-inventory.test.js` compares those linked files and names with the plugin tree without depending on headings, table columns, or list layout.

When documentation paths or architecture change, search incoming references throughout the repository, update links and validation tests in the same change, and resolve relative links from their containing files. Preserve links from any files outside the authorized edit scope. Documentation tests protect inventory agreement and link integrity, not incidental wording or presentation.

## Dependency inventory

The [dependency inventory](docs/development/dependencies.md) is authoritative for development and plugin-use dependencies. Read it before dependency setup or changes. When work adds, removes, upgrades, or otherwise changes a runtime, package, system tool, platform requirement, or required initialization artifact, update it in the same change. Keep the affected manifests, lockfiles, preflights, Dockerfile, and skill-local setup instructions consistent with it.

## Development container

On macOS hosts, run development commands and tests directly on macOS. On Linux hosts (including WSL2), run them through the development container using `./scripts/dev exec <command> [args...]`.

When building, running, or changing the development container, read [container guide](docs/development/container.md) for launcher commands, dependency volumes, failure remedies, and platform limits. Run the full container gate with `./scripts/dev exec node scripts/run-tests.js`. Keep Git operations on the host.

## Tests

Tests live at the repository root, in `tests/<skill-name>/`, never inside the skill. The one exception is a whole-tree invariant test that isn't scoped to a single skill, such as `tests/inventory/`, which checks `README.md` against the plugin tree itself.

Tests, fixtures, benchmarks, and development-only helpers remain at repository root and never ship. Installing a plugin copies the whole plugin directory into the harness's plugin cache, and neither Claude Code nor Codex supports excluding files from that copy. Anything assembled under `dist/harness/` is therefore shipped to every install. Tests reach their subject by relative path, and they run from a clone, where both trees exist.

Retain documentation tests that protect public contracts, and revise tests that merely freeze wording or layout when documentation is refactored. Test stable public behavior at the lowest useful layer, plus a small consumer integration test. Remove runtime parity tests when the obsolete runtime is removed. Remove implementation-detail tests when retained observable tests cover the contract. Treat performance comparisons as execution evidence, not permanent timing tests, unless timing is already a public contract.

Read [testing](docs/development/testing.md) for setup, focused commands, the full gate, and result interpretation.

The same reasoning applies to anything else that only exists to develop the code. If it never runs for someone who installed the plugin, it does not belong under `src/harness/`. Repo-root `scripts/` is where that development tooling lives, `bump-version.js` and `derive-bump-level.js` among it.

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

The diagnostic shape matches `src/harness/skills/write-asd-ste100/scripts/ste_data.py`, which reports a code, the failed condition, and an initialization command.

## Versioning and commits

Before committing, releasing, or changing versioning tooling, read [versioning and commits](docs/development/versioning.md). The sole editable plugin version is `src/harness/package.json`. Use `scripts/bump-version.js` to change it, then build to inject equal versions into both distribution manifests. Source host manifests are versionless templates. Set both author and committer dates to `1999-12-31T23:59:00-08:00`. The linked guide owns release mechanics and timestamp-hook setup.
