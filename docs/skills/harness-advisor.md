# Harness Advisor

[Documentation](../README.md) / Using the plugin

Harness Advisor provides a read-only second opinion for consequential planning, difficult diagnosis, changes of approach, and substantial reviews. The primary agent continues to own implementation, testing, and delivery.

## Enable integration

After [installing the plugin](../../README.md#install), ask the agent to use `install-harness-plugin-capabilities` for Codex, Claude Code, or both. It updates the effective user instructions and installs the companion guidance for final plans and skill discovery. Existing unrelated instructions, settings, and routing preferences are preserved.

Start a new host session afterward. Invoke the installer again to update integration. The [installer contract](../../dist/harness/skills/install-harness-plugin-capabilities/SKILL.md) describes the exact files and host overrides.

Codex uses Harness Advisor. Claude sessions with native Advisor use the native feature exclusively, including after a native error. Harness fallback is available for Claude sessions without native Advisor. A request limited to native Advisor does not authorize fallback.

Harness Advisor requires Node.js 22 or newer. Claude fallback also requires a usable Claude Code CLI and model access. Installation alone does not establish authentication or model availability. See [dependencies](../development/dependencies.md#2-using-the-plugin).

## Ask for guidance

Examples:

- “Ask the Advisor to review this implementation.”
- “Get an independent review of this plan.”
- “Ask Sol for a second opinion on this decision.”

A named family selects that consultation only. Without an override, the built-in routes select Astra for Codex, Opus for Claude Haiku/Sonnet/Opus, and Fable for Claude Fable. A matching family provides a fresh peer review. Availability is checked at invocation, and an unavailable family is reported without silently substituting another.

## Save a preference

Ask “Use Sol as my Harness Advisor” to save a host default, or “Map Sonnet to Opus for Harness fallback” to save a route for a particular primary family. You can also ask to show saved preferences, clear a host default, or remove a route. Specific routes take priority over host defaults.

Preferences live in `~/.harness-plugin/harness-advisor/config.json`, shared by both hosts and retained across plugin upgrades. The agent manages them through the bundled configuration CLI. Missing configuration uses built-in routing without creating a file. Saving a preference does not itself consult an Advisor.

## Evidence and source inspection

A fresh opinion does not independently verify the primary agent's account.
Advisor guidance distinguishes supplied claims and test results from source
actually inspected, and states unresolved gaps. Reading a test or log does not
reproduce execution. Source inspection also cannot establish user approval.

For implementation-dependent advice, the primary identifies the workspace and
review state and enables Codex inspection in the consultation context. An ordinary
fresh child can use existing reading/search tools or narrow non-mutating terminal
commands even without a child read-only permission selector. No new opt-in or
installation setting is needed. Available restrictive child controls are preferred.
Without verified enforcement, inspection is instruction-bound and inherited tool
permissions may be broader. Successful reads or unchanged files do not prove a
sandbox. Host denials and higher-priority instructions remain authoritative.

Claude fallback retains restricted file tools and customization isolation on
compatible hosts, with no shell. Without an explicit workspace it remains
evidence-only. Neither route authorizes Advisor-run tests, project execution,
implementation, elevation, or further delegation. Evidence-only or partial advice
reports actual unavailable tools, targets, or access denials. Missing enforcement
or parent-visible telemetry alone does not prohibit Codex inspection. Enabled tools,
actual reads, coverage, and enforcement are reported separately.
Final reviews identify the reviewed state and qualify changed targets, incomplete
inspection, and uninspected generated installation output.

## Contracts and qualification

The [skill contract](../../dist/harness/skills/harness-advisor/SKILL.md) owns exact dispatch policy, call accounting, routing, context handling, permissions, and diagnostics. Human requests should not need those internals.

See the [evaluation record](../../tests/harness-advisor/EVALUATION.md) for tested behavior and qualification limits. Recorded results describe the tested environment, not a guarantee of access or enforcement in another session.
