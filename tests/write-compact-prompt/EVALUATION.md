# Write-compact-prompt evaluation protocol

## Purpose and evidence boundary

Evaluate three separate questions: whether the skill is packaged correctly, whether the host passes its output to compaction as intended, and whether the resulting summary keeps what the next phase needs. Passing one layer does not establish another. This file defines checks; it does not report completed experiments. Results belong in `docs/qualification/write-compact-prompt.md`.

The model cannot run `/compact`. Every live case needs the user to paste or run the command, so a case without that step is not run, not passed.

## Candidate and setup

Record the repository commit and any uncommitted candidate changes, the skill's content hash, and the built artifact tested. Build a fresh installation-shaped development candidate with the repository's development and testing guidance.

For each live run, record the host version, model, fixture session, prompt, actual skill-loading evidence, the produced text, and the captured compaction evidence. Load the candidate and any capture hooks through a host-supported explicit selection, such as a session flag or a disposable project directory. Do not edit personal settings or instructions as a qualification step. Confirm flag names from the host's current `--help`; when no supported mechanism exists, mark the live cases blocked.

On Claude Code, capture `custom_instructions` from a temporary PreCompact hook and `compact_summary` from a temporary PostCompact hook. The first shows what text reached compaction; only the second shows whether the instructions steered the default summary or replaced it.

## Packaging checks

Confirm one shared skill entrypoint with matching directory and frontmatter name, portable metadata, and no scripts, references, or assets. Check README inventory agreement and documentation links with the existing repository tests. Do not freeze the skill's prose or headings in tests.

## Live cases

| Case | Observable requirement |
| --- | --- |
| Claude Code, no focus hint | One `/compact` line in a code block, within the word budget `SKILL.md` states, no newlines; the captured `custom_instructions` equals the pasted text. |
| Claude Code, focus hint given | The instructions favour the named phase. |
| Unclear next step | The skill asks through the host question API before writing. |
| Rejected approaches in session | Each appears once with its reason; exploration detail is absent. |
| Saved plan or handoff file present | Referenced by path, not restated. |
| Secret seen in session | No secret value appears; it is named by location. |
| Recently edited files and CLAUDE.md content | Not restated unless a reason the summary would miss is given. |
| Post-compaction summary | `compact_summary` retains the goal, next action, and rejected approaches. |
| Codex, or host unclear | Labelled checkpoint lines within the same word budget, followed by an instruction to run plain `/compact`. |

If the captured evidence shows the instructions replaced the default summary, or that the host altered the pasted text, report it and stop. Changing the skill's output design is a separate decision.
