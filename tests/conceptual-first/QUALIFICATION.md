# Conceptual-first qualification

This record covers checks actually performed for the `conceptual-first` skill and its activation component. The [evaluation protocol](EVALUATION.md) defines the full set of intended checks. Package-preparation results supplied with the integration bundle are not repository evidence and are not repeated here.

## Integration candidate (2026-09-30)

- Baseline: HEAD `7179c53ed83fbeb82d30441547e1f1ca3e9fcffb` plus the uncommitted conceptual-first integration. Host: macOS, Node.js 26.9.0.
- The skill is instruction-only: one `SKILL.md`, no scripts, references, or assets. Source SHA-256: `76c73946cba4e813d7c4b93d6bfa8c39a8b844a59518f55e14a206562fad12eb`. This matches the supplied payload and the built `.build/harness/skills/conceptual-first/SKILL.md`.

## Source and package checks

| Check | Command | Result |
| --- | --- | --- |
| Development build | `npm run build`, `npm run build:check`, `npm run validate:build` | **Passed.** Validation covered 88 files. |
| Inventory, links, bundled-path authority, Advisor template positions | `node --test tests/inventory/*.test.js tests/harness-advisor/policy.test.js` | **Passed.** 18 of 18 tests. |
| External links in new content | `grep -rnE 'https?://'` over the new skill, the evaluation protocol, and the added diff lines | **Passed.** No matches. |
| Whitespace | `git diff --check` | **Passed.** |
| Protected publication files | `git status --short -- dist src/harness/package.json` | **Passed.** No changes. |

## Full gate

The candidate was the integration before the post-review wording change to two installer sentences. Afterward, only the development build checks and the inventory and policy tests were rerun.

`npm run test:setup` followed by `npm test`, on native macOS.

- **Result: failed.** 798 passed, 6 failed, 1 skipped.
- All 6 failures are in `tests/harness-advisor/claude-adapter.test.js`. This change does not modify that file or the adapter.
- **Cause.** The tests compare paths built from `TMPDIR=/var/folders/...` with realpaths under `/private/var/folders/...`.
- **Confirmation.** The same file fails the same 6 of 41 tests on a clean baseline worktree. It passes 41 of 41 when `TMPDIR` is set to its resolved path.
- **Status.** This is a pre-existing environment-sensitivity issue in that test, not a regression from this change. Every other suite passed, including inventory (8 of 8).

## Follow-up gate (2026-09-30)

- **Candidate.** Release `59d3085` (3.1.18) plus these follow-up changes:
  - `tests/harness-advisor/claude-adapter.test.js` now resolves its fixture root with `fs.realpathSync`, fixing the 6 failures above.
  - Whitespace-only rewraps of the installer's step 7 and the Advisor guide.
  - The `AGENTS.md` conceptual-first paragraph unwrapped.
  - Corrections to the installer qualification record.
- **Commands.** `npm run build`, `npm run build:check`, `npm run validate:build`, `npm run test:setup`, then `npm test`, on native macOS with the default `TMPDIR` (`/var/folders/...`).
- **Result: passed.** 804 passed, 0 failed, 1 skipped (the existing `distribution` skip). `harness-advisor` passed 60 of 60.

## Live loading and installer behavior

Claude Code 2.1.286 loaded the candidate with `harness:conceptual-first` among 15 skills. The installer component passed fresh-install, repeat no-op, missing-skill block, and Advisor-only scope runs. Evidence and limits are in the [installer qualification](../install-harness-plugin-capabilities/QUALIFICATION.md#conceptual-first-component-claude-live-qualification-2026-09-30).

## Not run

- Codex live discovery, loading, and installer runs.
- The activation comparison: ordinary discovery versus the user-level trigger, with prompts that do not name the skill.
- The behavioral content trials and scenarios in the evaluation protocol, with and without the policy loaded.
- Installer cases for ambiguous markers, duplicate owned blocks, imported instructions, two selected hosts, and default target resolution.

No claim of policy adherence or improved implementation behavior is made.
