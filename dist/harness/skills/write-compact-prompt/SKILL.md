---
name: write-compact-prompt
description: "Write focus instructions for a /compact command from the current session. Use when the user asks for a /compact prompt or for compaction instructions. Not for handoff documents, plans, or summaries meant to be saved."
---

# Write a compact prompt

Compaction replaces the conversation with a summary. Write the text that steers that summary toward what the next phase of work needs. You cannot run `/compact` yourself: produce text for the user to paste, and never say compaction happened. Write no files and create no handoff document.

## Choose the focus

If the user names the next phase, steer toward it. Otherwise infer it from the session. Ask only when the next step is genuinely unclear, with the ask-user API of the current harness when it is available:

- Claude Code: use `AskUserQuestion`, with the header `Next focus`.
- Codex: use `request_user_input`, with the ID `next_focus`.

## What to keep

Keep only what lives in the conversation and the next phase needs:

- **Goal:** the current objective and its acceptance criteria.
- **Decided:** settled decisions and constraints, including the user's clarifications.
- **Rejected:** each rejected approach with the reason it failed, one clause each, so it is not retried. Drop the exploration detail.
- **Open:** unfinished work, blockers, and unanswered questions.
- **Next:** the exact next action.
- **Artifacts:** exact paths, failing commands, and their meaningful results. Refer to an existing plan, task list, or handoff file by path. Do not restate it.

Leave out what Claude Code already restores after compaction: project CLAUDE.md and rules, memory, the bodies of invoked skills, and recently read or edited files. Name a file only when it is outside that set or matters for a reason the summary would miss.

Never include a secret value such as a token, key, or password. Refer to it by name or location.

Focus instructions steer the summary; they are not the summary. Write steering, not a complete record.

## Output

Keep the text to about 120 words.

**Claude Code:** give one line in a code block, with no newlines and clauses separated by semicolons:

```text
/compact Keep goal: <goal>; decided: <decisions>; rejected: <approach> (<reason>); open: <work>; next: <action>; artifacts: <paths and commands>
```

**Codex, or when the host is unclear:** `/compact` may take no instructions there. Post this checkpoint in your reply so the summary can include it, then tell the user to run plain `/compact`:

```text
Goal: <goal>
Decided: <decisions>
Rejected: <approach> (<reason>)
Open: <work>
Next: <action>
Artifacts: <paths and commands>
```

Omit a label when it has nothing to say. Add no commentary beyond one line that tells the user what to paste or run.
