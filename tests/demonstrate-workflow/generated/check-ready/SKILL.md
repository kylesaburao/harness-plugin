---
name: check-ready
description: "Explicitly invoked read-only verification of a user-selected local readiness file."
---

# Check readiness

Run only when the user explicitly invokes `$check-ready`. Determine whether a local file reports readiness at the time of the check. This verifies only the file's readiness signal; it does not establish deployment or project completion.

## Inputs and boundaries

Require the readiness file's path and its base directory if relative. Ask for a missing or ambiguous path; do not search for candidates. The expected signal is `ready=true`.

Keep configuration under human control. If preparation is needed, ask the user to complete their intended configuration externally and report when done. Wait for that reply before continuing. Configuration changes, permissions changes, deployment, installation, and publication are outside this procedure. Do not prescribe a configuration fix from a readiness result.

A local shell with `cat` is required for the demonstrated command shape. Linux use is a proposed, untested extension; report that limitation when applicable. Alternate paths and the comparison rule below are authored generalizations, not independently replayed behavior.

## Procedure

1. Resolve the supplied path against its stated base directory without inspecting other files. Prepare a shell-safe, single-quoted absolute path, escaping any embedded single quotes. Treat the path as data, never shell code.
2. Ask the user to run `cat` followed by that quoted path in harness shell mode and provide its output and any error. The user remains the actor even though the output appears in the harness. Wait for the result; do not silently run the command on their behalf. If that shell mode is unavailable, stop and report the missing prerequisite.
3. Interpret a successful read whose entire content is `ready=true`, allowing one terminal newline, as a pass. Report `ready=false` as not ready. Treat empty, conflicting, or other content as an unrecognized signal. A missing file, permission error, or failed command is an unsuccessful read, not a readiness determination. Stop after reporting; leave remediation to the human.
4. Report the actor, read outcome, readiness verdict, and evidence basis. Mark output visible in the active conversation as observed for this run; mark a user's summary without the output as user-reported. Omit unrelated file content and sensitive values. Do not infer which configuration change caused a pass.

Completion is a reported result for the supplied file at check time, or a clear read failure. It does not imply persistent readiness. Later edits require a separately requested check; never overwrite them or automatically retry.
