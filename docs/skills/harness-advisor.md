# Harness Advisor

[Documentation](../README.md) / Using the plugin

Harness Advisor provides a separate reasoning pass for consequential planning,
difficult diagnosis, changes of approach, and substantial reviews of supplied
evidence. The executor gathers evidence, implements changes, tests, reconciles
advice, and delivers the result. The Advisor makes no tool calls.

## Enable integration

After [installing the plugin](../../README.md#install), ask the agent to use
`install-harness-plugin-capabilities` for Codex, Claude Code, or both. The installer
updates the effective user instructions for Advisor, the planning-skill trigger,
and Skill discovery. Unrelated instructions, settings, and routing are preserved.
Start a new session afterward. Invoke the installer again to update integration;
a plugin update does not itself rewrite your global instruction files. See the
[installer contract](../../dist/harness/skills/install-harness-plugin-capabilities/SKILL.md).

Codex uses Harness Advisor. Claude sessions with positively available native
Advisor use the native feature exclusively, including after native errors.
Harness fallback is for Claude sessions without native Advisor. A native-only
request does not authorize fallback.

Harness Advisor requires Node.js 22 or newer. Claude fallback also requires a
usable Claude Code CLI and access to the selected model. Installation does not
prove authentication or availability. See [dependencies](../development/dependencies.md#2-using-the-plugin).

## Ask for guidance

Ask to consult the Advisor, get a second opinion on a plan, review supplied code,
or ask a named family such as Sol. A named family selects that call only. Without
an override, built-in routes select Astra for Codex, Opus for Claude
Haiku/Sonnet/Opus, and Fable for Claude Fable. Matching primary and Advisor families
provide a fresh peer review. Unavailable configured families are reported rather
than silently replaced.

The executor should supply the relevant requirements, actual code and surrounding
context, observations, test commands/results, contradictions, and known gaps.
A path or link by itself is not evidence the Advisor can open. Advice may identify
what else the executor needs to obtain. That ends the consultation; it does not
start an automatic tool relay or unlimited follow-up loop.

## Save a preference

“Use Sol as my Harness Advisor” saves a host default. “Map Sonnet to Opus for
Harness fallback” saves a route for one primary family. Ask to show, clear, or
remove preferences through the bundled configuration manager. Specific routes
take priority over host defaults.

Preferences remain at `~/.harness-plugin/harness-advisor/config.json`, shared by
both hosts and preserved across upgrades. Missing configuration uses built-ins
without creating a file. Configuration changes do not themselves consult an
Advisor. The tool-free pivot does not migrate this file or reset saved effort.

## Evidence and review limits

A second model can challenge conclusions drawn from supplied evidence, including
contradictions between code and the executor's summary. It cannot discover an
omitted file, reproduce a test, or authenticate the executor's account. A final
review should identify the supplied state, actual verification results, and
material omissions, not claim independent repository verification or release
approval. The executor remains responsible for checking recommendations.

Both Harness fallback routes prohibit every Advisor tool call. Claude fallback
requests an empty built-in tool set and disables MCP tools. Ordinary Codex children
may inherit tools; without an actual child tool-disable control, the rule is
instruction-bound. The skill does not install another role or change parent
permissions. A requirement for mechanically unavailable tools must be reported
unsupported when the host cannot provide it. A read-only sandbox is not tool-free.

Observed tool attempts make a consultation nonconforming, even if denied. Missing
activity telemetry is unobserved adherence, not proof of zero calls. Useful advice
and unchanged files do not demonstrate enforcement. Report host limitations and
continue authorized executor work without automatic retries.

The Claude adapter no longer accepts `--workspace`. Old calls fail before probing
or inference with instructions to remove the argument and include evidence in the
prompt. There is no alternative workspace-inspection mode.

## Contracts and qualification

The [skill contract](../../dist/harness/skills/harness-advisor/SKILL.md) owns routing,
call accounting, context handling, diagnostics, and exact execution policy. The
[qualification procedure](../../tests/harness-advisor/QUALIFICATION.md) separates
adapter configuration, model behavior, and host enforcement. The
[evaluation record](../../tests/harness-advisor/EVALUATION.md) identifies actual
runs, failures, and unrun checks. Historical inspection results do not qualify the
current tool-free route.
