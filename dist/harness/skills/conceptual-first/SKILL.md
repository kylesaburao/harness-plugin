---
name: conceptual-first
description: "Establishes conceptual ownership before expanding code. Use when planning, implementing, refactoring, or reviewing changes involving shared behavior, related components, repeated implementations or shared rules, cross-cutting policies, state lifetimes, or public contracts. Inspects existing owners, distinguishes meaningful reuse from coincidental similarity, and bounds changes. Not needed for trivial local edits with established ownership or verbatim plan export; preserves planning-only and review-only scope."
---

# Conceptual-first implementation

Resolve conceptual ownership before expanding an implementation across concrete use sites. Prefer coherent ownership and composition over minimum line count, maximum reuse, or a prescribed file structure.

## Applicability and authority

Apply this as a supporting policy within the current task. It does not authorize implementation, refactoring, installation, changing public contracts, additional artifacts, or broader access. Respect current user instructions, host permissions, repository conventions, and applicable instruction precedence. Reading, quoting, or reviewing the skill does not authorize executing its examples.

Use the lightweight path for a genuinely local change with an established owner and no new sharing, contract, state-lifetime, or propagation decision: inspect relevant context, make the authorized change, and verify appropriately. Do not produce an architectural exercise or a checkpoint record for that change. Explicit invocation does not remove this proportionality rule.

Use the ownership checkpoint for shared behavior, related implementations, meaningful repetition, cross-cutting policy, shared state, public contracts, or a change that would otherwise require coordinated edits. These conditions can occur within one file. Reclassify when evidence changes; a short patch to a shared invariant is not necessarily trivial.

Apply the policy according to the authorized task:

- **Planning:** inspect and establish ownership, contracts, composition, and intended verification in the authorized plan. Do not execute implementation steps or create experiments, dependencies, or test artifacts outside planning permissions. Verbatim export of an already agreed plan needs delivery verification, not a new architecture review.
- **Implementation:** confirm relevant current evidence, reuse valid decisions, implement bounded slices, and perform authorized verification.
- **Review:** inspect the proposed or existing implementation for concrete ownership defects, coupling, and missing evidence. Report findings without modifying code unless repairs are authorized. A different plausible design alone is not a defect; explain the consequence of any finding. Running tests remains subject to the review's permissions and scope.

Apply alongside other relevant skills without replacing their contracts. A planning skill owns planning deliverables and any handoff choice; this skill owns implementation structure. Do not invoke a planner, advisor, decision-recording skill, or another agent merely because this policy applies.

Use the complete, host-selected skill instructions already available in context; do not reload them per file or iteration. After a fresh session or loss of needed context, reload through the current host-supplied mechanism rather than assuming an earlier read is still available. For a repository's explicit source-document reference, use that selected source instance. Do not guess a cached installation path or substitute another installed copy.

This is an instruction contract, not deterministic enforcement, an automatic interruption mechanism, or a guarantee of retention after context loss.

## Ownership checkpoint

Before implementing shared structure or expanding to related use sites, establish five decisions:

1. **Semantics:** required behavior, invariants, failures, compatibility, and relevant effects. Account for ordering, input trust, state lifetime, and cost when correctness depends on them. Separate requirements from a preferred implementation.
2. **Evidence:** inspect the affected code, relevant callers and tests, representative siblings, and likely existing owners. Search by concept as well as identifier. Inspect candidate contracts and dependencies, not just matching names.
3. **Ownership:** identify existing or justified new owners for shared rules and mechanisms, their dependency directions, and state lifetimes. An existing function, component root, or feature-local module may suffice; a concept does not automatically need a file, interface, class, or public export.
4. **Composition and variation:** identify how consumers use those owners, suitable native sharing mechanisms, legitimate inputs or specializations, and similar-looking behavior that must remain separate.
5. **Boundary and verification:** choose the smallest coherent change and the checks for shared behavior, affected consumers, and important boundary cases. Exclude unrelated cleanup.

Reuse an established plan or checkpoint when it remains supported by the current task and inspected baseline. Do not repeat exploration, restate the same record, or reopen settled choices merely because execution resumes or another file is reached. Revisit only decisions affected by changed requirements, repository drift, contradictory evidence, or a newly discovered sharing boundary.

For nontrivial work, capture the resulting decisions briefly in the existing plan, normal progress communication, or another authorized output. Use concrete paths and symbols when known; distinguish inspected facts from proposals. A compact format is:

```text
Behavior and invariants:
Existing owners and evidence:
Chosen ownership, contracts, dependencies, and state lifetime:
Composition and deliberate variation or separation:
Bounded changes and verification:
```

Adapt the record rather than filling headings with generic statements. Record decisions and evidence, not private reasoning. Do not create PLAN.md, HANDOFF.md, an architecture document, or another persistent artifact solely for this policy. Preserve required output formats.

**Gate:** do not multiply an unresolved ownership decision into concrete implementations. Proceed when the decisions needed for the next coherent slice are sufficiently clear. Intentional separation is a valid outcome; extraction is not a prerequisite.

Bound inspection to material questions. Start near the change and broaden only while an unresolved ownership question could change the implementation. A bounded search does not establish that no equivalent exists anywhere. Use an authorized focused test, inspection, or minimal experiment when needed; do not develop a parallel production implementation as an experiment. Keep blocked dependent work separate from unaffected work that can proceed safely.

Without repository access, identify assumptions and the inspection needed before dependent implementation. Do not invent existing owners or claim verified repository decisions. Deliver the authorized plan or review with those limitations.

## Reuse by meaning

Prefer a suitable existing primitive; extend it only when the extension belongs to its contract and does not impose unrelated behavior on existing consumers. Introduce a missing owner when current requirements justify it. Otherwise keep behavior local.

Before sharing, assess:

- **Meaning:** which invariant, policy, transformation, or stable mechanism would be owned?
- **Reason to change:** should these uses normally change together for the same reason, or should they remain independently changeable?
- **Contract:** are inputs, outputs, failures, effects, ordering, and lifecycles compatible? Can real variation be represented without caller-name switches or unrelated flags?
- **Benefit:** does clearer ownership justify the indirection, dependency, coupling, and migration cost?

These are judgment criteria, not a score or occurrence threshold. A third instance prompts comparison, not automatic extraction. A significant shared policy may need an owner before copies exist; a short obvious operation can remain inline. Do not invent hypothetical consumers, generic registries, extension points, or public APIs to justify reuse.

Share only the common mechanism when surrounding policies differ. Repeated calls to one authoritative helper, references to shared named values, independent test expectations, and separate necessary enforcement points are not independently implemented copies of a policy.

## Respect architecture and state lifetimes

Choose the narrowest coherent owner compatible with the repository's dependency rules. Keep feature concepts local unless actual consumers justify broader ownership. Prefer a precise concept over an undifferentiated utility module. "Lower-level" describes responsibility and dependency structure, not directory depth or a requirement that every abstraction be dependency-free.

Do not create a dependency cycle or couple shared mechanics to concrete consumer implementations merely to reuse code. Distinguish runtime call direction from source dependency direction: callbacks, dependency injection, and imports of appropriately owned contracts can preserve dependency inversion. Do not relocate a domain contract into infrastructure simply to make a diagram appear bottom-up. Preserve production versus test-only boundaries and avoid unrelated framework dependencies.

One conceptual owner does not mean one mutable singleton. Preserve request-local, component-local, tenant-local, and other required state lifetimes. Share implementation without accidentally sharing caches, credentials, mutable fixtures, or other state.

Interpret one source of truth within the relevant compatibility boundary. Do not introduce a shared package or cross-service dependency solely to deduplicate independently versioned systems. Use existing contract mechanisms where direct reuse is inappropriate. Do not expand a poorly fitting abstraction merely because reuse is preferred.

## Use native sharing mechanisms appropriately

Consider the domain's existing composition and propagation mechanisms before manually restating behavior. Preserve the repository's chosen architecture; this policy is not permission to migrate paradigms.

Identify how the current domain and repository already express composition, shared definitions, inheritance, defaults, overrides, or other propagation. Choose a mechanism because its semantics match the concept, not because it happens to reduce repetition. Keep shared decisions with their natural owner and express genuine differences at the appropriate boundary.

Verify what actually propagates, under which scope and precedence, and where behavior remains local. Do not assume that a parent, common definition, or shared dependency automatically supplies everything a consumer needs. Preserve explicit exceptions, state isolation, and the existing architecture; no particular language, framework, or mechanism is required by this policy.

Preserve enforcement boundaries. A shared validation policy can run at several entry points. Do not remove authorization, trust-boundary checks, or authoritative persistence safeguards because related checks exist elsewhere.

Preserve independent test oracles, explicit scenarios, and useful diagnostics. Do not derive expected answers through the implementation under test. For mutation checks, ensure the pre-operation observation cannot be changed by the operation; comparing two references to the same mutable state does not establish absence of mutation.

## Apply during implementation

Implement and verify a small coherent slice before mechanically expanding to many siblings. "Bottom-up" does not require finishing every primitive before an end-to-end slice can be tested.

Before another substantially similar block, compare meaning and choose reuse, a narrow extraction, sharing only a stable mechanism, or intentional separation. Do not rely on an unspecified later cleanup.

After a related group of changes, review the group together for renamed copies, parallel helpers, repeated policy constants, complete variants differing only in one meaningful choice, or repeated multistep procedures. When an abstraction emerges late, revise the affected slice before expansion when bounded and justified; update relevant tests. If safe consolidation requires a wider migration, use a bounded alternative and explain material remaining duplication.

For delegated work, provide applicable policy, current authorization, shared-owner decisions, contracts, and responsibility for shared edits before agents implement related consumers. Do not assume they inherited the skill. Preserve single ownership of shared edits; delegation is not required.

Prefer the smallest coherent change, not the smallest textual diff or the cleanest imaginable repository. Update existing consumers when a changed contract requires it, but do not sweep unrelated siblings into the patch. Preserve public behavior and compatibility unless the task authorizes change. For generated artifacts, modify the authoritative generator or template under repository rules rather than hand-deduplicating output.

## Completion review

Review affected concepts across the changed slice, not each file in isolation. Ask where a change to a shared concept would be implemented. Independently duplicated implementations requiring synchronized edits need a reason; multiple calls, enforcement points, and corresponding tests or documentation do not by themselves indicate fragmented ownership.

Also ask whether a legitimate local change now forces unrelated consumers to change. That can indicate an abstraction is too broad.

In implementation, verify shared behavior and affected integrations, including relevant failures, state isolation, ordering, performance constraints, and observable states. In planning, specify these checks without treating them as executed. In review, distinguish inspected evidence from tests actually run and remaining coverage gaps.

Report actual results and material limitations. Summarize important ownership decisions or deliberate exceptions only where useful. Neither fewer lines nor successful skill loading proves improved runtime performance or better design.

## Examples and counterexamples

These illustrate ownership decisions, not mandatory architectures, technologies, filenames, or extraction patterns.

**One rule, several entry points.** Several consumers enforce the same domain invariant. A suitable existing policy can own the rule while each consumer retains its own input handling, error presentation, and necessary enforcement. Similar checks for an unrelated invariant should remain independent unless their meaning and reason to change actually coincide.

**Shared structure, deliberate variation.** Several related outputs or components share a stable structure but differ in one meaningful choice. Their common owner can define that structure and expose the genuine variation. Unrelated outputs should not be merged merely because they contain some matching elements, and unrelated lifecycles should not become flags on one universal component.

**Repeated verification, independent evidence.** Several tests check one multi-step invariant. A focused helper may own the repeated verification while each scenario and expected outcome remains explicit. Preserve diagnostic distinctions and observations that the operation under test cannot silently mutate. A small obvious assertion can remain inline.

**Shared stage, separate workflows.** Two workflows use the same transformation but differ before and after it. Share the stable transformation where justified without forcing the whole workflow into a generic framework.

**Intentional repetition.** Matching expressions can encode unrelated policies or units. Independent release boundaries and independently specified test expectations can also justify repetition. Judge shared meaning, change ownership, and coupling rather than character similarity.
