---
name: write-implementation-plan
description: "Use when drafting or revising a coding implementation plan, especially in Codex or Claude Code plan mode and before presenting the final plan. Apply Harness ground rules for zero-context execution and user-requested pause, durable handoff, and resume. Not for routine implementation, loose brainstorming, informal task lists, or non-development planning."
---

# Write an implementation plan

Apply this contract while authoring the plan, then audit the final result before presenting it. It augments the host's native planning process. It does not enter or exit plan mode, implement the task, replace native planning tools, prescribe a model or exploration strategy, or require another agent.

Respect current instructions, permissions, and plan-mode write restrictions. Do not create extra files merely to apply this skill. Use an existing native plan artifact when appropriate; do not require a second copy. This is an instruction contract, not a guarantee of automatic invocation, interruption, or survival of an unexpected session loss.

If planning is delegated, provide the necessary requirements to isolated contexts. The main author remains responsible for the final audit; do not assume a subagent inherited this skill.

## Make the plan independently executable

Treat the plan as a serialization boundary: the planning conversation and original request may disappear. Assume the executor receives only the final plan, the identified repository/worktree, and explicitly identified durable artifacts. Reading this skill alone does not transfer task context.

State the problem, intended outcome, acceptance criteria, scope, and non-goals. Preserve implementation-critical user clarifications, accepted assumptions, decisions, constraints, prohibited approaches, compatibility and performance requirements, edge cases, and deferred work. Include rejected alternatives only when their rejection constrains implementation. Preserve the minimum sufficient context, not the transcript.

Reference durable, recoverable information rather than copying it unnecessarily. Write ephemeral decisions and requirements directly into the plan. Identify sources using repository-relative paths with a clear root, symbols, tests, issue identifiers, relevant commits, specifications, or other durable identifiers. Explain what each prerequisite supplies and require its relevant sections or full text to be read before dependent work.

A reference must resolve without the old conversation. Do not rely on "the agreed approach," "the earlier fix," transient tool output, an unidentified attachment, or a temporary file. A filename, URL, or skill name is not proof the next session can access its contents. Preserve essential information directly when its source will not remain available. Identify an unavailable prerequisite as a blocker rather than inventing it.

Distinguish intended behavior from current implementation, evidence from interpretation, and confirmed facts from assumptions. For consequential command-derived findings, preserve the meaningful result and the reproducible command and working directory when available. Identify which source governs a disagreement, subject to the applicable instruction hierarchy.

Record the relevant repository baseline when drift could invalidate the design. Tell the executor which assumptions to reconfirm. Current files establish observed state; they do not silently override an explicitly requested change in behavior.

Make each implementation step actionable: identify the component, intended change, important interfaces or data flow, preserved invariants, dependencies, and validation as needed. Include commands with their execution context and meaningful success criteria. Known decisions should not become another open-ended investigation. Describe genuine uncertainty, a bounded resolution procedure, and the dependent work that must wait. Do not hide an unknown inside an assumed answer.

Use a structure proportional to the task. No fixed Markdown template is required. Do not copy this entire skill into each plan or add machinery merely to satisfy headings.

## Carry execution continuity into the final plan

Every final plan must carry the material requirements below in a concise execution-continuity instruction. The executor must understand them without having this skill installed or recovering the planning conversation. Merely saying "support handoff" or "follow the planning skill" is insufficient. Preserve material constraints; omit inapplicable detail, not necessary behavior.

The user may request a pause or handoff during execution, including to stop before compaction. Do not create a handoff during ordinary planning or normal execution solely because this contract exists. Separate explicit instructions may authorize other checkpointing. Do not claim to detect compaction or guarantee recovery after an abrupt interruption.

### Stop new work and preserve the actual state

On a pause/handoff request, stop starting implementation, delegations, review cycles, and nonessential validation. Stop task-owned workers from starting further work. Use available, authorized controls to settle or interrupt in-flight activity safely; do not terminate unrelated processes.

Reach the nearest safe stopping boundary, not the next milestone. Perform only the minimal action needed to settle an already-started operation or prevent loss. Unfinished code, failing tests, and a dirty worktree can be valid pause states when accurately recorded. Do not finish the feature, clean up unrelated code, or run a full suite to make the handoff look complete.

Preserve staged, unstaged, and untracked work. Do not reset, discard, stash, stage, commit, amend, switch branches, or push merely to facilitate handoff. A handoff skill's instructions are not independent authorization for such changes.

Record any still-running or indeterminate activity. If task-owned writers cannot be confirmed stopped, report that limitation and make checking them a prerequisite to resuming edits; do not label the snapshot settled. Keep pause handling bounded rather than waiting indefinitely for optional work.

### Choose an available handoff capability

Inspect the current session's active skill catalogue for a capability that creates a durable continuation document. Select by purpose and compatibility, not a predetermined skill name. Resolve and load it through the host-supplied catalogue mechanism; do not guess installation paths.

Use a suitable skill according to its contract, within current permissions and the user's work-preservation constraints. If none is usable, or discovery/loading fails, use the manual fallback and disclose the reason. If a workflow fails after starting, inspect its partial output before using a fallback; do not overwrite an unrelated record or bypass a denied permission. Do not follow an incompatible workflow merely because it is called a handoff skill.

For the fallback, write a durable Markdown document using an existing project/worktree convention where available, otherwise an explicit stable project/worktree-relative location. Establish the absolute worktree root so the location is unambiguous. Inspect an existing destination before updating it; do not overwrite an unrelated record. Respect restrictions on writable locations. Do not use `/tmp`, plugin caches, conversation-only attachments, or an unconfirmed transient workspace as durable storage.

If no authorized durable destination is available, report the attempted location and blocker, preserve the worktree, and stop. A message containing handoff text may help recovery but is not a successfully written durable handoff.

### Preserve enough to resume without conversation history

The handoff must contain the material equivalent of:

- The objective, acceptance criteria, constraints, and non-goals; the authoritative plan location and prerequisites, or the still-relevant plan content if not durably accessible.
- Repository/worktree identity and absolute location; branch or detached state and HEAD; relevant staged, unstaged, and untracked state, including unrelated pre-existing changes that must be preserved.
- Completed and partially completed work, materially changed files, implementation decisions, deviations from the plan and their reasons, unresolved questions, and blockers.
- Commands/tests already run, their execution context and meaningful results, including failures, interrupted runs, and work not yet validated. Do not imply results cover edits made afterward.
- Remaining work in dependency order, material in-flight activity, and the exact next action with its prerequisites. If blocked, the next action is resolving the blocker, not blindly continuing an edit.

Mark unavailable facts as unknown and explain how to recover them. Do not fabricate a clean status or a passing result. Use Git state where applicable; describe equivalent workspace state when Git is unavailable.

A handoff document transfers context, not the bytes of uncommitted files. Identify whether the next session must use the same preserved worktree. If another machine or checkout is intended, identify what files and artifacts must also be transferred through an authorized mechanism. Do not imply a fresh clone contains uncommitted or untracked work, or claim transfer happened without evidence.

### Verify the handoff, emit the resume prompt, and stop

Confirm the document was written and can be read back. Check its essential references and next action. Do not claim destination-session accessibility unless established; state the required environment when it cannot be verified.

Then provide an exact, copyable resume prompt containing the actual handoff location and enough repository/worktree context to resolve it. Substitute all path placeholders. A stronger compatible prompt from the selected handoff skill is acceptable. Otherwise use the equivalent of:

```text
Continue the paused task in `<actual-repository/worktree-location>`.
Before implementation, read `<actual-handoff-location>` in full and recover
its named prerequisites. Treat it as the continuation record, subject to
current instructions and permissions. Verify the worktree, branch/HEAD,
local changes, and any recorded in-flight activity. Reconcile drift without
discarding work. If required artifacts or material preconditions are missing,
report the blocker rather than guessing. Otherwise resume from the recorded
next action and continue the remaining plan, including its pause/handoff
contract. Do not depend on the previous conversation.
```

At resume, distinguish harmless drift from a changed requirement, missing work, or a conflicting edit. Reconcile only what the evidence and authorization support; block affected work when a material conflict remains.

After reporting the handoff and resume prompt, stop implementation in that turn. If writing or verification failed, report a blocked/incomplete handoff instead of issuing a success-shaped resume prompt. The user-requested pause still applies.

## Audit before presenting

Conceptually delete the conversation and original request. Verify that the plan and its explicit durable references preserve the objective, acceptance criteria, boundaries, prerequisites, source authority, material decisions, assumptions, actionable steps, validation, and bounded uncertainty. Resolve every implementation-critical shorthand reference.

Confirm the execution-time continuity instruction covers stopping and preserving work, capability discovery with manual fallback, the necessary continuation state, verified durable output, an exact resume prompt, and stopping afterward. It must not depend on the executor retaining this skill or the old session.

Revise until every implementation-critical dependency on conversational history is stated or recoverable from an explicit durable reference. Report a genuinely missing prerequisite instead of presenting an incomplete plan as execution-ready.
