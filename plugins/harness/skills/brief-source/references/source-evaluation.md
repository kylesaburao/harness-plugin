# Evaluating a source

Criteria for judging what a source is entitled to claim. This is an inlined subset of the evaluation model from this repository's `research-precedent` skill (`plugins/harness/skills/research-precedent/references/source-evaluation.md`), kept separately here on purpose since each skill in this repository is self-contained - read that skill's fuller version if a research task needs the parts omitted below.

## Evaluate along independent dimensions

Do not collapse a source into one score. Several properties vary independently:

- **Authority.** Whether this source is entitled to settle the question it's answering.
- **Currency.** Whether it describes the present or an earlier state.
- **Applicability.** Whether it actually bears on the question being asked.
- **Provenance quality.** Whether its claims trace back to something checkable, or just to confident phrasing.
- **Maintenance status.** Whether anyone still keeps it accurate.

A polished, recent, confidently written source and an authoritative one are not the same thing. An official spec that hasn't been touched in three years can still outrank a well-written blog post from last week on the exact question at hand.

## Source roles

Classify what kind of question the source can actually answer:

- **Directive** - governs what should be done (a spec, a standard, an accepted proposal).
- **Observational** - evidence of what a system does right now.
- **Historical** - evidence of what existed or happened at a specific past point.
- **Contextual** - background that aids understanding without settling anything.
- **Discovery** - useful mainly for pointing toward a stronger source.

A source can hold more than one role, but the brief should say which role is doing the work for each claim used. A changelog entry answers "what changed"; it does not thereby answer "what should be done."

## Descriptive knowledge is an entry point, not a terminus

Documentation, wikis, onboarding pages, and README-style descriptions of mutable behavior are useful and routinely out of date, with nothing announcing when they stop being accurate. Convert an assertion from this kind of source into a hypothesis, not a fact:

```text
Page says:   "The API rate-limits at 100 requests per minute."
Record as:   Hypothesis - may be accurate, may be stale.
Verify by:   checking the current spec or the live behavior if it matters to the reader.
```

## Currency signals

Weigh creation date, last-modified date, version number, explicit deprecated/archived/superseded labels, and whether it references things (APIs, dependencies, systems) that still exist. Two symmetric warnings: recently edited does not mean correct, since a page touched last week can still describe something retired long ago; and old does not mean incorrect, since some specs and standards stay authoritative for years.

## Authority inversion

A well-written, confident secondary source (a blog post, a forum answer, an AI-generated summary) reads as more authoritative than a terse primary one (a changelog line, a spec clause, a maintainer's one-line comment on an issue), even when the terse one is the actual authority. Polish is not authority. Prefer official documentation, upstream repositories, standards text, and maintainers' own words over secondary commentary about them, and say plainly in the brief when the only source available is secondary.

## Reconciling multiple sources

When two sources disagree, check first whether they describe different points in time before treating it as a genuine conflict. Anchor each claim to its source's date or version and state that anchor in the brief rather than presenting the claim as timeless.
