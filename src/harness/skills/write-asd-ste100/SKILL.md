---
name: write-asd-ste100
description: Manually draft, revise, or review technical English with ASD-STE100 Issue 9 rules and a local dictionary.
disable-model-invocation: true
---

# Write ASD-STE100 Technical English

Use the local Issue 9 reference bundle. Keep technical meaning and repository conventions more important than a language change.

## Bundled path authority

Use the current host’s path for this loaded `SKILL.md`. Claude Code supplies this path through `${CLAUDE_SKILL_DIR}`. Expand any catalog root alias using its supplied mapping. Set `<SKILL_DIR>` to the absolute directory containing that exact file and retain it for this invocation. Replace `<SKILL_DIR>` in commands with that directory, keeping paths quoted. Resolve bundled scripts and skill-root resource paths from this directory. Resolve Markdown-relative links from the file containing the link, within the same installed skill instance. Preserve the caller’s working directory and existing input/output path semantics.

If the host-provided path is unavailable or a bundled file is missing, report the supplied skill path, attempted resource path, and actual failure. Other installations may be inspected for diagnosis, but use a replacement only when the host or user explicitly selects it. Do not infer the skill directory from conventional locations or select another copy by version, timestamp, or search order.

## Workflow

1. Identify procedural, descriptive, or mixed writing. Use procedural mode for work steps and commands. Use descriptive mode for explanations. Use mixed mode only when the text contains both.

2. Preserve code, syntax, exact identifiers, commands, paths, quoted material, copied diagnostics, and required external wording. Do not translate or normalize these spans.

3. For an uncertain word, run `python3 "<SKILL_DIR>/scripts/ste_lookup.py" WORD` once. Read `references/writing-rules.md` when a rule or recommendation affects the draft. Do not run a separate reference preflight.

4. If the lookup exits with status 2, relay its complete initialization diagnosis. Then use the Initialization approval workflow below. Do not inspect the reference files or make an independent readiness diagnosis.

5. Use approved dictionary words with their approved part of speech, meaning, and form. Treat unknown subject-specific nouns and verbs as terminology for review. If the repository has `STE_TERMS.jsonl`, pass it with `--terms` and obey `references/project-terminology-schema.md`. The bundled `references/software-terminology.jsonl` flags overused AI-coding-assistant words and phrases at `review` severity, with a `software_terms` source and a preferred alternative. Treat an `overused_term` finding as a style suggestion, not a rule violation.

6. Draft or revise the text. Keep procedural sentences to 20 words or fewer. Keep descriptive sentences to 25 words or fewer. Keep each descriptive paragraph to six sentences or fewer. Do not use semicolons or contractions in natural-language prose.

7. Prefer active voice. Do not use an `-ing` form unless the standard or project terminology permits it.

8. For substantial prose, run `python3 "<SKILL_DIR>/scripts/ste_check.py" FILE [FILE ...] --mode procedural|descriptive|mixed --json` once. Every invocation is a batch, including one file. Use `-` for standard input only when it is the sole input. An LLM must use `--json` when it runs the checker. The checker selects each input format from its file name. It reads `.md`, `.markdown`, and `.txt` files as prose. It checks only the comments of Python, JavaScript, and TypeScript source files: `.py`, `.pyi`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx`, `.d.ts`, `.d.mts`, and `.d.cts`. For standard input or another file name, add `--input-format prose|python|javascript|typescript|jsx|tsx`. One explicit format applies to all inputs, so split a batch whose inputs need different formats. Review each file result and the aggregate errors, warnings, and terminology findings separately. Preserve meaning and revise the text yourself. A finding can be a false positive in the context of the analyzed content. Examples include a preserved identifier, an established repository term, or a word that is correct in the subject matter. Do not complain about a false positive or about checker limitations. State calmly which findings you accept and apply, and note that you did not apply the rest because they do not fit the context.

9. Use `--layers asd,software,project` to select the vocabulary layers the checker applies. The default is all three layers. Use `--layers software` alone to review overused-term findings apart from unknown-term noise from the base dictionary.

10. If the checker exits with status 2, relay its complete diagnostic. Reference failures give the initialization diagnosis. Input-read, argument, input-format, source-parse, runtime, and terminology failures identify their own failure class. A source file that does not parse is not checked; do not check it as prose instead. For `dependency_missing` or `dependency_invalid`, relay the remedy, which is the setup command from `INSTALL.md`, and run it only after the user approves it. Status 1 with `source_parser_failed` means comment extraction started and failed; relay it. Do not retry the checker or inspect the generated directory.

## Source comments

For a source file, the checker parses the file and sends only comment text to the rules. Code, identifiers, strings, regular expressions, template text, and JSX text are never checked. Comments inside template or f-string expressions are checked. Python docstrings are string literals, so the checker does not check them. To check docstring text, check a copy as prose through standard input with `--input-format prose`.

Separate comments are checked separately, so a sentence never continues across code. Consecutive standalone line comments with the same indentation and marker form one paragraph. Machine directives, such as `noqa`, `@ts-ignore`, `eslint-disable`, and source-map lines, are not checked, and neither is a reason attached to one. A `TODO`, `FIXME`, `NOTE`, `HACK`, or `XXX` label is ignored, and its explanation is checked. In a `/** ... */` comment, the description and the descriptions of `@param`, `@returns`, `@throws`, `@description`, `@summary`, `@remarks`, and `@deprecated` are checked. Other tags, `@example` sections, and license text are not checked. When you revise a comment, keep its markers, tags, types, and parameter names exactly.

Each source file result has an `analysis` object: `inputFormat`, `scope` (`comments`), `commentCount`, `regionCount` (the comment prose regions checked), and `skipped` (excluded sections, each with a `reason` and a source position). Report what the check covered. A file with no checked regions passed only because nothing was checked; it is not evidence of STE compliance.

11. After a successful check, run the checker again only when a revision requires verification. Never use checker output as an automatic rewrite.

## Initialization approval

After you relay an initialization diagnosis, use the ask-user API of the current harness when it is available. Do not send a plain chat question before you try the available API.

- Codex: use `request_user_input`, with the ID `initialize_references`.
- Claude Code: use `AskUserQuestion`, with the header `Initialize`.

Send one question with the prompt `Run the reported initialization command now?` Use these options:

- `Initialize now (Recommended)`: Download the pinned source and create the generated reference data.

- `Do not initialize`: Leave the generated reference data unchanged and stop the skill workflow.

If the user selects `Initialize now`, run the exact initialization command from the diagnosis. Request command approval separately if the execution environment requires it. Relay a failure diagnosis verbatim. On success, relay the reported generated-data location, dictionary row count, and SHA-256; do not measure the artifact again. Relay `cleanupFailures` and `rollbackFailure`, including retained paths, when present. A successful report with cleanup failures exits with status 1. For `initialization_busy`, relay the lock path and manual recovery remedy. Do not retry initialization or delete retained paths or locks automatically. If no ask-user API is available, ask the same question through a plain chat message and wait for the answer. Do not mention API availability or the fallback to the user.

## Procedures and descriptions

Write one instruction in each procedural sentence unless actions occur at the same time. Use the imperative form. Put a condition first when the reader must know the condition before the instruction. Do not put instructions in notes.

Give descriptive information gradually. Keep one topic in each sentence and paragraph. Use connecting words to show the logical relation. Use passive voice only when the agent is unknown, unimportant, or obvious.

## Terminology and code

Use consistent technical nouns and technical verbs. Prefer a repository term that is technically correct over a general dictionary replacement. Do not change exact text in code blocks, inline code, URLs, paths, shell options, identifiers, quotations, or diagnostics. When you write or revise natural-language comments and docstrings, obey the rules around preserved identifiers and code fragments. The checker reads source comments but not docstrings.

## Validation and claims

The lookup and checker validate the local reference bundle before they read it. Generated bundles are stored under `~/.harness-plugin/write-asd-ste100/bundles/`, keyed by the tracked source configuration rather than the plugin version. Codex and Claude Code therefore use the same bundle. They never download reference data. Exit status 2 supplies a stable error code, the failed condition, the generated-data path, and the initialization command.

The checker is an aid. It cannot verify meaning, part of speech, every passive construction, or every multi-word noun. A human or assistant semantic review remains necessary.

Use `STE-compliant` only after lexical, mechanical, and semantic review confirms the text against Issue 9. Otherwise, use `STE-aligned` or `checked against the bundled Issue 9 data`.

Valid installed bundles remain unchanged during initialization, including `--force`, which still builds and validates a fresh stage. Publication revalidates under a per-bundle lock and repairs only missing or invalid destinations.

The `pypdfium2` package is only for local reference initialization. Lookup and prose checking use Python 3 and the standard library. Python source checking needs Python 3.12 or newer. JavaScript-family source checking needs Node.js 24.0.0 or newer and the `@babel/parser` install described in `INSTALL.md`. Prose and Python checks do not need Node.js. The checker never runs, imports, or changes a checked source file, and it never installs a package.

With `--json`, each command prints one stdout line. A check prints `{"result":{"mode","outcome","summary","files"}}` and a lookup prints `{"result":{"query","matches"}}`; dictionary entries in `matches` keep their own keys. Only source file results in `files` have an `analysis` object. Failures print one stderr line, `{"error":{"code","condition","remedy",...}}`, where a reference failure's `remedy` is the initialization command and bad arguments report `usage_error`.

`ste_check.py --preflight --json` and `ste_lookup.py --preflight --json` print `{"status":"ready"}` after they validate references and terminology without reading prose or looking up a word. `ste_check.py` also checks the source runtime that an explicit `--input-format` or the supplied file names select, for example `--preflight --input-format typescript --json`. Preflight never reads an input, so it cannot find syntax errors. Use these only when the user requests readiness alone. Normal commands perform the same reference and runtime checks.
