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
