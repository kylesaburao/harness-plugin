# harness-plugin

One repository of [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills), packaged as an installable plugin for both Claude Code and Codex. Skills live once, under `plugins/harness/skills/`.
The two `.claude-plugin/` and `.codex-plugin/` directories are thin packaging layers around that same content. See [AGENTS.md](AGENTS.md) for the architecture rules.

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

## Versioning

Pushing to `main` bumps the patch version automatically. To bump minor or major instead, add `[bump:minor]` or `[bump:major]` to a commit subject.

To bump by hand:

```sh
node scripts/bump-version.js --bump-patch
node scripts/bump-version.js --bump-minor
node scripts/bump-version.js --bump-major
```

Never edit either `plugin.json`'s `version` field directly.

## License

MIT: see [LICENSE](LICENSE).
