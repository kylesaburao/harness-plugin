# Codex fallback execution

These instructions are for the executor. Read them before dispatch. The Advisor
child receives the complete canonical contract and supplied evidence; it must not
read this file, resolve skill paths, or discover its tools.

Resolve the requested semantic family to a current callable model at invocation.
Prefer a host alias or active catalog; metadata is not proof of account access.
Use reliable current runtime knowledge when metadata is unavailable. Confirm the
requested effort is supported. Never save the exact provider ID in routing config.

Spawn an ordinary fresh subagent with model and reasoning effort explicitly set.
Use only the actual spawn schema's fresh-context control, such as
`fork_turns: "none"` when that field exists. Never resume an old Advisor or fork
the primary conversation. No named role is required or explicitly selected.
Unavailable models, unsupported effort, or a surface without fresh context and
explicit model/effort selection make the configured consultation unavailable.
Do not invent parameters or substitute a different model.

The prepared message consists of the exact canonical `contract.md` text followed
by the four task sections from SKILL.md. Pass the prepared prompt unchanged as
the spawn tool's message argument. Add no preamble, wrapper delimiters, role
instructions, workspace-inspection permission, or closing instructions outside
that prepared prompt. Immediately before dispatch, check the actual message
argument, not merely a saved file: it must start with the canonical contract and
match the prepared prompt. This is a check of agent-authored content, not a claim
that the host injects no additional context. Do not claim a byte comparison the
available execution surface did not permit you to perform.

The no-tools contract applies even if the child inherits tools. Use a real
per-child tool-disable control when the actual schema exposes one. A read-only
sandbox is not an empty tool set. Do not install a named agent, change the parent's
permissions, modify global configuration, or introduce a Codex CLI/API adapter to
simulate a missing selector. Missing runtime prevention alone does not block an
ordinary evidence-only consultation; describe it as instruction-bound. If the
user explicitly requires mechanically unavailable tools and the host cannot
provide that, report the requirement as unsupported before dispatch. Do not
silently downgrade that explicit requirement to a prompt instruction.

Reserve the applicable consultation count before dispatch. Wait for the answer
and close the child where supported. Waiting for the same answer is not a new
consultation. Do not send follow-up evidence, permit a tool-request relay, or
resume the child to complete its investigation. Missing-evidence advice ends the
call. A later consultation is fresh and follows the original budget rules.

Record observed model/effort where the host exposes them. A mismatch is an
unsuccessful configured consultation, not an equivalent result. Missing metadata
is unverified selection, not proof of substitution. Evaluate the answer within
its stated supplied-evidence scope.

Use existing host activity when available. Any Advisor-directed tool attempt,
including a rejected read or a tool whose name suggests planning or completion,
is a no-tools violation. Stop further child work where supported and report a
nonconforming consultation without an automatic retry. Passive host transport of
a final answer is not an Advisor-directed call. When activity is unavailable,
report adherence as unobserved rather than claiming zero calls. Self-reports,
unchanged files, and successful advice do not establish runtime prevention.

Actual higher-priority host instructions and managed policy remain authoritative.
Disclose conflicts or unavoidable host customization; a fresh context does not
prove instruction isolation. Tool-free advising does not authorize changing the
host to remove that uncertainty.

Do not assume the ordinary spawn route exposes a cache key or breakpoint. Use
cache controls only when the actual host supports them. Use reachable child
input/cache usage or report it unavailable; parent aggregate usage is not child
cache evidence. Do not add an API bridge, cache scheduler, transcript reader,
or telemetry service.

Host behavior must be checked against the actual execution surface. Public
references checked for this plan on 2026-09-15:

- [Codex subagents](https://developers.openai.com/codex/subagents/)

Repository qualification lives in `tests/harness-advisor/QUALIFICATION.md` and
`tests/harness-advisor/EVALUATION.md`; neither ships with the plugin. These
references are for executor-side maintenance, not child retrieval.
