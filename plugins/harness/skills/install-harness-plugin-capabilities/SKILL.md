---
name: install-harness-plugin-capabilities
description: Install, repair, or update user-level host integration for capabilities supplied by Harness. Use when requested to configure Harness capabilities or repair their host adapters. Advisor is the first capability.
---

# Install Harness capabilities

This installer manages one small host activation block per selected host.
Harness supplies the skills through the plugin, with one canonical copy.
It does not choose the user's Advisor family or modify Advisor routing.

1. Establish the integration host, Codex or Claude Code, and verify that the
   Harness skills are discoverable through the plugin. If the plugin is missing,
   follow its normal host installation flow first. Do not copy individual skills.
2. Read [host-detection.md](references/host-detection.md) for the session gate and
   host path rules. Install Claude fallback even when native Advisor is currently
   available. Native detection governs use per session, never whether to install.
3. Resolve this skill's installed absolute directory. Requires Node.js **22.0.0
   or newer**, standard library only. Dispatch for each requested host:

   ```sh
   node "<skill-directory>/scripts/install.js" --host codex --json
   node "<skill-directory>/scripts/install.js" --host claude --json
   ```

   The script creates or replaces exactly one managed capabilities block in
   `AGENTS.md` or `CLAUDE.md` per selected host. It preserves content outside the block,
   host settings, and `~/.harness-plugin/harness-advisor/config.json`. It neither creates
   nor materializes routing defaults. Neither CLI is required to install instructions.
   Legacy role files remain untouched, and new Harness dispatch neither requires nor explicitly selects them.
4. Relay failure diagnoses verbatim, including code, condition, and remedy.
   Relay success paths, changed files, status, and activation caveats from the
   script's report without rereading or remeasuring published files. Start a new
   host session to load integration. Installation does not consult an Advisor,
   establish account model access, or prove effective runtime permissions.

All commands accept `--help`, `--json`, and `--preflight`. Normal execution includes
preflight. Use a separate preflight only for a requested preview/readiness check
or a host permission boundary that needs a concrete write plan. Exit 0 is success,
2 means installation never started, and 1 means a write failed. Reports name the
single instruction file planned or published. The file is published atomically.

Markers are `<!-- harness-plugin:capabilities:start -->` and
`<!-- harness-plugin:capabilities:end -->`. Replace an existing block in place,
preserve unrelated bytes, and avoid no-op writes. Malformed or duplicate markers,
or an active Codex AGENTS.override.md are conflicts to report,
not permission to overwrite user data. Repeated successful installation converges.

The internal capability table contains the name, supported hosts, and small host
instructions. Activation installation remains a direct action.
Add more capability machinery only when another actual capability needs it.
