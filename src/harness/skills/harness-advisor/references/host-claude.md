# Claude fallback execution

This adapter applies only after the host's CLAUDE.md gate established native
Advisor absence. Positive native availability suppresses the entire Harness
Skill for the session, including after a native error. Do not invoke this adapter
to work around native rate limiting, timeouts, or model errors.

Use Claude Code's separate non-interactive session without a named role.
The primary passes the resolved family alias or current provider ID and
supported effort each time.
Claude aliases include haiku, sonnet, opus, and fable. Other families require an
actual callable deployment, otherwise report unavailable without substitution.

Write the four task sections of the prepared prompt into existing task temporary
storage.
Run the skill-local adapter directly (Node.js 22+, no packages):

```sh
node "<SKILL_DIR>/scripts/claude-advisor.js" --native-absent --model opus --reasoning-effort high --prompt "/absolute/task-temp/advisor-prompt.txt" --json
```

`--native-absent` is a caller attestation about the enclosing session, not a
capability probe. Do not pass it for unknown status or native execution failure.
Use the resolved profile instead of the example's Opus/high. One dispatch is one
consultation attempt, without automatic retries. Relay diagnosis/report fields
as specified in SKILL.md. The report includes model usage when Claude returns it.
Verify observed model identity against the requested family before treating the
answer as configured advice. Missing identity is unverified, not proof of model
selection. Do not reinterpret a substituted model as the configured Advisor.

The runner passes model/effort explicitly, disables all built-in and MCP tools,
and passes the canonical contract directly through `--system-prompt`. It starts
fresh, without resume, and does not persist the session. It disables hooks and model fallback chains for this
process. `switchModelsOnFlag: false` makes a flagged request refuse in print mode
instead of switching models. The child-only `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`
prevents the fallback Advisor from consulting native Advisor itself. This does
not change the primary session or saved user settings.

The runner uses a unique empty working directory and transmits task content on
stdin. `--setting-sources ''` excludes saved user/project/local settings, including
default-agent selections. Legacy role files are neither required nor explicitly
selected. Managed policy remains authoritative. Configurations depending on
excluded settings, such as authentication helpers, require separate qualification.
Do not restore ambient settings or weaken restrictions after a failure.

Explicit preflight checks that the prompt and canonical contract are readable and
nonempty and that `claude --version` succeeds. It reports
`runtime_controls: "unverified"`. Passed preflight proves neither authentication
nor model access. Missing or empty contract data returns exit 2 with
`advisor_contract_unavailable`, the absolute contract path, and a plugin reinstall
remedy. An unavailable CLI returns exit 2 with `claude_unavailable`. A runtime
rejection returns exit 1 with `advisor_execution_failed`, preserves the runtime
diagnosis, and emits no success report.
Help output is not exhaustive, so missing flags in help are not incompatibility
proof. The full restrictive invocation is documentation-backed, not qualified by a
version string. A runtime rejection is relayed without removing controls or retrying.
Live enforcement still requires qualification on the selected host.

Check current host controls rather than assuming every Claude runtime accepts
Claude Code flags. Hosted/API/Managed Agents sessions without a local Claude Code
execution surface cannot use this adapter. Report that limitation, never invent
an API bridge. Respect provider effort limitations rather than silently clamping
an unsupported setting. Managed policy that prevents these controls makes the
fallback unavailable.

Provider caching is opportunistic. The JSON response may contain cache-read and
cache-creation usage. Report reachable fields without promising a hit. No native
Advisor cache controls or Harness cache keys are applied.

Sources checked 2026-09-12. Claude CLI is installed but not logged in. Successful
inference, actual model/effort enforcement, and full runtime qualification are
Skipped: Claude is not logged in. Historical startup observations establish
neither authentication nor successful inference. Repository-only evidence is in
`tests/harness-advisor/EVALUATION.md`.

- [CLI tool, model, effort, and session controls](https://code.claude.com/docs/en/cli-reference)
- [Separate agent definitions and permissions](https://code.claude.com/docs/en/sub-agents)
- [Model fallback and reasoning settings](https://code.claude.com/docs/en/model-config)
- [Disabling native Advisor in the child](https://code.claude.com/docs/en/advisor#turn-the-advisor-off)
