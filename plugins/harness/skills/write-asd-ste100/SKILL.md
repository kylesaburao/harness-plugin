---
name: write-asd-ste100
description: Draft, revise, or review technical English with the ASD-STE100 Simplified Technical English Issue 9 rules and a locally generated dictionary. Use for a response that explains technical work, documentation, procedures, descriptions, comments, docstrings, release notes, and new user-facing text. Preserve programming syntax, exact identifiers, commands, paths, quotations, external diagnostics, and established project terminology.
---

# Write ASD-STE100 Technical English

Use the local Issue 9 reference bundle. Keep technical meaning and repository conventions more important than a language change.

## Workflow

1. Every command path in this skill is relative to the skill directory, not the current working directory. When the working directory is not the skill directory, prefix the script path with the absolute skill directory path, for example `python3 /path/to/write-asd-ste100/scripts/ste_lookup.py WORD`.

2. Identify procedural, descriptive, or mixed writing. Use procedural mode for work steps and commands. Use descriptive mode for explanations. Use mixed mode only when the text contains both.

3. Preserve code, syntax, exact identifiers, commands, paths, quoted material, copied diagnostics, and required external wording. Do not translate or normalize these spans.

4. For an uncertain word, run `python3 scripts/ste_lookup.py WORD` once. Read `references/writing-rules.md` when a rule or recommendation affects the draft. Do not run a separate reference preflight.

5. If the lookup exits with status 2, relay its complete initialization diagnosis. Then use the Initialization approval workflow below. Do not inspect the reference files or make an independent readiness diagnosis.

6. Use approved dictionary words with their approved part of speech, meaning, and form. Treat unknown subject-specific nouns and verbs as terminology for review. If the repository has `STE_TERMS.jsonl`, pass it with `--terms` and obey `references/project-terminology-schema.md`. The bundled `references/software-terminology.jsonl` flags overused AI-coding-assistant words and phrases at `review` severity, with a `software_terms` source and a preferred alternative. Treat an `overused_term` finding as a style suggestion, not a rule violation.

7. Draft or revise the text. Keep procedural sentences to 20 words or fewer. Keep descriptive sentences to 25 words or fewer. Keep each descriptive paragraph to six sentences or fewer. Do not use semicolons or contractions in natural-language prose.

8. Prefer active voice. Do not use an `-ing` form unless the standard or project terminology permits it.

9. For substantial prose, run `python3 scripts/ste_check.py FILE [FILE ...] --mode procedural|descriptive|mixed --json` once. Every invocation is a batch, including one file. Use `-` for standard input only when it is the sole input. An LLM must use `--json` when it runs the checker. Review each file result and the aggregate errors, warnings, and terminology findings separately. Preserve meaning and revise the text yourself. A finding can be a false positive in the context of the analyzed content. Examples include a preserved identifier, an established repository term, or a word that is correct in the subject matter. Do not complain about a false positive or about checker limitations. State calmly which findings you accept and apply, and note that you did not apply the rest because they do not fit the context.

10. Use `--layers asd,software,project` to select the vocabulary layers the checker applies. The default is all three layers. Use `--layers software` alone to review overused-term findings apart from unknown-term noise from the base dictionary.

11. If the checker exits with status 2, relay its complete diagnostic. Reference failures give the initialization diagnosis. Input-read, argument, and terminology failures identify their own failure class. Do not retry the checker or inspect the generated directory.

12. After a successful check, run the checker again only when a revision requires verification. Never use checker output as an automatic rewrite.

## Initialization approval

After you relay an initialization diagnosis, use the ask-user API of the current harness when it is available. Do not send a plain chat question before you try the available API.

- Codex: use `request_user_input`, with the ID `initialize_references`.
- Claude Code: use `AskUserQuestion`, with the header `Initialize`.

Send one question with the prompt `Run the reported initialization command now?` Use these options:

- `Initialize now (Recommended)`: Download the pinned source and create the generated reference data.

- `Do not initialize`: Leave the generated reference data unchanged and stop the skill workflow.

If the user selects `Initialize now`, run the exact initialization command from the diagnosis. Request command approval separately if the execution environment requires it. If no ask-user API is available, ask the same question through a plain chat message and wait for the answer. Do not mention API availability or the fallback to the user.

## Procedures and descriptions

Write one instruction in each procedural sentence unless actions occur at the same time. Use the imperative form. Put a condition first when the reader must know the condition before the instruction. Do not put instructions in notes.

Give descriptive information gradually. Keep one topic in each sentence and paragraph. Use connecting words to show the logical relation. Use passive voice only when the agent is unknown, unimportant, or obvious.

## Terminology and code

Use consistent technical nouns and technical verbs. Prefer a repository term that is technically correct over a general dictionary replacement. Do not change exact text in code blocks, inline code, URLs, paths, shell options, identifiers, quotations, or diagnostics. Natural-language comments and docstrings must obey the rules around preserved identifiers and code fragments.

## Validation and claims

The lookup and checker validate the local reference bundle before they read it. They never download reference data. Exit status 2 supplies a stable error code, the failed condition, the generated-data path, and the initialization command.

The checker is an aid. It cannot verify meaning, part of speech, every passive construction, or every multi-word noun. A human or assistant semantic review remains necessary.

Use `STE-compliant` only after lexical, mechanical, and semantic review confirms the text against Issue 9. Otherwise, use `STE-aligned` or `checked against the bundled Issue 9 data`.

The `pypdfium2` package is only for local reference initialization. Runtime lookup and checking use Python 3 and the standard library.
