# TypeScript migration handoff

## Current status

Implementation and final local qualification are complete. Stage7 is ready to commit. Cleanup, final committed-checkout verification, and the authorized push remain. No test or Advisor jobs are running. Keep this file current after delivery checkpoints.

Repository: `/Users/kyle/Documents/harness-plugin`, branch `main`.
Starting revision: `233fd2792ef598464152a52b7e96e110eacde70f`.
Current committed revision: `bcadf5f50fc9e37a1ac38a2ad7c29e9542eb9e05` (Stage6).

## Durable authority

- Read current `AGENTS.md` and `tests/distribution/IMPLEMENTATION_RECEIPT.md`. The receipt contains the complete stage history, executed commands, failures, qualification limits, and final section14 acceptance audit.
- The full user specification is the preserved local `tmp/TS_MIGRATION_PROMPT.md`. It is existing task authority, not disposable scratch. Earlier handoff chronology is retained in `tmp/TS_MIGRATION_HANDOFF_HISTORY.md`, with obsolete instructions superseded by this file.
- Read `docs/development/build.md`, `testing.md`, `dependencies.md`, and `container.md` before related development work, and `versioning.md` before commits.
- Latest user instructions require continual HANDOFF updates, clear source-to-dist procedure in README and AGENTS (implemented), cleanup of local repository state, and push when done. Push is explicitly authorized and supersedes earlier local-only instructions.

## Architecture

`src/harness/` is the complete editable plugin. First-party Node implementation is TypeScript. `dist/harness/` is generated and Git-tracked, with87 files. Both marketplaces install `./dist/harness` directly. Old `plugins/harness` and transitional JavaScript allowances are gone. Root development scripts/tests remain JavaScript. Python/Swift resources retain their languages and original bytes.

The locked root toolchain is TypeScript7.0.2 and @types/node20.19.43, with Node26 development. Strict NodeNext/ES2022 preserves CommonJS `.js` and sampler native ESM `.mjs`. The canonical plugin version remains3.1.5 in `src/harness/package.json`, injected into versionless source host-manifest templates. Backup retains its separate1.0.0 package.

Explicit `npm run build` assembles a unique stage and reconciles generated files in place, preserving exact runtime/cache overlays and mounted ancestors. It is not a whole-directory atomic transaction. Check mode never repairs output. Setup, runtime tests, and hosts require an existing distribution. Commit source and regenerated output together. Release automation explicitly bumps, builds, and tests fresh source on every push retry.

## Final verification

- Final native full gate:658 passed,0 failed,0 skipped. Final Docker full gate:598 passed,0 failed,60 platform skips. No groups excluded. Logs `tmp/ts-stage7-{host,container}-{setup,gate}.log`. All handles terminal0.
- Typecheck, build check, tracked distribution validation87 files, and whitespace check passed after final implementation/documentation edits.
- Stage runtime floors: actual Node20.6 frame/shared145 passed and native synthetic preparation, Node22 GIF123 passed plus sampler/Advisor direct qualification, Node22.12 isolated backup with real ZIP replication, Node26 wake/full gate. The modern sampler fault injector remains Node26-only, distinct from direct Node22 qualification.
- Actual Codex0.154.0 and Claude2.1.270 installation/discovery from a fresh committed clone without npm/build passed for all13 skills. Claude reports all3 styles. Native frame preparation ran from Codex's exact installed path. No inference requests or real user configuration changes.
- Separate release-clone rehearsal passed pre/post-bump partial gates535/0/0 with GIF explicitly excluded, matching3.1.6 host manifests, unchanged backup1.0.0, and final build check. Main remains3.1.5. This is not hosted CI evidence.
- Exact macOS26 execution remains an unavailable release qualification. The available native host tested is macOS27. Preserve this limit in delivery.
- Final Advisor: no concrete defect in supplied evidence, no independent source inspection. All3 automatic consultations are spent, user_requested_calls0, same_family_automatic_calls3. All agents terminal. No more automatic calls.

## Finish delivery

1. Stage only the final scoped changes, including this handoff and receipt. Inspect staged inventory, run build check and tracked validation again, and commit with both author/committer dates `1999-12-31T23:59:00-08:00`.
2. Verify fresh final committed output matches the already host-qualified distribution and passes static tracked validation without a root toolchain.
3. Preserve specification and raw local logs, remove task-created disposable host/release fixture roots and transformation scratch. Preserve unrelated branches, worktrees, dependencies, and user files. Do not run broad git clean/reset.
4. Update this handoff with exact finishing revision and cleanup results, commit it, then push main. Remote was fetched and had no commits ahead of local main. Recheck before push as needed.
5. Observe push and existing automated version-bump workflow honestly. If it completes, fetch/fast-forward its commit and verify artifact. Do not label a local rehearsal as hosted success.

Host fixture paths before cleanup are recorded in `tmp/ts-stage7-host-paths.json`, rooted at `/private/tmp/harness-ts-stage7-t7o54xnn`. Raw evidence remains under ignored local `tmp/` and is summarized in the tracked receipt. Git mutations require sandbox escalation because `.git` is protected. Native HEIC requires host access. No approval rejection remains outstanding.
