# Codex fallback execution

Resolve the requested family only now. Prefer a current host alias or the active
model catalog (`codex debug models --bundled` is local metadata, not proof of
account access). Use runtime knowledge when metadata is unavailable. Confirm the
requested effort is supported. Never persist the exact model ID.

Spawn an ordinary fresh subagent with the resolved model and reasoning effort
explicitly set. Use the actual spawn schema's fresh-context control, such as
`fork_turns: "none"`. Supply the canonical `contract.md` text, curated evidence,
and current question as the prepared prompt. Instruct the child to use no tools,
make no changes, and perform no further delegation. Wait for its response,
evaluate it, and continue primary work. Close the child where supported.
Never resume an old Advisor or fork the primary conversation.

No named role is required or explicitly selected. Missing named-role selection
must not block consultation. Unavailable models, unsupported effort, or a spawn
surface without fresh-context execution or explicit model/effort selection make
the configured Advisor unavailable. Do not invent parameters or substitute models.

Use additional child permission controls when the host exposes them, without
loosening parent permissions. Distinguish the no-tools, no-changes, and
no-delegation instructions from enforced permissions. An ordinary child may
inherit tools and write permissions, so the contract alone does not establish
an enforced read-only sandbox. Report only controls actually applied.

Record the actual model and effort from host metadata where exposed. A mismatch
is an unsuccessful configured consultation, never silently accepted as equivalent.
Host instructions may still be injected into a fresh child, so curated input does
not guarantee a byte-identical whole provider prompt.

The inspected subagent spawning surface exposes no documented cache breakpoint
or key. Child rollout token-count events may expose input and cached input tokens. Use these when reachable, otherwise report metrics unavailable.
Do not confuse parent aggregate usage or cached host instructions with reuse of
Harness carryover. No direct API or cache scheduler is installed.

Sources checked 2026-09-12, with local `codex exec --help`, `codex features list`,
and Codex CLI 0.154.0:

- [Custom agents, model selection, and permissions](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Global instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

Current execution evidence and its limits live in repository-root
`tests/harness-advisor/EVALUATION.md`, which does not ship with the plugin.
