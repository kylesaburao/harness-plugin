---
name: agentic-loop
description: Run implementation work as a bounded build, adversarial review, revise loop, delegating each round to keep the orchestrating session's own context small. Use for a multi-step implementation or fix where a second, independently-briefed pass would plausibly catch something the first pass missed. Do not use for a single small edit, for exploratory or research work with no artifact to review, or when the user wants the fastest path and has waived review.
---

# Agentic loop

A build, then an adversarial review from a reviewer that starts cold, then a
revision, repeated until the reviewer has nothing blocking left to say or the
round budget runs out. The loop's value comes from two properties held
together: the reviewer must not inherit the implementer's reasoning, and the
orchestrating session must not accumulate the work itself.

## Roles

**Orchestrator** is the session that invoked this skill. It runs the loop and
does none of the work: writes the acceptance criteria, dispatches the
implementer and reviewer, triages findings, decides whether another round
runs, writes the final report.

**Implementer** does one round of work and returns a compact report, not a
transcript: files touched, what each change does, what was verified and with
which command, what was deliberately left undone.

**Reviewer** receives only the artifact and the acceptance criteria, never
the implementer's reasoning or conversation history. It returns findings:
each one severity, location, and failure scenario, nothing else. A reviewer
that inherits the implementer's context inherits the belief that produced
the bug along with it, and its review is worth nothing.

Delegate these roles using whatever mechanism the current harness provides
for running a task with its own separate context. Where none exists, run the
same structure on the orchestrating session itself; see "Running without
delegation" below.

## Why the orchestrator stays thin

The orchestrator's context is the one that has to survive every round. Each
file it reads in full, each search it runs itself, each finding it
re-derives instead of trusting the report, is context that doesn't come back
and shortens how long the loop can run before quality degrades. So the
orchestrator works from reports, not from the work itself.

Its durable state across rounds is small and explicit: the acceptance
criteria, a triage table of finding → bucket → disposition, the round
number, and the budget. Nothing else needs to persist.

One escape hatch: when a finding's severity genuinely can't be judged from
the report, ask the reviewer for the missing detail, or dispatch a narrowly
targeted follow-up check. Don't pull the whole artifact into the
orchestrator's own context to settle it — that defeats the reason to
delegate at all.

## Before round 1

Write the acceptance criteria from the user's request, before any
implementation happens. This is the anchor for both the implementer and the
reviewer, and it's the first entry in the orchestrator's durable state. Work
that drifts from these criteria in a later round is scope the user didn't
ask for, not a finding to chase.

## Round structure

1. Implementer produces or revises the artifact against the acceptance
   criteria and the open findings from the previous round, if any. Returns
   its compact report.
2. Reviewer, briefed with only the artifact and the acceptance criteria,
   reviews adversarially: actively look for what's wrong, don't default to
   approval. Returns its findings list.
3. Orchestrator triages every finding into one of three buckets:
   - **Blocking** — concrete inputs or a concrete scenario that produces
     wrong behavior, or a stated acceptance criterion left unmet.
   - **Worth fixing now** — real but not blocking; cheap enough to fold into
     the next round.
   - **Noted, not acted on** — everything else, including "could be
     cleaner," undirected style preferences, and scope beyond what was
     asked.
4. If any blocking findings remain, start another round. Otherwise stop.

A finding earns the blocking or worth-fixing bucket only by naming concrete
inputs that lead to wrong behavior, or by citing a violated project rule
with a file and line. A reviewer that can't do either goes in the noted
list. This bar is what keeps an adversarial reviewer from manufacturing
findings just to have something to say — a reviewer instructed to be
adversarial will always find *something* if the bar for counting it is soft.

## Termination

The loop ends when a round produces zero blocking findings. It also ends at
a round budget, which is why "keep going until the reviewer calls it
flawless" is not the stop rule: paired with an adversarial reviewer, that
condition doesn't reliably fire, and the loop would rather run forever or
start rewriting things nobody asked for than stop cleanly.

Set the budget from how expensive the work is to undo if it's wrong, the
same calibration a research pass uses to scale its own effort: one round for
something cheap to reverse (an internal function, a local script), three to
four for something expensive to reverse (a storage format, a public
interface, a migration). State the chosen budget and its reasoning once, in
the acceptance-criteria step, so it isn't re-litigated mid-loop.

**Budget exhausted with blocking findings still open:** stop. Report the
open findings to the user rather than self-authorizing more rounds. This is
the branch that makes the budget mean something — without it, an agent at
the cap either keeps going anyway or drops the findings silently, and either
is worse than surfacing them.

## Running without delegation

When there's no way to give the reviewer its own separate context, run the
same structure on the orchestrating session: implement, then deliberately
switch stance and re-read the changed files as written (not as remembered)
to review them, then revise.

Two limitations to hold onto here, not paper over:

- A self-review shares the blind spot that produced the bug in the first
  place. Lean on mechanical checks over judgment: run the thing, read the
  diff line by line, walk each acceptance criterion explicitly, rather than
  trusting a general sense that it looks right.
- The context-preservation reason for delegating no longer applies, since
  everything happens in one session. Compensate by writing the acceptance
  criteria and the triage table to a file and working from that file each
  round, instead of from memory of earlier rounds. That written state is
  what keeps a multi-round loop coherent without delegation.

## Final report

State plainly: what changed, what the reviewer raised each round and how it
was triaged, and what was deliberately left undone and why. Anything
described as verified names the command that verified it.
