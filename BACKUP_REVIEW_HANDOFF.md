# Backup utility review handoff

## Purpose

This document records the verified correctness, security, consistency, performance, dependency, and simplification findings for `src/backup/backup.js` and turns them into an implementation plan. It contains the evidence needed to understand each finding without relying on a separate review. The work should preserve the utility's existing safety model: canonical directory paths, device/inode identity checks, exclusive UUID-named temporary files, atomic installation by rename, explicit confirmation, singleton locking, interruption cleanup, and rejection of output or target directories inside the source tree.

The current baseline is healthy but incomplete. On August 7, 2026, using Node.js 26.5.0 and npm 11.17.0, `node --check src/backup/backup.js` passed, all 43 tests passed, and backup-specific coverage was 93.46% of lines, 86.94% of branches, and 87.80% of functions. These results are regression protection, not proof that the edge cases below are handled.

## Verification decisions and method

The findings were checked against the current worktree with source and test inspection, focused temporary-directory probes, controlled synthetic benchmarks, the full test suite, the backup coverage run, the live dependency audit, and `git diff --check`. No full user backup or cloud hydration run was performed, and no tracked repository file was changed during verification.

The following corrections and qualifications are decisions based on that verification:

1. **Coverage correction:** use 93.46% line coverage and 86.94% branch coverage for this snapshot. The previously recorded 93.23% and 86.59% values were replaced because the current coverage command produced the newer figures. The test count remains 43 of 43 passing.
2. **Dependency clarification:** `npm audit --omit=dev` reports seven propagated high-severity vulnerable package records beneath `archiver`, but these records represent two underlying `brace-expansion` advisories. The installed CLI traversal does not supply the pattern options needed to reach brace expansion through `archive.directory(sourceDirectory, false)`.
3. **Compression evidence qualification:** controlled benchmarks confirm that level 9 can cost substantially more CPU for a small size improvement, but they are not representative enough to select a production compression policy on evidence alone. The user decision recorded below selects level 6.
4. **Stream refactor remains a candidate:** the missing race coverage and lifecycle complexity are verified. Refactoring around `node:stream/promises.pipeline` is a proposal, not a verified improvement, until it is implemented behind the required tests.

## Resolved user decisions

The following product and policy decisions are authoritative for this implementation plan:

1. **Trust model:** this is a personal utility for one user. It will remain a same-user interactive CLI with trusted configuration, environment variables, directories, and directory ownership. Privileged, uploaded-configuration, and cross-user operation are out of scope.
2. **Source consistency:** document that the utility archives a live source and does not guarantee a consistent point-in-time view. Do not add a file watcher. Callers must stop applications, quiesce mutable data, or provide a filesystem or application snapshot when consistency matters.
3. **Compression:** use ZIP DEFLATE level 6. Do not add a compression configuration option.
4. **Permissions:** every newly installed or replacement archive and target copy must have POSIX mode `0600`.
5. **Cancellation:** preserve output-directory creation during preflight. Correct the cancellation message instead of deferring directory creation.
6. **Dependencies:** the utility may ship with the currently reported transitive findings because the affected brace-expansion path is not reachable through this CLI flow. Keep the findings documented and monitored.
7. **Supported storage:** performance work must cover reads from and writes to local SSD, external disk, and Google Drive, all from the same Mac. Network storage and cross-machine operation are out of scope.

## Scope and assumptions

The utility is a personal, same-user interactive CLI running on macOS. Configuration files and environment variables are trusted. Configured directories and their parent directories must not be writable or renameable by less-trusted users. Coordination across different operating-system users or machines is outside the supported locking model.

The implementation does not provide filesystem snapshots or source-mutation detection. Callers must quiesce mutable data or point the utility at a snapshot when a consistent point-in-time archive is required.

Do not remove `acquireDirectoryLocks` during this work. It is deprecated and unused internally, but it remains part of the exported package surface, so removal requires an explicit compatibility decision.

## Delivery sequence

### Phase 1: close correctness and confidentiality gaps

This phase is release-blocking because it addresses misleading signal handling and the permissions assigned to backup data.

#### 1. Create archive and copy files with explicit private permissions

Locations: `createArchive` near line 575 and `copyAtomically` near line 664.

Both write streams currently use `flags: 'wx'` without a `mode`. Under the current `022` umask, a direct probe produced mode `0644`. This can make retained archives or target copies readable by other local users, and a rename can replace a previously restrictive destination with the temporary file's broader mode.

Verification status: **confirmed**. A POSIX probe produced `0644` for both a staging archive and a copied archive and `0755` for a recursively created output directory. A replacement probe began with retained and target destinations at `0600`; after atomic installation, both replacements were `0644`. Existing tests cover creation and overwrite behavior but contain no mode assertions.

Implementation plan:

1. Pass `mode: 0o600` to both production `createWriteStream` calls.
2. Pass `mode: 0o700` when recursively creating a missing output directory. Existing directories must not have their permissions silently changed.
3. Document the user decision that replacing an existing backup also replaces its mode with `0600`.
4. Preserve `wx`; it prevents a pre-existing file or symlink from being opened as the temporary artifact.

Acceptance criteria:

- A newly created staging archive has mode `0600` on POSIX.
- A newly created target copy has mode `0600` on POSIX.
- Overwriting an existing destination leaves the new archive at mode `0600`.
- A newly created output directory is private on POSIX, while an existing output directory's mode is unchanged.
- Tests skip or adapt mode assertions on platforms without POSIX permission semantics.

#### 2. Make interruption authoritative through final installation

Locations: `copyAtomically` near lines 666 to 668, the retained archive path near lines 690 to 694, and successful completion reporting near line 821.

A signal can arrive while the final directory identity check is awaiting. The existing check then completes and the code performs `rename` without observing the recorded interruption. The retained archive path has the same gap. This can overwrite a destination after `SIGINT` or `SIGTERM` and can subsequently print a successful completion message.

Verification status: **confirmed**. Deterministic probes delayed the final `fsp.stat`, recorded an interruption while that await was pending, and then released the validation. `copyAtomically` resolved and replaced the old destination after `SIGINT`; the retained-archive path resolved and replaced the old archive after `SIGTERM`. A third probe interrupted during delayed staging removal after the last copy, and `execute` still resolved successfully. Because `main` does not check interruption between `await execute(...)` and the success heading, that state can be reported as `Backup complete` with exit code zero.

Implementation plan:

1. Call `context.throwIfInterrupted()` immediately after the final `assertDirectoryUnchanged` and immediately before each final `rename`.
2. Add a final interruption check after execution and cleanup-sensitive awaits, before printing `Backup complete`.
3. Review staging removal behavior when interruption arrives after the last copy. The command should report interruption even if cleanup succeeds.
4. Keep rename windows as short as possible. Portable Node APIs cannot make the interruption check and rename one indivisible operation, but the known await-sized gaps should be removed.

Acceptance criteria:

- An interruption during the last target validation prevents destination replacement.
- An interruption during the retained-archive validation prevents archive replacement.
- An interruption after stream completion but before success reporting produces the signal-specific exit code, not exit code zero.
- Temporary artifacts and the run lock are still cleaned up.
- No success heading is printed after an observed interruption.

Suggested tests should inject a delayed final validation, trigger `context.interrupt()`, then release the validation and assert that the old destination remains unchanged.

#### 3. Handle unknown directory-entry types during startup cleanup

Location: `cleanupStartupArtifacts` near lines 554 to 564.

Startup cleanup currently selects only entries for which `Dirent.isFile()` is true. Some filesystems return unknown directory types, so owned `.backup-archive-<uuid>.tmp` and `.backup-copy-<uuid>.tmp` files can be left behind indefinitely. `measureDirectoryStorage` already contains an `lstat` fallback for this situation.

Verification status: **confirmed**. A probe represented a matching regular temporary file with an all-false, unknown-type Dirent. `cleanupStartupArtifacts` completed successfully and left the file in place. The existing cleanup test covers normal file Dirents and strict UUID matching; unknown Dirents are tested only for `measureDirectoryStorage`.

Implementation plan:

1. Reuse or extract the unknown-dirent classification logic.
2. For an unknown type, call `lstat` and delete only a regular file whose basename matches `TEMPORARY_FILE_PATTERN`.
3. Continue ignoring symlinks, directories, sockets, devices, and broader lookalike names.
4. Preserve non-recursive removal.

Acceptance criteria:

- A matching regular file represented by an unknown Dirent is removed.
- A matching symlink or directory represented by an unknown Dirent is not removed.
- Existing strict UUID-pattern tests continue to pass.

#### 4. Correct the cancellation message

Locations: missing-output creation near lines 128 to 151 and cancellation reporting near lines 787 to 789.

Preflight can create the configured output directory and missing parents before confirmation, so the current cancellation claim that no files were changed is not always true.

Verification status: **confirmed**. A CLI probe used an initially missing nested output directory and answered no at the prompt. The command exited zero, left the new output path present, and printed `CANCELLED — No files were changed.` The existing cancellation test starts with an output directory that already exists, so it does not exercise the contradiction. `src/backup/BACKUP.md` already describes the preflight side effect accurately; the CLI message and its regression coverage are the remaining defects.

User decision: preserve output-directory creation during preflight. Change the cancellation message to state that no archive or replicated copy was created and, when preflight created the output path, identify that side effect explicitly. Do not defer directory creation until after confirmation.

Acceptance criteria:

- Cancellation after preflight never claims that no filesystem changes occurred when directories were created.
- Cancellation with pre-existing directories remains concise.
- A CLI test covers cancellation with an initially missing output directory.

### Phase 2: document consistency and trust boundaries

This phase makes the actual consistency and security model explicit without adding complex watcher behavior or implying snapshot-grade guarantees.

#### 5. Document live-source consistency limitations

Archiver traverses and lazily opens source entries by pathname. Directory identity checks detect replacement of the configured source directory at their checkpoints, but they do not detect in-place file mutation. A file can be modified or truncated while it is being streamed, producing a valid ZIP with a mixed point-in-time view.

Verification status: **confirmed**. Installed Archiver 7.0.1 enumerates entries by absolute pathname and creates lazy read streams that open those paths later. A controlled probe mutated a later source file after an earlier entry completed. The resulting valid ZIP contained the changed content even though the configured source directory's device and inode identity remained unchanged. The current backup documentation contains no snapshot, quiescence, or live-source consistency warning.

User decision: resolve this risk through explicit documentation. Do not add a file watcher or claim that the utility detects source mutations.

Implementation plan:

1. Update `src/backup/BACKUP.md` to state that Archiver traverses and lazily opens live source entries by pathname.
2. State that directory identity checks detect configured-directory replacement only at their checkpoints and do not detect in-place file mutation.
3. State that a successful ZIP can contain a mixed point-in-time view when source content changes during archive creation.
4. Tell callers to stop applications, quiesce mutable data, or provide a filesystem or application snapshot when consistency matters.
5. Do not add source-watcher code, configuration, platform-specific behavior, or tests.

Acceptance criteria:

- Documentation explicitly says that the utility does not provide snapshots or source-mutation detection.
- Documentation explains the possible mixed point-in-time ZIP result.
- Documentation gives actionable quiescing and snapshot guidance.
- No file-watcher dependency, code path, configuration, or platform-specific promise is introduced.

#### 6. Preserve and clarify the trusted-directory requirement

Path-based filesystem operations retain unavoidable check-to-use windows. A less-trusted principal who can rename configured directories, replace source entries, or write into shared output locations can redirect reads, substitute replication input, or race cleanup. The existing documentation already requires configured directories and parents not to be writable by untrusted users.

Verification status: **confirmed**. The implementation checks identities at discrete checkpoints and then performs pathname-based `readdir`, `rm`, stream-open, and `rename` operations. Tests prove that a replaced configured symlink is rejected when checked, but they do not eliminate races between a check and a later pathname use. The same-user singleton-lock scope and trusted-directory requirement in `src/backup/BACKUP.md` match the implementation.

Keep that requirement prominent. If the utility is ever used as a privileged service, accepts uploaded configuration, or crosses user boundaries, it needs a separate threat-model project with allowed-root enforcement, ownership and permission validation, descriptor-relative operations, and stronger artifact ownership tracking. That expansion is not part of this same-user CLI plan.

User decision: the utility is for one user with trusted inputs and directories. Do not expand this implementation into privileged, uploaded-configuration, cross-user, or cross-machine operation.

### Phase 3: improve performance with measurements

Performance changes should follow Phases 1 and 2 so optimization does not complicate unresolved safety or consistency behavior. The supported benchmark matrix is reading from and writing to local SSD, external disk, and Google Drive on the same Mac. Exercise every practical source and target pairing among those storage types. Network storage and cross-machine copies are out of scope. Separate cold cloud hydration from cached performance and record whether Google Drive upload completion occurs after the CLI returns.

#### 7. Set ZIP DEFLATE level 6

Location: `createArchive` near line 589.

Level 9 increases the CPU cost of the utility's single DEFLATE stream and can provide only a small size reduction over zlib's default level 6. The user selected level 6 and does not require a configurable compression policy.

Verification status: **performance tradeoff partially confirmed; policy resolved by user decision**. On a controlled 128 MiB repository-text-derived corpus, two runs at each level gave these means: level 6 used 1,217.5 ms wall time and 1,314.5 ms CPU time for a 28,585,548-byte archive; level 9 used 1,956.2 ms wall time and 2,035.1 ms CPU time for a 28,482,810-byte archive. In that workload, level 9 was 60.7% slower by wall time and 54.8% more CPU-intensive for a 102,738-byte, or 0.359%, size reduction. A separate 64 MiB half-repeated-JSONL and half-random corpus produced identical archive sizes and no meaningful level-9 slowdown. The user selected level 6 despite the workload sensitivity, so representative benchmarks measure impact rather than decide the policy.

Implementation plan:

1. Change the Archiver ZIP option from DEFLATE level 9 to level 6.
2. Do not add configuration parsing or documentation for multiple compression policies.
3. Add a focused test that verifies production archive construction requests level 6.
4. Record before-and-after measurements across the supported storage matrix without treating cloud hydration time as compression time.

Acceptance criteria:

- Production archive construction requests DEFLATE level 6.
- No compression-level configuration option is added.
- Benchmarks record elapsed time, CPU time, and archive size for the supported storage matrix.
- ZIP validity, warning handling, interruption, and atomic installation remain unchanged.

#### 8. Add bounded concurrency to target storage measurement

Locations: `measureDirectoryStorage` near lines 216 to 267 and target planning near lines 348 to 354.

Every `readdir`, `lstat`, and `stat` is currently awaited serially, and unique targets are also measured one at a time. This is O(N) work with wall time close to the sum of filesystem-operation latencies, which is especially costly for external and cloud-backed targets.

Verification status: **confirmed**. A delayed-filesystem probe over ten files and three directories observed three `readdir` calls, ten `stat` calls, peak metadata concurrency of one, and the correct 50-byte total. The alias cache still ensures equivalent target identities are measured once. Existing tests cover totals, root-only backup classification, unknown Dirents, and alias reuse, but not a concurrency cap.

Implementation plan:

1. Introduce a small bounded queue for directory traversal and file metadata calls.
2. Optionally measure distinct target identities concurrently under the same global cap.
3. Preserve symlink skipping and root-only backup classification.
4. Avoid unbounded `Promise.all` over directory entries.

Acceptance criteria:

- Totals and backup counts exactly match the existing implementation.
- Equivalent target aliases are still measured once.
- Peak concurrency never exceeds the configured internal cap.
- A synthetic delayed-filesystem test demonstrates overlapping operations without relying on wall-clock flakiness.

#### 9. Evaluate bounded parallel target copies

Location: the replication loop near lines 706 to 720.

Copies currently run sequentially and reread the full archive for every target. A small concurrency limit can reduce elapsed time when targets are independent. Do not implement a shared-stream fan-out in the first pass; shared backpressure and partial-target failures add substantial complexity.

Verification status: **confirmed for current behavior; benefit remains workload-dependent**. A controlled two-target probe observed two reads of the same staging path, peak concurrent reads of one, and the second copy starting only after the first completed. The staging archive was removed after both copies. Existing execution tests use one copy target and do not cover multi-target overlap, partial parallel failure, interruption of multiple pipelines, or parallel cleanup ordering.

Evaluate bounded parallel copies only with targets drawn from local SSD, external disk, and Google Drive on the same Mac. Include cases where multiple paths share one physical or cloud-backed device. Enable concurrency only when measurements show a meaningful benefit without increasing failure ambiguity or saturating a shared device.

Acceptance criteria:

- The staging archive remains present until every started copy has settled.
- A failure aborts or drains in-flight work safely and reports every cleanup failure needed for diagnosis.
- No target is reported as copied until its atomic rename succeeds.
- Interruption aborts all active pipelines and preserves the signal exit code.
- Tests cover at least two targets, partial failure, interruption, and staging cleanup ordering.

### Phase 4: simplify archive stream lifecycle

#### 10. Refactor `createArchive` only after race coverage exists

Location: `createArchive` near lines 573 to 653.

The function manually coordinates close, errors, warnings, abort handlers, progress timers, finalization, and one-time settlement. This is the most race-sensitive section of the file. A refactor around `node:stream/promises.pipeline` may remove much of the custom settlement state, but it must account for Archiver's `finalize()` promise and convert warnings into stream failures.

Verification status: **confirmed coverage gap; refactor unproven**. Current tests cover successful output, initial and final progress, an archive warning, an already-interrupted context, and a synchronous `outputFactory` failure through `execute`. They do not explicitly cover archive errors, interruption while progress reporting is active, warning followed by close, error/close ordering, or synchronous failures from `archiveFactory`, `archive.pipe`, and `archive.finalize`.

Before refactoring, add tests for:

- output stream failure;
- archive error;
- interruption while progress reporting is active;
- warning followed by close;
- error and close ordering;
- synchronous failure from `archiveFactory`, `outputFactory`, `archive.pipe`, or `archive.finalize`.

After those tests exist, prefer one pipeline-completion promise, explicit destruction on warnings or interruption, and timer/handler teardown in `finally`. Do not merge this refactor with the Phase 1 fixes because isolating behavioral changes will make regressions easier to diagnose.

## Dependency follow-up

On August 7, 2026, `npm audit --omit=dev` exited one and reported seven propagated high-severity vulnerable package records beneath `archiver`: `archiver`, `archiver-utils`, `brace-expansion`, `glob`, `minimatch`, `readdir-glob`, and `zip-stream`. These records trace to two underlying `brace-expansion` advisories through installed `minimatch` versions 9.0.9 and 5.1.9 and `brace-expansion` 2.1.2.

The production code calls `archive.directory(sourceDirectory, false)`. Installed Archiver passes the directory to `readdir-glob` with `stat` and `dot` options but no `pattern`, `ignore`, or `skip`. In this exact traversal, `readdir-glob` does not construct the Minimatch path that invokes brace expansion. The denial-of-service condition therefore does not appear reachable through this CLI flow. This conclusion is limited to the installed dependency tree and this API path; it is not a claim about every Archiver API or future dependency version.

Track upstream releases and rerun the audit during implementation. Do not describe the current command as remotely exploitable based only on the audit severity. Any dependency override must be validated with the full backup test suite and a real ZIP creation/extraction test.

User decision: these currently unreachable transitive findings do not block release. Continue monitoring and recording them; do not add an unvalidated override merely to make the audit exit zero.

## Worktree execution plan

Use a serial preparation spine, two parallel worktree waves, and a final integration pass:

```text
Commit planning documents
        |
Characterization tests and authoritative interruption handling
        |
Parallel wave 1: Phase 1 policy, startup cleanup, consistency docs, benchmark harness
        |
Merge and validate Phase 1 and Phase 2
        |
Set DEFLATE level 6 and capture storage baselines
        |
Parallel wave 2: metadata concurrency, target-copy evaluation, archive lifecycle
        |
Final documentation and integration verification
```

### Work required before dispatching parallel worktrees

1. Commit `BACKUP_REVIEW_HANDOFF.md` and `BACKUP_REVIEW_QUESTIONS.md` on the common base. They are currently untracked and therefore will not appear in new worktrees.
2. Add the missing `createArchive` characterization and race tests listed in Phase 4 before any branch changes archive construction or lifecycle behavior. Keep this first change test-only.
3. Establish a feature-specific test-file convention or a small shared test helper so parallel branches do not all append to `test/backup/backup.test.js`. Do not perform a broad test-suite rewrite solely for worktree convenience.
4. Implement and merge Phase 1 item 2, authoritative interruption through final installation and success reporting. This establishes the signal and cleanup contract required by later target-copy work and avoids simultaneous edits to `OperationContext`, `copyAtomically`, `execute`, and `main`.
5. Do not add a generalized non-signal abort model or watcher injection seam. The documentation-only consistency decision removes that prerequisite. A later parallel-copy implementation may add narrowly scoped in-flight cancellation if its design requires it.

### Parallel wave 1

Create every worktree from the post-interruption common base.

#### `backup-artifact-policy`

Implement Phase 1 items 1 and 4 together: private archive, copy, and output-directory permissions; replacement mode `0600`; preserved preflight directory creation; and accurate cancellation reporting. These changes belong together because they share `validateOutputDirectory`, `copyAtomically`, CLI plan state, and adjacent tests.

Keep this branch to production code and tests. Defer its `src/backup/BACKUP.md` changes to the documentation worktree below.

#### `backup-startup-cleanup`

Implement Phase 1 item 3: unknown-Dirent classification and safe `lstat` fallback in `cleanupStartupArtifacts`. Restrict this branch to startup cleanup and focused tests.

#### `backup-consistency-docs`

Own the consolidated `src/backup/BACKUP.md` update for wave 1. Document the Phase 1 replacement-mode and cancellation behavior plus Phase 2 live-source consistency limitations, quiescing or snapshot guidance, and the trusted personal-utility boundary. Do not add watcher code or change production behavior.

#### `backup-benchmark-harness`

Add reproducible benchmark tooling and a results schema for local SSD, external disk, and Google Drive source and target pairings. Keep harness files separate from production code. The harness must distinguish cold cloud hydration, cached reads, CLI completion, and any later Google Drive upload completion.

The artifact-policy, startup-cleanup, and benchmark-harness branches may be merged in any order after they are rebased onto the same foundation. Rebase and merge the consistency-docs branch after the artifact-policy branch so documentation never describes behavior that is not yet present. Run the complete merge gate after each branch. Phase 1 and Phase 2 must both be complete before performance implementation begins.

### Serial work between parallel waves

1. Change production ZIP construction to DEFLATE level 6 and add its focused option test. Land this small change before the second wave so it does not conflict with the later `createArchive` lifecycle branch.
2. Run the benchmark harness against the merged safety and documentation baseline. Record every available local SSD, external disk, and Google Drive source and target pairing. Record unavailable hardware rather than substituting a local-directory mock.
3. Use the baseline results as the go or no-go decision for bounded parallel target copies. Metadata concurrency remains planned because its serial behavior and latency summing are already verified, but its before-and-after measurements must still be captured.

### Parallel wave 2

Create every worktree from the post-compression, benchmarked common base.

#### `backup-measurement-concurrency`

Implement Phase 3 item 8. Own `measureDirectoryStorage`, unique-target measurement scheduling, a bounded internal queue, and deterministic concurrency-cap tests. Preserve alias deduplication, symlink skipping, totals, and root-only backup classification.

#### `backup-parallel-copies`

Implement Phase 3 item 9 only if the storage baseline demonstrates a meaningful benefit. Own the replication loop, active-copy cancellation, failure draining, staging cleanup ordering, and multi-target tests. Do not introduce shared-stream fan-out. This worktree may correctly produce no mergeable change if the measurements do not justify concurrency.

#### `backup-archive-lifecycle`

Evaluate Phase 4 item 10 after all characterization tests are on the common base. Own `createArchive` settlement, stream failure, warning, finalization, progress timer, and handler teardown behavior. Merge a refactor only if it is materially simpler and every ordering and cleanup test remains intact; an evidence-backed decision to retain the current implementation is acceptable.

These branches must use separate feature-specific test files and must not edit `src/backup/BACKUP.md`, this handoff, or the questionnaire. Avoid whole-file formatting and unrelated cleanup. This keeps production ownership mostly separated: metadata planning, replication, and archive lifecycle respectively.

### Merge order and final integration

Merge wave 2 in this order: measurement concurrency, archive lifecycle if retained, then parallel copies if justified. Rebase each branch onto the latest integration head before merging and run the complete gate after every merge. The final integration pass owns all shared documentation, benchmark results, dependency status, completion evidence, and any conflict resolution. Do not mark a conditional branch complete merely because its experiment finished; record whether it merged and why.

## Required verification for each change

Run these checks from the project root:

```sh
node --check src/backup/backup.js
npm test
npm run test:backup:coverage
npm audit --omit=dev
git diff --check
```

Record the audit result even when it exits nonzero. At this verification snapshot, a nonzero audit exit is expected because the installed dependency tree still contains the findings described above.

For changes affecting archive creation or copying, also create a real archive through the CLI, inspect it with a ZIP reader, verify its file mode on POSIX, and confirm that the run lock and all UUID temporary files are absent afterward. For signal changes, exercise both `SIGINT` and `SIGTERM` and verify exit codes 130 and 143 respectively.

## Completion checklist

The verification snapshot confirms the need for the work but does not satisfy this checklist. Treat an item as complete only after its implementation and the corresponding acceptance evidence have been recorded.

- Phase 1 issues are fixed with deterministic regression tests.
- Documentation accurately describes cancellation side effects, the absence of source-mutation detection or snapshot semantics, quiescing and snapshot guidance, and trusted-directory assumptions.
- Performance changes are justified by measurements and use bounded concurrency.
- Stream-lifecycle simplification lands separately from behavioral fixes and retains warning, interruption, and cleanup guarantees.
- The full test suite, coverage run, syntax check, dependency audit, and diff check have been recorded in the final handoff or pull request.
- The dependency audit result and reachability analysis have been rechecked against the installed dependency versions, even if no upstream fix is yet available.
- Archive and copy changes have passed real ZIP creation and extraction, POSIX mode verification, lock cleanup, and UUID temporary-file cleanup checks.
- Signal changes have passed end-to-end `SIGINT` and `SIGTERM` tests with exit codes 130 and 143 and no success heading.
- No existing safety control has been removed merely to reduce code size or improve benchmark results.
