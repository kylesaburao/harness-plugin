# harness-plugin

One repository of [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills), packaged as an installable plugin for both Claude Code and Codex. Skills live once, under `plugins/harness/skills/`.
The two `.claude-plugin/` and `.codex-plugin/` directories are thin packaging layers around that same content. See [AGENTS.md](AGENTS.md) for the architecture rules.

## Install

Claude Code:

```
/plugin marketplace add kylesaburao/harness-plugin
/plugin install harness@harness-plugin
```

Codex:

```
codex plugin marketplace add kylesaburao/harness-plugin
codex plugin add harness@harness-plugin
```

## Skills

Most skills are workflow guidance and need nothing installed. These three run a script and
have external requirements. Each accepts `--preflight --json`, which reports in one call
whether the machine can run it and what to install if not.

| Skill | Does | Needs |
| --- | --- | --- |
| `convert-video-to-gif` | Searches frame rate, palette, and dither for the best GIF under a byte budget | macOS, `ffmpeg` with `libvmaf`, `ffprobe`, `gifsicle` |
| `wake-desktop` | Sends a Wake-on-LAN magic packet and waits for the host | A LAN path to the target and the system `ping`. No npm packages |
| `back-up-directories` | Archives a directory to a dated ZIP and replicates it | `npm install --omit=dev` in the skill directory, see its `INSTALL.md` |

## License

MIT: see [LICENSE](LICENSE).
