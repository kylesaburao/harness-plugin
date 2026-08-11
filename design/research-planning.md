Below is the consolidated prompt. I tightened the distinction between current-state evidence, historical evidence, contextual/discovery sources, and authoritative directives, since that is central to making the skill useful in a real enterprise rather than turning it into an indiscriminate internal-search agent.

You are working in an existing repository that provides reusable skills/plugins for Claude Code and Codex.

Design, implement, test, and document a new durable engineering skill for historical precedent research.

The working name is research-precedent. You may choose a better concise name if repository conventions or the final design strongly justify it.

Do not merely produce a proposal. Inspect the repository, implement the skill, validate it, and review the resulting diff.

Objective

Create a harness-independent engineering research skill that contextualizes a current development problem or proposed implementation approach against historical precedent.

The skill should answer questions such as:

* Has this organization encountered this problem before?
* Has this team or an adjacent team implemented something similar?
* Has a similar architecture previously been introduced, removed, migrated, or reverted?
* Were there incidents caused by an approach similar to the one now being proposed?
* Why did a previous implementation choose its architecture?
* What constraints existed when that decision was made?
* Do those constraints still exist?
* Has the relevant technology or organizational environment changed?
* What approaches have authoritative external projects or vendors used?
* What does broader public engineering precedent suggest?
* Is there evidence against the proposed approach?
* Should the current implementation follow, adapt, or reject the discovered precedent?

The skill is intended to improve engineering judgment through institutional memory and historical evidence.

Historical precedent is evidence, not instruction.

The skill must not blindly reproduce previous implementations merely because they exist.

Operating environments

The skill must support both enterprise and non-enterprise environments.

In a highly connected enterprise environment it may have access to:

* enterprise instructions;
* organizational skills;
* MCP servers;
* enterprise GitHub;
* Jira;
* Confluence or another wiki;
* internal architecture documentation;
* ADR/RFC systems;
* incident management systems;
* internal search;
* service catalogs;
* source repositories;
* local Git history;
* public GitHub;
* vendor documentation;
* standards;
* public web search.

In a general development environment it may have access only to:

* the current repository;
* local Git history;
* public GitHub;
* vendor documentation;
* standards;
* public web search.

Both are valid environments.

The skill must degrade gracefully according to available capabilities.

Do not make enterprise connectivity a prerequisite.

Do not hard-code assumptions about a specific company, organizational structure, MCP server, Jira installation, wiki product, repository host, or internal tool.

First inspect this repository

Before implementing the skill, inspect this repository sufficiently to understand its existing architecture and conventions.

Determine:

* how skills are structured;
* how Claude Code discovers and installs skills;
* how Codex discovers and installs skills;
* how the repository achieves shared behavior between Claude and Codex;
* how SKILL.md files are written;
* how supporting references are organized;
* how scripts are packaged;
* how deterministic tooling is tested;
* how validation works;
* what plugin metadata exists;
* what conventions should be preserved.

Inspect the more substantial existing skills rather than inferring conventions only from trivial examples.

Reuse established repository patterns wherever appropriate.

Do not create a parallel architecture when the repository already provides one.

Design philosophy

This should be a durable engineering utility, not merely a long prompt stored inside SKILL.md.

Follow this separation:

Scripts establish facts. Skills define procedures. The LLM makes judgments.

Use deterministic tooling when it improves:

* reproducibility;
* normalization;
* validation;
* provenance;
* deduplication;
* timeline construction;
* evidence management;
* efficiency.

Do not move semantic architectural judgment into scripts simply because it is possible to encode heuristics.

For example, deterministic tooling may establish:

* a commit date;
* a PR identifier;
* a Jira identifier;
* a source URL;
* a document modification date;
* duplicate search results;
* chronological ordering;
* repository metadata;
* evidence schema validity.

The LLM should determine:

* whether two engineering problems are meaningfully analogous;
* whether a historical constraint still applies;
* whether an approach was actually successful;
* whether a precedent is relevant;
* whether contradictory evidence changes the interpretation;
* whether the current design should follow, adapt, or reject precedent.

Do not add deterministic scripts that provide little benefit relative to their maintenance cost.

Activation intent

The skill should be useful when an engineer or coding agent is:

* planning a substantial implementation;
* choosing between architectural approaches;
* designing a migration;
* modifying an established subsystem;
* considering a new infrastructure pattern;
* debugging a recurring architectural problem;
* addressing a reliability or scaling issue;
* proposing a replacement for an existing pattern;
* reviewing whether an approach is consistent with organizational experience;
* explicitly asking for historical precedent.

Do not make it trigger indiscriminately for every trivial code edit.

The skill should be particularly valuable before committing to a consequential development direction.

Phase 1: Establish current development context

Before searching for precedent, understand the actual engineering problem.

Do not immediately search the user’s wording verbatim.

Normalize the task into a concise internal research representation.

Identify, where relevant:

* the underlying engineering problem;
* the proposed approach;
* architectural pattern;
* technologies involved;
* relevant libraries/frameworks;
* system boundaries;
* data flow;
* state ownership;
* consistency requirements;
* performance requirements;
* reliability requirements;
* compatibility requirements;
* security constraints;
* deployment constraints;
* migration constraints;
* organizational constraints;
* known failure modes;
* assumptions;
* reasons the proposed approach is attractive;
* alternatives already being considered.

Separate the implementation vocabulary from the underlying problem class.

For example:

Implementation vocabulary:
"Add a Redis-backed distributed lock."
Underlying problem:
"Prevent concurrent execution of a logically singleton operation across
multiple application instances."

Both representations may be useful for research.

This abstraction is essential for finding analogous and conceptual precedent.

Phase 2: Discover environmental and organizational context

Before conducting broad precedent research, inspect applicable environmental instructions and available contextual sources.

Potential sources include:

* user-level CLAUDE.md;
* repository-level CLAUDE.md;
* applicable nested CLAUDE.md files;
* user-level AGENTS.md where applicable;
* repository-level AGENTS.md;
* applicable nested AGENTS.md files;
* repository documentation;
* repository metadata;
* available skills;
* available MCP servers;
* connected enterprise tools;
* service metadata;
* project configuration.

Do not assume CLAUDE.md or AGENTS.md contains only coding instructions.

These files may contain small but highly valuable enterprise contextualization such as:

* organization identity;
* user identity;
* role;
* team;
* team ownership;
* product area;
* service ownership;
* repository relationships;
* adjacent systems;
* upstream/downstream systems;
* adjacent teams;
* internal terminology;
* aliases for systems;
* Jira project identifiers;
* documentation locations;
* service catalogs;
* architecture systems;
* source-of-truth guidance;
* internal search instructions;
* preferred enterprise tools;
* relevant organizational constraints.

Extract only context relevant to the current research task.

Do not dump unrelated user or organizational information into the research result.

Context discovered from these files should generally be treated as retrieval guidance, not automatically as proof of architectural facts.

For example:

AGENTS.md:
"The Payments Platform team owns Ledger Gateway."
Useful consequence:
Search Payments Platform repositories and PAY Jira projects for related work.
Not automatically established:
Every ownership statement elsewhere must still be current.

The skill must continue normally when no enterprise contextualization is present.

Phase 3: Discover available research capabilities

Determine what sources can actually be queried in the current environment.

Do not assume specific tools exist.

Potential capabilities include:

* filesystem/repository inspection;
* Git history;
* Git blame;
* GitHub search;
* enterprise GitHub;
* public GitHub;
* Jira;
* Confluence;
* internal wiki;
* architecture databases;
* ADR/RFC repositories;
* incident systems;
* enterprise search;
* service catalogs;
* available MCP servers;
* installed skills describing enterprise systems;
* vendor documentation;
* standards;
* public web search.

Where enterprise-specific skills or instructions exist, inspect them when relevant to learn how authoritative sources should be accessed.

Prefer semantic capability discovery over hard-coded tool names where practical.

Record unavailable capabilities when their absence materially limits the research.

Do not claim that an organization has no precedent merely because a particular enterprise source is unavailable.

Phase 4: Build private and public-safe research context

Enterprise context may contain proprietary or private information.

Do not leak that information into public searches unnecessarily.

Maintain a conceptual distinction between:

1. private/internal research context;
2. public-safe research context.

The internal representation may contain:

* internal repository names;
* project names;
* Jira identifiers;
* internal service names;
* team names;
* incident identifiers;
* proprietary terminology;
* unreleased product names;
* employee identities where genuinely relevant.

The public-safe representation should abstract these into the engineering concepts needed for external research.

Example:

PRIVATE CONTEXT
System:
Orion Settlement Router
Problem:
Replica reconciliation becomes expensive during regional failover.
Related internal system:
Atlas Ledger
Jira:
PAY-1842

Public-safe abstraction:

PUBLIC RESEARCH CONTEXT
Domain:
distributed transaction processing
Component:
multi-region transaction router / ledger
Problem:
replica reconciliation cost during regional failover
Concepts:
- eventual consistency
- reconciliation
- regional failover
- multi-region state
- ledger replication

Public search should use the abstracted representation unless an internal identifier is already intentionally public and using it is necessary.

Never expose proprietary information to a public search merely because it might improve search precision.

Phase 5: Generate precedent hypotheses

Do not rely on a single search query.

Generate multiple semantic search branches based on the normalized problem.

Search for at least the relevant subset of:

Exact precedent

The same or nearly identical problem has occurred before.

Example:

Another service migrated the same library between the same major versions.

Analogous precedent

A different implementation encountered substantially the same engineering constraints.

Example:

Another subsystem migrated a stateful middleware component while supporting mixed application versions.

Conceptual precedent

The implementation differs but the underlying engineering problem is the same.

Example:

The current task is fundamentally a distributed consistency problem, and established approaches exist for that problem class.

Do not stop because no exact precedent exists.

Often the most valuable precedent will be analogous rather than identical.

Phase 6: Search deliberately for negative precedent

The skill must actively resist confirmation bias.

For meaningful proposed approaches, search both supporting and contrary directions.

Look for evidence such as:

* successful adoption;
* unsuccessful adoption;
* removal;
* replacement;
* rollback;
* revert;
* migration away from the pattern;
* incidents;
* reliability failures;
* operational burden;
* performance regressions;
* scalability limitations;
* security problems;
* unexpected complexity;
* deprecation;
* abandoned implementations;
* maintenance problems;
* upstream discouragement;
* changed best practices.

Generate semantically related negative queries.

For example, if the proposed approach is an in-process cache, possible branches include:

supporting:
- in-process cache
- local cache
- request cache
- process-local cache
negative:
- remove in-process cache
- replace local cache
- stale local cache
- cache inconsistency
- cache invalidation incident
- cache memory growth
- cache synchronization failure
conceptual:
- distributed cache consistency
- bounded staleness
- cache coherence
- replicated state consistency

Do not mechanically use these exact terms for every case.

Generate search branches appropriate to the current engineering problem.

Phase 7: Search in contextual rings

Prefer searching from the most locally applicable context outward.

A useful conceptual model is:

Ring 0: current implementation
Ring 1: current repository history
Ring 2: same service/component history
Ring 3: same team's repositories/work items
Ring 4: adjacent systems and teams
Ring 5: organization-wide precedent
Ring 6: authoritative external sources
Ring 7: relevant public implementations
Ring 8: broader public engineering discussion

This is a search strategy, not a rigid authority hierarchy.

A result from Ring 7 may be more authoritative or applicable than a result from Ring 3.

Use contextual rings to improve retrieval efficiency, especially in large enterprises where organization-wide searches can produce large amounts of irrelevant material.

Phase 8: Treat source authority, freshness, and applicability independently

Do not use a simplistic source hierarchy.

Evaluate evidence along separate conceptual dimensions such as:

* authority;
* freshness;
* applicability;
* similarity;
* provenance quality;
* evidence of outcome;
* production usage;
* maintenance status;
* temporal relevance.

Avoid collapsing these dimensions into one arbitrary numeric score unless there is a strong implementation reason.

Examples:

An active architecture standard may have:

authority: very high
freshness: high
applicability: moderate

A three-year-old PR solving almost exactly the current problem may have:

authority: moderate
freshness: lower
applicability: very high
historical value: very high

A wiki page may have:

authority: uncertain
freshness: uncertain
applicability: high
discovery value: very high

These distinctions matter.

Phase 9: Treat wiki and descriptive knowledge as potentially stale

Wiki-style and descriptive knowledge systems are valuable but must not automatically be treated as golden knowledge.

Potentially stale sources include:

* Confluence;
* internal wikis;
* knowledge bases;
* onboarding documentation;
* project documentation;
* manually maintained architecture pages;
* old design documents;
* runbooks;
* README files describing mutable runtime behavior;
* manually maintained diagrams.

These sources can be excellent for discovering:

* historical context;
* terminology;
* system names;
* team names;
* ownership;
* architectural concepts;
* related projects;
* old decisions;
* migrations;
* incidents;
* repositories;
* Jira tickets;
* RFCs;
* ADRs;
* people or teams worth investigating;
* links to stronger evidence.

Treat them primarily as sources of:

* context;
* hypotheses;
* terminology;
* historical evidence;
* directions for further investigation;

unless their current authority and freshness can be established.

A wiki statement such as:

Service A sends authorization requests directly to Service B.

should often initially become:

Hypothesis:
Service A may currently communicate directly with Service B.
Verification:
Inspect current implementation/configuration and recent history.

Do not silently convert mutable historical documentation into current fact.

Follow references from weak evidence toward stronger evidence

When descriptive knowledge references stronger artifacts, follow those references when practical.

Example:

Wiki
  ↓
mentions migration
  ↓
Jira epic
  ↓
links RFC
  ↓
links implementation PR
  ↓
current source/configuration

The wiki may be extremely valuable because it exposes the vocabulary and history required to find the real evidence.

Treat descriptive knowledge as an entry point into an evidence graph rather than automatically as the terminal source.

Freshness signals

Where available, consider:

* creation date;
* modification date;
* last reviewed date;
* last verified date;
* owner;
* document status;
* active/deprecated/archive labels;
* superseding documents;
* links to newer decisions;
* references to obsolete dependency versions;
* references to removed systems;
* references to renamed systems;
* contradictions with current implementation;
* recent activity.

Do not equate “recently edited” with “correct.”

Do not equate “old” with “incorrect.”

Some old standards remain authoritative.

Some recently edited wiki pages remain inaccurate.

Freshness is evidence, not proof.

Source roles

Classify important sources mentally, and structurally where useful, according to the role they serve.

Useful roles include:

Directive

An active standard, policy, accepted ADR/RFC, or other source that governs what should be done.

Observational

Evidence about what the system currently does.

Examples:

* current source code;
* current deployment configuration;
* current schema;
* runtime evidence.

Historical

Evidence about what existed or happened at a specific point in time.

Examples:

* old commits;
* historical PRs;
* completed Jira work;
* incident reports;
* archived design documents.

Contextual

Background that improves understanding.

Examples:

* system descriptions;
* team ownership;
* terminology;
* architecture overview.

Discovery

A source primarily useful because it points toward stronger evidence.

Examples:

* wiki page linking a migration ticket;
* README mentioning an old RFC;
* Jira issue linking an implementation PR.

A single source may serve multiple roles.

Do not automatically treat a wiki as weak if the organization explicitly declares it to be an active source of truth.

Likewise, do not automatically treat code as the governing architectural policy simply because it currently exists.

Current implementation tells you what exists.

Directive sources may tell you what should exist.

Historical sources tell you what existed or happened.

These are different questions.

Phase 10: Reconstruct temporal history

When sources disagree, investigate whether they represent different points in time.

Prefer temporal reconstruction over simply reporting contradiction.

For example:

2023 architecture documentation:
Gateway A handles requests.
2024 RFC:
Proposes migration from Gateway A to Gateway B.
2024 implementation PR:
Completes migration.
2025 deployment configuration:
Routes requests through Gateway B.
2026 wiki page:
Still describes Gateway A.

The useful conclusion is:

Gateway A was the historical architecture.
The organization deliberately migrated to Gateway B in 2024.
Current operational evidence indicates Gateway B remains in use.
The wiki appears to preserve the pre-migration architecture and should
not be treated as current-state evidence.

This discrepancy is itself useful historical information.

The skill is specifically intended to understand how engineering decisions evolve over time.

Phase 11: Reconstruct important precedents

For strong precedents, do not stop after locating an implementation.

Attempt to determine:

* what problem existed;
* what triggered the work;
* what approach was selected;
* what alternatives were considered;
* why the approach was selected;
* what constraints existed;
* what assumptions existed;
* what technology versions existed;
* what organizational environment existed;
* what rollout strategy was used;
* whether compatibility was required;
* what happened during rollout;
* what happened after rollout;
* whether the approach remained;
* whether it was later modified;
* whether it was replaced;
* whether it was reverted;
* whether incidents exposed weaknesses;
* whether maintainers later expressed regret or changed direction.

Do not fabricate missing history.

Mark unknowns explicitly.

Phase 12: Compare historical context with present context

For each important precedent, compare its original environment against the current environment.

Ask:

* Which historical constraints still apply?
* Which constraints no longer apply?
* What new constraints exist?
* Have relevant technologies changed?
* Have library/platform capabilities changed?
* Has organizational architecture changed?
* Has scale changed?
* Have reliability expectations changed?
* Have security requirements changed?
* Has deployment infrastructure changed?
* Has the organization learned something since then?
* Has the precedent itself been superseded?
* Was the previous solution successful only because of conditions that do not exist here?

This comparison is one of the core responsibilities of the skill.

The goal is not:

"We did X before, therefore do X again."

The goal is:

"We did X before because A, B, and C were true.
A and B remain true.
C no longer applies.
D is now an additional constraint.
Therefore the reasoning behind X remains partly applicable, but the
implementation should be adapted."

Evidence representation

Design a lightweight normalized representation for significant precedent evidence.

It may contain fields such as:

precedent:
  title:
  source:
    type:
    identifier:
    location:
    date:
  relationship:
    type: exact | analogous | conceptual
  source_role:
    - historical
    - observational
  problem:
  approach:
  constraints: []
  alternatives: []
  outcome:
    status:
    evidence: []
  current_applicability:
    supporting: []
    differing: []
  source_characteristics:
    authority:
    freshness:
    maintenance_status:
  provenance: []

This is illustrative, not mandatory.

Adapt the schema if a better representation emerges.

Do not force unknown data into fields.

Do not fabricate outcome information.

Preserve provenance sufficiently that important claims can be traced back to sources.

Deterministic tooling

Consider whether deterministic utilities would materially improve the skill.

Potential uses include:

* normalizing source metadata;
* canonicalizing GitHub/Jira/document identifiers;
* deduplicating results;
* validating evidence records;
* building chronological timelines;
* detecting duplicate precedents discovered through multiple systems;
* sorting evidence by date;
* validating provenance;
* extracting structured metadata;
* producing compact intermediate artifacts.

Do not implement scripts for semantic tasks such as:

* determining architectural similarity;
* deciding whether precedent applies;
* judging whether an approach was successful;
* deciding whether the current implementation should use the same pattern.

Those remain LLM responsibilities.

Any deterministic scripts added must have focused tests.

Research efficiency

This skill must be useful in large repositories and enterprises without consuming unbounded context.

Use progressive disclosure.

Prefer:

search
→ inspect metadata/snippets
→ rank candidates
→ retrieve strongest candidates deeply

over:

retrieve everything
→ put everything into context
→ reason afterward

Do not load entire Jira epics, repositories, wikis, or PR histories when a smaller amount of evidence is sufficient.

Use contextual signals to narrow searches.

Deduplicate aggressively where multiple systems reference the same underlying work.

Research stopping criteria

Avoid both premature stopping and research without end.

Continue until there is sufficient evidence to understand, where reasonably possible:

* whether meaningful precedent exists;
* the strongest supporting precedent;
* meaningful contrary precedent;
* relevant historical evolution;
* important differences from the current situation;
* whether additional searching is likely to materially change the recommendation.

Do not require exhaustive organization-wide or internet-wide search.

Stop when marginal research value becomes low.

If important evidence remains unavailable, state the limitation.

Never interpret:

"No precedent was found."

as:

"No precedent exists."

unless the available evidence genuinely supports such a strong claim.

Prefer wording equivalent to:

"No relevant precedent was identified in the sources available during
this research."

Public research quality

When using the public internet, prefer strong primary or authoritative sources where available.

Examples include:

* official project documentation;
* upstream repositories;
* upstream issue trackers;
* official migration guides;
* vendor engineering documentation;
* standards;
* specifications;
* maintainers’ design discussions;
* high-quality engineering publications;
* public postmortems;
* implementation history.

Community discussion and secondary sources can be useful for:

* discovery;
* identifying failure modes;
* finding terminology;
* understanding practitioner experience.

Do not treat low-quality SEO content as equivalent to primary technical evidence.

Evidence discipline

Clearly distinguish:

* observed fact;
* historical fact;
* current-state evidence;
* directive guidance;
* inference;
* hypothesis;
* unknown.

Do not present inference as if it were directly stated by a source.

Do not claim an implementation succeeded merely because it merged.

Look for outcome evidence where outcome matters.

Possible outcome evidence includes:

* continued production use;
* follow-up changes;
* metrics;
* incident history;
* migration completion;
* rollback;
* later replacement;
* retrospective discussion;
* maintainers’ comments;
* subsequent architectural decisions.

Absence of negative evidence is not proof of success.

Expected final synthesis

The final research output should be concise enough to support an engineering decision but detailed enough to explain the evidence.

Use a structure approximately like the following when applicable.

Current problem

Concise normalized statement of the engineering problem, proposed approach, and important constraints.

Relevant context

Only contextual information materially affecting precedent research.

Do not dump unrelated enterprise/user information.

Strongest precedent

Describe the strongest applicable precedent.

Include:

* what happened;
* why it happened;
* why it is relevant;
* what the outcome appears to have been;
* important differences from today;
* provenance.

Additional precedent

Other useful exact, analogous, or conceptual cases.

Contrary / negative precedent

Evidence against the proposed direction, including:

* failed attempts;
* migrations away;
* removals;
* incidents;
* deprecations;
* operational problems;
* conflicting architectural decisions.

Do not omit this section merely because supporting precedent was found.

If no meaningful contrary evidence was identified, say that within the limits of the searched sources.

Historical evolution

When useful, reconstruct how the organization’s or ecosystem’s approach changed over time.

For example:

2021: direct synchronous calls
2022: latency incidents
2023: local caching introduced
2024: stale-state incident
2025: centralized cache adopted
2026: current architecture

Differences from the current situation

Explain which historical assumptions and constraints differ today.

Implication for the current design

Prefer conclusions framed conceptually as:

FOLLOW

Precedent whose reasoning and implementation remain directly applicable.

ADAPT

Precedent whose reasoning remains useful but whose implementation should change because the current environment differs.

AVOID

Historical approaches whose failure modes, obsolete assumptions, or later replacement make them poor choices now.

Do not force all categories to appear if they are not useful.

Confidence and unknowns

State:

* unavailable sources;
* uncertain outcomes;
* stale documentation;
* unresolved contradictions;
* assumptions;
* evidence gaps;
* areas where further research could materially change the conclusion.

Source citations and provenance

Use the citation/provenance mechanisms available in the active harness.

Important claims should remain traceable to their underlying sources.

Where possible, identify durable source coordinates such as:

* repository + commit;
* PR number;
* issue number;
* Jira ticket;
* ADR/RFC identifier;
* document identifier;
* stable URL;
* file path and revision.

Do not produce fake precision when a source cannot provide it.

Harness independence

The skill must work in both Claude Code and Codex.

The methodology must not fundamentally depend on Claude-only or Codex-only behavior.

Harness-specific packaging is acceptable.

Harness-specific adapters are acceptable when required.

The conceptual workflow should remain shared.

Prefer capability-oriented instructions such as:

Search available enterprise work-tracking sources.

over unnecessary hard-coding such as:

Call tool X with operation Y.

unless the repository’s skill architecture specifically requires those implementation details.

Progressive disclosure and context economy

Keep the primary SKILL.md focused.

Activation should not inject an enormous methodology document into every invocation.

Use references for detailed material such as:

* research methodology;
* source evaluation;
* evidence schema;
* enterprise contextualization;
* public-safe query abstraction;
* historical reconstruction;
* examples;
* deterministic-tool documentation.

Design the skill so that detailed references are loaded when needed.

Optimize for a high signal-to-context ratio.

Safety around contextual information

Enterprise instruction files may expose user identity, team membership, organizational relationships, internal project names, and other information.

Use this information only when it materially improves the current precedent search.

Do not surface unrelated personal or organizational information in the final report.

Do not copy internal identifiers into public searches unless they are already intentionally public and necessary.

Prefer conceptual abstraction before crossing the internal/public research boundary.

Avoid cargo-cult precedent

The skill must explicitly resist this reasoning:

Existing code does X.
Therefore new code should do X.

Existing code can represent:

* current best practice;
* legacy debt;
* temporary migration state;
* accidental architecture;
* an obsolete constraint;
* a failed experiment that was never removed;
* a workaround;
* an implementation awaiting replacement.

Likewise:

An old ADR says X.
Therefore X is still correct.

may be wrong if the ADR was superseded or its assumptions changed.

Precedent should narrow uncertainty and expose organizational learning, not eliminate engineering judgment.

Prefer explanation over precedent counting

Do not produce shallow outputs such as:

I found seven repositories using pattern X and three using pattern Y.

Counts can be useful but are rarely sufficient.

Prefer understanding:

* why the pattern was selected;
* what constraints it addressed;
* what happened afterward;
* why other systems selected alternatives;
* whether those reasons apply now.

One deeply applicable precedent may be more useful than twenty superficial matches.

Handle disagreement explicitly

Different teams or systems may have made different architectural choices.

Do not force false organizational consensus.

If evidence shows:

Team A uses pattern X.
Team B rejected X and uses Y.
Team C migrated from X to Y.

investigate why.

Differences may be explained by:

* scale;
* consistency requirements;
* latency requirements;
* technology generation;
* deployment model;
* team ownership;
* security requirements;
* operational maturity;
* chronology.

The disagreement itself can be valuable precedent.

Current state versus historical state

When making claims about the present system, prefer current evidence.

Before relying on mutable facts discovered earlier in a long research session, refresh them when practical if there is a realistic possibility they changed.

Historical evidence should remain anchored to its historical revision/date.

Do not accidentally reinterpret old evidence as current evidence.

Implementation expectations

After understanding the repository, implement the skill using the smallest maintainable structure that satisfies these requirements.

A possible structure might include:

skills/research-precedent/
├── SKILL.md
├── references/
│   ├── methodology.md
│   ├── source-evaluation.md
│   ├── evidence-model.md
│   └── enterprise-context.md
├── scripts/
│   └── ...
└── tests/
    └── ...

This structure is illustrative.

Follow existing repository conventions instead if they differ.

Do not create files merely to match this example.

Testing

Test deterministic components thoroughly.

Also reason through behavioral scenarios such as:

Scenario A: Full enterprise environment

Available:

* enterprise GitHub;
* Jira;
* internal wiki;
* architecture MCP;
* public web.

Expected behavior:

* discover relevant organizational context;
* search locally first;
* use wiki for terminology/history;
* follow wiki references toward stronger evidence;
* search Jira/GitHub for implementation history;
* search negative precedent;
* abstract private context before public research;
* synthesize internal and external evidence.

Scenario B: Stale wiki

Wiki says architecture uses A.

Recent PR and current configuration show migration to B.

Expected behavior:

* reconstruct temporal history;
* treat wiki as historical/contextual evidence;
* treat current configuration as stronger current-state evidence;
* explain the migration rather than simply reporting contradictory sources.

Scenario C: No enterprise integrations

Available:

* local repository;
* Git history;
* public internet.

Expected behavior:

* operate normally;
* search local history;
* derive conceptual search terms;
* research authoritative external precedent;
* avoid behaving as though enterprise data is required.

Scenario D: Supporting precedent only appears initially

Initial search finds successful examples of X.

Expected behavior:

* deliberately search for removal, failure, incident, deprecation, replacement, and alternative patterns before recommending X.

Scenario E: Old exact precedent versus new conceptual precedent

Internal implementation from five years ago exactly matches the proposed implementation.

Modern upstream documentation recommends a different pattern because the technology has changed.

Expected behavior:

* recognize the exact historical similarity;
* reconstruct why the old approach existed;
* account for changed technology;
* potentially recommend adapting or rejecting the old precedent.

Scenario F: Enterprise instructions contain contextual snippets

CLAUDE.md or AGENTS.md identifies:

* user’s team;
* owned services;
* adjacent systems;
* Jira project;
* architecture source.

Expected behavior:

* use those signals to improve retrieval;
* avoid treating all contextual statements as architectural fact;
* avoid surfacing irrelevant user/team details.

Scenario G: Conflicting internal precedent

Different teams made different choices.

Expected behavior:

* investigate contextual differences;
* avoid inventing consensus;
* explain why the precedents diverge.

Validation

After implementation:

1. Validate the skill structure against repository conventions.
2. Verify Claude Code compatibility.
3. Verify Codex compatibility.
4. Run existing repository skill validation where applicable.
5. Run tests for deterministic tooling.
6. Inspect failures and fix them rather than merely reporting them.
7. Review the skill for unnecessary Claude-specific assumptions.
8. Review it for unnecessary Codex-specific assumptions.
9. Review it for accidental enterprise-specific assumptions.
10. Review public-search behavior for possible private-information leakage.
11. Review the methodology for confirmation bias.
12. Review handling of stale wiki/documentation knowledge.
13. Review current-state versus historical-state reasoning.
14. Review context consumption and progressive disclosure.
15. Verify useful degradation when enterprise integrations are unavailable.

Final self-review

Before finishing, inspect the complete diff rather than relying on your memory of what you changed.

Ask:

* Is SKILL.md too large?
* Can detailed instructions move into references?
* Are activation conditions clear?
* Does the skill know when not to activate?
* Does it perform problem abstraction before search?
* Does it discover enterprise context without requiring it?
* Does it inspect CLAUDE.md / AGENTS.md appropriately?
* Does it discover available capabilities rather than assuming them?
* Does it use internal terminology to improve internal search?
* Does it abstract proprietary context before public search?
* Does it search exact, analogous, and conceptual precedent?
* Does it deliberately search negative precedent?
* Does it distinguish authority, freshness, and applicability?
* Does it treat wiki material as potentially stale?
* Does it follow weak/discovery evidence toward stronger evidence?
* Does it reconstruct timelines when sources conflict?
* Does it distinguish current-state evidence from historical evidence?
* Does it investigate outcomes rather than equating merged code with success?
* Does it avoid cargo-culting existing implementations?
* Does it stop research at a sensible point?
* Are important conclusions traceable to evidence?
* Are deterministic scripts actually justified?
* Are deterministic scripts tested?
* Is the methodology genuinely portable between Claude Code and Codex?
* Would the skill still be valuable to an open-source developer with no enterprise integrations?

Fix material weaknesses discovered during this review.

Final response

After implementation and validation, report:

1. what was implemented;
2. the resulting skill structure;
3. important design decisions;
4. activation behavior;
5. how development problems are normalized;
6. how CLAUDE.md and AGENTS.md are used for contextualization;
7. how enterprise capabilities and sources are discovered;
8. how wiki and potentially stale knowledge is handled;
9. how exact, analogous, conceptual, and negative precedent are researched;
10. how historical timelines and contradictory evidence are handled;
11. how private enterprise context is transformed into public-safe research queries;
12. what deterministic tooling was added and why;
13. how progressive disclosure/context efficiency was implemented;
14. how Claude Code and Codex portability was preserved;
15. tests and validation performed;
16. important limitations or intentionally deferred improvements.

Keep the final report focused on material implementation details.

Do not merely describe what you intended to build.

Implement the skill, inspect the finished result, validate it, and report what actually exists.
