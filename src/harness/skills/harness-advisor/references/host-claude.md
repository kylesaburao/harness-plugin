# Claude fallback execution

These instructions are for the executor. Use this adapter only after the host's
CLAUDE.md gate establishes native Advisor absence. Positive native availability
suppresses the entire Harness skill for the session, including after native
errors. Unknown status is not absence. Do not use fallback to work around native
rate limits, timeouts, or model failures.

Use one separate, non-interactive Claude Code session without a named role.
Resolve the selected semantic family to a current callable alias or model ID and
supported effort for this call. Do not silently substitute a model or clamp effort.
No callable configured deployment means unavailable, not permission for an API
bridge. A hosted session without local Claude Code execution cannot use this
adapter. Consultation does not authorize installation or authentication changes.

The executor writes the prepared four task sections to existing task temporary
storage. Include substantive evidence, not file paths or URLs the Advisor must
retrieve. Run the bundled adapter directly, with Node.js 22 or newer and no npm
packages:

```sh
node "<SKILL_DIR>/scripts/claude-advisor.js" --native-absent --model opus --reasoning-effort high --prompt "/absolute/task-temp/advisor-prompt.txt" --json
```

Replace Opus/high with the resolved profile. `--native-absent` attests the parent
session's native status; it is not a capability probe. The adapter reads the
canonical contract from its own installed skill and supplies it through
`--system-prompt`. stdin contains only the four task sections. Prompt bytes are
not trimmed or rewritten. This is one consultation attempt with no retries.

There is one evidence-only route. The former `--workspace` argument is unsupported
and returns `usage_error` with exit 2 before file reads, CLI probing, or inference.
Remove the argument and put the material evidence in the prompt. There is no
replacement inspection flag or hidden workspace mode.

The invocation requests zero built-in tools with `--tools ""`, denies MCP tools
with `--disallowedTools "mcp__*"`, and requests strict empty MCP configuration.
An empty `--allowedTools` list is not a substitute. It explicitly selects model
and effort, disables slash commands, disables session persistence, disables hooks
and model fallback settings for the child, and suppresses native recursion with
child-only `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`. It removes `CLAUDECODE` in the child
environment for the separate print session, without changing the primary's
environment or saved configuration.

The child starts in a unique empty temporary working directory. Task content is
sent on stdin, not shell-interpolated. `--setting-sources ''` excludes saved
user/project/local settings, including a saved default-agent choice. Managed
policy and inherited environment can still matter. A setup depending on excluded
settings, such as authentication helpers, needs separate qualification. Do not
restore ambient settings or weaken restrictions after failure. No workspace is
granted and no restricted file-tool branch remains.

Explicit preflight checks a readable nonempty prompt and bundled contract, then
successful `claude --version`. It does not dispatch inference, prove account
access, or qualify enforcement. There is no workspace-version threshold and no
new numeric Claude minimum: the installed CLI must support the complete retained
invocation. Missing help entries alone are not incompatibility proof; actual
rejection fails once without permissive retry.

The report retains requested model/effort, mechanism, fresh context, `tools: []`,
and `runtime_controls: "unverified"`. Consultation reports include advice and
reachable model/usage data. There is no workspace or observed-read report.
`consulted` describes successful result transport, not independent verification
or demonstrated runtime enforcement. Compare observed model identity with the
requested family where available; missing metadata is unverified and a known
mismatch is not configured advice. The executor evaluates evidence coverage.

Startup/input failures return exit 2. Consultation-attempt or cleanup failures
return exit 1, with the existing code/condition/remedy diagnostic on stderr.
Successful output is emitted only after invocation-directory cleanup succeeds.
Relay the actual report or diagnosis without re-probing or silently retrying.
The adapter retains the existing bounded JSON transport; it does not retain a
transcript or source store. Native provider operations and executor-side adapter
startup are not Advisor evidence-gathering tool calls.

Public CLI behavior is documented here, checked for this plan on 2026-09-15:

- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Native Advisor](https://code.claude.com/docs/en/advisor)

Documentation and deterministic fake-host tests are not live qualification of
authentication, model/effort selection, tool suppression, or managed-policy
behavior. Record actual qualification separately in repository-root
`tests/harness-advisor/EVALUATION.md`; that record does not ship with the plugin.
