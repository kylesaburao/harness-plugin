---
name: harness-advisor
description: Consult a configured read-only Advisor for consequential planning, difficult diagnosis, material approach changes, unresolved reasoning, or substantial final review. Also use when the user requests an advisor, second opinion, named Advisor family, or independent review. Do not repeatedly invoke for routine or mechanically determined steps.
---

# Harness Advisor

The primary agent owns investigation, implementation, testing, and delivery. The
Advisor supplies reasoning at a sparse decision point. This skill requests
delegation for consultations that pass the following policy, subject to the
active host's tools and higher-priority instructions.

## Bundled path authority

Use the current host’s path for this loaded `SKILL.md`. Claude Code supplies this path through `${CLAUDE_SKILL_DIR}`. Expand any catalog root alias using its supplied mapping. Set `<SKILL_DIR>` to the absolute directory containing that exact file and retain it for this invocation. Replace `<SKILL_DIR>` in commands with that directory, keeping paths quoted. Resolve bundled scripts and skill-root resource paths from this directory. Resolve Markdown-relative links from the file containing the link, within the same installed skill instance. Preserve the caller’s working directory and existing input/output path semantics.

If the host-provided path is unavailable or a bundled file is missing, report the supplied skill path, attempted resource path, and actual failure. Other installations may be inspected for diagnosis, but use a replacement only when the host or user explicitly selects it. Do not infer the skill directory from conventional locations or select another copy by version, timestamp, or search order.

## Claude safety boundary

Claude safety boundary: if native Advisor was positively detected in this session,
stop using this Skill entirely, even after native errors. The host's CLAUDE.md gate
owns detection and native behavior. Nothing below governs native consultations.
If native availability is unknown, establish it through the host gate before
continuing. A request explicitly limited to unavailable native Advisor does not
authorize Harness fallback.

## Decide whether to consult

For a configuration-only request, run the configuration manager below and stop.
Saving or inspecting routing does not itself request a consultation.

Classify the invocation before dispatch:

- `USER_REQUEST`: a clear request to ask the Advisor or a named family, obtain a second
  opinion or independent review, or use this skill. Perform one consultation,
  even for trivial work or after the automatic budget is exhausted. Multiple
  calls require requested phases or a requested count. A mention in quoted
  material or a request to implement Advisor is not itself a consultation request.
- `AUTOMATIC`: after repository orientation, consult only when stronger reasoning
  can materially improve a consequential decision, resolve a failed approach or
  evidence conflict, or catch substantial completion defects. Routine renames,
  mechanical steps, and uncertainty without investigation do not justify a call.

Keep task-local accounting: `automatic_calls`, `user_requested_calls`, the last automatic
question and reason, and evidence obtained since it. Allow at most **3 automatic calls per substantial task**, a ceiling rather than a target. User calls do not consume
that budget. Reserve a dispatch before starting it, including a failed attempt,
so failures cannot create a retry loop. Clearly report a failed user consultation.

The first automatic call may be `STRATEGY`, after orientation and before
consequential implementation. Subsequent automatic calls require
`NEW_EVIDENCE`, `APPROACH_FAILED`, `NEW_DECISION`, `RECONCILE_CONFLICT`, or
`FINAL_REVIEW`. State what materially changed. Final review follows implementation
and primary testing. A new turn, elapsed time, lingering doubt, or rephrasing the
same question is insufficient. Obtain source, test, runtime, or documentation
evidence between calls. An explicit request overrides duplicate suppression.

Weigh reasoning benefit against inference cost, context, and latency only for
automatic calls. Never call to warm a cache or improve cache economics. If every
decision needs escalation, prefer a stronger available primary instead of continuous
Advisor supervision. Compose with domain skills without taking over their workflow.

## Resolve routing and dispatch

Requires Node.js **22.0.0 or newer**, standard library only. Run directly:

```sh
node "<SKILL_DIR>/scripts/advisor-config.js" resolve --host codex --primary sol --json
```

Use the current host and semantic primary family, never a guessed exact model ID.
For a family explicitly requested for this call, add `--advisor <family>`.
For an explicit effort add `--reasoning-effort <level>`. Missing config means
built-ins and creates no file. Resolution returns family selectors, effort,
`route_source`, and `consultation_mode`, not an exact callable model or native status.

Precedence: explicit call family, exact user host/primary route, user host default,
built-in route, otherwise unresolved. Built-ins use `high` reasoning:

| Host | Primary | Advisor |
| --- | --- | --- |
| Codex | luna, terra, sol, astra | astra |
| Claude fallback | haiku, sonnet, opus | opus |
| Claude fallback | fable | fable |

Selectors are `luna`, `terra`, `sol`, `astra`, `haiku`, `sonnet`, `opus`, `fable`.
Equal primary/advisor families derive `fresh-review`, otherwise `escalation`.
Never store the mode. User defaults override built-ins even if the mapping is a
capability downgrade. Do not automatically route lower Claude families to Fable.
A one-off family does not inherit another route's effort, defaulting to `high`
unless the user specifies it. An omitted effort on a saved route uses `high`.

When the user asks to save a preference, use the manager, never edit JSON:

```sh
node "<SKILL_DIR>/scripts/advisor-config.js" show --json
node "<SKILL_DIR>/scripts/advisor-config.js" set-default --host codex --advisor sol --reasoning-effort high --json
node "<SKILL_DIR>/scripts/advisor-config.js" clear-default --host codex --json
node "<SKILL_DIR>/scripts/advisor-config.js" set-route --host claude --primary sonnet --advisor opus --reasoning-effort high --json
node "<SKILL_DIR>/scripts/advisor-config.js" remove-route --host claude --primary sonnet --json
```

“Use Sol as my Advisor” saves a host default. “Ask Sol” selects one call only.
An update without effort preserves the existing entry's effort. Configuration is
sparse schema-version-1 `defaults[]` and `routes[]` at
`~/.harness-plugin/harness-advisor/config.json`, shared by both hosts. Entries contain
`host`, `advisor`, optional `reasoning_effort`, and `primary` for routes. Exact
routes override host defaults. Automatic consultation never changes this file.
Mutations hold an exclusive `config.json.lock` directory from the fresh read through
atomic publication. A contending writer fails with `config_busy` without saving.
Retry after the writer finishes. An interrupted writer's lock is never stolen:
confirm no configuration mutation is running before following the reported manual
recovery command. `show` and `resolve` remain read-only. Explicit preflight neither
locks nor publishes and previews only the state read at that moment.

All commands accept `--help`, `--json`, and `--preflight`. Dispatch normally,
without a preliminary probe. Use preflight for an explicit readiness/preview
request. Exit 2 means nothing started, 1 means a write or consultation failed.
Relay the script's failure diagnosis verbatim, including code, condition, and
remedy. Relay success report fields without rereading configuration or remeasuring
artifacts. Invalid config is not permission to ignore user routing.

Only at invocation resolve a callable model: prefer a stable host alias, then
current host metadata/discovery, then the current runtime's knowledge. Do not
maintain a provider-ID registry or save resolved IDs into routing config.
Record a task-local profile: `host`, `primary_family`, `advisor_family`,
`exact_advisor_model`, `reasoning_effort`, `route_source`, `consultation_mode`.
Native/fallback selection is not part of this profile.

Read [host-codex.md](references/host-codex.md) for Codex execution or
[host-claude.md](references/host-claude.md) for Claude fallback execution.
No callable configured family, supported effort, or fresh-context execution
means **Advisor unavailable**. Report the family, route source, and
specific limitation. Point to `set-default` or `set-route` when appropriate.
Never silently substitute another family, including a substitution made by the
host. Continue authorized primary work if possible. Installation/repair uses
`install-harness-plugin-capabilities`, and consultation alone does not authorize
changing global host integration.

Every consultation starts a separate fresh context, without resuming an old
Advisor or forking the primary transcript. Same-family review supplies neutral
evidence so the peer reconstructs the problem independently. Different-family
escalation can receive more relevant current execution evidence. Neither receives
an indiscriminate reasoning transcript. The Advisor cannot edit, commit, mutate
external state, take over execution, or invoke another agent/Advisor.

Normally allow at most one automatic same-family review. A second requires
meaningful new evidence or a materially new decision, as well as the overall
three-call ceiling and reinvocation gate. FINAL_REVIEW alone does not waive this
same-family condition. User calls remain authoritative.

## Prepare relevant context

Keep one task-local epoch consisting of a stable baseline and ordered durable
records. The baseline contains the objective, user requirements, and relevant
repository invariants. Preserve its wording within the epoch. Records have
monotonically increasing IDs and a type: `CONSTRAINT`, `EVIDENCE`, `DECISION`,
`FAILURE`, or `SUPERSEDES`. Each record is a concise fact with its source or
accepted decision. A supersession names the old record, which remains unchanged.
Later supersessions take precedence.

Promote only explicit constraints, source/test/runtime observations, authoritative
documentation, accepted decisions, observed failed approaches, and corrections.
Advisor speculation is not evidence. Keep unresolved questions labeled and near
the volatile suffix. Preserve useful conclusions after evaluating them, never
the previous Advisor's prose, full tool logs, or abandoned reasoning history.

### Context sizing and compaction

Include the context needed to answer the current question accurately. Keep carryover
relevant, accurate, and free of unnecessary duplication. Do not impose a fixed
Harness token or byte limit.

Preserve useful baseline and serialized ledger content unchanged while it remains
accurate and relevant. Start a new compact epoch when obsolete material, confusing
supersessions, misleading assumptions, or a material change in scope makes the
existing carryover less useful, or when available host information indicates that
the complete consultation is approaching its usable context capacity.

Preserve explicit requirements, critical invariants, relevant evidence, accepted
decisions, useful failures, and unresolved conflicts. Keep exact details when
summarizing them would obscure a defect or change the meaning. Do not remove
necessary evidence merely to make the prompt shorter.

Respect the selected model's and host's actual request limits, including the space
needed for output and host-provided instructions, and any explicit user cost or
latency budget. Use reliable host counts or documented capacity information when
available. Do not treat a guessed count as a guarantee or require a new measurement
subsystem when that information is unavailable.

An explicit user consultation is not blocked merely because carryover exceeds a
former Harness threshold. If necessary evidence cannot fit within an actual limit,
report the limitation and any material omission rather than claim a complete review.
Missing telemetry alone is not grounds to invent a smaller universal ceiling or
refuse an otherwise supported consultation.

Compaction preserves useful task facts and all task accounting. Epoch changes do
**not** reset task call counts or authorize another consultation. Cache reuse remains
subordinate to correctness. Never retain misleading material solely to preserve a
cached prefix. Keep accounting and the useful epoch in the task handoff when context
compacts.

The task-local record contains only baseline, ordered ledger, epoch, profile,
`automatic_calls`, `user_requested_calls`, `same_family_automatic_calls`, and
last automatic reason/question plus intervening evidence. Retain this in the
active task context or its existing handoff, never as global Advisor memory.
If accounting cannot be recovered, disable further automatic calls for that task,
but honor user calls. Reconstruct useful facts from current evidence if epoch
storage is unavailable. No database, global memory, or installed-tree writes are
needed. Task-local state is bookkeeping, not a prerequisite for a user consultation.

## Construct the prompt

Read [contract.md](references/contract.md). For Codex, use its exact text first
in the child prompt. For Claude, the adapter reads it once and supplies it through
`--system-prompt`, so the stdin prompt contains only the sections below. Append:

```text
[TASK BASELINE]
<unchanged objective, requirements, invariants>
[DURABLE CARRYOVER]
C0001 | CONSTRAINT | <constraint and provenance>
E0002 | EVIDENCE | <observation and evidence location>
<append new records in insertion order>
[NEW EVIDENCE]
<current delta and any labeled unresolved questions>
[QUESTION]
<one decision or review to resolve now>
```

Copy the baseline and existing serialized ledger verbatim from task state.
Append records without reordering or polishing old entries. Keep timestamps,
turn numbers, and changing metadata out of the static prefix. Include all facts
needed for correctness every time, even if previously supplied.

For strategy, give enough oriented source evidence to assess the choices. For
completion, include requirements, relevant final diff, actual primary test
results, and remaining uncertainty. Ask about correctness, regressions, missed
requirements, unnecessary complexity, and validation gaps.

Caching is opportunistic, not memory. Keep model, effort, instructions, tools,
baseline, and serialization stable where practical. Cache identity is host,
exact Advisor model, reasoning configuration, policy version (1), and epoch.
A model or effort change changes the cache profile, not the semantic epoch:
retain constraints, verified evidence, accepted decisions, and useful failures.
One-off model choices share those facts but have a different provider cache. Use an epoch-scoped cache
key or a boundary after durable carryover only when the host exposes a documented
control. Record input/cached/write tokens when available, otherwise report them
as unavailable. Zero cached tokens changes neither context nor invocation policy.
Never use unsupported cache controls or retain misleading context for a cache hit.

## Reconcile and continue

Evaluate guidance against user requirements and primary source, test, runtime,
and documentation evidence. Accept, reject, or investigate it. If a same-family peer and primary disagree,
identify differing assumptions and obtain discriminating evidence. Do not spawn a third Advisor to vote. Another call needs new evidence within budget or a user
request. Promote only useful durable state, then continue execution and report
what consultation actually occurred, including any failure or remaining uncertainty.
