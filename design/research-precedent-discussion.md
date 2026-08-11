# research-precedent: extended discussion

Sibling to `research-planning.md` and `research-precedent-design.md`. This file
treats the skill as a self-contained artifact and works through the design
problems that determine whether it produces trustworthy output. Nothing here
depends on other skills in this repository.

## 1. The abstraction ladder is the engine

Phase 1 of the planning document shows one worked example: "add a Redis-backed
distributed lock" abstracts to "prevent concurrent execution of a logically
singleton operation across multiple application instances." It presents this as a
single step. It is really a ladder, and knowing which rung to stand on is the
skill's core competence.

```
L0  verbatim          "add a Redis-backed distributed lock"
L1  implementation    distributed lock backed by an external store
L2  mechanism         mutual exclusion across processes
L3  problem class     serialize a logically singleton operation
L4  domain            coordination in distributed systems
```

Search value is not monotonic in either direction. L0 returns either nothing or
the exact thing you already know about. L4 returns textbooks and conference
talks, all true and none decisive. The productive band is L1 to L3.

The part the planning document misses: **the right rung differs by search
target.** An organization's internal history is written in the organization's own
implementation vocabulary, so internal search wants L0 to L1. Public and
authoritative sources are written in the ecosystem's conceptual vocabulary, so
public search wants L2 to L3. Fixing one abstraction level for the whole
invocation makes half the searches miss.

This also gives the private-to-public boundary a second justification beyond
confidentiality. Abstraction is not only what makes the query safe to send
outward, it is what makes it effective outward. Those two motives happen to
point the same direction, which is convenient and worth stating in the skill,
because a rule with two independent reasons survives pressure better than a rule
with one.

Practical consequence: generate search terms per ring, at the rung that ring
speaks, rather than generating one normalized problem statement and reusing it
everywhere.

## 2. Discoverability bias skews the evidence toward success

This is the most serious structural problem with the whole idea, and the planning
document does not address it.

What gets written down is not a random sample of what happened:

- A large successful migration produces an RFC, a tracking epic, a wiki page, a
  launch announcement, and often a conference talk.
- An approach that was tried and quietly abandoned produces a stale branch, a
  closed pull request, and silence.
- Incidents are frequently held in systems with tighter access control than
  source code, so an agent may reach the code but not the postmortem.
- Reverts appear in version control but the reasoning behind them usually does
  not.
- Nobody writes a document explaining why they stopped doing something.

So the evidence a search returns is biased toward things that worked, and biased
toward teams that document. Phase 6's deliberate negative search partially
compensates, but it is fighting a gradient rather than correcting for it, because
negative outcomes are underdocumented at the source. Searching harder does not
manufacture records that were never created.

Concrete mitigations worth putting in the methodology:

- Search deletions, not only additions. The history of a file that no longer
  exists, or of a directory that shrank, is where abandonment is recorded.
- Look at closed-unmerged work, not only merged work. An approach that got as far
  as an implementation and then stopped is strong negative evidence, and it is
  almost never written up anywhere else.
- Treat a gap after a launch as a question rather than as confirmation. A system
  announced enthusiastically in one quarter with no subsequent activity is a
  prompt to investigate, not evidence of stable success.
- When outcome evidence is absent, say the outcome is unknown. Do not let
  "nothing bad was recorded" become "it went well." The planning document says
  this once, under Evidence discipline. It deserves to be a standing rule,
  because this is precisely the point where the bias converts into a wrong
  recommendation.

## 3. The rationale is usually not recorded

Phase 11 asks the skill to determine what alternatives were considered and why the
selected approach won. In most organizations this is the single least recorded
category of engineering information. Commit messages describe what changed. Pull
requests sometimes describe why, at the level of the diff rather than the
decision. Architecture decision records capture rationale properly and are rare.

If the skill is designed assuming rationale is retrievable, it will either return
unknowns constantly or, worse, invent plausible reasoning to fill the section.

The alternative is to reconstruct constraints from circumstantial evidence, which
is genuinely possible and often reliable:

- Dependency versions in the manifest at that commit bound what was available.
- The date bounds what existed at all. An approach chosen in 2019 could not have
  used a technology released in 2022, so its absence from the alternatives is not
  a judgment against it.
- Configuration and infrastructure definitions at that revision show the
  deployment model the decision had to fit.
- The size and shape of the change shows whether it was a considered project or
  an expedient fix.
- What shipped alongside it shows the pressure the team was under.

This reconstruction is legitimate and useful, but it is inference, and the
evidence model must keep it separate from stated rationale. Two distinct fields,
never merged:

```
rationale:
  stated:        # quoted or cited from a source that actually says it
  reconstructed: # inferred from circumstantial evidence, with the evidence named
```

Presenting reconstruction as if it were stated rationale is the most likely way
this skill produces confident fiction.

## 4. Reversibility should scale the research budget

The design document proposes a flat budget: three rings, six to ten branches, five
deep retrievals. A flat number is better than no number, but the input that
should drive it is how hard the decision is to undo.

- **Hard to reverse:** storage format, data migration, public API shape, auth
  model, anything that writes persistent state or that other teams will build
  against. Precedent research is worth a large budget here, because the cost of
  being wrong is paid for years.
- **Easy to reverse:** an internal module boundary, a caching layer, a library
  choice behind an interface, anything one team can rip out in an afternoon.
  A quick pass is appropriate, and a long report is actively harmful because it
  spends the engineer's attention on a decision that did not need it.

The skill cannot infer this reliably from the code, but it can usually infer it
from the change being proposed, and it can ask when genuinely unclear. Making
reversibility an explicit early input gives the stopping rule a principled basis
instead of an arbitrary constant, and it also sets the output tier discussed in
section 7.

Worth noting the interaction with section 2: irreversible decisions are also the
ones where negative precedent matters most, and negative precedent is the
hardest to find. So the budget increase for one-way doors should be spent
disproportionately on the contrary search, not spread evenly.

## 5. Failure modes to design against

Naming these makes them guardable. Each has a specific defense.

**Fabricated precedent.** Hallucinated ticket identifiers, plausible pull request
numbers, a confidently cited document that does not exist. This is the failure
that destroys trust permanently, because a reader who checks one citation and
finds it fictional will discard the entire report. Defense: every precedent that
appears in the output carries a coordinate that can actually be retrieved. If a
coordinate cannot be produced, the finding is described as an impression and not
as a precedent.

**False analogy.** Two systems that share vocabulary but not constraints. This is
the most dangerous failure because the output is fluent, specific, and wrong, and
because analogous precedent is exactly what the skill is supposed to be good at
finding. Defense: state the constraint match explicitly rather than the surface
match. "Both are payment routers" is not an analogy. "Both needed to serialize
writes across regions under a latency budget that forbade a consensus round trip"
is.

**Precedent laundering.** The skill reads a wiki page, reports its claim with
appropriate hedging, and the hedge is lost when a human quotes the report. If the
report is committed to a repository it becomes a new citable artifact that
appears authoritative and carries none of the original uncertainty. Defense: the
provenance chain must survive into the output, attached to the claim rather than
collected in a footer.

**Anchoring.** The first precedent found frames every subsequent query. Once the
skill has decided the problem resembles a caching problem, it searches for caching
and finds caching. Defense: generate the search branches before running any of
them, and commit to running the contrary branches even after a strong supporting
result appears. Order of execution matters less than the branch set being fixed
before results start arriving.

**Authority inversion.** A well-written external blog post reads as more
authoritative than a terse internal commit message, though the commit is
enormously more applicable to the decision at hand. The planning document's
insistence on separating authority from applicability is the right correction,
but it needs a concrete reminder that production evidence from one's own
organization usually outweighs polished prose from outside it.

## 6. Degenerate environments

The skill must behave well when there is very little to find:

- A repository with a handful of commits and no history worth mining.
- A solo developer with no organization behind them.
- An organization with no wiki, no decision records, and no ticket hygiene.
- A genuinely novel problem with no meaningful precedent anywhere.

The bad outcome in all four is a ceremonially complete report: every heading
present, every section padded with restated context, producing the appearance of
research where none was possible. This is worse than a short answer because it
costs the reader time and teaches them to skim the skill's output.

Two design responses. First, an early triage step that asks whether there is
enough substrate for the research to be worth running, and says so plainly when
there is not. Second, permission to collapse the output structure. "No internal
history exists for this. Here is the external state of the art and one relevant
public postmortem" is a complete and useful answer. Sections with nothing in them
should be omitted, not filled.

Related, and worth stating in the skill: an honest report of a thin search is more
valuable than a padded one, because the reader's next action depends on knowing
how much weight the finding can bear.

## 7. Output tiering

The full synthesis structure in the planning document runs to nine headings. For
an engineer who has stopped to ask "has anyone tried this," that is appropriate.
For a coding agent that triggered the skill mid-implementation, it is a wall of
text arriving in the middle of a task, and the likely outcome is that it is
skimmed and ignored.

Three tiers, selected by the reversibility judgment from section 4:

1. **Verdict line.** One or two sentences with the conclusion and its single
   strongest supporting coordinate. Appropriate for an easily reversed decision
   where research found nothing alarming.
2. **Brief.** Roughly fifteen lines: the verdict, the strongest precedent, the
   strongest contrary evidence, and the main difference from today. This should
   be the default.
3. **Full report.** The complete structure, for one-way doors and for explicit
   requests.

A tier should always be escalatable on request, and the skill should escalate on
its own initiative in one specific case: when contrary evidence is strong enough
to change the decision. A finding that the proposed approach caused an incident
before is worth interrupting for, whatever tier was selected.

## 8. The skill's own output is subject to its own warnings

A precedent report is a descriptive document summarizing mutable facts at a point
in time. That is precisely the category Phase 9 warns about. If the report is
committed to a repository or pasted into a design document, then in eighteen
months it becomes a stale artifact making confident architectural claims, of the
same kind the skill was built to be suspicious of.

This is not a paradox to resolve, just a discipline to apply to itself:

- Date the output.
- Name the sources actually searched, so a later reader can tell what was not
  looked at.
- Keep current-state claims and historical claims visibly separated, so the parts
  that decay fastest are identifiable.

A report that says "as of this date, searching these sources" ages into a useful
historical record. A report that says "the architecture uses X" ages into
misinformation.

## 9. Two open questions

**Does the research half stand alone?** Phases 1 through 11 answer "what has been
done here and why." Phase 12 and the synthesis answer "should I do this." The
first is useful with no proposal in hand, for onboarding, for archaeology on an
unfamiliar subsystem, for understanding why something is built the way it is. If
that use is intended, the synthesis must be conditional rather than mandatory,
and the activation description should cover it. If it is not intended, the skill
should say so and decline, rather than producing a verdict on a proposal that was
never made.

**What happens when precedent contradicts an active directive?** The planning
document separates directive sources from historical ones, correctly. It does not
say what to do when historical evidence suggests a current standard is wrong,
which is not a rare situation, since standards outlive their justifications. The
skill should probably report the conflict rather than resolve it, because
overriding an active organizational standard is not a call an assistant should
make silently. But the conflict itself is a high-value finding and should be
surfaced prominently rather than buried under Confidence and unknowns.
