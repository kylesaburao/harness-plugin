# Software terminology schema

A repository loads this skill's own additive vocabulary layer from
`references/software-terminology.jsonl`. Each nonblank line is one JSON object. Unlike
the generated ASD dictionary in `~/.harness-plugin/write-asd-ste100/bundles/`, this file is hand-edited and version-controlled
directly. It is not a pinned download, and it has no SHA-256 check.

This layer supplies software-domain specifics for ASD-STE100 Rule 1.10 ("Do not use
regional, slang, or jargon words as technical nouns") and the general vocabulary-approval
principle in Rule 1.1. It is not a parallel invented rule system.

## Scope

This file is a **denylist only**. It contains no approved software vocabulary and no
`"approved"` status value. It exists to flag words and phrases that AI coding assistants
reach for disproportionately when writing about code — docstrings, commit messages, PR
summaries, review comments, architecture explanations — with alternatives an engineer
would write instead. See `RESEARCH-LOG.md` for the research behind each entry and the
evaluation results in `evaluation/` for the measured false-positive rate.

## Required fields

- `term`: The flagged word or phrase, lowercase.
- `status`: Always `"unapproved"`. The field exists so a future approved half could be
  added without a schema break, not because one exists today.
- `part_of_speech`: One of `ste_data.VALID_PARTS`. Most entries are `adv`, because most
  entries are discourse connectors or sentence-level hedges, not technical nouns.
- `flagged_sense`: One sentence naming the sense targeted.
- `alternatives`: Non-empty array of what an engineer writes instead in the same
  context. Not a word-for-word swap — usually the removal of a framing device.
- `rationale`: One sentence on why it is flagged.
- `observed`: Approximate observation date, `"YYYY-MM"`.
- `models`: Array of assistants it was observed in. Leave this honest — do not claim
  cross-model observation a source does not support.
- `attestation`: URL or citation for the claim.

## Optional fields

- `forms`: Explicit array of additional literal forms to flag (for example a
  capitalized sentence-initial variant). There is **no inflection synthesis** for this
  layer — see below.
- `rule`: ASD-STE100 rule number to cite. Defaults to `"1.1"` (the general
  vocabulary-approval rule, the same rule the base dictionary's unapproved entries
  cite) when omitted. Use `"4.4"` for entries that function as unapproved connecting
  phrases.
- `examples`: Array of short before/after example strings.

## Two rules this file enforces on itself

1. **A single-word entry is only legal when the word has no common legitimate software
   sense.** Anything ambiguous — `wire`, `honest`, `load-bearing` — must be expressed
   as an unambiguous multi-word phrase, or left out. `check_file` does pure
   case-folded string matching with no part-of-speech tagging, so a bare ambiguous
   word cannot be scoped to only its overused sense. As of the first draft, every
   entry in this file is a phrase; no candidate survived research with a legitimate
   sense to exclude *and* a code-specific overuse attestation *and* an unambiguous
   single-word form. See `RESEARCH-LOG.md` for what was rejected and why.
2. **No inflection synthesis.** `ste_data.inflections()` would turn a hypothetical
   single-word entry like `wire` into `wiring`, a legitimate noun. This layer's loader
   does not call `inflections()`. An entry gets exactly the literal forms listed in
   `forms`, nothing derived.

## Contraction masking

`check_file` masks every contraction out of the text before its phrase-matching pass
runs, so it never double-reports a contraction as both a `contraction` finding and a
vocabulary finding. A consequence: an entry whose canonical `term` contains an
apostrophe contraction (`you're`, `it's`, `here's`, `let's`) can never itself produce
an `overused_term` finding — the contracted span is always caught first, correctly,
as a plain `contraction` error under Rule 4.2, which STE bans outright regardless of
this layer. This is not a bug; a document with a contraction already fails for a more
fundamental reason. It does mean such an entry needs its **uncontracted** phrasing
declared in `forms` — that is the string this layer can actually match, and it is what
a caller sees once they fix the contraction. When adding an entry whose natural
phrasing is a contraction, always include the uncontracted equivalent in `forms`; the
contracted phrasing is fine to keep too, for `ste_lookup` and documentation purposes,
even though `check_file` cannot reach it directly.

## Precedence

Within the checker, this layer sits between the per-project `--terms` layer and the
ASD-STE100 base dictionary: `project_terms` outranks `software_terms`, which outranks
`asd_ste_terms`. A project term protects text this layer would otherwise flag. See
`ste_data.merge_layers`.

## Severity

Every match against this file is `severity: "review"`, category `overused_term`. It
never contributes to a `fail` outcome, per the base rule that legitimate-but-overused
software vocabulary must never be treated as a hard error — see hard problem #1 in the
planning history for this feature.

## Example

```json
{"term":"you're absolutely right","status":"unapproved","part_of_speech":"adv","flagged_sense":"reflexive validation opener before a substantive reply, unrelated to whether the prior statement was correct","alternatives":["Confirmed.","Correct — fixing now.","(omit entirely and answer the substance)"],"rationale":"Sycophantic validation reflex documented specifically in AI coding-assistant output; a human reviewer's occasional \"you're right\" is not the same tic as an assistant's reflexive, unearned, every-time opener.","observed":"2026-08","models":["Claude"],"attestation":"https://crystl.dev/blog/footgun-and-other-things-claude-says/"}
```

## Governance

- Entries land only by PR with a filled `rationale` and `attestation`.
- A schema test validates every row in the committed file (see
  `tests/test_ste_tools.py`); this is the CI gate, not a separate validator script.
- Re-run the Phase 1 research method (see `RESEARCH-LOG.md`) on a new model
  generation, or when a maintainer observes drift — new tics appearing, listed
  entries no longer firing.
- Human review of a proposed batch of entries is tracked in `REVIEW.md` before merge.

Do not use this file to approve general prose words, and do not add entries whose only
support is an assistant's introspective claim about its own writing. Every entry needs
an external source that names a context.
