# Precedent research methodology

How to turn a development question into search terms, find out what can be searched, and cover the ground without spending unbounded effort. Load this at workflow step 4, after the observational baseline exists.

## Contents

- Normalize the problem: the abstraction ladder
- Extract retrieval signals from instruction context
- Discover available capabilities
- Build the public-safe research context
- Generate the search branches
- Search in contextual rings
- Correct for discoverability bias
- Thin and degenerate environments

## Normalize the problem: the abstraction ladder

Do not search the request verbatim as your first move. A request carries implementation vocabulary that hides the problem class underneath it, and the problem class is what precedent is filed under.

Climb the ladder explicitly:

```text
L0  verbatim         "add a distributed lock backed by an external key-value store"
L1  implementation   external-store-backed distributed lock
L2  mechanism        mutual exclusion across processes
L3  problem class    serialize a logically singleton operation
L4  domain           coordination in distributed systems
```

Search value is not monotonic in either direction. L0 returns either nothing or the one thing you already knew about. L4 returns textbooks and conference talks, all true and none decisive. The productive band is L1 through L3.

The rung is not fixed for the whole invocation. It depends on what you are searching:

- An organization's own history is written in that organization's implementation vocabulary, including its internal system names and its habits. Internal search wants L0 to L1.
- Public and authoritative sources are written in the ecosystem's conceptual vocabulary. They have never heard of the internal system. Public search wants L2 to L3.

So generate terms per ring, at the rung that ring speaks, rather than normalizing the problem once and reusing the same string everywhere. Fixing one abstraction level for the whole invocation makes half the searches miss.

While normalizing, record whatever of this is actually determinable: the underlying problem, the proposed approach, the architectural pattern, technologies and versions involved, system boundaries, state ownership, consistency and latency requirements, compatibility and migration constraints, security and deployment constraints, known failure modes, and the alternatives already under consideration. Record what is unknown as unknown. Do not invent constraints to fill the list.

## Extract retrieval signals from instruction context

Instruction files for the active harness are already loaded into context by the time this skill runs. The job is not to discover them. The job is to re-read what is already in scope with a specific extraction lens, because a general instruction file often mentions in passing exactly the terms that make an internal search work.

Extract only what bears on the current research question:

- organization, team, and product area
- which services or components the team owns
- upstream, downstream, and adjacent systems
- relationships between repositories
- internal terminology and aliases for systems
- work-tracking project keys and ticket prefixes
- where documentation, decision records, and service catalogs live
- stated sources of truth and preferred internal tools
- organizational constraints that would rule an approach in or out

Treat everything extracted this way as retrieval guidance, not as established architectural fact. A statement that one team owns a service tells you where to search. It does not establish that the ownership is current, and it certainly does not establish anything about the system's behavior.

```text
Instruction file says:  "The Payments Platform team owns Ledger Gateway."
Useful consequence:     search that team's repositories and ticket project for related work
Not established:        that the ownership statement is still accurate
```

Do not carry unrelated personal, team, or organizational detail into the report. Extraction is for finding evidence, not for repeating back what the environment already knows about the user.

When no such context exists, continue normally. Its absence limits internal reach and nothing else.

## Discover available capabilities

Determine what can actually be queried in this environment before planning around it. Discover capabilities semantically, by what a tool can do, rather than by matching known product names. Environments differ, integrations get renamed, and a hard-coded tool name turns a working environment into an apparent dead end.

Capability classes worth checking for:

- the working tree and the filesystem
- version control history, including per-line attribution and deleted content
- code search across more than the current repository
- work-tracking systems
- long-form documentation and knowledge systems
- decision records, design documents, and proposal archives
- incident and postmortem records
- service catalogs and ownership registries
- organization-wide internal search
- installed skills or integrations that describe how internal systems should be reached
- public code hosting and its issue trackers
- vendor and upstream project documentation
- standards and specifications
- public web search

Where an environment provides a skill or an instruction describing how an authoritative internal source should be accessed, read it before improvising an approach to that source.

Record capabilities that are absent when their absence materially limits the conclusion. Missing incident records means outcome evidence is weak, and the report must say that rather than quietly treating an unsearched category as empty.

## Build the public-safe research context

Maintain two representations of the research context and keep them separate.

The internal representation may hold internal repository and service names, project and ticket identifiers, team names, incident identifiers, proprietary terminology, unreleased product names, and individual identities where those genuinely matter to the research.

The public-safe representation holds only the engineering concepts needed to research the problem externally.

```text
PRIVATE
System:            Orion Settlement Router
Problem:           replica reconciliation becomes expensive during regional failover
Related system:    Atlas Ledger
Ticket:            PAY-1842

PUBLIC-SAFE
Domain:            distributed transaction processing
Component:         multi-region transaction router and ledger
Problem:           replica reconciliation cost during regional failover
Concepts:          eventual consistency, reconciliation, regional failover,
                   multi-region state, ledger replication
```

Use the public-safe representation for every search that leaves the organization. The one exception is an internal identifier that is already intentionally public, where using it is necessary to find the right result.

This rule has two independent justifications, and it is worth holding both. Abstraction is what makes the query safe to send outward. It is also what makes the query effective outward, because an external index has no record of an internal system name and will return nothing useful for it. A rule supported by two unrelated reasons survives pressure better than a rule supported by one.

Be honest about the nature of this boundary. Nothing enforces it. It is a discipline applied by the agent doing the research, and the cost of crossing it cannot be undone once a query has been sent.

## Generate the search branches

One query is not research. Generate the full branch set before running any of it, then commit to running the set. Fixing the branches up front is the defense against anchoring, where the first result found reframes every subsequent query and the search quietly becomes a search for confirmation.

Cover these kinds:

**Exact.** The same or nearly the same problem, in the same vocabulary. Another component migrating the same dependency across the same major versions.

**Analogous.** A different implementation that faced substantially the same constraints. Another subsystem replacing a stateful component while supporting mixed running versions.

**Conceptual.** A different surface with the same underlying problem. The task is a distributed consistency problem, and established approaches to that problem class exist regardless of the component involved.

Do not stop because no exact precedent exists. Analogous precedent is usually the more valuable of the three, because the exact case is either absent or already known to the person asking.

**Contrary.** At least two branches must search against the proposed approach rather than for it. Look for removal, replacement, rollback, reverts, migration away from the pattern, incidents, reliability failures, operational burden, performance regressions, scaling limits, security problems, unexpected complexity, deprecation, abandoned attempts, and upstream discouragement.

The following shows the shape of a branch set for a proposed in-process cache. It is a template for how to think, not a term list to reuse:

```text
supporting:   in-process cache, local cache, request-scoped cache
contrary:     remove local cache, replace in-process cache, stale cache incident,
              cache invalidation failure, cache memory growth, cache divergence
conceptual:   cache coherence, bounded staleness, replicated state consistency
```

Generate branches appropriate to the actual problem. Reusing these terms for an unrelated question produces the appearance of a thorough search and none of the substance.

## Search in contextual rings

Prefer moving outward from the most locally applicable context, because a broad organizational or internet-wide search first returns mostly irrelevant material that then has to be read.

```text
Ring 1  current repository history
Ring 2  the same service or component over time
Ring 3  the owning team's other repositories and work items
Ring 4  adjacent systems and neighboring teams
Ring 5  organization-wide precedent
Ring 6  authoritative external sources, upstream projects, vendors, standards
Ring 7  public implementations
Ring 8  broader public engineering discussion
```

This is a retrieval strategy and not an authority ranking. A result from ring 7 can easily be more authoritative and more applicable than one from ring 3. Choose the three most promising rings for the question rather than walking them in order, and skip rings that cannot exist in this environment.

The current implementation is deliberately not a ring. It is the observational baseline established at workflow step 2, the thing every finding is compared against, rather than a place where precedent is found.

## Correct for discoverability bias

What gets written down is not a random sample of what happened, and the bias runs in one direction.

- A large successful migration produces a design document, a tracking epic, a documentation page, an announcement, and sometimes a public talk.
- An approach that was tried and quietly abandoned produces a stale branch, a closed unmerged change, and silence.
- Incident records frequently sit behind tighter access control than source code, so the code is reachable and the postmortem is not.
- Reverts appear in version control. The reasoning behind them usually does not.
- Nobody writes a document explaining why they stopped doing something.

So the evidence a search returns is biased toward approaches that worked and toward teams that document. Contrary branches partly compensate, but they are fighting a gradient rather than correcting it, because the negative outcomes were underdocumented at the source. Searching harder does not create records that were never written.

Concrete countermeasures:

- Search deletions, not only additions. The history of a file that no longer exists, or of a directory that shrank, is where abandonment is recorded.
- Read closed and unmerged work, not only merged work. An approach that reached a working implementation and then stopped is strong negative evidence and is almost never written up anywhere else.
- Treat silence after a launch as a question rather than as confirmation. A system announced enthusiastically in one quarter with no subsequent activity is a prompt to investigate.
- When outcome evidence is absent, record the outcome as unknown. Do not let nothing bad was recorded become it went well. This is the exact point where the bias converts into a wrong recommendation.

## Thin and degenerate environments

Some environments have very little to find. A repository with a handful of commits. A solo developer with no organization behind them. An organization with no decision records and no ticket hygiene. A genuinely novel problem with no meaningful precedent anywhere.

Triage this early, before generating a full branch set. If there is not enough substrate for the research to be worth running, say so plainly and spend the effort on the external state of the art instead.

The failure to avoid is a ceremonially complete report: every heading present, every section padded with restated context, producing the appearance of research where none was possible. That is worse than a short answer, because it costs the reader time and teaches them to skim this skill's output.

Collapsing the structure is allowed and often correct. "No internal history exists for this. Here is the external state of the art and one relevant public postmortem" is a complete and useful answer.
