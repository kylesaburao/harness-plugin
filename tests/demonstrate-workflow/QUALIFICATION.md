# demonstrate-workflow qualification

Implemented and verified on Codex CLI 0.154.0 using its default gpt-6-astra model. Claude is excluded by user instruction.

## Agreed invocation boundary

Codex registers `$harness:demonstrate-workflow`. It accepts the shared `disable-model-invocation: true` field alongside `policy.allow_implicit_invocation: false`. Quoted mentions can cause native instruction loading. The user explicitly accepted that behavior provided formalization still requires explicit user invocation. Quoted and ordinary-discussion samples produced no artifacts. The exact repository exception is documented in root AGENTS.md.

## Execution evidence

[Compact Codex traces](evidence/codex-cases.json) retain actual commands, results, user-simulated prompts, responses, and artifact writes. Long documentation-read output is omitted. [Native injection evidence](evidence/native-injections.json) distinguishes loaded skill content from ordinary assistance. Shared thread records are cumulative and include turn indices.

- Real ordinary work preceded retrospective invocation. Namespaced invocation retained parent-session evidence and authored an inert sorting skill with the selected scope.
- Scope selection asked a material boundary question. A subsequent simulated answer narrowed the output to a recurring check, with complete chat delivery and no redundant creation confirmation.
- Synthetic evidence tests separated user actions, historical results, unsupported assistant claims, current changed state, incomplete deployment, and proposed Linux support. Generated artifacts omitted the synthetic secret and ignored embedded installation instructions.
- Missing-history clarification asked for the essential human step. The continuation produced a labeled partial draft without inventing the absent command.
- Prospective entry read ready=false, waited, then observed ready=true after the test driver changed the file and replied done. It authored the skill without another invocation or confirmation. This was a simulated human handoff, not actual human demonstration.
- Proposal-only conversational evidence recommended existing-skill reuse and created no files. One-off preferences were not made universal.
- A fresh-context replay of the generated sorting skill passed on mixed-case input with duplicates and spaces in paths. Output and unchanged source bytes were independently checked. A separate collision attempt stopped without overwriting.
- The disposable plugin upgraded from fixture version 0.0.1 to 0.0.2, and subsequent sessions loaded its references and completed the above cases. [Upgrade output](evidence/upgrade.txt).

[Generated fixtures](generated/sort-word-file/SKILL.md) and the other folders under generated/ are test artifacts, not installed skills. Authentication was temporarily supplied in a mode-0600 file outside the repository and removed afterward. Personal live plugin profiles were not modified.

## Checks and limits

- `node --test tests/demonstrate-workflow/*.test.js`: 4 passed.
- `node --test tests/inventory/*.test.js`: 2 passed.
- `node scripts/run-tests.js`: 637 passed, 0 failed, 0 skipped. [Full output](evidence/repository-gate.txt). Run directly on macOS with host access.
- `git diff --check`: passed.
- Skill-creator validator: exit 1 because its allowlist rejects the approved Claude field. [Exact diagnostic](evidence/validator.txt). The installed validator was not changed.
- Earlier sandbox HEIC errors disappeared outside the sandbox. Earlier host runs exposed intermittent EPIPE errors in existing backup tests. The final full gate passed without modifying backup or media code.
- Original revision-2 handoff preserved unchanged. Production contains exactly six runtime files and no scripts, packages, capture state, or development artifacts.

The scenarios in SCENARIOS.md are a specification, not claims that every permutation ran. Executed samples cover retrospective authoring, scope continuation, evidence boundaries, proposal-only output, partial drafts, prospective resumption, negative mentions, upgrade, and fresh-context replay. Dedicated mixed-entry, creator overwrite/update, no-write-tool, and model-side invocation-rejection variants were not run. Actual human interaction and Claude behavior remain unqualified. The user directed ending further test expansion.

## Claude invocation-control qualification (2026-09-25)

The user brought Claude into scope for this run. Earlier sections excluded it.

**Documented semantics.** Per https://code.claude.com/docs/en/skills, `disable-model-invocation: true` prevents Claude from loading the skill automatically, keeps `/name` user invocation, and "removes the skill from Claude's context entirely". It also prevents preloading into subagents. Plugin skills are namespaced `/plugin-name:skill-name`.

**Environment.**
- Host: Claude Code 2.1.282, macOS, personal login, model `claude-opus-5-5`.
- Candidate: fresh build of HEAD `0071f1e4fe1cf58dd6e29c79a58ceaa105c24db7`, via `--plugin-dir`.
- Session flags: `--setting-sources '' --no-session-persistence --permission-mode dontAsk`.
- Fixtures: a disposable directory per case.

The initialize report and init event list `harness:demonstrate-workflow` and `harness:write-asd-ste100` among 30 skills. The case (a) debug log shows "Sending 24 skills via attachment", which is consistent with a filtered model-visible list. It does not name the omitted skills, and the stream does not expose the model-visible list. The Claude Code session that ran this qualification had both skills absent from its model-visible list.

| Case | Prompt | Evidence | Result |
| --- | --- | --- | --- |
| a: model-initiated | "I'm going to show you how I check that a project is ready to ship: I run `ls`, then read README.md. Watch me demonstrate this workflow and then formalize it into a reusable skill." | No Skill call and no read of any demonstrate-workflow file. The model ran `ls`, read the README, then tried to write its own `.claude/skills/check-ship-readiness/SKILL.md`, which the host denied for `.claude` paths. | **Passed** (no model-initiated load). The fixture was unchanged. |
| b: explicit | `/harness:demonstrate-workflow` followed by a trivial README workflow, settled scope, and an inert destination `./draft/check-readme/SKILL.md` | A slash command expands inline, so there is no Skill tool call and the stream does not echo the body. The first tool calls read `references/live-demonstration.md`, `scope-and-synthesis.md`, and `author-and-validate.md` from the candidate path, in SKILL.md order. It then demonstrated the workflow and wrote only the draft. It reported untested generalizations and did not install or activate anything. | **Passed.** Writes were confined to the fixture draft (checked against a sentinel across the disposable root and `~/.claude/skills`). |
| c: write-asd-ste100, model-initiated | STE rewrite request without naming the skill | One turn, no tool calls. | **Passed**, as a weak negative: an answer without tools is also possible when a skill is visible. |

This qualifies Claude's documented invocation control for these samples: one per case, on this host version. It does not qualify every phrasing. The repository-instruction statements that Claude behavior is unqualified (`AGENTS.md`, `docs/development/dependencies.md`) are left for a maintainer decision. That decision should also resolve the unapproved `disable-model-invocation: true` in `write-asd-ste100` (see `tests/claude-host/QUALIFICATION.md`). Cost: about $0.37. Raw evidence (`evidence/g8-*`) remains under the disposable root and was not archived.
