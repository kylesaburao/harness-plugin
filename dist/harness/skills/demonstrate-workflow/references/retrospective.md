# Retrospective reconstruction

Read this when the user invokes the creator after work has already happened, including the earlier portion of a mixed-entry session.

## Select the evidence span

Use the user's named task or requested subset. Otherwise identify the most recent meaningful episode and propose it. Several different tasks require selection rather than silent merger. The span may include earlier relevant prerequisites, but unrelated conversation is excluded.

Distinguish the outcome from the method. A user who says "turn this into a skill" after debugging might want a diagnostic process, an exact project recipe, or just the recurring verification. Reconstruct first so the scope question can be concrete.

## Reuse available evidence before asking

Read the conversation and tool outputs actually accessible to the active model. Extract the goal, relevant constraints, actions, corrections, decision points, material failures, and completion evidence. Reference real tool results, messages, commits, file ranges, or supplied excerpts when possible.

An old assistant narrative is not equivalent to its underlying tool output. A summarized account can guide retrieval or a question, but do not call its unsupported details directly observed. Likewise, a user report is valid evidence without being an agent observation.

Inspect named artifacts when a targeted read will resolve a relevant uncertainty. Do not sweep unrelated files, shell history, hidden application databases, other chats, or accounts. No automatic recording or history collection starts now.

## Separate past and present

A present file can show the configuration that exists now. A diff can show changes relative to a base. Neither by itself proves the sequence of commands, who made them, or which change caused the fix. File modification times are not an action trace.

Represent separate claims separately. For example:

| Claim | Support |
| --- | --- |
| The user says they enabled a setting in a GUI. | User-reported action. |
| A task-linked status result shows the setting enabled. | Observed state at the time of that result. |
| A later request succeeded. | Observed outcome if its result is available. |
| The setting was the only cause of the repair. | Not established solely by the preceding sequence. |

The table illustrates evidence classification, not a real run. Do not invent commands to bridge these events.

## Missing or compacted history

State the relevant limit plainly. Distinguish "the command output is unavailable" from "the command was never run." Inspect the exact supplied record if the user points to one and it is accessible. Do not pretend that a skill invocation grants access to the entire harness history.

Ask only for facts that change the reusable procedure or its completion claim. If a missing detail is incidental, omit it. If the original outcome was visible only to the user, accept an explicit report when suitable and label it. If an essential step remains unknown, propose a narrower target or an explicitly qualified draft rather than inventing it.

## Build a compact account

For each important event, keep the actor, operation or state transition, evidence category, temporal scope, available locator, and outcome. Explain why it matters only when it changes the procedure. No serialized event schema or persistent log is required.

Retain failed attempts when they revealed a prerequisite, constraint, misleading signal, recovery, or decision. Preserve uncertainty when multiple changes occurred together. Do not equate temporal sequence with proven causation.

Stop reconstructing once the selected path and important gaps are clear. The next output should help the user choose what to formalize, not overwhelm them with a transcript.

## Transition to scope clarification

Give a short recap, recommend a reusable boundary, and name any material evidence gap. Then use `scope-and-synthesis.md` in this references directory. Reconstruction supplies facts; the user selects the desired future behavior.
