---
name: install-harness-plugin-capabilities
description: Install, repair, or update Harness user-level integration for Codex or Claude Code, including Advisor activation, implementation-planning activation, and Skill discovery. Use when requested to configure Harness capabilities or repair their host integration.
---

# Install Harness capabilities

Use ordinary agent file operations to install three independent components in
each selected host's effective user instructions: Advisor, implementation-planning
activation, and Skill discovery. Follow these steps in order for each host.

## Bundled path authority

Use the current host’s path for this loaded `SKILL.md`. Claude Code supplies this path through `${CLAUDE_SKILL_DIR}`. Expand any catalog root alias using its supplied mapping. Set `<SKILL_DIR>` to the absolute directory containing that exact file and retain it for this invocation. Replace `<SKILL_DIR>` in commands with that directory, keeping paths quoted. Resolve bundled scripts and skill-root resource paths from this directory. Resolve Markdown-relative links from the file containing the link, within the same installed skill instance. Preserve the caller’s working directory and existing input/output path semantics.

If the host-provided path is unavailable or a bundled file is missing, report the supplied skill path, attempted resource path, and actual failure. Other installations may be inspected for diagnosis, but use a replacement only when the host or user explicitly selects it. Do not infer the skill directory from conventional locations or select another copy by version, timestamp, or search order.

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

Preserve host settings, Advisor routing (including
`~/.harness-plugin/harness-advisor/config.json`), legacy role files, and unrelated
instructions. Do not create or maintain a user-level `final-plan-context.md`.
Do not delete, rename, overwrite, or adopt ownership of an existing legacy
companion. Its presence does not justify retaining an obsolete active Harness
pointer. Do not inspect the companion unnecessarily.

## 2. Read templates and identify existing integration

Read the selected host's capabilities block, shared implementation-planning
trigger, and shared Skill discovery template in
[activation-instructions.md](references/activation-instructions.md).
Read the existing effective user instruction file before editing.

Identify active integration from its document context. Fenced or quoted examples
and historical descriptions are not active instructions. Preserve unrelated prose,
examples, adjacent sections, and nested blocks. Use contextual edits without
building a Markdown parser or replacing everything through the next heading.
A heading alone does not establish ownership of its contents. Report the path
and specific ambiguity when ownership or conflicting instructions make an edit
unclear; preserve the uncertain content.

Inspect all three components independently. A correct or blocked component must
not cause another component to be skipped. Leave correct components unchanged;
with unchanged inputs a second run must make no edits. Do not rewrite the whole
file to normalize whitespace or headings.

## 3. Install the Advisor instructions

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

## 4. Check availability and install implementation planning

Before adding or replacing planning integration, establish that the selected
host can discover and load the intended Harness `write-implementation-plan`
skill through its supported active catalogue mechanism. Use actual target-host
discovery evidence. A source file, a successful development build, or availability
in a different host is insufficient. Do not search caches for a substitute or
select an installation by version or timestamp.

If the replacement is absent, stale, unloadable, ambiguous, or cannot be verified
from this session, leave that host's existing planning integration untouched and
report this component blocked. Direct the user to the normal plugin update/reload
workflow and, when necessary, rerun capability installation in a fresh session of
that host. Do not add a CLI dependency or use the legacy companion as the new
contract. Continue Advisor and Skill discovery installation where their own
prerequisites are satisfied.

Once availability is established, copy the shared implementation-planning trigger
as active Markdown, including its ownership markers and excluding the surrounding
code fence. Install it independently of Advisor availability.

Recognize old Harness planning integration only through the combined context of
its `final-plan-context.md` companion pointer and identifiable Harness
context-transfer/fresh-context-audit wording. The `# Final plans` heading alone,
or an arbitrary similarly named file reference, does not establish ownership.
Replace only the identifiable Harness-owned span. Preserve custom prose and any
nested capabilities blocks. Rename or remove the old heading only when doing so
does not discard unrelated content.

For new integration, matching ownership markers and the activation template define
the normal update boundary. An unmarked but clearly identifiable equivalent
Harness trigger may be migrated to the marked form. Incomplete markers,
conflicting content, or uncertain ownership require an ambiguity report instead
of guessed replacement. Preserve uncertain content rather than adding another
trigger alongside it.

If identifiable old and new active Harness triggers coexist, retain one canonical
new trigger and remove only obsolete or duplicate Harness-owned spans. Leave the
legacy companion itself untouched. Do not leave two active planning authorities.

Update identifiable integration in place. If absent, insert before
`# Engineering context` when present, otherwise append with blank-line separation.
Avoid moving unrelated content. Keep `# Implementation planning` and
`# Skill discovery` as sibling sections.

## 5. Install Skill discovery

Copy the shared Skill discovery template from `activation-instructions.md` as
active Markdown without its surrounding code fence into the effective instruction
file. Install for both hosts regardless of Claude native Advisor availability.

Update identifiable active guidance in place, preserving unrelated prose, nested
content, and examples. Report specific ambiguities instead of guessing ownership.
Leave matching guidance unchanged. If absent, insert before
`# Engineering context` when present, otherwise append with blank-line separation.
Avoid duplicate active guidance. Check this component even if Advisor or planning
integration already matches or is blocked.

## 6. Verify and report

Inspect the effective instruction file and resulting edits. Verify each installed
component is active text and correct. For a successful planning migration, verify
one canonical Harness planning trigger remains and the migrated Harness pointer
is removed. Do not claim removal of arbitrary user-authored references. Confirm
unrelated content is preserved; do not inspect or modify the legacy companion
for verification.

For each selected host report changed paths, unchanged components, blocked
components, failures, and partial completion honestly. Mention an untouched legacy
companion only when its presence is known. Remind the user to start a new host
session. Installation does not establish account model access, effective runtime
permissions, runtime compliance, or guaranteed skill invocation.
