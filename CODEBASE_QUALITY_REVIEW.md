# Architectural and code quality review

Reviewed on 2026-09-04 at commit `9743ec9`.

The best next improvements concern process lifecycle ownership, preservation of failure evidence, CLI contract consistency, and separation of test setup from test execution. The current skill-local architecture provides a suitable foundation. These findings do not justify a broad rewrite.

This session produced this report only. No implementation, tests, configuration, or dependencies were changed. The existing untracked `HANDOFF.md` was preserved.

## Prioritized recommendations

| Priority | Improvement | Expected benefit | Relative effort |
| --- | --- | --- | --- |
| High | Make extractor cancellation terminal | Prevent work from continuing after interruption and bound shutdown | Medium |
| Medium | Make the GIF runner own cleanup and final outcome | Preserve primary failures and report cleanup failures reliably | Small to medium |
| Medium | Preserve subprocess exit codes and signals | Make failed conversions diagnosable from their first report | Small |
| Medium | Reconcile CLI behavior with the repository contract | Give calling agents consistent readiness and failure information | Medium |
| Lower | Separate test setup from test execution | Allow repeat test runs without dependency installation | Small to medium |

Priorities are engineering judgments. The changes range from small diagnostic fixes to moderate lifecycle and CLI changes. No performance improvement was measured.

### 1. Make extractor cancellation terminal

**Verified:** The extractor's `ProcessManager.run()` starts a child even when `interrupt()` has already recorded a signal. Its interruption method signals current children but does not prohibit later launches or escalate when a child ignores that signal. See [ProcessManager](/Users/kyle/Documents/harness-plugin/plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js:159).

A controlled probe called `interrupt('SIGTERM')` before `run()`. The child still completed with exit code 0 and printed `ran after interrupt`. A second probe used a child that explicitly ignored SIGTERM. It remained active after interruption and required explicit SIGKILL cleanup by the probe.

**Implication:** Shutdown behavior depends on each child cooperating and on callers remembering to inspect the signal between operations. The main flow checks the signal before structural verification, but does not check it again before publication. Continued verification or publication after a late interruption is therefore a source-supported risk, not an end-to-end failure reproduced in this review. See [verification and publication flow](/Users/kyle/Documents/harness-plugin/plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js:735).

**Recommendation:** Make interruption a terminal state of the extractor's process module. Reject later launches, preserve the first interruption signal, wait for active children to close, and escalate after a bounded grace period. Check interruption immediately before publication. Keep this change local to the extractor. The GIF manager already provides a tested cancellation precedent, but its process-group and scheduling interface need not be imported wholesale. See [GIF cancellation](/Users/kyle/Documents/harness-plugin/plugins/harness/skills/create-discord-emoji-gif/scripts/node/process-manager.js:150).

**Acceptance:** Cover interruption before launch, a child that ignores SIGTERM, and interruption during final verification. Assert no subsequent child or publisher starts, temporary artifacts are removed after children stop, and the original signal exit status is preserved.

### 2. Make the GIF runner own cleanup and final outcome

**Verified:** `cleanupArtifacts()` can throw when removing the work directory. The runner invokes it both after conversion and within its catch block, without isolating cleanup errors. A cleanup failure can therefore replace the conversion failure and escape the structured error path. See [cleanup](/Users/kyle/Documents/harness-plugin/plugins/harness/skills/create-discord-emoji-gif/scripts/node/shared.js:280) and [runner error handling](/Users/kyle/Documents/harness-plugin/plugins/harness/skills/create-discord-emoji-gif/scripts/node/converter-runner.js:54).

A controlled probe supplied an original `candidate_encode_failed` error and a cleanup function that threw `EACCES`. The runner rejected with `EACCES`, losing the original failure from its returned outcome.

The backends also emit successful results before the runner performs final cleanup. This splits ownership of completion between backend code and the runner. See [gifski completion](/Users/kyle/Documents/harness-plugin/plugins/harness/skills/create-discord-emoji-gif/scripts/node/mov-to-gif-gifski.js:109).

**Recommendation:** Have the runner own cleanup and final reporting. Backends should return their published-result data. Cleanup should return failures rather than replace the primary error. Preserve the original conversion diagnosis and attach cleanup failures as secondary information. If publication succeeded but cleanup failed, report the published artifact and remaining temporary paths accurately.

**Acceptance:** Inject cleanup failures after both successful publication and failed conversion. Verify that JSON remains parseable, primary failures survive, and the report accurately distinguishes a published artifact from incomplete cleanup.

### 3. Preserve subprocess exit codes and signals

**Verified:** The GIF process manager captures both exit code and signal, but conversion wrappers discard them when constructing domain errors. VMAF scoring retains stderr only, and gifsicle adds a generic worker wrapper. See [child result capture](/Users/kyle/Documents/harness-plugin/plugins/harness/skills/create-discord-emoji-gif/scripts/node/process-manager.js:81), [VMAF failure](/Users/kyle/Documents/harness-plugin/plugins/harness/skills/create-discord-emoji-gif/scripts/node/shared.js:225), and [worker wrapper](/Users/kyle/Documents/harness-plugin/plugins/harness/skills/create-discord-emoji-gif/scripts/node/mov-to-gif.js:77).

A controlled VMAF probe returned `code: null` and `signal: 'SIGSEGV'`. The resulting domain error contained neither value. This was simulated diagnostic input, not an observed FFmpeg crash.

The existing handoff separately records an unresolved VMAF failure whose report lacked the child exit status or signal. This review does not establish the cause of that failure. See [handoff evidence](/Users/kyle/Documents/harness-plugin/HANDOFF.md:52).

**Recommendation:** Preserve task identity, child exit code, child signal, and the underlying domain error through wrapping and serialization. Retain stable top-level error codes. Use a small skill-local helper for repeated conversion of subprocess results into errors, rather than introducing a logging framework. The extractor should also retain the signal supplied by the child close event.

**Acceptance:** Exercise an ordinary nonzero exit, signal termination, and launch failure. Confirm that plain and JSON reports retain the distinguishing evidence, including through the gifsicle worker wrapper.

### 4. Reconcile CLI behavior with the repository contract

**Verified:** The repository requires `--preflight`, machine-readable JSON, and errors containing a stable code, condition, and remedy. Several entrypoints implement narrower contracts. See [repository contract](/Users/kyle/Documents/harness-plugin/AGENTS.md:95).

- `ste_lookup.py` uses the default argparse error reporter. Running it with `--json --bogus` produced plain usage text rather than JSON. Its parser also has no `--preflight` option. See [lookup parser](/Users/kyle/Documents/harness-plugin/plugins/harness/skills/write-asd-ste100/scripts/ste_lookup.py:20).
- `ste_check.py` emits structured invocation errors without a remedy. A missing terms-file probe produced `terms_invalid` with code and condition only. See [invocation error serializer](/Users/kyle/Documents/harness-plugin/plugins/harness/skills/write-asd-ste100/scripts/ste_check.py:548).
- Backup help limits `--json` to readiness and startup errors. Successful execution prints a prose report regardless of that flag. See [backup help](/Users/kyle/Documents/harness-plugin/plugins/harness/skills/back-up-directories/scripts/backup.js:131) and [completion report](/Users/kyle/Documents/harness-plugin/plugins/harness/skills/back-up-directories/scripts/backup.js:965).

**Recommendation:** Bring agent-facing entrypoints into agreement with the declared contract, or explicitly document justified exceptions. Share the Python argument-error serializer within the skill. Add concrete remedies to invocation errors. Define readiness-only behavior for the checker and lookup commands. Give backup a machine-readable completion report while preserving its interactive confirmation requirement.

**Acceptance:** Add a small consumer-level contract test for each affected entrypoint: invalid arguments under JSON, readiness-only invocation, and representative success or failure output. Keep existing semantic and documentation tests.

### 5. Separate test setup from test execution

**Verified:** Every invocation of the test runner starts with `npm ci`, Python virtual-environment creation, `pip install pypdfium2`, and reference initialization before running tests. Valid references are now reused, but setup remains mandatory. See [test command plan](/Users/kyle/Documents/harness-plugin/scripts/run-tests.js:59).

For this assessment, all suites ran successfully using existing dependencies and direct test commands. The setup portion of the orchestrator was not run.

**Recommendation:** Provide an explicit development setup command and make ordinary test execution validate and use the existing environment. Keep dependency installation and reference initialization in setup. Update the existing workflow to call setup before its test gate, preserving its requirement to test the revision it will release. No additional CI system, cache service, or dependency-management framework is needed.

**Expected benefit:** Routine verification can run without attempting package installation and can report missing prerequisites separately from test failures. No speedup or offline benchmark was measured.

**Acceptance:** Verify that a prepared checkout runs tests without installer commands, a missing prerequisite produces an actionable failure, setup remains usable from a fresh checkout, and the existing workflow preserves its revision checks.

## Architectural conclusions

Retain the canonical skill tree and skill-local production modules. The dual-harness packaging does not require separate implementations. The existing GIF runner, publication helpers, backup execution functions, and dictionary data module already provide useful seams.

Do not split large files solely to reduce line counts. Concentrate changes where callers currently have to coordinate lifecycle state, reconstruct missing errors, or compensate for inconsistent CLI behavior.

Preserve publication guarantees. In particular, the current extractor uses a macOS publisher and has a passing test that refuses replacement of an existing empty directory. A bare rename substitution must not silently weaken that contract. See [publication test](/Users/kyle/Documents/harness-plugin/tests/extract-video-frames/lifecycle.test.js:60).

## Verification

**Passed:** 149 non-GIF Node tests, with no failures or skips.

```sh
node --test tests/back-up-directories/*.test.js tests/bump-version/*.test.js tests/git-hooks/*.test.js tests/inventory/*.test.js tests/run-tests/*.test.js tests/extract-video-frames/*.test.js
```

**Passed:** 76 GIF Node tests, including real conversions, with no failures or skips.

```sh
node --test tests/create-discord-emoji-gif/*.test.js
```

**Passed:** 108 Python tests, with no failures or skips.

```sh
.venv/bin/python -m unittest discover -s tests/write-asd-ste100 -v
```

**Total:** 333 tests passed. Existing green tests do not cover all the controlled failure scenarios identified above. These results were obtained during the assessment, before this report was written. No implementation changes followed those runs.

**Additional evidence:** In-memory probes confirmed launch after interruption, a deliberately uncooperative child remaining active after interruption, loss of child termination details, and cleanup masking the original failure. These probes did not modify repository files.

**Not run:** The installer stages of `node scripts/run-tests.js`, hosted CI, and a dedicated reproduction of the small-fixture VMAF failure from the handoff.

**Repository state:** Before report creation, `git status --short` showed only `?? HANDOFF.md`. The report is the only file added by this task.

## Review limits

This is a source review with local tests and targeted probes, not an exhaustive audit of every platform or external media-tool build. Priority and implementation effort are judgments. Continued publication after a late interruption is an inference from control flow. The VMAF signal-loss finding is reproduced with controlled input and does not attribute the prior unexplained failure to a crash.

A progress-channel concern was checked and rejected: extraction uses `pipe:2`, matching its stderr callback. The representative decode probe intentionally uses `pipe:1` and inspects stdout. No progress defect is included in these findings.
