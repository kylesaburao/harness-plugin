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

## Contracts and qualification

The [skill contract](../../dist/harness/skills/harness-advisor/SKILL.md) owns exact dispatch policy, call accounting, routing, context handling, permissions, and diagnostics. Human requests should not need those internals.

See the [evaluation record](../../tests/harness-advisor/EVALUATION.md) for tested behavior and qualification limits. Recorded results describe the tested environment, not a guarantee of access or enforcement in another session.
