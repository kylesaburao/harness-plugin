---
name: install-harness-plugin-capabilities
description: Install, repair, or update Harness user-level integration for Codex or Claude Code, including Advisor activation and final-plan guidance. Use when requested to configure Harness capabilities or repair their host integration.
---

# Install Harness capabilities

Use ordinary agent file operations. For each requested host, copy one companion
file into its user directory and add Advisor instructions and a Final plans
pointer to its user-level instruction file. Follow these steps in order.

## 1. Select the host and destination files

Establish whether the user wants Codex, Claude Code, or both. Verify that Harness
skills are discoverable through the plugin. If the plugin is missing, follow
its normal host installation flow first. Do not copy individual skills.

Resolve the selected host's user directory:

| Host | User directory | User instruction file |
| --- | --- | --- |
| Codex | Nonempty absolute `CODEX_HOME`, otherwise the target user's `.codex` directory | `AGENTS.md`, or a nonempty `AGENTS.override.md` when present |
| Claude Code | Nonempty absolute `CLAUDE_CONFIG_DIR`, otherwise the target user's `.claude` directory | `CLAUDE.md` |

Normalize the directory to an absolute path. A nonempty relative environment
override is a blocker, not a reason to silently use the default. Inspect the
effective user instruction file before editing. A nonempty Codex
`AGENTS.override.md` shadows `AGENTS.md`, so edit the override in that case.
If the host uses another applicable user-level instruction file, establish that
file first. Report a specific blocker if the effective file cannot be established.

The companion destination is `<host-user-directory>/final-plan-context.md` for
both hosts. These host integration files are an intentional exception to the
plugin's runtime-data root. Preserve host settings, Advisor routing (including
`~/.harness-plugin/harness-advisor/config.json`), and legacy role files.

## 2. Read the source and existing destination content

Read the bundled [final-plan-context.md](references/final-plan-context.md),
the selected host's capabilities block and the shared Final plans trigger in
[activation-instructions.md](references/activation-instructions.md).
Read the existing destination companion and user instruction file if present.

Identify the existing integration from the document's context. Preserve unrelated
instructions and examples. Example headings and markers are not active
integration. Use contextual edits, without rebuilding a Markdown parser. If
ownership or the intended edit is genuinely unclear, report the path and blocker
instead of guessing.

## 3. Copy the companion

Create missing destination directories as needed. Copy the bundled
`final-plan-context.md` byte-for-byte, including its final newline, to the
companion destination. The bundled file is authoritative. Leave an identical
installed companion alone. If copying fails, report the failure and stop before
installing or updating its pointer.

## 4. Install the Advisor instructions

Create the user instruction file if missing. Copy the selected host's capabilities
block from `activation-instructions.md` exactly, including its markers. Update
existing integration in place, or append the missing block with blank-line
separation. Avoid duplicate additions and leave correct content alone.

For Claude, install the native-first gate even when native Advisor is currently
available. Its wording governs Advisor use in future sessions. Current availability
does not change installation. Codex uses Harness Advisor. Do not choose an Advisor
family, materialize routing defaults, or consult an Advisor during installation.
The optional [host-detection.md](references/host-detection.md) explains the Claude
session gate, but adds no installation steps.

## 5. Install the Final plans note in the same instruction file

Take the shared `# Final plans` trigger from `activation-instructions.md` and
replace `<absolute-companion-path>` with the absolute path copied to in step 3.
Write the resulting note as active instructions in the file selected in step 1.
This applies to both Codex and Claude independently of Advisor availability.

Update existing final-plan integration in place. Preserve unrelated content
sharing its section, including any nested capabilities block updated in step 4.
If the guidance is missing, insert it before `# Engineering context` when
present, otherwise append it with blank-line separation. Avoid duplicates and
leave correct guidance alone. Always check both steps 4 and 5, even when one
integration already matches its template.

## 6. Verify and report

Inspect the resulting edits. Check that the installed companion matches the
bundled bytes, the Final plans pointer resolves to that installed file, and
both instruction templates are active text in the effective instruction file.

Report changed paths, unchanged artifacts, failures, and partial completion
honestly. Remind the user to start a new host session. Installation does not
establish account model access, effective runtime permissions, or future agents'
compliance with the guidance.
