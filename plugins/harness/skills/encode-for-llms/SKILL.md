---
name: encode-for-llms
description: Use when prose, technical material, code, or mixed content must become a maximally compact representation decodable by another LLM without prior context. Do not use for human-facing summaries, encryption, or verbatim recovery.
---

# Encode for LLMs

Emit the shortest standalone one-line semantic algebra from which an LLM can reconstruct equivalent meaning or behavior. Minimize target-model tokens, then Unicode code points. Ignore readability.

## Equivalence

Preserve only distinctions required for equivalence:

- General language: necessary propositions, participants, events, reference, scope, logic, causality, time, modality, uncertainty, and discourse function.
- Technical material: mechanisms, quantities, units, relations, constraints, transitions, data/control flow, and limitations.
- Code: observable behavioral equivalence, including inputs, outputs, errors, effects, order, state, concurrency, persistence, protocols, and behaviorally relevant complexity.

Wording, formatting, language, attribution, citations, proper names, identifiers, syntax, and implementation structure may change or disappear. Alpha-rename entities, APIs, variables, organizations, and types if relationships remain recoverable. Translate code into any capable language or algebra.

## Algebra

Emit no JSON, XML, fields, prose instructions, schema labels, Markdown, or decoding boilerplate. Encode directly in the densest inferable notation.

Prefer conventional symbols: `≔` definition, `→` transition, `⇒` consequence, `∧` conjunction, `∨` alternative, `¬` negation, `∀`/`∃` quantification, `∈` membership, `≈` approximation, `↑`/`↓` change, `∥` concurrency, grouping, ranges, tuples, subscripts, and superscripts. This is not a fixed grammar.

Any Unicode, natural/programming language, mathematics, or invented mixture is valid when inferable and smaller. Add a micro-legend only when necessary and cheaper than repetition. Factor shared subjects, units, scopes, conditions, and relations. Nest, alias, elide grammar, and fuse repetition when smaller. Aliases must amortize.

## Procedure

1. Atomize the source into semantic relations and behavioral obligations.
2. Remove rhetoric, redundancy, presentation, replaceable names, and implementation accidents.
3. Form three faithful candidates: Unicode algebra, ASCII algebra, and maximally compressed natural language.
4. Choose the fewest target-model tokens. Break ties by Unicode code points, then context-free inferability.
5. Reconstruct from only the candidate. Restore losses that change meaning or behavior, then remove tokens whose loss does not.
6. Emit only the encoding on one physical line, without fence, explanation, status, preamble, or newline.

## Example

Source: TypeScript 7 is a Go-native compiler with shared-memory parallel parsing, checking, and emitting. Builds are 7.7 to 11.9 times faster, RAM falls 6 to 26 percent, VS Code's first error improves from 17.5 seconds to under 1.3 seconds, language-server failures fall over 80 percent and crashes over 60 percent, Slack type-checking improves from 7.5 to 1.25 minutes and queue time falls 40 percent, Microsoft News saves about 400 waiting hours monthly, and the unstable API keeps compiler-embedding tools on TypeScript 6.

Output: `TS7≔Go+shm∥{parse,check,emit}⇒build×[7.7,11.9]∧RAM↓[6,26]%∧VS.err₁:17.5→<1.3s∧LS₆→₇{fail↓>80%,crash↓>60%}∧Slack{check:7.5→1.25m,Q↓40%}∧MSNews{wait↓≈400h/mo}∧¬APIstable⇒embedTools→TS6`

## Final Gate

Pass only if an LLM with no prior context can recover equivalent meaning or behavior, no unnecessary token remains, and output is one physical line.
