# harness-plugin

One repository of [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills), packaged for Claude Code and Codex. Canonical skills are authored once under `src/harness/skills/`. Both harnesses install the generated, Git-tracked `dist/harness/` artifact.

## Install

Run these commands in a terminal, outside Claude Code or Codex.

### Claude Code

```sh
claude plugin marketplace add kylesaburao/harness-plugin
claude plugin install harness@harness-plugin
```

### Codex

```sh
codex plugin marketplace add kylesaburao/harness-plugin
codex plugin add harness@harness-plugin
```

Some skills retain configuration or generated data under `~/.harness-plugin/`, shared by both harnesses and preserved across plugin upgrades. See [skill requirements and setup](docs/development/dependencies.md#2-using-the-plugin) for additional dependencies.

## Plugin contents

### Skills

| Skill | Purpose |
| --- | --- |
| [harness-advisor](dist/harness/skills/harness-advisor/SKILL.md) | Get a tool-free reasoning review of executor-supplied evidence. [Guide](docs/skills/harness-advisor.md). |
| [back-up-directories](dist/harness/skills/back-up-directories/SKILL.md) | Archive a directory to a dated ZIP and replicate it to configured destinations. |
| [create-discord-emoji-gif](dist/harness/skills/create-discord-emoji-gif/SKILL.md) | Convert a clip into a looping, under-256KB, 128x128 Discord emoji GIF. |
| [diagnose-environment](dist/harness/skills/diagnose-environment/SKILL.md) | Bisect a failure that lives in the machine (PATH, shims, stale caches) rather than the code. |
| [extract-video-frames](dist/harness/skills/extract-video-frames/SKILL.md) | Extract every full-resolution SDR or HDR video frame, optionally within an inclusive time window. |
| [inspect-development-environment](dist/harness/skills/inspect-development-environment/SKILL.md) | Produce an evidence-backed inventory of the current dev environment. |
| [install-harness-plugin-capabilities](dist/harness/skills/install-harness-plugin-capabilities/SKILL.md) | Install or repair Advisor integration, implementation-planning activation, and Skill discovery for Codex and Claude Code through agent file edits. |
| [record-decision](dist/harness/skills/record-decision/SKILL.md) | Capture a consequential technical decision, its constraints, and its reversibility. |
| [demonstrate-workflow](dist/harness/skills/demonstrate-workflow/SKILL.md) | Turn completed session work or a new demonstration into a reusable skill through explicit invocation. |
| [research-precedent](dist/harness/skills/research-precedent/SKILL.md) | Research whether a proposed approach has precedent, internally or in the wider industry. |
| [random-sampler](dist/harness/skills/random-sampler/SKILL.md) | Make cryptographic random choices, integers, samples, shuffles, dice rolls, and coin flips. |
| [wake-desktop](dist/harness/skills/wake-desktop/SKILL.md) | Manage named LAN wake targets and send a magic packet, optionally waiting for a ping response. [Guide](docs/skills/wake-desktop.md). |
| [write-implementation-plan](dist/harness/skills/write-implementation-plan/SKILL.md) | Create self-contained implementation plans with an explicit choice of optional HANDOFF.md support. |
| [write-asd-ste100](dist/harness/skills/write-asd-ste100/SKILL.md) | Draft or revise technical English against the ASD-STE100 Simplified Technical English ruleset. |

### Output styles

Claude Code only: `.codex-plugin/plugin.json` pins its component list to `./skills/` and ignores these.

- [Casual](dist/harness/output-styles/casual.md): short, direct, everyday speech.
- [Encoded](dist/harness/output-styles/encoded.md): one-line semantic algebra for LLM consumption.
- [Natural](dist/harness/output-styles/natural.md): natural technical prose with default Claude Code behavior.

The plugin ships skills and output styles only: no commands, no hooks, no plugin-level agents.

## From implementation to installed distribution

Edit `src/harness/`, then build the ignored installation-shaped candidate at `.build/harness/`. Rebuild after changes to implementation, bundled resources, source manifests, compiler configuration, or build tooling. Repository development uses Node 26, declared in `.nvmrc`; see [runtime bootstrap and terminal activation](docs/development/dependencies.md#node-runtime-bootstrap). On macOS, run from the repository root:

```sh
npm ci --include=dev
npm run build
npm run test:setup
npm test
```

The first command installs the locked development toolchain. The build compiles TypeScript to JavaScript, copies bundled resources, and injects the current canonical version into both candidate host manifests. On Linux/WSL2, run these development commands through `./scripts/dev exec`, as described in the [container guide](docs/development/container.md).

Setup and runtime tests use `.build/harness/` by default and check it without silently rebuilding it. `npm run build:check` compares it with a fresh candidate without repairing drift. Both marketplace installers continue to consume the committed `dist/harness/` release directly and never run the compiler. Repository development can be ahead of that installable release; installed content changes only after successful CI publication. Plugin users need no TypeScript build, though individual skills retain their documented runtime setup requirements.

Commit source, tooling, tests, and documentation without regenerated output or a local version bump. The release workflow owns `src/harness/package.json` and `dist/harness/`, tests the exact versioned distribution, and publishes them together. See the [build workflow](docs/development/build.md) for target commands and recovery, and [versioning](docs/development/versioning.md) for release details.

## Documentation

Start with the [documentation index](docs/README.md), or go directly to:

- [Harness Advisor](docs/skills/harness-advisor.md): integration, requests, and routing preferences.
- [Wake Desktop](docs/skills/wake-desktop.md): save and wake computers on your LAN.
- [Development](docs/development/README.md): setup, testing, containers, and versioning.
- [Dependencies and skill setup](docs/development/dependencies.md): runtimes, tools, and initialization.
- [Suggested plugins](docs/suggested-plugins.md): related projects.

Repository architecture and contribution invariants live in [AGENTS.md](AGENTS.md).

## License

MIT: see [LICENSE](LICENSE).
