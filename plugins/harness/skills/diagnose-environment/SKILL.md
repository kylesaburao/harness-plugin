---
name: diagnose-environment
description: "Diagnose environment failures specific to this machine when code works elsewhere, a command uses the wrong binary or version, an upgrade breaks a build, or reinstalling only temporarily fixes it. Check PATH, shims, architecture, caches, and permissions. Not for failures reproduced in a clean checkout on another machine or in CI."
---

# Diagnose an environment problem

The code is not the suspect here. Bisect the machine instead of the program.

## Signal that this is an environment problem, not a code problem

- The same commit behaves differently on two machines, or differently in a fresh shell versus the current one.
- A command resolves to a version, path, or binary that doesn't match what the project expects.
- A fix works immediately after a reinstall or a fresh terminal, then degrades again over time.
- The failure is specific to this machine's history: things installed, upgraded, or half-removed over time.

If the failure reproduces from a clean checkout in CI or on another machine, stop - that's a code defect, not an environment one, and belongs to ordinary debugging instead.

## Workflow

1. **Resolve what's actually running.** Don't assume the tool in use is the one intended. Find out what a command actually resolves to and where that resolution came from: `which -a <cmd>`, `type <cmd>`, `command -v <cmd>`. For an interpreted language or version-managed toolchain, check which manager (if any) is claiming the shim and whether a local pin (`.nvmrc`, `.python-version`, `.tool-versions`) is being honored or silently ignored.

2. **Compare against a clean baseline.** What would a fresh install produce here - default PATH, default shell init, no local overrides? The gap between that baseline and the current state is the actual thing to explain.

3. **Work outward through the resolution chain**, only as far as needed to explain the symptom:
   - Shell init order (see the platform-specific reference below for the login/non-login and interactive/non-interactive distinctions that change which file actually loads).
   - Version manager state: is the manager itself outdated, is its shim stale, does it disagree with a lockfile or pinned version.
   - Package manager state: local vs. global installs, a stale lockfile, a cache holding an old build.
   - Permissions and ownership, particularly after a `sudo` install mixed with a user-level one.
   - Stale build artifacts or caches that a clean rebuild would bypass - confirm this by actually clearing the specific cache, not by guessing.

4. **State the actual cause before fixing it.** "Reinstalling fixed it" is not a diagnosis; it's a description of the fix's blast area. Say specifically what was stale or misconfigured, so it doesn't reappear.

5. **Prefer the fix that addresses the found cause over the fix that happens to work.** A `rm -rf` and reinstall often "fixes" an environment problem by accident while leaving the actual misconfiguration (a shell-init ordering issue, a duplicate install) in place to recur.

## Platform reference

Read [references/macos-environment.md](references/macos-environment.md) for macOS-specific resolution order and inspection commands: shell-init file precedence, Homebrew prefix differences between architectures, Rosetta and architecture mismatches, and Gatekeeper quarantine attributes. Read it when the machine in question is macOS and the general workflow above isn't enough to localize the cause.
