# Conceptual-first evaluation protocol

## Purpose and evidence boundary

Evaluate three separate questions: whether the skill is packaged correctly, whether the intended host loads it under the proposed activation rule, and whether its presence improves actual implementation behavior. Passing one layer does not establish another. This file defines future checks; it does not report completed experiments.

The policy is technology-neutral. Choose representative fixtures from the repository's real work or small disposable projects. Concrete technologies may be used to execute a fixture, but they do not become requirements of the skill. Avoid evaluating only repetition that obviously calls for extraction; include cases that require preserving independent implementations.

## Candidate and setup

Record the repository commit and any relevant uncommitted candidate changes, the skill's content hash, and the built artifact tested. Use repository development/testing guidance to create a fresh installation-shaped development candidate. Keep fixtures, evidence, and test-only helpers outside the shipped skill tree.

For each live run, record the host version, model and relevant settings, available tools and permissions, fixture identity, starting instructions, prompt, actual skill-loading evidence, resulting changes, verification results, and observed limits. Use a host-supported explicitly selected candidate or isolated installation. Do not edit personal instructions, change personal plugin registrations, copy credentials, or bypass denied permissions as an incidental qualification step. When a live trial is unavailable, mark it blocked or not run and give the prerequisite; do not infer success from a file read in another host.

## Packaging checks

Confirm one shared skill entrypoint with matching directory/frontmatter name and portable metadata, and that the selected artifact includes the intended source bytes. Check README inventory agreement and local documentation links using the existing repository tests. Confirm no runtime package, bundled script, persistent-state requirement, or external reference dependency was introduced.

Do not freeze the skill's prose, paragraph order, or number of headings in tests. Add deterministic assertions only for an uncovered stable packaging or activation-identity contract. A keyword test cannot establish semantic policy adherence.

## Installer qualification

Use the revised installer against disposable effective instruction files. Capture before/after bytes and, where supported, modes and modification times. Distinguish fixture-level file-edit evidence from live discovery and default target-resolution evidence.

| Case | Observable requirement |
| --- | --- |
| Fresh selected host | One active conceptual-first block, with other authorized components handled independently. |
| Effective override or custom host directory | Reuse the existing resolver; edit only the actual effective file and preserve the shadowed file. Invalid relative overrides remain blockers. |
| Repeat invocation | No writes when inputs and integration already match. |
| Missing or clearly stale owned block | Insert or update only the known component. |
| Clearly owned duplicate active blocks | Retain one canonical block without deleting unrelated content. |
| Fenced/quoted examples and lookalike headings | Preserve them; do not count them as active integration or edit boundaries. |
| Ambiguous, partial, or customized markers | Preserve uncertain content and report the ambiguity; do not add a competing trigger. |
| Absent, denied, stale, or unverifiable skill load | No new or replacement activation block; preserve prior integration and handle other eligible components independently. |
| Two selected hosts, evidence for only one | Do not infer cross-host success; report per-host outcomes. |
| Host-recognized imported instructions | Do not duplicate correct active imported guidance. Block repair when it needs an off-limits imported file. Ordinary links are not assumed to be imports. |
| Explicitly narrow component request or exclusion | Do not install conceptual-first outside the selected scope. |
| Advisor-specific conditions | Conceptual-first remains independent of Advisor availability and routing. |

Use current host-provided discovery and actual CLI help when needed. Do not guess installed paths or invoke a remembered command form. Preserve historical qualification records; append new evidence with its own candidate and scope.

## Content and activation comparisons

For content trials, compare equivalent fresh fixtures without the policy and with the candidate explicitly loaded. This tests the effect of the instructions when present.

For activation trials, compare ordinary plugin discovery against the proposed user-level trigger using task prompts that do not name the skill. Keep model, settings, permissions, and other instructions matched. This tests whether the trigger loads the intended policy before dependent implementation. A control fixture must not accidentally load this repository's contributor rule or inherit the trigger under test.

Use several independent fresh runs for important cases before describing reliability. Bound trials to the authorized tools and budget; report the number attempted, completed, blocked, and not run. Missing usage or latency data is unknown, not zero. One successful run establishes a possibility, not a general compliance rate.

## Behavioral scenarios

| Scenario | Expected behavior and failure to detect |
| --- | --- |
| Shared invariant at independent entry points | Reuse or narrowly establish one policy; retain each entry point's required enforcement and adaptation. Detect duplicated policies or missing checks. |
| Related outputs with stable common structure | Establish shared ownership and genuine variation. Detect full independently maintained copies or inappropriate global coupling. |
| Common stage in different workflows | Share only the stable mechanism when appropriate. Detect a generic framework that forces unrelated lifecycles together. |
| Repeated multi-step verification | Preserve explicit scenarios, independent expected outcomes, and useful diagnostics. Detect observations mutated by the tested operation. |
| Similar syntax, unrelated meaning | Retain deliberate separation. Detect abstractions justified only by matching statements. |
| Existing but unsuitable helper | Inspect its contract and avoid extending the mismatch through unrelated flags or caller-name branches. |
| Genuinely local correction | Make the bounded change without an architecture exercise, extra persistent artifact, or speculative extraction. |
| Tiny edit to a shared invariant or default | Recognize structural risk despite a short diff; inspect affected consumers. |
| Planning-only or review-only request | Keep authorized outputs and side effects distinct; do not execute implementation just because steps appear in a plan. |
| Existing plan or verbatim plan export | Reuse valid decisions and verify delivery without restarting design. |
| Dependency direction and isolated state | Preserve appropriately owned contracts and required state lifetimes; detect concrete-consumer coupling or new global mutable instances. |
| Repetition discovered during implementation | Reconsider the affected slice before further expansion without an unrestricted cleanup. |
| Generated representation | Change the authoritative generator or template under repository conventions, not generated copies. |
| Delegated related work | Convey shared decisions and edit ownership; detect competing helpers or uncoordinated shared edits. |

For each case inspect actual actions, functional behavior, resulting ownership, change scope, and verification evidence. Naming a helper, producing fewer lines, or writing a checkpoint is not sufficient. Where practical, evaluate artifacts without revealing their condition to the reviewer, and explain judgments through concrete consequences rather than arbitrary design scores.

## Skill interactions

Exercise the conceptual policy alongside implementation-planning guidance, including an established handoff choice where the fixture needs one. Two loaded skills should produce one coherent task, not duplicate planning, forced decision logs, or an automatic continuation file. The policy must not force Advisor invocation, create a new agent, or give a tool-free reviewer access it does not have.

## Reporting

Create or update `tests/conceptual-first/QUALIFICATION.md` only to record actual work and its result, including an actual blocked attempt. Separate source inspection, static/package checks, live loading, installer fixture edits, behavioral trials, and full repository tests. Record the exact candidate, scope, meaningful observations, unexpected behavior, and remaining checks. Preserve failed and blocked outcomes rather than presenting only successful trials. Do not pre-populate a qualification record with promised passes.
