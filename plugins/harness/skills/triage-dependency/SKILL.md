---
name: triage-dependency
description: Decide whether to add, keep, replace, or remove a third-party dependency by weighing what it actually costs against what the standard library, an existing dependency, or a small amount of local code would do instead. Use when about to add a package, when a dependency needs a major-version upgrade, when auditing what a project pulls in, or when a transitive dependency raises a concern. Do not use for pinning versions, resolving a lockfile conflict, or applying a known-vulnerability patch, all of which are mechanical fixes rather than judgments about whether the dependency belongs.
---

# Triage a dependency

The default failure mode is reaching for a package before checking what's already available. Work in this order.

## 1. Check what's already there

Before evaluating a candidate package, rule out the alternatives that cost nothing to adopt:

- Does the language's standard library already do this, even a slightly less convenient way?
- Does an existing dependency already expose this, directly or as an incidental capability?
- Is the actual functionality needed small enough to write and own locally - a few dozen lines, not a subsystem?

If any of these covers the need, stop here and recommend that instead of the package.

## 2. Evaluate the candidate

When a new dependency genuinely earns its place, weigh:

- **Maintenance signal.** Is it actively maintained, or does it look abandoned? A single-maintainer package with no recent activity is a different risk than one with an active team behind it.
- **Transitive weight.** What does it pull in underneath it? A package that looks small but drags in twenty transitive dependencies is not small.
- **Removability.** How hard would this be to rip out later if it turns out to be the wrong call? A dependency used behind a narrow interface is cheap to replace; one whose API leaks through the whole codebase is not.
- **Actual scope of use.** Is the full package needed, or just one function's worth of it?

## 3. For an upgrade or an existing dependency being audited

Ask whether the reason for the version pin or the dependency's continued presence still holds. A major-version upgrade is worth doing when it unblocks something concretely needed, not on a cadence for its own sake. A dependency kept only from inertia is worth flagging even if the request was to evaluate something else.

## Output

State the recommendation directly: add it, use what's already there, or remove it. Give the one or two reasons that actually drove the call, not a scorecard. When the recommendation is "add it" and the decision is consequential enough to be worth recording, write the one-line rationale in a form suitable for a decision record.
