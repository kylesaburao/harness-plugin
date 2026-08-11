# research-precedent: analysis and design decisions

Companion to `research-planning.md`. That file is the captured input. This file is
the analysis of it against the actual repository, and it resolves the decisions the
input deliberately left open.

## What `research-planning.md` actually is

It opens with "Below is the consolidated prompt" and addresses an implementing
agent in the second person. It is a commissioning prompt, not a design. Two
consequences follow.

First, roughly 285 of its 1445 lines are addressed to the implementer and never
ship inside the skill: the preamble (1-10), "First inspect this repository"
(77-99), "Implementation expectations" (1238-1261), "Testing" (1262-1364),
"Validation" (1365-1384), "Final self-review" (1385-1418), and "Final response"
(1419-1445). Much of "Design philosophy" (101-144) is also a constraint on the
implementer rather than instruction for the running skill.

Second, the remaining ~1160 lines compress a lot further than they look, because
the prompt states several ideas three or four times in different sections.
"Do not treat a wiki as current fact" appears in Phase 9, in "Source roles", in
"Current state versus historical state", and again in the self-review checklist.
The shipped skill states each rule once.

Keep this file and `research-planning.md` separate. Editing the prompt in place
would destroy the record of what was actually asked for.

## Repository constraints the prompt does not know about

The prompt says to inspect the repository first. Here is what that inspection
returns, and where it contradicts the prompt's illustrative guidance.

**Path.** The prompt's example layout says `skills/research-precedent/`. The
real canonical path is `plugins/harness/skills/research-precedent/`. `AGENTS.md`
is explicit that `plugins/harness/skills/` is the single source of truth and that
per-harness copies are forbidden.

**SKILL.md size in practice.** The three existing skills are 14, 68, and 69
lines. `write-asd-ste100` is a genuinely complex skill with 3,489 lines of Python
behind it, and its `SKILL.md` is still 69 lines. That is the real budget signal,
much stronger than the prompt's vague "keep the primary SKILL.md focused".

**Frontmatter.** `AGENTS.md` restricts shared `SKILL.md` frontmatter to `name`,
`description`, and optionally `license`, `compatibility`, `metadata`,
`allowed-tools`. All three existing skills use only `name` and `description`.

**Codex interface manifest.** The prompt's example layout omits it, but
`write-asd-ste100/agents/openai.yaml` is the established convention for giving
Codex a display name, short description, and default prompt. Claude Code needs no
equivalent because it reads the frontmatter directly.

**No validation infrastructure exists.** The prompt's validation step 4 says
"Run existing repository skill validation where applicable". There is none.
`AGENTS.md` lists `scripts/validate.py` and CI as explicitly out of scope, to be
added "only when an actual need appears". Step 4 is unsatisfiable as written and
should not motivate building a validator.

**Per-skill README and INSTALL.** `write-asd-ste100` has both. They exist because
it has a generated reference bundle requiring a documented initialization step.
A skill with no scripts and no generated data needs neither.

## The central tension

The prompt asks for a methodology of 12 phases plus about 15 cross-cutting
sections, and it also asks that activation not "inject an enormous methodology
document into every invocation". Those pull in opposite directions, and the
prompt never says where to cut. That is the main decision to make.

Resolution: `SKILL.md` carries only what must be true on every invocation, and
each reference is loaded on demand by an explicit instruction in the workflow, not
by a general suggestion that references exist.

## Decisions

### D1. Layout

```text
plugins/harness/skills/research-precedent/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── references/
    ├── methodology.md
    ├── source-evaluation.md
    ├── evidence-model.md
    └── enterprise-context.md
```

No `scripts/`, no `tests/`, no `README.md`, no `INSTALL.md` in the first version.
See D3.

**As shipped:** three references, not four. `enterprise-context.md` was folded into
`methodology.md`, since instruction-context extraction, capability discovery, and the
public-safe abstraction are steps of the search procedure and read better next to the
abstraction ladder. `methodology.md` absorbed the material and still came in at 196
lines.

### D2. What goes where

| Prompt section | Destination |
| --- | --- |
| Phase 1 problem normalization | `references/methodology.md` |
| Phase 5 exact / analogous / conceptual hypotheses | `references/methodology.md` |
| Phase 6 negative precedent branches | `references/methodology.md` |
| Phase 7 contextual rings | `references/methodology.md` |
| Phase 2 environmental and organizational context | `references/enterprise-context.md` |
| Phase 3 capability discovery | `references/enterprise-context.md` |
| Phase 4 private and public-safe context | `references/enterprise-context.md` |
| Phase 8 authority, freshness, applicability | `references/source-evaluation.md` |
| Phase 9 staleness, source roles, freshness signals | `references/source-evaluation.md` |
| Phase 10 temporal reconstruction | `references/source-evaluation.md` |
| Phase 11 precedent reconstruction | `references/evidence-model.md` |
| Phase 12 historical versus present comparison | `references/evidence-model.md` |
| Evidence representation schema | `references/evidence-model.md` |
| Expected final synthesis | `references/evidence-model.md` |

`SKILL.md` keeps, in about 60 to 80 lines: activation and non-activation
conditions, the ordered workflow with the specific point at which each reference
loads, the output contract, and the four rules that must never be violated even
if no reference is ever read.

Those four rules are worth naming explicitly, because they are the ones where a
partial execution still needs to be safe:

1. Abstract private context before any public search.
2. Search for contrary evidence before recommending an approach.
3. Never report "no precedent exists", only "none identified in the sources
   searched".
4. Never present a historical or documentary claim as current-state fact.

Estimated reference sizes: methodology ~200 lines, source-evaluation ~180,
evidence-model ~200, enterprise-context ~150.

### D3. Deterministic tooling: ship none in v1

The prompt's design philosophy ("Scripts establish facts. Skills define
procedures. The LLM makes judgments.") is sound, and it is exactly why
`write-asd-ste100` has 3,489 lines of Python: there is an external standard, a
hash-pinned PDF, and a dictionary that must be extracted identically every time.
The script establishes a fact that exists outside the model.

The prompt's candidate scripts for this skill do not have that property.
Normalizing source metadata, canonicalizing identifiers, deduplicating results,
sorting a timeline, and validating evidence records all operate on data the model
itself produced moments earlier, within one session, at a scale of tens of
records. A schema validator here checks the model's JSON against a schema the
model also wrote. That is close to zero added assurance for real maintenance
cost, and `AGENTS.md` is explicit that such things get added only when a need
appears.

One candidate is genuinely different and the prompt does not list it: a
**public-query leak check**. It would take the private-term list the skill built
in Phase 4 plus a candidate public query, and flag any overlap. It is
deterministic, it is cheap, and it guards the only irreversible action in the
entire workflow, since sending an internal service name to a third-party search
engine cannot be undone. The argument against shipping it in v1 is that its
recall is bounded by the completeness of the private-term list, which is itself a
model judgment, so it cannot be the safety mechanism, only a backstop.

Recommendation: ship v1 with no scripts, treat the Phase 4 boundary as a
procedural rule in `SKILL.md`, and revisit the leak check once there is evidence
of the rule actually being violated in practice.

### D4. Frontmatter: `name` and `description` only

Specifically, do not declare `allowed-tools`. This skill's Phase 3 is capability
discovery, meaning it is supposed to opportunistically use whatever MCP servers,
search tools, and enterprise integrations happen to exist in the environment. An
`allowed-tools` list would enumerate a fixed set and defeat the central design
goal. Omitting it is both the portable choice and the correct one.

### D5. Activation

The hard part is that the trigger is about stakes, not about a keyword. The repo
convention already covers half of this: both `natural-style` and `hello-world`
carry explicit negative triggers in their descriptions. Draft:

```
description: Research whether a problem, architecture, or proposed approach has
  precedent in this repository's history, in the wider organization, or in
  authoritative public sources, then report what happened, why, and whether the
  reasoning still applies. Use before committing to a consequential technical
  direction, such as choosing between architectures, planning a migration,
  changing an established subsystem, or adopting a new infrastructure pattern,
  and when asked whether something has been tried before. Do not use for routine
  edits, bug fixes, or questions the current code answers directly.
```

### D6. How to reach a FOLLOW / ADAPT / AVOID verdict

The prompt has a real gap here. Phase 8 insists that authority, freshness, and
applicability stay separate and warns against collapsing them into one score. The
final synthesis then demands a single verdict. It never explains the step
between.

Proposed rule, to be stated in `evidence-model.md`: the verdict is a function of
the precedent's **reasoning** and its **constraints**, not of its authority or
freshness. Authority and freshness govern how much you believe the evidence is
true. Applicability governs whether it bears on the decision. So:

- reasoning applies, constraints still hold: **FOLLOW**
- reasoning applies, constraints have changed: **ADAPT**
- reasoning invalidated, outcome was bad, or the precedent was superseded:
  **AVOID**
- evidence too weak to establish what the reasoning or outcome even was:
  **not a verdict**

That fourth outcome is missing from the prompt and needs a name. A precedent that
was found but not understood belongs under "Confidence and unknowns", not forced
into one of the three verdicts. Forcing it is how a research skill manufactures
false confidence.

### D7. A stopping rule with actual numbers

"Stop when marginal research value becomes low" is unfalsifiable, and unbounded
research is the most likely real failure mode for this skill. Concrete budget for
a single invocation:

- pursue at most 3 contextual rings, chosen by relevance rather than in order
- generate 6 to 10 search branches, of which at least 2 are negative
- retrieve deeply at most 5 candidates
- stop early when two consecutive branches return no evidence that is new

State the budget in `SKILL.md`, not in a reference, since it must bind even when
no reference is loaded. It is a default, not a limit: an explicit user request for
exhaustive research overrides it.

### D8. Codex adapter

```yaml
interface:
  display_name: "Precedent Research"
  short_description: "Check a proposed approach against historical precedent"
  default_prompt: "Use $research-precedent to check this approach against prior art."
policy:
  allow_implicit_invocation: true
```

`allow_implicit_invocation: true` matches `write-asd-ste100` and is right here,
since the skill's value depends on firing before a decision is locked in rather
than waiting to be called by name.

### D9. What can and cannot be validated

Scenarios A through G in the prompt are behavioral and depend on enterprise
systems that do not exist in this repository. They cannot be executed. Reasoning
through them is review, not testing, and the distinction should be stated plainly
rather than blurred.

What is actually checkable without new infrastructure:

- `SKILL.md` frontmatter uses only the portable field set
- no reference exceeds its budget and `SKILL.md` stays under ~80 lines
- every reference is reachable from an explicit load instruction in the workflow
- no hard-coded vendor, tool, company, or MCP server name appears anywhere
- Scenario C (no enterprise integrations) can be run for real against this
  repository, since local git history plus public web is exactly this environment

Scenario C is the one genuine end-to-end test available, and it is also the
scenario that matters most for an open-source user. Worth running deliberately.

## Gaps and tensions inside the prompt

Beyond the verdict gap in D6 and the stopping rule in D7:

**Phase 2 partly duplicates harness behavior.** Claude Code already loads
`CLAUDE.md` and Codex already loads `AGENTS.md`. The skill's actual job is not
discovering these files, it is re-reading already-loaded context with a specific
extraction lens, pulling out team ownership, Jira project keys, and system
aliases that a general instruction file mentions in passing. Writing Phase 2 as
"read CLAUDE.md" wastes tokens on something already done. Write it as "extract
retrieval signals from instruction context already in scope".

**The private/public boundary is a discipline with no enforcement.** Covered in
D3. Worth being honest in the skill text that this is a rule the model must hold,
not a control the system applies.

**Two skills may be hiding in one.** Phases 1 through 11 are research. Phase 12
and the synthesis are advisory judgment about a specific proposal. They are
coherent together, but note that the research half is useful on its own for a
question like "why is this built this way", with no proposal in hand. Keep the
synthesis section conditional so the skill degrades to pure research when there
is no approach to evaluate.

**Ring 0 is underspecified.** "Current implementation" as a search ring is doing
different work from rings 1 through 8, which are all historical or external. Ring
0 is the observational baseline you compare everything against, not a place you
search for precedent. Consider pulling it out of the ring model entirely and into
Phase 1.

## What the prompt gets right

These should survive compression intact.

The **source-role taxonomy** (directive, observational, historical, contextual,
discovery) is the strongest idea in the document. It cleanly separates "what
should exist", "what exists", and "what existed", which is exactly the confusion
that makes naive precedent research produce wrong answers. It is reusable well
beyond this skill.

**Temporal reconstruction over contradiction reporting** (Phase 10) is
non-obvious and correct. Two sources disagreeing is usually a migration seen from
two points in time, and the migration is the finding.

**Negative-precedent branch generation** (Phase 6) is the concrete mechanism
behind the anti-confirmation-bias goal, specified concretely enough to act on.
The in-process cache example is a good template.

**The private to public abstraction example** (Phase 4, the Orion Settlement
Router case) is concrete and immediately usable as a reference example.

**"No precedent was found" is not "no precedent exists"** is a precise, checkable
output constraint, and it is the kind of thing that quietly determines whether
the skill is trustworthy.

**Discovery evidence as an entry point into an evidence graph** (Phase 9, the
wiki to Jira to RFC to PR chain) correctly reframes a stale wiki from a liability
into the thing that supplies the vocabulary needed to find real evidence.

## Suggested implementation order

1. Write `SKILL.md` first, to its line budget, including the four invariant rules
   and the D7 budget. Everything else is subordinate to it.
2. Write `references/methodology.md`, since it carries the workflow's core loop.
3. Write `references/evidence-model.md`, including the D6 verdict rule and the
   conditional synthesis section.
4. Write `references/source-evaluation.md`.
5. Write `references/enterprise-context.md` last, since it is the part most
   likely to accumulate accidental organization-specific assumptions and benefits
   from being written once the rest is settled.
6. Add `agents/openai.yaml`.
7. Run Scenario C for real against this repository.
8. Review the diff for hard-coded tool and vendor names, and for any place where
   a reference is unreachable from the workflow.
