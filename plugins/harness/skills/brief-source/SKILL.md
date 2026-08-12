---
name: brief-source
description: Read a long source such as a paper, spec, RFC, thread, changelog, or transcript, and produce a brief that separates what the source claims from what it establishes, names the source's authority and currency, and states what it leaves unanswered. Use when handed a link or a file to read and summarize, when comparing several sources on one question, or when deciding whether a source is worth reading in full. Do not use for summarizing this repository's own code, for a source already read in full during the current conversation, or when what's needed is a single fact the source states directly.
---

# Brief a source

The point of a brief is to separate what the source says from what it proves, so the reader doesn't inherit an overstated claim by accident. Read [references/source-evaluation.md](references/source-evaluation.md) for the evaluation criteria this skill is built on before writing the brief.

## What the brief covers

1. **The source's own claim.** What it asserts, in its own terms, without upgrading a hedge into a fact or a proposal into a decision.
2. **The evidence it actually supplies.** Does the source show its work - data, a reproduction, a cited primary source - or does it assert without support? A confident tone is not evidence.
3. **Authority and currency.** Is this source entitled to settle the question it's answering (an official spec, a maintainer's design doc, a standards body) or is it secondary or informal (a forum thread, a blog post, an unofficial summary)? Is it current, or does it describe an earlier state of the thing it's about - check version numbers, dates, and any note of supersession.
4. **What it does not establish.** The most useful line in the brief is often this one: what the source leaves open, what it assumes without justifying, what question a reader might think it answered but didn't.
5. **Read-in-full recommendation.** Say plainly whether the brief is sufficient or whether the underlying source needs a full read for the reader's actual purpose.

Omit a section only when it's genuinely empty, not to shorten the brief artificially.

## Comparing multiple sources

When briefing several sources on the same question, do not just summarize each one in sequence. State where they agree, where they conflict, and if they conflict, whether that's because they describe different points in time or genuinely different positions - see "Reconciling multiple sources" in [references/source-evaluation.md](references/source-evaluation.md) for how to tell those apart.

## What this is not

This produces a brief on one or a few sources already in hand. It does not decide whether an approach has precedent, does not search broadly across an organization's history, and does not reach a verdict on a technical direction - that broader research is a separate skill (`research-precedent`) when it's installed.
