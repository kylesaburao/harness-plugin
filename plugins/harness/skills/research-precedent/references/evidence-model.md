# Evidence model, verdicts, and reporting

How to record a precedent, how to reach a conclusion from it, and how to write the result so it stays trustworthy after the session ends. Load this at workflow step 6.

## Contents

- Recording a precedent
- Stated rationale versus reconstructed rationale
- Reconstructing constraints from circumstantial evidence
- Comparing historical context with present context
- Reaching a verdict
- Report structure
- Failure modes and their defenses
- Applying the skill's warnings to its own output

## Recording a precedent

Keep a compact record for each precedent strong enough to appear in the report. The shape below is illustrative. Adapt it, drop fields that do not apply, and never invent a value to fill a field.

```yaml
precedent:
  title:
  source:
    type:                 # commit, change request, work item, decision record,
                          # documentation page, incident record, external project
    identifier:
    location:
    date:
  relationship: exact | analogous | conceptual
  source_role: [historical, observational, directive, contextual, discovery]
  problem:
  approach:
  rationale:
    stated:               # quoted or cited from a source that says it
    reconstructed:        # inferred, with the circumstantial evidence named
  constraints: []
  alternatives_considered: []
  outcome:
    status: adopted | modified | replaced | reverted | abandoned | unknown
    evidence: []
  current_applicability:
    still_holds: []
    changed: []
    new: []
  source_characteristics:
    authority:
    currency:
    maintenance_status:
  provenance: []
```

Every precedent that reaches the report carries a coordinate that can actually be retrieved: a repository and commit, a change request number, a work item key, a decision record identifier, a document identifier, a stable URL, or a file path at a named revision. If no such coordinate can be produced, the finding is described as an impression and is not presented as a precedent.

Do not manufacture precision a source cannot support. An approximate date recorded as approximate is useful. An invented exact date is worse than nothing.

## Stated rationale versus reconstructed rationale

Keep these two fields separate and never merge them.

In most organizations, why an approach was chosen is the least recorded category of engineering information. Commit messages describe what changed. Change requests sometimes describe why at the level of the diff rather than the decision. Decision records capture rationale properly and are rare.

A skill designed on the assumption that rationale is retrievable will either return unknowns constantly or, much worse, generate plausible reasoning to fill the gap. Presenting reconstruction as stated rationale is the single most likely way this research produces confident fiction.

```text
stated:         a source actually says this, and the source is cited
reconstructed:  you inferred this, and the evidence you inferred it from is named
```

If both are empty, the rationale is unknown. Say so.

## Reconstructing constraints from circumstantial evidence

Reconstruction is legitimate and often reliable. It just has to be labeled.

- Dependency and platform versions in the manifest at that revision bound what was available to choose from.
- The date bounds what existed at all. An approach chosen before a technology was released cannot have rejected that technology, so its absence from the alternatives is not a judgment against it.
- Configuration and infrastructure definitions at that revision show the deployment model the decision had to fit.
- The size and shape of the change distinguishes a considered project from an expedient fix made under pressure.
- What shipped alongside it indicates what else the team was dealing with at the time.

Each of these supports a statement of the form "the choice was made under these conditions", which is usually enough to judge whether the reasoning transfers, even when the reasoning itself was never written down.

## Comparing historical context with present context

For each strong precedent, compare the environment it was made in against the environment now. Which constraints still hold. Which no longer apply. Which are new. Whether relevant technology, platform capabilities, scale, reliability expectations, security requirements, deployment model, or organizational structure have changed. Whether the precedent has since been superseded. Whether the previous solution worked only because of a condition that does not exist here.

The output of this comparison is the substance of the report. Not this:

```text
We did X before, so do X.
```

But this:

```text
X was chosen because A, B, and C held.
A and B still hold. C no longer applies.
D is a new constraint that did not exist then.
The reasoning behind X remains partly applicable. The implementation should
change to account for C and D.
```

## Reaching a verdict

Authority and currency govern how much you believe the evidence is true. Applicability governs whether it bears on this decision. Neither determines the verdict. The verdict is a function of the precedent's reasoning and its constraints.

- **FOLLOW.** The reasoning applies and the constraints that drove it still hold.
- **ADAPT.** The reasoning applies but the constraints have changed, so the implementation should differ.
- **AVOID.** The reasoning has been invalidated, the outcome was bad, or the precedent was superseded.
- **Not a verdict.** The evidence is too weak to establish what the reasoning or the outcome even was.

That fourth outcome is real and must not be forced into one of the first three. A precedent that was found but not understood belongs under confidence and unknowns. Forcing it into a verdict is how research manufactures false confidence, and it is the failure a reader is least able to detect.

Not every category needs to appear. A report with one ADAPT and nothing else is complete if that is what the evidence supports.

## Report structure

Use the tier selected in `SKILL.md`. This is the full structure. The brief tier is the first four items compressed, and the verdict line is the conclusion plus one coordinate.

**Current problem.** The normalized problem, the proposed approach, and the constraints that matter. Short.

**Relevant context.** Only context that materially affected the research. Not a summary of the environment.

**Strongest precedent.** What happened, why, why it is relevant here, what the outcome appears to have been, how it differs from today, and where to find it.

**Contrary precedent.** Evidence against the proposed direction: failed attempts, migrations away, removals, incidents, deprecations, operational burden, conflicting decisions. Do not omit this section because supporting precedent was found. If nothing was identified, say that within the limits of the sources searched.

**Additional precedent.** Other useful exact, analogous, or conceptual cases, briefly.

**Historical evolution.** When it clarifies things, reconstruct how the approach changed over time as a dated sequence. A migration seen from two points in time explains far more than two contradictory sources reported side by side.

**Differences from the current situation.** Which historical assumptions and constraints no longer hold.

**Implication for the current design.** The verdict and the reasoning behind it. Omit this section entirely when there is no proposal to evaluate. The research half of this skill stands on its own for questions like why a subsystem is built the way it is, and it should degrade to pure research rather than inventing a proposal to render judgment on.

**Confidence and unknowns.** Sources that could not be reached, uncertain outcomes, documentation suspected of being stale, unresolved contradictions, assumptions made, and the places where more research could still change the conclusion.

Prefer explanation over counting. "Seven repositories use this pattern and three use the alternative" is nearly useless on its own. Why each was chosen, what constraints each addressed, and what happened afterward is the finding. One deeply applicable precedent is worth more than twenty superficial matches.

Do not manufacture consensus. When teams diverged, investigate why: scale, consistency or latency requirements, technology generation, deployment model, security requirements, operational maturity, or simply chronology. The disagreement is itself precedent, and flattening it into a majority vote destroys the most informative thing found.

Resist the inference that existing code endorses itself. Code that exists may represent current best practice, legacy debt, a temporary migration state, accidental architecture, an obsolete constraint, a failed experiment nobody removed, a workaround, or an implementation already scheduled for replacement. The same caution applies to an old decision record, which may have been superseded or may rest on assumptions that no longer hold.

## Failure modes and their defenses

**Fabricated precedent.** Invented identifiers, plausible change request numbers, a confidently cited document that does not exist. This destroys trust permanently, because a reader who checks one citation and finds it fictional discards the whole report. Defense: the retrievable-coordinate rule above, applied without exception.

**False analogy.** Two systems that share vocabulary but not constraints. This is the most dangerous failure, because the output is fluent and specific and wrong, and because analogous precedent is exactly what this research is supposed to be good at finding. Defense: state the constraint match rather than the surface match. "Both are payment routers" is not an analogy. "Both had to serialize writes across regions under a latency budget that ruled out a consensus round trip" is.

**Precedent laundering.** The report hedges a claim appropriately, then a human quotes the report and the hedge is lost. If the report is committed to a repository it becomes a new citable artifact that looks authoritative and carries none of the original uncertainty. Defense: attach provenance to the claim itself rather than collecting citations in a footer, so the hedge travels with the sentence.

**Anchoring.** The first precedent found frames every later query, and the search becomes a search for confirmation. Defense: fix the branch set before running any branch, and run the contrary branches even after a strong supporting result appears.

**Authority inversion.** A well-written external article reads as more authoritative than a terse internal commit message that is enormously more applicable to this decision. Defense: keep authority and applicability separate, and remember that production evidence from the organization making the decision usually outweighs polished prose from outside it.

## Applying the skill's warnings to its own output

A precedent report is a descriptive document summarizing mutable facts at one point in time. That is precisely the category this skill treats with suspicion everywhere else. Committed to a repository or pasted into a design document, it becomes, in eighteen months, exactly the kind of stale artifact making confident architectural claims that the research was built to distrust.

This is not a paradox. It is a discipline to apply reflexively:

- Date the output.
- Name the sources actually searched, so a later reader can tell what was never looked at.
- Keep current-state claims visibly separate from historical claims, so the parts that decay fastest are identifiable.

A report that says "as of this date, searching these sources, the evidence indicates" ages into a useful historical record. A report that says "the architecture uses X" ages into misinformation.
