# Final-plan context transfer

Treat the final plan as a serialization boundary. The entire planning
conversation may disappear before execution. A fresh executor must be
able to implement the task using only the plan, repository/worktree
state, and artifacts explicitly identified by the plan.

## Write the plan

- State the problem, intended outcome, and acceptance criteria.
- Identify every implementation-critical prerequisite source with a
  stable repository-relative path or other durable identifier. Establish
  the repository/worktree location when needed to resolve paths. Sources
  can include handoffs, specifications, issues, documentation sections,
  source symbols, tests, commits, external documents, generated artifacts,
  and command results. Explain what each prerequisite supplies.
- When execution requires prerequisite reading, make context recovery the
  first step. Name the artifacts and required sections or full-file reads.
  Reconfirm repository assumptions whose drift could invalidate the plan.
- State which source governs when sources could conflict, subject to the
  applicable instruction hierarchy. Distinguish intended behavior from
  historical implementation.
- Prefer pointers for durable, rediscoverable information. Write ephemeral
  information directly into the plan: material user clarifications,
  conversational decisions, accepted assumptions, pasted requirements,
  interpretations, and conclusions unavailable in named artifacts.
- Preserve intended behavior, invariants, architectural, compatibility,
  performance and security constraints, scope boundaries, non-goals,
  prohibited approaches, edge cases, validation requirements, and
  deliberately deferred decisions when they affect implementation.
- Preserve discoveries that materially motivate or change the work.
  Reference the evidence and explain its connection to the change.
  Distinguish observations from interpretations. For command-derived
  findings, preserve the relevant result and, when reproducible, the exact
  command and working directory. Transient tool output or temporary files
  alone are insufficient references.
- Make each implementation step understandable without conversational
  history. Name components, interfaces, behavior, and validation where
  needed. Preserve rationale when it constrains implementation choices.
- Resolve every shorthand reference inside the plan. "The handoff" or
  "the agreed behavior" is acceptable only after the plan establishes
  its referent. Otherwise state the requirement or name its source.
- Record unresolved uncertainty explicitly, with a bounded procedure for
  resolving it and the dependent actions that must wait. Do not convert
  unknowns into accepted assumptions.
- Preserve minimum sufficient context, not the transcript. Include a fact
  or durable pointer if removing it could change an implementation
  decision, lose a requirement, or leave a reference unresolvable.

Example: write "First read `handoffs/resource-monitor/HANDOFF.md` in full.
It governs the intended architecture. Keep pressure measurement
independent of admission enforcement." Do not write only "Follow the
handoff."

## Audit before presenting

Pretend the conversation and original request have been deleted. Verify:

- The problem, intended outcome, and task boundaries are clear.
- Every prerequisite is identifiable, recoverable, and assigned authority
  where necessary.
- Material user clarifications, decisions, constraints, non-goals, and
  assumptions survive.
- Every pronoun and shorthand reference resolves within the plan.
- Each step states enough to determine the change, preserved properties,
  and validation.
- Remaining uncertainty is visible and has a resolution procedure.
- A competent executor could perform the work with this plan as its first
  message.

Revise until every check passes. The completion criterion is referential
closure: every implementation-critical dependency on the conversation
is either stated in the plan or recoverable through an explicit durable
reference. Reading this guidance does not transfer task context by itself.
