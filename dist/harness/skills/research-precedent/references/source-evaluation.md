# Evaluating sources

How much to believe a source, which question it is able to answer, and what to do when two sources disagree. Load this at workflow step 5, when a source's authority, currency, or role bears on a claim.

## Contents

- Evaluate along independent dimensions
- Source roles
- Descriptive knowledge is an entry point, not a terminus
- Currency signals
- Reconstruct the timeline before reporting a contradiction
- Authority inversion
- When precedent contradicts an active directive

## Evaluate along independent dimensions

Do not rank sources on a single scale, and do not collapse them into one score. A source has several properties that vary independently:

- **Authority.** Whether this source is entitled to settle the question.
- **Currency.** Whether it describes the present or some earlier state.
- **Applicability.** Whether it bears on the decision at hand.
- **Similarity.** How close its problem is to this problem.
- **Provenance quality.** Whether the claim can be traced back to something checkable.
- **Outcome evidence.** Whether it says what actually happened afterward.
- **Maintenance status.** Whether anyone still keeps it accurate.

These come apart constantly, and the combinations are what make a source useful:

```text
An active architecture standard
  authority   very high      applicability  moderate
  currency    high           outcome        usually absent

A three-year-old change request solving almost exactly this problem
  authority   moderate       applicability  very high
  currency    low            historical value  very high

A documentation page describing the system
  authority   uncertain      applicability  high
  currency    uncertain      discovery value   very high
```

Collapsing those into one number loses the reason each is worth reading. The standard tells you what should be true. The old change request tells you what someone actually did about this exact problem. The documentation page probably tells you what to search for next.

## Source roles

Classify each important source by the question it can answer. A source can hold more than one role.

**Directive.** Governs what should be done. An active standard, a policy, an accepted decision record. Answers: what is required here.

**Observational.** Evidence about what the system does right now. Current source, current configuration, current schema, runtime evidence. Answers: what exists.

**Historical.** Evidence about what existed or happened at a specific point in time. Old commits, past change requests, completed work items, incident records, archived design documents. Answers: what existed then, and what happened.

**Contextual.** Background that improves understanding. System descriptions, ownership, terminology, architecture overviews. Answers: what the pieces are called and how they relate.

**Discovery.** Useful mainly because it points at stronger evidence. A page mentioning a migration, a readme referencing an old proposal, a work item linking an implementation. Answers: where to look next.

The distinction that matters most:

```text
Current implementation  tells you what exists
Directive sources       tell you what should exist
Historical sources      tell you what existed, and what happened to it
```

These are three different questions. Conflating them is the specific confusion that makes naive precedent research produce wrong answers. Code that exists is not thereby policy. A standard that exists is not thereby implemented.

## Descriptive knowledge is an entry point, not a terminus

Wiki pages, knowledge bases, onboarding material, project documentation, hand-maintained architecture pages, old design documents, runbooks, readmes describing mutable runtime behavior, and hand-drawn diagrams are all valuable and all liable to be out of date. Nothing enforces their accuracy, and nothing announces when they stop being accurate.

Convert an assertion from such a source into a hypothesis plus a verification step rather than into a fact:

```text
Page says:      "Service A sends authorization requests directly to Service B."
Record as:      Hypothesis. Service A may currently call Service B directly.
Verify by:      inspecting current implementation and configuration, plus recent history.
```

The real value of these sources is usually not the claim. It is the vocabulary, the system names, the team names, the project names, and the links, which are exactly what an internal search needs in order to find the artifacts that do carry authority. Follow the chain toward stronger evidence whenever it is practical:

```text
documentation page
  mentions a migration
    work item or epic
      links a design proposal
        links the implementing change
          current source and configuration
```

A page that is badly out of date can still be the most useful thing found, because it supplies the terminology needed to locate the real evidence. That reframes a stale page from a liability into a lead.

Two symmetric cautions. Do not treat a knowledge system as weak when the organization explicitly declares it an active source of truth, because in that case it may genuinely be directive. And do not treat current code as governing policy merely because it is what happens to exist.

## Currency signals

Where available, weigh creation date, modification date, last reviewed or verified date, named owner, document status, active or deprecated or archived labels, superseding documents, links to newer decisions, references to dependency versions that no longer exist, references to systems since removed or renamed, contradictions with current implementation, and recent activity.

Two warnings, and they are symmetric:

- Recently edited does not mean correct. A page touched last week can still describe an architecture retired two years ago.
- Old does not mean incorrect. Some standards remain authoritative for a decade, and an old change request can be the most applicable thing in the entire search.

Currency is evidence, not proof. It shifts confidence. It does not settle the question by itself.

## Reconstruct the timeline before reporting a contradiction

When sources disagree, the first question is not which one is right. It is whether they describe different points in time. They usually do, and the change between them is normally the finding.

```text
2023  architecture documentation   requests handled by Gateway A
2024  design proposal              proposes migrating from Gateway A to Gateway B
2024  implementing change          migration completed
2025  deployment configuration     requests routed through Gateway B
2026  documentation page           still describes Gateway A
```

Reported as a contradiction, this is noise. Reconstructed as a timeline, it says:

```text
Gateway A was the historical architecture. The organization deliberately migrated
to Gateway B in 2024. Current configuration indicates Gateway B remains in use.
The documentation page preserves the pre-migration architecture and should not be
treated as current-state evidence.
```

The stale page is not merely wrong. It dates the migration and reveals that the documentation was never updated, which is itself worth knowing about how much weight that source can carry in future.

Anchor historical evidence to its revision or date and keep it anchored. When a claim about the present rests on a mutable fact gathered earlier in a long research session, refresh it before relying on it if there is a realistic chance it changed.

## Authority inversion

A well-written external article reads as more authoritative than a terse internal commit message, even when the commit is enormously more applicable to the decision being made. Polish is not authority, and it is certainly not applicability.

For external sources, prefer primary and authoritative material: official project documentation, upstream repositories and their issue trackers, official migration guides, vendor engineering documentation, standards and specifications, maintainers' design discussions, public postmortems, and implementation history. Community discussion and secondary material are useful for discovery, for finding failure modes, and for practitioner experience, but they are not equivalent to primary technical evidence, and low-quality search-optimized content is not evidence at all.

For internal sources, production evidence from the organization making the decision usually outweighs polished prose from outside it.

## When precedent contradicts an active directive

Historical evidence sometimes indicates that a current standard is wrong. This is not rare, because standards outlive the conditions that justified them.

Report the conflict. Do not resolve it silently. Overriding an active organizational standard is not a call an assistant should make on its own, and quietly following the historical evidence instead of the directive hides the most important thing found.

The conflict belongs in the body of the report, stated prominently, not buried under confidence and unknowns. Give the directive, give the contrary evidence, give the dates, and let the reader decide whether the standard needs revisiting.
