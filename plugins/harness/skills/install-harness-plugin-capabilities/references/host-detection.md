# Host integration and native capability gate

## User directories and instruction surfaces

For Codex, use nonempty absolute `CODEX_HOME`, otherwise the target user's
`.codex` directory. For Claude Code, use nonempty absolute `CLAUDE_CONFIG_DIR`,
otherwise the target user's `.claude` directory. Normalize the selected directory
to an absolute path. If a nonempty override is relative, report it as a blocker
rather than guessing a directory or silently falling back.

Codex normally loads user instructions from `AGENTS.md` in its user directory.
A nonempty `AGENTS.override.md` shadows that file. Inspect the override and edit
that effective surface when applicable, rather than activating a shadowed
`AGENTS.md`. Codex uses Harness Advisor. Do not invent a native-equivalence branch.

Claude Code normally uses `CLAUDE.md` in its user directory. If the selected
host uses a different applicable user-level instruction surface, establish it
before editing. If the effective surface cannot be established, report the
specific blocker instead of claiming an unused file is active.

For either host, use ordinary file operations to copy the bundled companion to
`final-plan-context.md` in the resolved user directory, then contextually patch
Advisor activation and the Final plans trigger on the effective instruction
surface. The trigger points to that absolute installed companion path. These
are user-level host integration files, an intentional exception to the
runtime-data root. They contain no chosen Advisor model. Preserve host settings,
Advisor configuration, and legacy role files.

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
