# Activation instruction templates

Copy the selected host's capabilities block exactly, including its markers.
Install the Final plans trigger independently for either host, replacing
`<absolute-companion-path>` with the absolute path to the installed
`final-plan-context.md` in that host's user directory. Install the shared Skill
discovery template independently for both hosts, directly as active instructions.

## Codex capabilities

```markdown
<!-- harness-plugin:capabilities:start -->
## Harness capabilities

### Harness Advisor

Use the `harness-advisor` Skill for selective read-only reasoning escalation and
independent review. For substantial or difficult work, consider the Skill at
high-leverage decision points rather than during routine execution.
If the user explicitly asks for an advisor, second opinion, named Advisor model
family, or independent review, invoke the Skill. It defines routing, invocation
limits, context handling, cache-aware carryover, and Advisor execution.
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
selective read-only reasoning escalation and independent review. Consider it at
consequential decisions, and invoke it for explicit advisor, second opinion,
named Advisor family, or independent review requests.
An explicit native-only request when native is absent must report unavailable.
Do not use both native Advisor and Harness Advisor to obtain additional review.
<!-- harness-plugin:capabilities:end -->
```

## Final plans (both hosts)

```markdown
# Final plans

Before drafting or revising a final implementation plan, read
`<absolute-companion-path>` and apply its context-transfer
rules and fresh-context audit. Assume the planning conversation will
be erased. The executor must need only the final plan, repository/worktree
state, and explicitly identified artifacts. If the guidance cannot be
read, report the blocker rather than presenting an unaudited final plan.
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
