---
name: research-precedent
description: "Research technical precedent in repository history and external practice before consequential architecture, migration, or subsystem decisions, or for recurring architectural problems. Use when asked what was tried before, why a system was built that way, or how others solve similar problems. Not for routine edits, bug fixes, or current-code lookup."
---

# Research historical precedent

Precedent is evidence, not instruction. The result of this research is a better-informed judgment, never a rule that the previous implementation must be repeated.

## Workflow

1. Every reference path in this skill is relative to the skill directory, not the current working directory. When the working directory differs, prefix the path with the absolute skill directory path.

2. Establish the observational baseline before searching anything. State the underlying engineering problem, the proposed approach if one exists, and the constraints that bear on it. Read the current implementation to know what exists now. This baseline is what every later finding is compared against, and it is not itself precedent.

3. Judge how reversible the decision is, and record the judgment. A storage format, a data migration, a public interface, or an authorization model is expensive to undo and deserves a large budget. An internal module boundary or a library choice behind an interface can be replaced in an afternoon and deserves a quick pass. Reversibility sets both the research budget and the output tier below. Ask the user when it is genuinely unclear and the answer would change the effort.

4. Read `references/methodology.md` and follow it to normalize the problem, extract retrieval signals from instruction context already loaded, discover which sources can actually be queried, and generate the search branches. Generate the complete branch set before running any branch.

5. Before running the branch set, confirm which external capability classes are actually reachable rather than assuming it. Record the ones that are not. Search the branches. Read `references/source-evaluation.md` when a source's authority, currency, or role bears on a claim you intend to make, when two sources disagree, or when a finding rests on descriptive documentation rather than on the artifact it describes.

6. Read `references/evidence-model.md` to reconstruct each strong precedent, compare its original constraints against present constraints, reach a verdict, and write the report.

## Invariants

These hold even when no reference is read and the research is cut short.

- Abstract private context into public-safe concepts before any search that leaves the organization. This is a discipline you hold, not a control the system applies.
- Search outside the current repository in every invocation where any organizational or public capability class is reachable. Name the external source classes that could not be reached, always, including in an offline or air-gapped environment where none are.
- Generate and run contrary branches before recommending an approach, including after a strong supporting result has already appeared.
- Never report that no precedent exists. Report that none was identified in the sources searched, and name those sources.
- Never present a historical or documentary claim as current-state fact. What a document said and what the system does now are separate claims with separate evidence.

## Research budget

Default for one invocation: generate six to ten search branches. At most two run against the current repository (the `local` tier). At least one runs against the `organizational` tier whenever any organizational capability class is reachable. At least one runs against the `public` tier whenever public search is reachable. At least two are contrary. Retrieve at most five candidates deeply. Stop early when two consecutive branches return nothing new.

Scale the budget by the reversibility judgment from step 3, and spend the increase on the contrary search rather than spreading it evenly, because decisions that are hard to undo are also the ones where negative evidence is hardest to find. An explicit request for exhaustive research overrides the default.

## Output tier

Select the tier from the same reversibility judgment.

- **Verdict line.** One or two sentences carrying the conclusion and its single strongest coordinate. For an easily reversed decision where nothing alarming was found.
- **Brief.** Roughly fifteen lines, compressing five sections of the full structure in `references/evidence-model.md`: Strongest precedent, Contrary precedent, External state of the art, Differences from the current situation, and Confidence and unknowns (source classes searched and external classes unreachable, named explicitly). This is the default.
- **Full report.** The complete structure in `references/evidence-model.md`, for decisions that are hard to undo and for explicit requests.

The verdict line tier is exempt from naming source classes. Brief and full both name them, per the Confidence and unknowns section above.

Escalate the tier without being asked in one case only: contrary evidence strong enough to change the decision. A finding that this approach previously caused an incident is worth interrupting for at any tier.

Omit sections that have nothing in them. A short honest report of a thin search is more useful than a padded one, because the reader's next action depends on knowing how much weight the finding can carry.
