---
name: install-harness-plugin-capabilities
description: Install, repair, or update Harness user-level integration for Codex or Claude Code, including Advisor activation and final-plan guidance. Use when requested to configure Harness capabilities or repair their host integration.
---

# Install Harness capabilities

Use ordinary agent file operations to install the bundled instructions and
final-plan companion for each requested host. This skill is instruction-only.
Harness supplies the skills through the plugin, with one canonical copy.

1. Establish the requested host, Codex or Claude Code, and verify that Harness
   skills are discoverable through the plugin. If the plugin is missing, follow
   its normal host installation flow first. Do not copy individual skills.
   Read [host-detection.md](references/host-detection.md) and the selected host's
   block and shared Final plans trigger in
   [activation-instructions.md](references/activation-instructions.md).
2. Resolve the host's user directory and inspect the effective user-level
   instruction surface using the host guidance. Read existing destination
   instructions and companion content before editing. Do not patch a shadowed
   file and claim activation.
3. Read the bundled [final-plan-context.md](references/final-plan-context.md).
   Copy it byte-for-byte, including its final newline, to
   `<host-user-directory>/final-plan-context.md` before installing or updating
   its pointer. This bundled file is authoritative for both hosts. Create
   missing directories and files as needed. Leave an identical companion alone.
   If copying fails, report the failure and do not install a new pointer.
4. Patch Advisor activation and Final plans guidance independently using the
   bundled templates. Substitute the installed companion's absolute path in
   the trigger. Update existing integration in place, adding only missing
   integration and avoiding duplicates or unnecessary writes. Correct final-plan
   guidance does not suppress Advisor repair, or vice versa.

   Resolve structure from the document and use contextual edits, without
   rebuilding a Markdown parser. Preserve unrelated instructions and examples.
   Preserve any capabilities block nested within a Final plans section while
   independently updating its Advisor wording. Replace the existing final-plan
   integration text, not unrelated content sharing its section. If Final plans
   guidance is absent, insert the trigger before `# Engineering context` when
   present, otherwise append it with blank-line separation. Examples of headings
   or markers are not active integration. If ownership or the intended edit is
   genuinely unclear, report the specific path and blocker instead of guessing.
5. Inspect the resulting edits. Verify that the installed companion matches the
   bundled bytes, its pointer resolves to that file, and both instruction
   templates are active text on the effective instruction surface. Report
   changed paths, unchanged artifacts, failures, and any partial completion
   honestly. Remind the user to start a new host session to load integration.

Install Claude's native-first Advisor gate even when native Advisor is currently
available. That gate controls Advisor use per session, never installation.
Final-plan guidance applies to both hosts independently of Advisor availability.

Preserve host settings, Advisor routing (including
`~/.harness-plugin/harness-advisor/config.json`), and legacy role files. Do not
choose an Advisor family, materialize routing defaults, or consult an Advisor
as part of installation. Installation does not establish account model access,
effective runtime permissions, or future agents' compliance with the guidance.
