# harness-plugin

One repository of [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills), packaged as an installable plugin for both Claude Code and Codex. Skills live once, under `plugins/harness/skills/`.
The two `.claude-plugin/` and `.codex-plugin/` directories are thin packaging layers around that same content. See [AGENTS.md](AGENTS.md) for the architecture rules.

## Plugin contents

### Skills

| Skill | Purpose | Setup |
| --- | --- | --- |
| `back-up-directories` | Archive a directory to a dated ZIP and replicate it to configured destinations. | `npm install --omit=dev --prefix plugins/harness/skills/back-up-directories` (needs `archiver`); see its `INSTALL.md` |
| `create-discord-emoji-gif` | Convert a clip into a looping, under-256KB, 128x128 Discord emoji GIF. | Node ≥22, `ffmpeg` built with `libvmaf`, `ffprobe`, and `gifski` or `gifsicle` |
| `diagnose-environment` | Bisect a failure that lives in the machine (PATH, shims, stale caches) rather than the code. | |
| `extract-video-frames` | Extract every full-resolution SDR or HDR video frame, optionally within an inclusive time window. | Node ≥20.6, macOS ≥26.0, Command Line Tools, and `ffmpeg-full` with `ffprobe`, `zscale`, PNG, and TIFF |
| `inspect-development-environment` | Produce an evidence-backed inventory of the current dev environment. | |
| `record-decision` | Capture a consequential technical decision, its constraints, and its reversibility. | |
| `research-precedent` | Research whether a proposed approach has precedent, internally or in the wider industry. | |
| `write-asd-ste100` | Draft or revise technical English against the ASD-STE100 Simplified Technical English ruleset. | `python3`, plus a locally generated reference bundle; see its `INSTALL.md` |

### Output styles

Claude Code only — `.codex-plugin/plugin.json` pins its component list to `./skills/` and ignores these.

- `Casual` ([plugins/harness/output-styles/casual.md](plugins/harness/output-styles/casual.md)) — plain street-level speech instead of technical or academic prose, kept short and direct.
- `Encoded` ([plugins/harness/output-styles/encoded.md](plugins/harness/output-styles/encoded.md)) — every user-facing message compressed to one-line semantic algebra for LLM consumption.
- `Natural` ([plugins/harness/output-styles/natural.md](plugins/harness/output-styles/natural.md)) — default Claude Code behavior with natural technical prose, no semicolons, no em-dashes.

The plugin ships skills and output styles only: no commands, no hooks, no plugin-level agents.

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

Some skills generate data on first use and store it under `~/.harness-plugin/`. That directory survives plugin upgrades and is shared by both harnesses. Uninstalling the plugin does not remove it, so delete `~/.harness-plugin/` by hand if you want the space back.

## Versioning

Pushing to `main` bumps the patch version automatically. To bump minor or major instead, add `[bump:minor]` or `[bump:major]` to a commit subject.

Only changes that reach an install count. A push bumps the version if it touched `plugins/`, `.claude-plugin/`, or `.agents/plugins/`; a push that only edits docs, `tests/`, or repo tooling leaves the version alone. When a push does mix the two, a `[bump:minor]` or `[bump:major]` tag anywhere in it is still honored.

To bump by hand:

```sh
node scripts/bump-version.js --bump-patch
node scripts/bump-version.js --bump-minor
node scripts/bump-version.js --bump-major
```

Never edit either `plugin.json`'s `version` field directly.

## License

MIT: see [LICENSE](LICENSE).

## Development tests

Run `node scripts/setup-tests.js` once to install test dependencies and initialize references. Run `node scripts/run-tests.js` for the complete local gate. The test command validates the existing environment and does not install dependencies. Use `--skip-gif` to omit GIF tests and converter preflights.
