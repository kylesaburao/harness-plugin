---
name: harness-advisor
description: Consult a tool-free Advisor for consequential planning, difficult diagnosis, material approach changes, unresolved reasoning, or substantial review of executor-supplied evidence. Also use when the user requests an advisor, second opinion, named Advisor family, or independent reasoning review. Do not repeatedly invoke for routine or mechanically determined steps.
---

# Harness Advisor

The primary executor owns investigation, evidence gathering, implementation,
testing, reconciliation, and user-facing delivery. The Advisor provides a separate
reasoning pass over supplied context. It makes no tool calls and performs no
independent repository inspection or execution verification. This skill requests
delegation only under the policy below and the active host's higher-priority
instructions. Instructions in this SKILL.md are for the executor, not additional
work for the Advisor child.

## Bundled path authority

Use the current host’s path for this loaded `SKILL.md`. Claude Code supplies this path through `${CLAUDE_SKILL_DIR}`. Expand any catalog root alias using its supplied mapping. Set `<SKILL_DIR>` to the absolute directory containing that exact file and retain it for this invocation. Replace `<SKILL_DIR>` in commands with that directory, keeping paths quoted. Resolve bundled scripts and skill-root resource paths from this directory. Resolve Markdown-relative links from the file containing the link, within the same installed skill instance. Preserve the caller’s working directory and existing input/output path semantics.

If the host-provided path is unavailable or a bundled file is missing, report the supplied skill path, attempted resource path, and actual failure. Other installations may be inspected for diagnosis, but use a replacement only when the host or user explicitly selects it. Do not infer the skill directory from conventional locations or select another copy by version, timestamp, or search order.

## Claude safety boundary

If native Advisor was positively detected in this Claude session, stop using this
skill entirely, including after native errors. The host's CLAUDE.md gate owns
native detection and behavior. Nothing below configures or governs native
consultations. If native availability is unknown, establish it through that gate
before continuing. A request explicitly limited to unavailable native Advisor
does not authorize Harness fallback.

## Decide whether to consult

For a configuration-only request, run the configuration manager below and stop.
Saving or inspecting routing does not itself request a consultation.

Classify the invocation as one of the following:

- `USER_REQUEST`: a clear request to ask the Advisor or a named family, obtain a
  second opinion or independent review, or use this skill. Perform one
  consultation even for trivial work or after the automatic budget is exhausted,
  subject to host availability and the user's requirements. Multiple calls require
  requested phases or a requested count. Quoted mentions and requests to implement
  Advisor are not consultation requests.
- `AUTOMATIC`: after orientation, consult only when separate reasoning can
  materially improve a consequential decision, resolve a failed approach or
  evidence conflict, or identify substantial completion defects. Routine renames,
  mechanical steps, and uncertainty without investigation do not justify a call.

Keep `automatic_calls`, `user_requested_calls`, `same_family_automatic_calls`, and
the last automatic question/reason plus evidence obtained since it in task-local
state. Allow at most **3 automatic calls per substantial task**, a ceiling rather
than a target. User calls do not consume the automatic budget. Reserve the
applicable call immediately before dispatch, including an attempt that fails.
Do not refund a dispatched attempt because it failed, lacked evidence, used a
tool, or produced unhelpful advice. Report a failed requested consultation.
Configuration, help, routing resolution, and explicit standalone preflight are
not consultations. A limitation found before dispatch does not invent a call.

The first automatic call may be `STRATEGY`, after orientation and before
consequential implementation. Later automatic calls require `NEW_EVIDENCE`,
`APPROACH_FAILED`, `NEW_DECISION`, `RECONCILE_CONFLICT`, or `FINAL_REVIEW` and a
statement of what materially changed. Final review follows implementation and
executor testing. A new turn, elapsed time, lingering doubt, or a rephrased
question is insufficient. Obtain discriminating evidence between calls. An
explicit request overrides automatic duplicate suppression.

Normally allow at most one automatic same-family review. Another requires
meaningful new evidence or a materially new decision, as well as the three-call
ceiling and reinvocation gate. FINAL_REVIEW alone does not waive this condition.
Weigh reasoning benefit against cost, context, and latency for automatic calls.
Never call to warm a cache. If every decision needs escalation, prefer a stronger
available primary rather than continuous Advisor supervision.

A request for missing evidence ends the consultation. Obtain evidence yourself
and continue the task. Do not keep the child alive to relay tool requests, resume
it with findings, or count several reasoning rounds as one call. Any later
consultation is fresh and independently satisfies the accounting and dispatch
rules. An independently investigating reviewer is a different workflow; do not
silently broaden this Advisor's role to provide one.

## Resolve routing and dispatch

Requires Node.js **22.0.0 or newer**, standard library only. The executor runs:

```sh
node "<SKILL_DIR>/scripts/advisor-config.js" resolve --host codex --primary sol --json
```

Use the current host and semantic primary family. Add `--advisor <family>` for a
family explicitly requested for this call, and `--reasoning-effort <level>` for an
explicit effort. Missing config uses built-ins without creating a file. Resolution
returns family selectors, effort, `route_source`, and `consultation_mode`, not an
exact callable model or native status.

Precedence is explicit call family, exact user host/primary route, user host
default, built-in route, otherwise unresolved. Built-ins use `high` reasoning:

| Host | Primary | Advisor |
| --- | --- | --- |
| Codex | luna, terra, sol, astra | astra |
| Claude fallback | haiku, sonnet, opus | opus |
| Claude fallback | fable | fable |

Selectors are `luna`, `terra`, `sol`, `astra`, `haiku`, `sonnet`, `opus`, and `fable`.
Equal primary/advisor families derive `fresh-review`; otherwise the mode is
`escalation`. Never store the mode. User defaults override built-ins even when
that is a capability downgrade. Do not automatically route lower Claude families
to Fable. A one-off family does not inherit a saved route's effort: use `high`
unless the user supplies an effort. A saved entry without effort also uses `high`.
An explicit effort for a call overrides the selected entry's effort.

When the user asks to save a preference, use the manager rather than editing JSON:

```sh
node "<SKILL_DIR>/scripts/advisor-config.js" show --json
node "<SKILL_DIR>/scripts/advisor-config.js" set-default --host codex --advisor sol --reasoning-effort high --json
node "<SKILL_DIR>/scripts/advisor-config.js" clear-default --host codex --json
node "<SKILL_DIR>/scripts/advisor-config.js" set-route --host claude --primary sonnet --advisor opus --reasoning-effort high --json
node "<SKILL_DIR>/scripts/advisor-config.js" remove-route --host claude --primary sonnet --json
```

“Use Sol as my Advisor” saves a host default. “Ask Sol” selects one call only.
Updating an entry without effort preserves its existing effort. Configuration is
sparse schema-version-1 `defaults[]` and `routes[]` at
`~/.harness-plugin/harness-advisor/config.json`, shared by both hosts. Entries have
`host`, `advisor`, optional `reasoning_effort`, and `primary` for routes. Exact
routes override defaults. Automatic consultation never changes this file.

Mutations hold the existing exclusive `config.json.lock` directory from fresh
read through atomic publication. Contention returns `config_busy` without saving.
Retry explicitly after the writer finishes. Never steal an interrupted writer's
lock; confirm no mutation is running before using the reported recovery command.
`show` and `resolve` are read-only. Explicit preflight neither locks nor publishes
and previews only the state it read.

All bundled commands accept `--help`, `--json`, and `--preflight`. Dispatch the real
command by default, without a preliminary preflight. Use preflight for an explicit
readiness or preview request. Exit 2 means startup/usage failure; exit 1 means a
write or consultation attempt failed. Relay the failing script's code, condition,
and remedy verbatim. Relay success fields without rereading configuration or
remeasuring artifacts. Invalid config is not permission to ignore saved routing.

Resolve a callable model only at invocation: prefer a stable host alias, then
current host metadata, then reliable current runtime knowledge. Never guess an
exact ID or maintain a provider-ID registry. Record `host`, `primary_family`,
`advisor_family`, `exact_advisor_model`, `reasoning_effort`, `route_source`, and
`consultation_mode` in the task-local profile. Native/fallback selection is not
part of that routing profile.

The executor reads [host-codex.md](references/host-codex.md) or
[host-claude.md](references/host-claude.md) before preparing the consultation.
The Advisor must not retrieve either file. No callable configured family,
supported effort, or fresh execution surface means **Advisor unavailable**.
Report the route and limitation without silently substituting another family,
including a host substitution. Known incompatible host requirements are also a
limitation. Continue authorized primary work where possible. Consultation does
not authorize installation, authentication, permission changes, or global
integration repair; installation uses `install-harness-plugin-capabilities`.

Every Harness consultation uses a separate fresh context without resuming an old
Advisor or forking the primary transcript. Use neutral evidence for same-family
review. Escalation may include more relevant execution context, but neither mode
receives an indiscriminate private reasoning transcript or the prior Advisor's
prose as authority. The Advisor never invokes tools, implements changes, or
delegates. Executor-side configuration, prompt preparation, and dispatch are not
Advisor tool use.

## Prepare relevant evidence

Supply the material needed to reason about this question, not merely a success
summary. Identify direct user requirements and distinguish the executor's
interpretation or account of approvals. Include relevant exact code, surrounding
logic, callers, configuration, test definitions, observed outputs, contradictions,
and boundary conditions. Label supplied excerpts and execution results with their
source and applicable state. Preserve errors and exclusions that could change the
answer. Paths, URLs, artifact IDs, and previous-turn references alone do not supply
readable content to a tool-free Advisor.

For a broad implementation or final review, obtain a repository-wide changed-path
inventory before narrowing by relevance. Account for staged, unstaged, and relevant
untracked changes. Gather the imports, callers, tests, and configuration needed to
interpret the selected changes. Include generated/installed bytes when material,
or state that installed behavior is unresolved. Conceptual advice needs relevant
constraints, not a repository ceremony. These are executor preparation duties,
not permission for the Advisor to inspect anything.

State the review target, baseline when applicable, exclusions, actual validation
commands and outcomes, test state, environment limits, skips, and unrun checks.
Pause executor-owned writers while capturing and reviewing relevant evidence.
Use an existing cheap content comparison when practical; otherwise call stability
coordinated, not mechanically proven. HEAD or unchanged filenames do not prove
content stability. Disclose external-writer limits. Material changes invalidate
affected conclusions, not the whole task or its accounting.

Do not claim to have provided every relevant fact when that is uncertain. Obtain
reasonably accessible missing evidence before dispatch. When it remains unavailable,
ask a conditional question and disclose the gap; an explicit consultation is not
blocked solely by incomplete evidence. The Advisor must not invent missing source,
authenticate user approval, or treat executor-reported tests as reproduced tests.

## Carryover and compaction

Keep one task-local epoch with a stable baseline and ordered durable records.
The baseline contains the objective, requirements, and relevant invariants.
Records use monotonically increasing IDs and `CONSTRAINT`, `EVIDENCE`, `DECISION`,
`FAILURE`, or `SUPERSEDES`. Each is a concise sourced task record, not authentication.
A supersession names the old record, which stays unchanged; later supersessions
take precedence. The executor owns reconciliation of contradictions.

Promote explicit requirements, observed source/test/runtime facts, authoritative
documentation, accepted decisions, useful failures, and corrections. Advisor
speculation is not evidence. Label supplied-only facts, assumptions, and unresolved
questions. Recheck material premises when their applicable state changes; retain
unaffected facts and history. Do not carry forward full logs, abandoned reasoning,
or earlier Advisor prose just because it exists.

Preserve useful baseline and serialized ledger text verbatim while relevant and
accurate. Start a compact epoch when obsolete material, confusing supersessions,
changed scope, or actual capacity makes the existing carryover less useful.
Preserve requirements, invariants, useful evidence, decisions, failures, and
unresolved conflicts, including exact details necessary to expose a defect.
Do not remove necessary evidence merely to shorten the prompt. There is no fixed
Harness input token, byte, or file-count limit. Respect actual host/model request
capacity, room for output and host instructions, and explicit user cost or latency
budgets. Use reliable counts when available; do not invent a universal ceiling or
add a measurement subsystem. Report unavoidable omissions. Missing telemetry alone
does not block a supported consultation.

Compaction preserves useful task facts and all task accounting. Epoch changes do
**not** reset task call counts or authorize another consultation. Retain task-local
baseline, ledger, epoch, profile, counts, and last automatic reason/question with
intervening evidence in the active context or existing handoff, never global
Advisor memory. If accounting cannot be recovered, disable further automatic
calls for that task but honor user calls. Reconstruct useful facts from current
evidence where necessary. An existing ledger or epoch file is not a prerequisite
for an explicit user consultation.

## Construct the prompt

The executor reads [contract.md](references/contract.md). For Codex, place its
exact text first in the child message. For Claude fallback, the adapter supplies
that text through `--system-prompt`; stdin contains only these four sections:

```text
[TASK BASELINE]
<objective, requirements, relevant invariants>
[DURABLE CARRYOVER]
<existing ordered records, or None for an initial consultation>
[NEW EVIDENCE]
<target and applicable state; substantive excerpts and observations with provenance>
<actual validation results, contradictions, omissions, and stability limits>
[QUESTION]
<the decision or review to resolve using this supplied evidence>
```

Copy the baseline and existing serialized ledger verbatim from task state.
Append records without reordering old entries. Keep changing metadata out of the
stable prefix. Include the facts needed for this question on every call, even if
previously supplied. Before dispatch, read the prepared message as a fresh Advisor
with no tools: replace material pointer-only references with content, label what
remains unavailable, and remove instructions to obtain anything externally.
Neither an empty optional section nor an absent ledger requires a helper service.

For final review, include relevant requirements, final changes and context,
executor validation, and remaining uncertainty. Ask about concrete defects,
regressions, missed requirements, unnecessary complexity, and validation gaps.
Do not ask the Advisor to run the tests or certify completion.

Caching is opportunistic, not memory. Preserve stable, relevant instructions,
baseline, and serialization where practical. The cache profile is host, exact
model, reasoning configuration, tool-free policy, policy version (4), and epoch.
A model or effort change changes the cache profile, not the semantic epoch.
Retain valid task facts and all budgets. Use cache controls only when the actual
host exposes them; do not import native Advisor controls into fallback execution.
Report reachable input/cached/write token metrics or their unavailability. Never
warm a cache, preserve misleading context for a hit, or request Advisor tools to
measure usage.

## Reconcile and continue

Evaluate advice against user requirements and the evidence you gathered. Accept,
reject, or investigate specific recommendations. When a peer disagrees, identify
the competing premises and obtain discriminating evidence; do not call a third
Advisor to vote. A further consultation requires a new eligible reason or an
explicit request and consumes its applicable budget.

Describe the result as reasoning over supplied evidence, not independent source
inspection or reproduced verification. Preserve target and coverage limitations,
missing premises, and the distinction between a hypothesis and a demonstrated
finding. Suggested commands and examples were not executed by the Advisor.

Use actual host information to distinguish requested restrictions, observed
activity, and runtime enforcement. Without a real tool-disable control, Codex's
no-tools rule is instruction-bound; do not claim tools were unavailable. Lack of
visible activity does not establish zero calls. An observed model-selected tool
attempt, even a denied one, makes the consultation nonconforming. Stop further
Advisor work where supported, report the violation, and do not automatically retry
or promote the answer as a conforming review. Useful ideas may be investigated
independently by the executor. Do not add a monitoring system or change host
permissions to manufacture a stronger guarantee.

Continue authorized executor work and report the consultation that actually
occurred, including failure or unobserved adherence when material. The Advisor
cannot authorize release, authenticate the packet, or replace your verification.
