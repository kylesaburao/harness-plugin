# harness-plugin

One repository of [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills), packaged as an installable plugin for both Claude Code and Codex. Skills live once, under `plugins/harness/skills/`.
The two `.claude-plugin/` and `.codex-plugin/` directories are thin packaging layers around that same content. See [AGENTS.md](AGENTS.md) for the architecture rules.

## Dependencies

See [DEPENDENCIES.md](DEPENDENCIES.md) for the authoritative runtime, tool, and initialization requirements for development and for using each plugin skill.

## Plugin contents

### Skills

| Skill | Purpose |
| --- | --- |
| `back-up-directories` | Archive a directory to a dated ZIP and replicate it to configured destinations. |
| `create-discord-emoji-gif` | Convert a clip into a looping, under-256KB, 128x128 Discord emoji GIF. |
| `diagnose-environment` | Bisect a failure that lives in the machine (PATH, shims, stale caches) rather than the code. |
| `extract-video-frames` | Extract every full-resolution SDR or HDR video frame, optionally within an inclusive time window. |
| `inspect-development-environment` | Produce an evidence-backed inventory of the current dev environment. |
| `record-decision` | Capture a consequential technical decision, its constraints, and its reversibility. |
| `research-precedent` | Research whether a proposed approach has precedent, internally or in the wider industry. |
| `wake-desktop` | Manage named LAN wake targets and send a magic packet, optionally waiting for a ping response. |
| `write-asd-ste100` | Draft or revise technical English against the ASD-STE100 Simplified Technical English ruleset. |

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

## Using wake-desktop

Use this skill to save named computers and wake them on the same LAN. Both scripts
require Node.js 26.0.0 or newer, with no npm packages. Waking supports macOS and
Linux and requires UDP broadcast access to the target LAN. Waiting also requires
system `ping` and ICMP permission. The target must have Wake-on-LAN enabled and a
wake-capable network adapter with standby power. Ordinary VPNs, WSL2 NAT, and
container networking can prevent broadcast delivery.

### Ask the agent

After installing the plugin, ask for the operation in plain language. For example:

- “Use wake-desktop to register my desktop: IP 192.168.1.91, MAC 34:5a:60:37:3e:21.”
- “Wake my desktop.”
- “List my saved wake targets.”
- “Update desktop's IP to 192.168.1.92.”
- “Rename desktop to office desktop.”
- “Remove office desktop from my saved wake targets.”

Registration saves the addresses without waking anything. Ask to “register and
wake” for both operations. A wake request does not register a computer implicitly.
The agent asks only for missing information or an ambiguous target name. Names
are exact and case-sensitive, and can contain spaces or Unicode, but cannot be
empty or have surrounding whitespace.

### Run the scripts directly

Set `wake_skill` to the actual absolute installed skill directory shown by your
harness. From a repository checkout, you can instead use the absolute path to
`plugins/harness/skills/wake-desktop`. Resolve the installed path again after an
upgrade instead of relying on a hard-coded cache version.

```sh
wake_skill="/absolute/path/to/skills/wake-desktop"
node "$wake_skill/scripts/manage-targets.js" register --name desktop --ip 192.168.1.91 --mac 34:5a:60:37:3e:21 --json
node "$wake_skill/scripts/manage-targets.js" list --json
```

To send a wake packet and wait up to 120 seconds for a ping response:

```sh
node "$wake_skill/scripts/wake-desktop.js" --target desktop --timeout 120 --json
```

Add `--no-wait` to send without polling. For an explicit readiness check, add
`--preflight`, which sends no wake packet. Wake preflight checks the environment
and prepares a broadcast socket, but cannot prove delivery to the target.

Run maintenance commands individually as needed:

```sh
node "$wake_skill/scripts/manage-targets.js" update --name desktop --ip 192.168.1.92 --json
node "$wake_skill/scripts/manage-targets.js" rename --name desktop --new-name "office desktop" --json
node "$wake_skill/scripts/manage-targets.js" remove --name "office desktop" --json
```

Update accepts either address or both. Registering an existing name with identical
addresses is a no-op. Different addresses require explicit `--replace` authorization.
Rename cannot overwrite another saved name. Update, rename, and remove require an
existing source name. All management commands accept `--preflight` to validate
without writing or networking. Both executables accept `--help`, `--json`, and
`--flag=value` for value options. Use the equals form for names beginning with `-`.

### Configuration and results

Targets live in `~/.harness-plugin/wake-desktop/config.json`, shared by Codex and
Claude Code and retained across plugin upgrades. The manager owns all writes,
using atomic replacement and preserving unrelated targets and unknown properties.
Manage this file through the CLI. Waking only reads it. Listing an absent registry
returns an empty list without creating a file.

For a named wake, explicit `--mac` and `--ip` override the saved addresses for that
invocation without changing them. Named wakes ignore `MAC_ADDRESS` and `IP_ADDRESS`.
Without `--target`, provide those addresses through flags or environment variables,
and the script does not read saved configuration. Timeout precedence is `--timeout`,
then `TIMEOUT`, then 120 seconds. Timeout must be a positive whole number and is
never saved.

JSON results appear on stdout. Management reports its operation status and
`configPath`, with `changed` for completed mutations. Wake reports `online` when
ping responds, or `packet-sent` with `--no-wait`. Named wake results include `target`.
A ping response proves reachability, not application readiness. After a timeout,
the agent reports the result and stops without retrying. A timeout alone does not
prove the computer stayed asleep.

Errors appear on stderr with a stable code, condition, and remedy. Exit 0 means
success or passed preflight. Exit 2 means validation or startup failed. Exit 1
means a management write failed or a wake failed after at least one packet send
succeeded. See the [complete skill contract](plugins/harness/skills/wake-desktop/SKILL.md)
for dispatch, diagnostics, and stopping behavior.

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

Prerequisites run sequentially and stop the gate on failure. Then sequential Python tests overlap the dedicated full GIF search. After that search finishes, all remaining Node files share one process-isolated pool sized by `os.availableParallelism()`. The full search uses that many encoding workers, and independent retained-candidate scenarios use `max(1, floor(availableParallelism / 4))` concurrent tests. Tests that change process-global state remain sequential inside their files.

Test failures do not stop other groups. The final terminal report includes actual wall time, selected concurrency, prerequisite timings, per-group counts and elapsed spans, aggregate counts, five slowest tests, and failure locations. Group spans overlap and must not be summed. Excluded groups are omitted by `--skip-gif`, unrun groups never started, and skipped tests come from the test frameworks. No report files are written. Exit status is 0 on success, the failed prerequisite's status, 1 after test failures, or the conventional 128 plus signal number on interruption. Setup remains a separate sequential command.

The gate timer includes prerequisites and scheduling time, but excludes Node startup and any external container wrapper.

## Development container

See [CONTAINER.md](CONTAINER.md) to build the Node 26 and media toolchain image, prepare persistent dependency volumes, and run temporary command containers against your live checkout with `./scripts/dev`. Git operations stay on the host.

## Other Plugins

See [Suggested Plugins](SUGGESTED-PLUGINS.md).
