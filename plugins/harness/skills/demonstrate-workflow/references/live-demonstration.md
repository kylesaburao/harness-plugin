# Prospective and mixed-entry demonstrations

Read this only for work the user explicitly wants to demonstrate now or continue as a demonstration. Do not apply it retroactively as a requirement that capture must already have been enabled.

## Start with the actual task

Determine the goal, relevant initial state, and completion condition from the request and context. Ask only when ambiguity changes execution. For mixed entry, reconstruct prior accessible work first and mark which portion predates invocation.

Help complete the task normally. There is no required narration, step counter, screenshot sequence, or persistent ledger. Retain only useful observations, user choices, state changes, and lessons in the session context.

## Alternate actors naturally

The agent can use authorized tools. The user can converse, use harness shell mode, run a command elsewhere, edit files, use an application, authenticate, or manipulate a physical device. Do not confuse the tool channel with the person who acted.

When a human action is necessary or chosen, explain the required state change, relevant constraint, and what to report back. Stop until the user responds. Do not guess that the action is complete because time passed or a subsequent turn arrived.

When the user resumes, inspect the relevant new state where necessary and available. Respect edits that happened outside the agent. Do not overwrite them from a stale buffer, restart from the beginning, or repeat an already completed side effect.

A command entered through the harness is visible evidence only if the host actually supplies it or its output to the model. An operation in another editor may be entirely user-reported. Both can be part of a useful demonstrated workflow.

## Capture useful corrections without overgeneralizing

Record a user's explicit stable preference as a future requirement when appropriate. Keep a one-off choice scoped to this run until clarified. If the user chooses a different action from the suggested one, preserve what actually happened, not the agent's original plan.

Retain a failure when it teaches a useful condition or remedy. Do not perform extra failures to make the demonstration richer, and do not keep incidental errors merely because they occurred.

## Complete, narrow, or stop

Use the task's natural success signal. For a conversation or subjective artifact, an explicit user judgment can establish completion. Do not force artificial measurements or regard silence as acceptance.

When the user ends early, do not call the full task demonstrated. A completed subworkflow may still be worth formalizing after the user selects it. When no supported procedure is available, explain the gap. An expressly requested partial draft must remain labeled accordingly.

After the selected outcome is established, use `scope-and-synthesis.md`. The live task and the authoring conversation are separate phases. Do not silently continue capture into unrelated later work.
