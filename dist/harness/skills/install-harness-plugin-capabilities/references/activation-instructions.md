# Activation instruction templates

Copy the selected host's Advisor capabilities block exactly, including its markers.
Install the shared implementation-planning trigger and Skill discovery template
independently for both hosts, directly as active instructions. Check replacement
skill availability as required by the installer before changing planning integration.

## Codex capabilities

```markdown
<!-- harness-plugin:capabilities:start -->
## Harness capabilities

### Harness Advisor

Use the `harness-advisor` Skill for selective reasoning escalation and a separate
review of executor-supplied evidence. For substantial or difficult work, consider
it at consequential decision points rather than during routine execution.
If the user explicitly asks for an advisor, second opinion, named Advisor model
family, or independent review, invoke the Skill. It defines routing, invocation
limits, context handling, cache-aware carryover, and Advisor execution.
The executor gathers evidence and owns implementation, verification, and delivery.
The Advisor makes no tool calls. A second reasoning pass is not independent
repository inspection or reproduced verification. The Skill defines host
restriction limits; do not invent permissions or an alternate execution adapter.
<!-- harness-plugin:capabilities:end -->
```

## Claude Code capabilities

```markdown
<!-- harness-plugin:capabilities:start -->
## Harness capabilities

### Harness Advisor

First determine whether this Claude session provides native Advisor: an active
Anthropic `advisor` server tool or session metadata identifying a configured
Managed Agents advisor is positive evidence. Host identity or saved settings alone
are not evidence. If status is unknown, establish it before using Harness fallback.
If native Advisor is available, use it and do not load, invoke, or otherwise use
the Harness `harness-advisor` Skill. Native Advisor owns the session's Advisor behavior,
including generic user requests. Native errors do not enable Harness fallback.
Only when native Advisor is unavailable, use the Harness `harness-advisor` Skill for
selective reasoning escalation and a separate review of executor-supplied evidence.
Consider it at consequential decisions, and invoke it for explicit advisor,
second opinion, named Advisor family, or independent review requests.
For Harness fallback, the executor gathers evidence and owns implementation,
verification, and delivery. The Advisor makes no tool calls. A separate reasoning
pass is not independent repository inspection or reproduced verification.
An explicit native-only request when native is absent must report unavailable.
Do not use both native Advisor and Harness Advisor to obtain additional review.
<!-- harness-plugin:capabilities:end -->
```

## Implementation planning (both hosts)

```markdown
<!-- harness-plugin:implementation-planning:start -->
# Implementation planning

When authoring, reviewing, revising, or saving a coding implementation plan,
including plan-file-only requests and the current host's native plan mode,
find and use the Harness `write-implementation-plan` Skill through the active
skill catalogue. Apply it alongside the host's native planning process and
audit the plan under its contract before delivery.
Permission to produce or save a plan does not authorize executing its contents;
keep any later action phase within the user's authorized scope.
If the Skill cannot be resolved or loaded, report that blocker instead of
presenting an unaudited final implementation plan.
<!-- harness-plugin:implementation-planning:end -->
```

## Skill discovery (both hosts)

```markdown
# Skill discovery

Before reading a skill, find it in the list of available skills supplied by
the host (Codex or Claude Code). Use the location listed for that skill.
If the host abbreviates part of the location, expand it using the accompanying
directory mapping. Use the current session's mapping. Never construct a
filesystem path from the skill's display name or a remembered installation
location.

If the host provides a tool or resource reference instead of a file path,
use that provided mechanism to load the skill. If the supplied location
cannot be resolved or loaded, report it, the attempted file path when
applicable, and the failure. Use another installation only when the host
or user explicitly selects it.
```
