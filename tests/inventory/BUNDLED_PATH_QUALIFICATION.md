# Bundled path qualification

Qualified on macOS on 2026-09-13. This evidence checks resource provenance for the loaded skill instance. It does not prove model compliance for every prompt or repair stale host discovery metadata.

## Status

| Area | Status | Evidence |
| --- | --- | --- |
| Repository validation | Passed with validator limitation | Focused Node tests: 17 passed. Python tests: 142 passed. The inventory mutation cases rejected in-memory copies with the authority section removed or appended to. The portable skill validator passed 7 skills. Its rejections of existing `compatibility` fields were unrelated to this change, and `disable-model-invocation` validation was excluded by user instruction. Claude Code strict plugin-manifest validation passed with zero errors or warnings. |
| Codex behavioral validation | Passed | Two fresh Codex sessions used the supplied `r2` instance for the bundled script and reference. |
| Claude documentation compatibility | Passed | Official documentation defines `${CLAUDE_SKILL_DIR}` substitution in skill Markdown, relative Markdown links for supporting files, plugin skill discovery, and session-only `--plugin-dir` loading. The shared contract names the substitution and retains host-neutral `<SKILL_DIR>` command examples. |
| Claude live validation | Pending | Deferred to an authenticated Claude session by scope. No live Claude inference or authentication change was attempted. |

## Codex behavioral evidence

Client: `codex-cli 0.154.0`. The disposable root was `/private/tmp/bundled-path-qualification.UsWNHq`. A local marketplace copy of the modified plugin was installed as `harness@harness-plugin` into an isolated `CODEX_HOME`. Only the existing authentication file was copied, with mode `0600`. Personal configuration and plugin installations were not changed. The working directory was the unrelated empty directory `/private/tmp/bundled-path-qualification.UsWNHq/workspace`.

Setup used:

```sh
codex plugin marketplace add /private/tmp/bundled-path-qualification.UsWNHq/marketplace --json
codex plugin add harness@harness-plugin --json
```

Both final runs used `codex -a never exec --ephemeral --ignore-rules --skip-git-repo-check -C /private/tmp/bundled-path-qualification.UsWNHq/workspace -s read-only --json PROMPT`. The parent sandbox initially prevented the nested Codex sandbox from starting. Repeating the final runs with host access allowed Codex's own read-only sandbox to enforce isolation.

### random-sampler help

- Thread: `01a09cde-6293-7dc3-8f20-82e6e7fbc47f`.
- Supplied mapping: `r2` to `/private/tmp/bundled-path-qualification.UsWNHq/codex-home/plugins/cache/harness-plugin/harness/3.1.3/skills`.
- Instructions read: `/private/tmp/bundled-path-qualification.UsWNHq/codex-home/plugins/cache/harness-plugin/harness/3.1.3/skills/random-sampler/SKILL.md`.
- Resource command: `node "/private/tmp/bundled-path-qualification.UsWNHq/codex-home/plugins/cache/harness-plugin/harness/3.1.3/skills/random-sampler/scripts/sample.mjs" --help`.
- Result: exit 0 and `Usage: sample.mjs [--help | --preflight] [--json]`. No number was drawn.
- Provenance: no conventional alternate root was inspected or probed.

### diagnose-environment macOS reference

- Thread: `01a09cde-dead-7f50-b2d2-7509e0cee13e`.
- Supplied mapping: the same `r2` instance above.
- Instructions read: `/private/tmp/bundled-path-qualification.UsWNHq/codex-home/plugins/cache/harness-plugin/harness/3.1.3/skills/diagnose-environment/SKILL.md`.
- Resource command: `cat '/private/tmp/bundled-path-qualification.UsWNHq/codex-home/plugins/cache/harness-plugin/harness/3.1.3/skills/diagnose-environment/references/macos-environment.md'`.
- Result: the summary covered shell and PATH resolution, architecture and Homebrew mismatches, version-manager shims, permissions and quarantine, and targeted cache inspection.
- Provenance: no system diagnostics ran and no conventional alternate root was inspected or probed.

## Claude documentation compatibility

Client inspected without starting a session: `2.1.270 (Claude Code)`.

- [Claude skills documentation](https://code.claude.com/docs/en/skills) states that `${CLAUDE_SKILL_DIR}` is substituted in skill Markdown with the installed skill directory. It also documents Markdown-relative supporting-file links.
- [Claude plugins reference](https://code.claude.com/docs/en/plugins-reference) documents plugin skills under `skills/<name>/SKILL.md`, their `/plugin-name:skill-name` namespace, and session-only loading with `--plugin-dir`.
- Compatibility conclusion: Claude supplies the loaded skill directory through a documented substitution. After substitution, the shared contract provides an absolute source for `<SKILL_DIR>`. The quoted command examples and relative Markdown links fit the documented mechanism. No cache layout assumption is required.

## Deferred Claude live procedure

Run this only in a future authenticated session. `<QUAL_ROOT>` is a new disposable absolute directory. Keep the working directory outside the plugin tree.

```sh
mkdir -p "<QUAL_ROOT>/claude-config" "<QUAL_ROOT>/workspace"
cp -R "/Users/kyle/Documents/harness-plugin/plugins/harness" "<QUAL_ROOT>/harness"
CLAUDE_CONFIG_DIR="<QUAL_ROOT>/claude-config" claude auth login --claudeai
CLAUDE_CONFIG_DIR="<QUAL_ROOT>/claude-config" claude plugin validate "<QUAL_ROOT>/harness" --json --strict
```

From `<QUAL_ROOT>/workspace`, run each command as a separate fresh session:

```sh
CLAUDE_CONFIG_DIR="<QUAL_ROOT>/claude-config" claude --plugin-dir "<QUAL_ROOT>/harness" --setting-sources '' --permission-mode dontAsk --permission-prompts none --allowedTools 'Read,Bash(cat *),Bash(node *)' --no-session-persistence --output-format stream-json -p 'Use /harness:random-sampler to display its bundled CLI help without drawing a number. Report the substituted skill directory, exact SKILL.md path read, exact resource command, exit code, and first usage line. Do not inspect conventional alternate roots.'

CLAUDE_CONFIG_DIR="<QUAL_ROOT>/claude-config" claude --plugin-dir "<QUAL_ROOT>/harness" --setting-sources '' --permission-mode dontAsk --permission-prompts none --allowedTools 'Read,Bash(cat *),Bash(node *)' --no-session-persistence --output-format stream-json -p 'Use /harness:diagnose-environment to read and summarize its bundled macOS reference without running system diagnostics. Report the substituted skill directory, exact SKILL.md path read, exact reference read command, and one-sentence summary. Do not inspect conventional alternate roots.'
```

Pass each case only when the stream shows the plugin skill, `SKILL.md`, and resource all came from `<QUAL_ROOT>/harness/skills/<skill>`. Fail provenance if any conventional alternate root is probed. Record authentication or permission failures as blocked, not passed.
