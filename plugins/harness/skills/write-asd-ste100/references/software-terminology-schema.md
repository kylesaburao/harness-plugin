# Software terminology schema

`references/software-terminology.jsonl` is the skill's additive vocabulary layer. Each
nonblank line is one JSON object. Unlike the generated ASD dictionary under
`~/.harness-plugin/write-asd-ste100/bundles/`, this file is hand-edited and version
controlled directly: it is not a pinned download and has no SHA-256 check. It is a
**denylist only** (no `"approved"` entries), flagging words and phrases AI coding
assistants overuse, with the alternative an engineer would write instead. It supplies
software-domain specifics for ASD-STE100 Rule 1.10 and the Rule 1.1 vocabulary principle.

`ste_data.load_software_terms` validates every row; the committed file is checked by
`tests/write-asd-ste100/test_ste_tools.py`.

## Required fields

- `term`: the flagged word or phrase, lowercase.
- `status`: always `"unapproved"`.
- `part_of_speech`: one of `ste_data.VALID_PARTS`. Usually `adv` (most entries are
  discourse connectors or hedges).
- `flagged_sense`: one sentence naming the targeted sense.
- `alternatives`: non-empty array of what an engineer writes instead. Often the removal
  of a framing device, not a word-for-word swap.
- `rationale`: one sentence on why it is flagged.
- `observed`: approximate observation date, `"YYYY-MM"`.
- `models`: array of assistants it was observed in. Keep it honest.
- `attestation`: URL or citation for the claim.

## Optional fields

- `forms`: additional literal forms to flag (for example an uncontracted variant of a
  contraction, or a sentence-initial capitalized form). There is no inflection synthesis
  for this layer: an entry gets exactly the forms listed here plus `term`, nothing derived.
- `rule`: ASD-STE100 rule number to cite. Defaults to `"1.1"`; use `"4.4"` for entries
  that act as unapproved connecting phrases.
- `examples`: array of short before/after strings.

## Two rules the file keeps on itself

1. **A single-word entry is legal only when the word has no common legitimate software
   sense.** `check_file` does case-folded string matching with no part-of-speech tagging,
   so an ambiguous bare word (`wire`, `honest`) cannot be scoped to its overused sense.
   Express it as an unambiguous phrase or leave it out.
2. **No inflection synthesis.** The loader does not call `ste_data.inflections()`, so a
   hypothetical `wire` entry never becomes `wiring`.

`check_file` masks contractions before its phrase pass, so an entry whose natural phrasing
is a contraction (`you're absolutely right`) needs its uncontracted form in `forms` to be
matchable. Within the checker this layer sits between `--terms` (project) and the ASD base
dictionary: `project_terms` > `software_terms` > `asd_ste_terms`. Every match is
`severity: "review"`, category `overused_term`, and never causes a `fail` outcome.

## Example

```json
{"term":"you're absolutely right","status":"unapproved","part_of_speech":"adv","flagged_sense":"reflexive validation opener before a substantive reply, unrelated to whether the prior statement was correct","alternatives":["Confirmed.","Correct — fixing now.","(omit entirely and answer the substance)"],"rationale":"Sycophantic validation reflex documented specifically in AI coding-assistant output.","observed":"2026-08","models":["Claude"],"attestation":"https://crystl.dev/blog/footgun-and-other-things-claude-says/","forms":["you are absolutely right"]}
```
