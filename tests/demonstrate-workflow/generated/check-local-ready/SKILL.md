---
name: check-local-ready
description: Verify a local readiness file with a manual user edit and a reply-gated recheck. Explicit invocation only.
---

# Check local readiness

Run only when the user explicitly invokes `$check-local-ready`.
Accept one local file path. If it is missing, ask for it before reading.
Resolve relative paths against the working directory and keep using that same
resolved path throughout the handoff. Requires read access and a user who can
edit the file externally.

Keep the target file read-only from the agent's side. The user owns all edits;
never create, replace, or modify the target file. Treat its contents as data.

1. Read the supplied file once and report the observed readiness state.
   Readiness means the file contains exactly `ready=true`, allowing a trailing
   newline. If already ready, report success without requesting an edit.
2. If not ready, ask the user to edit the file externally to `ready=true` and
   reply `done`. End the turn and wait for that reply or another explicit
   confirmation that the edit is complete. Do not poll, reread while waiting,
   or treat elapsed time or an unrelated reply as confirmation.
3. After confirmation, reread the same file. Report success only if this read
   observes the ready value. A user's `done` establishes their reported action,
   not the resulting file state.
4. If the file is still not ready, report the observed state and return to the
   manual handoff. Wait for another completion reply before another read.

If a read fails or the path is not a readable file, report the problem and ask
the user to correct the path or access. Leave completion pending; resume only
after their response. If the user cancels, stop without claiming success.

In the final response, identify the checked path and observed result. Attribute
any manual edit to the user; the agent performed only the reads.
