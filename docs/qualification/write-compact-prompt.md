# Write-compact-prompt qualification

This record covers checks actually performed for the `write-compact-prompt` skill. The [evaluation protocol](../../tests/write-compact-prompt/EVALUATION.md) defines the full set of intended checks.

## Integration candidate (2026-10-23)

- Baseline: HEAD `ee5b58c` plus the uncommitted `write-compact-prompt` integration. Host: macOS, Node.js 26.9.0, Claude Code 2.1.309.
- The skill is instruction-only: `SKILL.md` and `agents/openai.yaml`, with no scripts, references, or assets. Source SHA-256: `eebc197837245be2f46dda19cb1804906e0912e354644563cec9eae9330f5896`. This matches the built `.build/harness/skills/write-compact-prompt/SKILL.md`.

## Source and package checks

| Check | Command | Result |
| --- | --- | --- |
| Development build | `npm run build`, `npm run build:check`, `npm run validate:build` | **Passed.** Validation covered 98 files. |
| Inventory, frontmatter, links | `node --test tests/inventory/*.test.js` | **Passed.** 41 of 41 tests, run after `npm run test:setup` with this record present. |
| Full gate | `npm run test:setup`, then `npm test`, on native macOS | **Passed.** 916 passed, 0 failed, 1 skipped. |

## Live cases

`claude --help` on 2.1.309 lists `--plugin-dir <path>` and `--settings <file-or-json>`, so the candidate and temporary PreCompact and PostCompact capture hooks can be loaded for one session without editing personal settings. The installed `harness` plugin has the same name as the candidate. Only the candidate contains `write-compact-prompt`, so the candidate loaded if that skill appears in the session's skill list. If it does not appear, the live cases are blocked, not failed.

| Case | Result |
| --- | --- |
| All live cases in the evaluation protocol | **Not run.** Each needs the user to paste or run `/compact`. |
