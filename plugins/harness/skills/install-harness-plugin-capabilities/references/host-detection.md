# Host integration and native capability gate

Codex installation uses absolute `CODEX_HOME`, defaulting to `~/.codex`, and
manages only the activation block in `AGENTS.md`. A nonempty
`AGENTS.override.md` shadows AGENTS.md, so report that conflict before writing.
Codex currently uses Harness Advisor. Do not invent a native-equivalence branch.

Claude Code installation uses absolute `CLAUDE_CONFIG_DIR`, defaulting to
`~/.claude`, and manages only the activation block in `CLAUDE.md`. These are
user-level host integration files, an intentional exception to the runtime-data
root. They contain no chosen Advisor model. Host settings and Advisor config are
untouched. If this session uses a different applicable user instruction surface,
establish that surface before installation rather than claim an unused file is
active. The initial installer supports these local host paths only.

## Claude session gate

Persistent CLAUDE.md performs this decision before the Harness Skill loads:

- Native Advisor positively present: use native and suppress Harness entirely.
- Native Advisor absent: Harness Skill can apply its own invocation policy.
- Unknown: inspect available session tools/status or adapter metadata first.

Normalize the observation conceptually as `{ available, kind }`, with kinds
`server-tool`, `managed-agent`, or `none`. This is session evidence, not a saved
config file. Presence of Anthropic's native `advisor` server tool is sufficient.
Managed Agents configuration can establish that the active session's agent has
an advisor entry in `multiagent.agents`. Do not require unrelated Harness budget,
fresh-context, or model-routing semantics for native capability to take precedence.
Host identity, an installed CLI, or a saved but inactive advisorModel is insufficient.

Once positively detected, native errors (including rate limits, overload, timeout,
and configured-model problems) do not enable fallback during that session. Generic
requests go to native. An explicit native-only request with no native capability
reports unavailable. No Harness route, prompt, budget, carryover, cache, or peer
review policy participates in native behavior. Do not load the Harness Skill just
to select between the two mechanisms, and do not run both for additional review.

Install the Claude gate regardless of current session availability, so a later
session without native Advisor can use fallback. Neither host CLI is required
for installation. Legacy role files remain untouched and are neither required
nor explicitly selected by new Harness dispatch.

Sources checked 2026-09-12:

- [Codex AGENTS discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Claude user instructions](https://code.claude.com/docs/en/memory)
- [Claude native Advisor](https://code.claude.com/docs/en/advisor)
- [Messages API advisor server tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)
- [Managed Agents advisor roster](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#give-the-session-an-advisor)
