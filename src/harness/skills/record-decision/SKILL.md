---
name: record-decision
description: "Write a technical decision record after choosing an architecture, storage format, dependency, or exception to a convention. Use for consequential decisions or requests to document an existing decision's rationale. Not for routine choices, undecided plans, or agent instructions."
---

# Record a decision

A decision record exists to be read by someone who wasn't there, months later, wondering whether the reasoning still holds. Write for that reader, not for the person who just made the call.

## What to capture

1. **The problem.** What needed deciding, stated as a problem, not as the chosen solution restated.
2. **Constraints in force at the time.** What actually limited the options: existing infrastructure, team size, deadlines, a prior incident, a platform limit. Constraints that no longer hold are exactly what makes a record worth revisiting later, so name them plainly even if they seem obvious now.
3. **Options considered and rejected.** Each option gets one line: what it was and the specific reason it lost. "Simpler" or "better" is not a reason; name the actual tradeoff.
4. **The decision.** What was chosen, in one or two sentences.
5. **Reversibility.** How expensive this is to undo: a storage format or public interface is expensive, an internal module boundary or library choice behind an interface is cheap. State it plainly - "cheap to reverse" or "expensive to reverse" - because that judgment is what tells a future reader how much scrutiny a change here deserves.
6. **What would change this.** The observation, metric, or event that would justify revisiting the decision. If nothing would, say so - that's a real answer for a decision with no plausible alternative right now.

Skip a section if it's genuinely empty (e.g., no options were seriously considered) rather than padding it.

## Where it goes

Scale placement to the size of the project: default to appending a dated entry to the architecture doc or README the project already has. Don't create a `docs/decisions/` directory or an ADR template for a single entry - only introduce that structure once the existing doc has become too long to scan for this kind of content.

## Sourcing the reversibility judgment

If a `research-precedent` investigation already ran for this decision, its step-3 reversibility judgment and its report are the evidence this record should cite directly rather than re-deriving. When no such research happened, make the judgment directly from constraints and stakes: what does undoing this actually require touching.

## Style

Write the record in plain prose, not a form. State facts, not hedges. Cite the actual evidence, exact commands run, files changed, or measurements taken, wherever the record claims something was tested or verified - "verified" without evidence is not a record, it's an assertion.
