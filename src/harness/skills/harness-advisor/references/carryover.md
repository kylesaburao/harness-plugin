# Carryover and compaction

These instructions are for the executor. The Advisor must not retrieve this file.
Task accounting during compaction stays in `SKILL.md`.

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
