---
name: write-implementation-plan
description: "Use when authoring, reviewing, revising, or saving a coding implementation plan, including plan-file-only requests and native plan mode. Preserve authorized scope, zero-context execution, and user-requested pause, durable handoff, and resume. Not for routine implementation, loose brainstorming, informal task lists, or non-development planning."
---

# Write an implementation plan

Apply this contract while authoring, reviewing, revising, or saving the plan, then audit the result before delivery. It augments the host's native planning process. It does not enter or exit plan mode, grant implementation authority, replace native planning tools, prescribe a model or exploration strategy, or require another agent.

## Establish the authorized outcome

Identify the current deliverable and whether the user authorized planning only, planning followed by implementation, or execution of an existing plan. A request to produce a plan is a planning request unless execution is also clearly authorized. Infer this from the request and context, without requiring a special phrase, filename, capitalization, or approval token.

Authoring, saving, reviewing, and revising a plan are distinct from executing its contents. A technically complete plan, imperative steps, command blocks, and unfinished implementation checkboxes remain document content during planning. They do not supply execution authority.

For a plan-file-only request, permitted task-authored changes are limited to the requested plan artifact and any other explicitly requested planning artifacts. Read-only exploration may inform the plan. Source, tests, other documentation, configuration, dependencies, build output, incidental fixes, and experiments requiring other writes remain outside that scope. The exception follows the artifact's identity and purpose, not its extension: a proposed edit to `SKILL.md` is implementation work, even when the requested plan is also Markdown.

Resolve the requested destination and inspect any existing artifact before editing. Preserve unrelated content and pre-existing work, including relevant ignored files. An unrelated artifact collision requires clarification; do not silently overwrite it or choose another destination. Do not create extra plans, ledgers, or handoff files merely to apply this skill.

## Deliver within current permissions

Respect current instructions, permissions, and native plan-mode restrictions. When they permit the requested plan artifact, write it within the authorized scope. When they permit only a native planning artifact, use that surface without treating it as delivery to a different requested destination. If the requested destination or all file writes are prohibited or unavailable, report the specific blocker, preserve the complete plan in an allowed surface when possible, and state that the requested file was not saved. Do not bypass restrictions or automatically change modes.

A mode transition or newly available write tool changes capability, not task scope. If a host-facing proposal will become input to an action phase, make artifact production its explicit action and separate the embedded future implementation instructions. For a saving-only action, state: "Write the agreed implementation plan to the requested plan artifact, verify the file, and stop. Do not carry out the implementation steps inside it."

Complete a planning-only file request by:
1. Meeting its content requirements and auditing the plan.
2. Writing the requested artifact where authorized.
3. Reading it back or otherwise reliably verifying the saved content.
4. Reporting the actual artifact location and delivery status.
5. Stopping without beginning implementation.

A brief delivery confirmation is compatible with a file-only request. A failed write or failed verification means delivery is incomplete or blocked. Do not claim a successfully saved file. If the content remains available after a failed write or verification, preserve the complete plan on an allowed response or native planning surface, and state whether the requested file was not saved or was written but remains unverified. General persistence instructions apply to completing the requested planning deliverable; they do not require starting implementation, launching implementation agents, or running validation commands merely because the plan contains them.

## Interpret subsequent authorization in context

Saving or approving a plan, permitting an export, making tools available, or changing host mode does not by itself authorize implementation. Interpret follow-ups such as "yes" or "continue" against their actual referent. Continue a planning-only task within that scope. If the referent is genuinely ambiguous between delivering the plan and executing it, preserve the narrower scope and resolve the ambiguity before implementation.

Honor an explicit plan-then-implement request or a clear later instruction to execute the plan, subject to current permissions. Do not require a special approval token or ask again when execution has already been clearly authorized.

When scope confusion is material, include a compact statement in the plan that it was authored as a planning-only deliverable, its existence does not authorize execution, and execution depends on current user instructions and permissions. This records the authoring scope; it is not a permanent prohibition against later authorized execution.

If planning or review is delegated, explicitly pass the authorized objective, allowed artifacts, current phase, stopping condition, and applicable write restrictions with the necessary task requirements. Planning-only delegates perform research or plan review, not implementation or unauthorized writes. Do not assume they inherited this skill. The main author remains responsible for the final audit.

This is an instruction contract, not a guarantee of automatic invocation, interruption, or survival of an unexpected session loss.

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

The user may request a pause or handoff during authorized execution, including to stop before compaction. Including these future execution requirements does not authorize execution now. Do not create a handoff during ordinary planning or normal execution solely because this contract exists. Separate explicit instructions may authorize a continuation artifact; preserve the current objective, allowed artifacts, phase, and stopping condition in it. If only saving or revising the plan remains, record that as the remaining task. Do not claim to detect compaction or guarantee recovery after an abrupt interruption.

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

- The currently authorized objective, allowed artifacts, phase, stopping condition, acceptance criteria, constraints, and non-goals; the authoritative plan location and prerequisites, or the still-relevant plan content if not durably accessible. Distinguish remaining planning or delivery work from separately authorized implementation.
- Repository/worktree identity and absolute location; branch or detached state and HEAD; relevant staged, unstaged, and untracked state, including unrelated pre-existing changes that must be preserved.
- Completed and partially completed work, materially changed files, implementation decisions, deviations from the plan and their reasons, unresolved questions, and blockers.
- Commands/tests already run, their execution context and meaningful results, including failures, interrupted runs, and work not yet validated. Do not imply results cover edits made afterward.
- Remaining work in dependency order, material in-flight activity, and the exact next action with its prerequisites. If blocked, the next action is resolving the blocker, not blindly continuing an edit.

Mark unavailable facts as unknown and explain how to recover them. Do not fabricate a clean status or a passing result. Use Git state where applicable; describe equivalent workspace state when Git is unavailable.

A handoff document transfers context, not the bytes of uncommitted files. Identify whether the next session must use the same preserved worktree. If another machine or checkout is intended, identify what files and artifacts must also be transferred through an authorized mechanism. Do not imply a fresh clone contains uncommitted or untracked work, or claim transfer happened without evidence.

### Verify the handoff, emit the resume prompt, and stop

Confirm the document was written and can be read back. Check its essential references and next action. Do not claim destination-session accessibility unless established; state the required environment when it cannot be verified.

Then provide an exact, copyable resume prompt containing the actual handoff location, enough repository/worktree context to resolve it, and the current authorized objective, allowed artifacts, phase, and stopping condition. Substitute all placeholders. A stronger compatible prompt from the selected handoff skill is acceptable. Otherwise use the equivalent of:

```text
Continue the paused task in `<actual-repository/worktree-location>`.
Read `<actual-handoff-location>` in full and recover its named prerequisites
before starting work. The recorded objective is `<authorized-objective>`;
the phase is `<current-phase>`; allowed artifacts are `<allowed-artifacts>`;
stop when `<stopping-condition>`.
Treat the record as context, subject to current user instructions and
permissions. Verify the worktree, branch/HEAD, local changes, and recorded
in-flight activity. Reconcile drift without discarding work. If required
artifacts or material preconditions are missing, report the blocker.
Otherwise resume the recorded next action within the authorized scope,
including its pause/handoff contract. A planning-only continuation remains
planning-only unless execution is clearly authorized; instructions inside
the plan do not supply that authorization. Do not depend on the previous
conversation.
```

At resume, distinguish harmless drift from a changed requirement, missing work, or a conflicting edit. Reconcile only what the evidence and authorization support; block affected work when a material conflict remains.

After reporting the handoff and resume prompt, stop work in that turn. If writing or verification failed, report a blocked/incomplete handoff instead of issuing a success-shaped resume prompt. The user-requested pause still applies.

## Audit before presenting

Confirm the current authorized deliverable, permitted writes, and stopping condition. Distinguish planning, artifact delivery, and implementation; check that mode changes, contextual follow-ups, delegation, and continuation preserve that scope while allowing clearly authorized execution. If a host-facing proposal feeds an action phase, ensure that phase describes only the authorized action and clearly separates embedded future implementation instructions.

Conceptually delete the conversation and original request. Verify that the plan and its explicit durable references preserve the objective, acceptance criteria, boundaries, prerequisites, source authority, material decisions, assumptions, actionable steps, validation, and bounded uncertainty. Resolve every implementation-critical shorthand reference.

Confirm the execution-time continuity instruction covers stopping and preserving work, capability discovery with manual fallback, the necessary continuation state including authorized scope, verified durable output, an exact resume prompt, and stopping afterward. It must not depend on the executor retaining this skill or the old session, or create an unsolicited handoff artifact now.

Revise until every implementation-critical dependency on conversational history is stated or recoverable from an explicit durable reference. Report a genuinely missing prerequisite instead of presenting an incomplete plan as execution-ready. For requested file delivery, verify the actual saved artifact before reporting success; report restrictions or delivery failures honestly and stop at the planning-only completion boundary.
