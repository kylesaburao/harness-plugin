# Bundled path qualification

Qualified on macOS on 2026-09-13. This evidence checks resource provenance for the loaded skill instance. It does not prove model compliance for every prompt or repair stale host discovery metadata.

## Status

| Area | Status | Evidence |
| --- | --- | --- |
| Repository validation | Passed with validator limitation | Focused Node tests: 17 passed. Python tests: 142 passed. The inventory mutation cases rejected in-memory copies with the authority section removed or appended to. The portable skill validator passed 7 skills. Its rejections of existing `compatibility` fields were unrelated to this change, and `disable-model-invocation` validation was excluded by user instruction. Claude Code strict plugin-manifest validation passed with zero errors or warnings. |
| Codex behavioral validation | Passed | Two fresh Codex sessions used the supplied `r2` instance for the bundled script and reference. |
| Claude documentation compatibility | Passed | Official documentation defines `${CLAUDE_SKILL_DIR}` substitution in skill Markdown, relative Markdown links for supporting files, plugin skill discovery, and session-only `--plugin-dir` loading. The shared contract names the substitution and retains host-neutral `<SKILL_DIR>` command examples. |
| Claude live validation | Passed on 2026-09-25, after permission corrections | Claude Code 2.1.282 loaded both skills and their resources from the `--plugin-dir` instance and probed no alternate root. The first attempts were blocked by the recorded allowlist, not by path resolution. See [Claude live validation](#claude-live-validation-2026-09-25). |

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

## Claude live validation (2026-09-25)

Client: `2.1.282 (Claude Code)`, macOS, the user's personal claude.ai login. Repository HEAD `0071f1e4fe1cf58dd6e29c79a58ceaa105c24db7`. `npm run build` produced the candidate, which was copied to the disposable root `/private/tmp/claude-qual-20260925092150/harness` without the `back-up-directories` dependency overlay. Candidate tree SHA-256 over sorted per-file hashes: `ca43f7443adc4aef01960a11a74e8db8cb5aa47dffa42c421ddd91699de89902`. The working directory was the empty `/private/tmp/claude-qual-20260925092150/workspace`.

The original deferred procedure used a disposable `CLAUDE_CONFIG_DIR` with its own login. By user decision, it was replaced with the personal profile plus `--setting-sources ''`. An initialize-only control request, which sends no model turn, showed one `harness` plugin loaded from the disposable path (`harness@inline`, version 3.1.16) plus built-ins. The personally installed `harness@harness-plugin` was not enabled, and personal `CLAUDE.md` was not loaded. Personal settings, plugins, and authentication were not changed.

Base command. Each case was a fresh session:

```sh
claude -p --plugin-dir "$QROOT/harness" --setting-sources '' --permission-mode dontAsk --permission-prompts none --allowedTools 'Read,Bash(cat *),Bash(node *)' --no-session-persistence --output-format stream-json --verbose --max-budget-usd 2 '<prompt from the original procedure>'
```

| Case | Attempt | Result |
| --- | --- | --- |
| random-sampler help | 1: base command | Blocked. The Skill tool loaded `harness:random-sampler` from `$QROOT/harness/skills/random-sampler`. The model ran `node "$QROOT/harness/skills/random-sampler/scripts/sample.mjs" --help; echo "EXIT=$?"`, which was denied. No alternate root was probed and no result was invented. |
| random-sampler help | 2: added `--add-dir "$QROOT/harness"` | Blocked. The same command was denied because `echo` was not allowlisted. |
| random-sampler help | 3: also allowed `Bash(echo *)` | **Passed.** The Skill tool loaded from the `--plugin-dir` instance. The command resolved under `$QROOT/harness/skills/random-sampler/scripts/`. Output `Usage: sample.mjs [--help | --preflight] [--json]`. No number was drawn. |
| diagnose-environment reference | 1: base command | **Passed.** The Skill tool loaded `harness:diagnose-environment`. `cat` of the reference was denied, then the Read tool read `$QROOT/harness/skills/diagnose-environment/references/macos-environment.md`. The summary covered shell init order, architecture and Rosetta, Homebrew prefixes, version managers, quarantine, ownership, and targeted cache clearing. No diagnostics ran and no alternate root was probed. |

Haiku control sessions isolated the permission behavior. `cat` of a file in the working directory passed with `Bash(cat *)`. Commands that name files outside the working directory were denied under `dontAsk` until that directory was added with `--add-dir`. A compound command needs every component allowlisted. For this host version, a future procedure therefore needs `--add-dir` for the plugin copy, plus allowlist entries for every command the model may chain.

The skill instructions were supplied by the Skill tool, not by a model `Read` of `SKILL.md`. The substituted directory was reported from the loaded instance. This evidence covers loading and resource provenance for these two prompts. It does not establish compliance for every prompt. Raw stream evidence: `evidence/g2-*.jsonl` and `evidence/perm-control-*.jsonl` under the disposable root, which was not archived.
