# Claude Code host qualification

This record covers the whole plugin tree on Claude Code: manifest validation, discovery, and the Claude-only output styles. Qualification of individual skills lives in each skill's own record under `tests/<skill>/`.

## Environment (2026-09-25)

- Host: Claude Code `2.1.282` on macOS, using the user's personal claude.ai (Pro) login. The init report showed default model `claude-opus-5-5`.
- Candidate: a fresh `npm run build` of HEAD `0071f1e4fe1cf58dd6e29c79a58ceaa105c24db7`, copied from `.build/harness` to `/private/tmp/claude-qual-20260925092150/harness`. The copy omits the `back-up-directories` dependency overlay. Tree SHA-256 over sorted per-file hashes: `ca43f7443adc4aef01960a11a74e8db8cb5aa47dffa42c421ddd91699de89902`.
- Isolation: the candidate loads through `--plugin-dir`, with `--setting-sources '' --no-session-persistence`. A throwaway `CLAUDE_CONFIG_DIR` was not used. The user chose the personal profile instead, and the earlier disposable-profile attempt had failed to authenticate (see [random-sampler](../random-sampler/QUALIFICATION.md)). `--bare` was not used because it skips keychain authentication. Personal settings, plugins, and instruction files were not modified.

## Isolation probe

This probe sends no model turn. It sends a stream-json `initialize` control request, then closes input:

```sh
(echo '{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize"}}'; sleep 8) | claude -p --plugin-dir "$QROOT/harness" --setting-sources '' --input-format stream-json --output-format stream-json --verbose --no-session-persistence --debug-file "$QROOT/evidence/init-debug.log"
```

- Passed: one `harness` plugin (`harness@inline`, version 3.1.16) loaded from the disposable path, plus the built-ins `agents-md` and `telemetry`. The debug log reports `Loaded 14 skills from plugin harness default directory` and `0 duplicate/user-owned entries skipped`. The personally installed `harness@harness-plugin` was not enabled, because it is enabled only by user settings, which were excluded.
- The personal `~/.claude/CLAUDE.md` and its `~/.llm/AGENTS.md` import did not load under `--setting-sources ''`. A tool-free Haiku session reported both the Advisor and Implementation planning headings absent. The debug log showed no memory-file load. Other qualifications that need activation text supply it explicitly.
- Headless startup ran its plugin-cache housekeeping against the personal cache. It logged `Keeping …` for every entry and removed nothing.
- Running with `< /dev/null` and no control request produced no output, so the initialize request is required.

## Validation and discovery

| Check | Command | Result |
| --- | --- | --- |
| Plugin manifest, strict | `claude plugin validate "$QROOT/harness" --json --strict` | **Passed**: exit 0, zero errors, warnings, or notes. |
| Marketplace manifest, strict | `claude plugin validate .claude-plugin/marketplace.json --json --strict` | **Failed (warning only)**: exit 1, zero errors, one warning: `description`, "No marketplace description provided." Non-strict validation would pass. |
| Skill content | `claude plugin validate "$QROOT/harness/skills" --json --strict` | Exit 0 with no manifest and empty `contents`. Validating a single skill directory reports "No manifest found". This client version produced no observable skill-frontmatter validation, so frontmatter is not claimed as validated. |
| Discovery | initialize probe above | **Passed**: all 14 skills appear as `harness:<skill>` commands: back-up-directories, create-discord-emoji-gif, demonstrate-workflow, diagnose-environment, extract-video-frames, harness-advisor, inspect-development-environment, install-harness-plugin-capabilities, random-sampler, record-decision, research-precedent, wake-desktop, write-asd-ste100, write-implementation-plan. `available_output_styles` includes `harness:Casual`, `harness:Encoded`, and `harness:Natural`. |

This is `--plugin-dir` discovery of the development candidate, not a marketplace installation. Marketplace installation into the personal profile was out of scope. The earlier isolated marketplace installation on Claude Code 2.1.270 is recorded in [the implementation receipt](../distribution/IMPLEMENTATION_RECEIPT.md). It predates `write-implementation-plan`.

### Frontmatter finding

`src/harness/skills/write-asd-ste100/SKILL.md` declares `disable-model-invocation: true` (introduced in `efac900`). `AGENTS.md` limits that shared-frontmatter extension to `demonstrate-workflow`, and no test enforces that limit. On Claude, both skills appear in the initialize command list but were absent from the model-visible skill list of the Claude Code session that ran this qualification. The contradiction between the repository instruction and the tree is unresolved and needs a maintainer decision.

## Output styles (2026-09-25)

Selection used `--settings '{"outputStyle":"harness:<Name>"}'`. `--settings` applies even with `--setting-sources ''`. The Claude documentation names the `outputStyle` key but does not spell out the id format for plugin styles; the `harness:<Name>` ids come from the initialize report. Each stream's `system/init.output_style` confirmed the selection: `harness:Casual`, `harness:Encoded`, `harness:Natural`, and `default` for the control.

The fixture was a small git repository whose `sum.js:5` loops `i <= arr.length`, so `node cli.js 1 2 3` prints `NaN`.

Each case was a fresh session:

```sh
claude -p --plugin-dir "$QROOT/harness" --add-dir "$QROOT/harness" --setting-sources '' --no-session-persistence --output-format stream-json --verbose --max-budget-usd 2 --permission-mode dontAsk --allowedTools 'Read,Glob,Grep' [--settings '{"outputStyle":"harness:<Name>"}']
```

Prompts: P1 "What does this project do and which file holds the main logic?" and P2 "Is there a bug in sum.js? Answer and explain briefly."

The first two control sessions exited 1 before inference because `--allowedTools` is variadic and consumed the positional prompt. They were rerun once, with the prompt on stdin.

| Style | P1 | P2 |
| --- | --- | --- |
| Casual | Mostly passed: verdict first, contractions, flat one-fact bullets, absolute `path:line` citations, no semicolons, em-dashes, emoji, or profanity. Deviations: bold rather than bare bullet labels, and one off-topic bullet. | Mostly passed: "Yep, it's an off-by-one in the loop." with a `sum.js:5` citation. Deviation: four sentences of cause, where the rule allows at most one or two. |
| Encoded | Passed: one physical line in compact notation, with citations intact. Minor: Markdown backticks, and an unrelated connector note appended. | Passed: one line, off-by-one ⇒ `undefined` ⇒ `NaN`, fix `i<arr.length`. |
| Natural | Partial: verdict first, plain prose, no headers or bold, clean punctuation, absolute citations. Deviation: three paragraphs, where the rule allows at most one further sentence. | Mostly passed: verdict first with a citation. Deviations: slightly more than one sentence of cause, and an unrelated connector note. |

All eight answers, including the control, found the off-by-one at line 5, its `NaN` effect, and the `<` fix. Tool use was comparable to the control: two to three read-only calls per session. Styles changed presentation without a correctness regression in these samples. Length limits were the most frequently missed rule. These are single samples, not guarantees. G7 inference cost was about $0.85.

## Host behavior observed during qualification

These observations apply to any future Claude qualification on this host version:

- `--allowedTools` is variadic. A following positional prompt is consumed as a tool name. Pass the prompt on stdin or place another flag after the list.
- Under `--permission-mode dontAsk`:
  - Bash commands that name paths outside the working directory are denied until that directory is added with `--add-dir`.
  - A compound command or heredoc needs every component allowlisted. For example, `Bash(node *)` did not admit random-sampler's `node … <<'SAMPLER_REQUEST'` form.
  - Some read-only commands, such as `git ls-files`, `cat`, and `ls`, ran without being allowlisted. `--allowedTools` is therefore not a strict allowlist for read-only Bash.
  - Writes under a project's `.claude/` directory were denied even with Write allowed.
- `--setting-sources ''` does not suppress claude.ai account connectors (`source: claudeai`) in ordinary sessions. Several answers appended unrelated connector-authorization notes. The Advisor adapter's child passes `--strict-mcp-config` and was unaffected.
- Native plan mode (`--permission-mode plan`) writes its plan file to the personal `~/.claude/plans/` despite `--setting-sources ''` and `--no-session-persistence`.
- Headless plan mode exposes neither AskUserQuestion nor ExitPlanMode.

Raw evidence for this record (`evidence/init*`, `validate-*`, `memory-probe*`, `perm-control-*`, `g7-*`, `g7r-*`) remains under the disposable root and was not archived.

## Repository gate after recording (2026-09-25)

The qualification changed only Markdown under `tests/`. `dist/` and `src/` have no diff. `npm run test:setup` passed.

`npm test` on macOS with the default `TMPDIR`: **797 passed, 7 failed**. The failures:
- Six `harness-advisor/claude-adapter.test.js` cases (contract-missing and cleanup-denial). The default `TMPDIR` under `/var/folders` resolves to `/private/var/folders`, so the expected paths differ from the real paths.
- `distribution/build.test.js` "assembly failures and unsafe ancestors". It expects case-colliding paths, which requires a case-sensitive filesystem.

`tests/write-implementation-plan/QUALIFICATION.md` records the same environment-only failures at a pristine HEAD. With `TMPDIR` set to a realpath directory, `claude-adapter.test.js` passed 41/41. The case-sensitive build test was not rerun, because doing so would need a case-sensitive disk image on the host.
