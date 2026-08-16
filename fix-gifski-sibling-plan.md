# Implementation plan: Fix all `mov-to-gif-gifski.sh` review findings

## Purpose and final result

Implement all seven findings in `fix-gifski-sibling.md`. The completed change must decode
the input only once per FPS during the search. It must give gifski full-chroma yuv444p
frames, search down to quality 1 by default, and scale encoder concurrency from `JOBS`.

The completed change must also preserve safe interruption, deterministic winner
regeneration, strict byte limits, VMAF selection, and atomic output publication.

This document is the complete execution specification. Do not introduce an alternative
design when this document gives an implementation choice.

## Edit boundary

Modify only these implementation files:

- `plugins/harness/skills/convert-video-to-gif/scripts/mov-to-gif-gifski.sh`
- `plugins/harness/skills/convert-video-to-gif/SKILL.md`
- `tests/convert-video-to-gif/mov-to-gif-gifski.test.js`

Keep this plan as the fourth changed file. Do not modify `fix-gifski-sibling.md`.

Do not modify `plugins/harness/skills/convert-video-to-gif/scripts/mov-to-gif.sh`. It is
the behavioral reference and the comparison implementation.

The baseline command is:

```sh
node --test tests/convert-video-to-gif/*.test.js
```

The verified baseline is 15 passing tests and zero failures.

## Behavior that must not change

- Keep the CLI options, environment variable names, stdout summary, and JSON error shape.
- Keep argument validation before environment and dependency checks.
- Keep the preflight and normal-run preflight sequence.
- Keep the VMAF reference as FFV1 with `-pix_fmt yuv420p` and `-color_range pc`.
- Keep the complete coarse ladder. Do not stop after the first fitting quality.
- Keep candidate deduplication and all asymmetric refinement profiles.
- Keep the six selection levels: VMAF, FPS, quality, motion quality, lossy quality, bytes.
- Keep the GIF timing behavior and centisecond delay behavior.
- Keep the strict condition `bytes < MAX_BYTES`.
- Keep winner size, digest, and VMAF regeneration checks.
- Keep final codec, dimensions, frame count, duration, byte, digest, and VMAF checks.
- Keep destination publication atomic and preserve an existing destination after failure.
- Keep exit 0 for success, exit 2 when work cannot start, and exit 1 after work starts.

## Required implementation sequence

Make the production changes first. Then update the tests and `SKILL.md`. Run the focused
checks before the full benchmark. Do not change the reference script to make a comparison
pass.

### 1. Change constants, preflight, and concurrency

In `mov-to-gif-gifski.sh`, change:

```bash
readonly DEFAULT_MIN_QUALITY=20
```

to:

```bash
readonly DEFAULT_MIN_QUALITY=1
```

Remove `mkfifo` from the `required_commands` array in `preflight`. Do not add a replacement
dependency. The final search needs only regular files and shell input redirection.

Replace the hard-coded two-encoder calculation with this logic:

```bash
encoder_jobs=$(( jobs / 3 ))
if (( encoder_jobs < 1 )); then
  encoder_jobs=1
fi
readonly encoder_jobs
```

Keep a comment directly above this calculation. The comment must say that gifski uses
approximately three to four internal threads, so the script allocates one concurrent
encoder for each three requested jobs.

The calculation must produce these results:

| `JOBS` | `encoder_jobs` |
| ---: | ---: |
| 1 | 1 |
| 2 | 1 |
| 3 | 1 |
| 5 | 1 |
| 6 | 2 |
| 8 | 2 |
| 9 | 3 |

Do not rename the progress text `encoder workers`. The existing `JOBS=8` test must still
observe `with 2 encoder workers`.

### 2. Add one yuv444p source cache per FPS worker

Add worker cache state beside the existing worker child state:

```bash
worker_source_cache=''
```

Reset `worker_source_cache` to an empty value in `worker_setup`.

In `worker_cleanup`, remove `worker_source_cache` when all these conditions are true:

- `KEEP_WORK` is not 1.
- `worker_source_cache` is not empty.
- The path exists or is a partially written file.

Use `rm -f -- "$worker_source_cache"`. Keep this cleanup after tracked child termination.
This order prevents removal while FFmpeg still writes to the cache.

At the start of `search_fps_worker`, after `worker_setup`, declare these local paths:

```bash
local source_cache="$work_dir/source-f${fps}.y4m"
local source_log="$work_dir/source-f${fps}-ffmpeg.log"
local seen_file="$work_dir/seen-f${fps}.txt"
local result_file="$work_dir/result-f${fps}.txt"
```

Assign `worker_source_cache=$source_cache`. Remove a stale cache before preparation.

Prepare the cache once with `worker_run_stderr`. Use this exact FFmpeg data path in both
the worker and the later parent regeneration:

```bash
ffmpeg -v error -nostdin -threads 1 -filter_threads 1 \
  -i "$input" -map 0:v:0 \
  -vf "fps=${fps},scale=${gif_size}:${gif_size}:flags=lanczos,format=yuv444p,setpts=PTS-STARTPTS" \
  -an -sn -dn -c:v rawvideo -pix_fmt yuv444p -f yuv4mpegpipe -y "$source_cache"
```

If this worker command fails, call:

```bash
worker_abort source_prepare_failed \
  "could not prepare the source cache for ${fps} FPS"
```

Do not start the coarse ladder after a preparation failure.

After all coarse and refinement candidates finish, remove `source_cache` when
`KEEP_WORK` is not 1. Then set `worker_source_cache=''` so the exit trap does not repeat
the removal. When `KEEP_WORK=1`, do not remove the cache and do not clear its path before
the worker exits.

This ownership rule bounds peak y4m storage by `encoder_jobs`. Completed workers remove
their caches before later FPS workers can expand peak disk use. The final parent cache is
the only cache needed after the search.

### 3. Replace candidate FIFOs with cache input

Change `encode_candidate_worker` to accept these arguments in this order:

1. FPS.
2. Overall quality.
3. Motion quality.
4. Lossy quality.
5. Candidate output path.
6. Source-cache path.
7. Gifski stderr-log path.

The function must remove only a stale candidate and then execute one tracked process:

```bash
worker_run_stderr "$gifski_log" \
  gifski --quiet --fps "$fps" --width "$gif_size" --height "$gif_size" \
    --quality "$quality" --motion-quality "$motion_quality" \
    --lossy-quality "$lossy_quality" --repeat 0 --output "$candidate" - \
    < "$source_cache"
```

Do not call FFmpeg from `encode_candidate_worker`.

In `evaluate_candidate_worker`:

- Replace the FIFO local with `local source_cache="$work_dir/source-f${fps}.y4m"`.
- Remove the per-candidate FFmpeg log local.
- Keep the per-candidate gifski log, VMAF log, score file, candidate, bytes, score, and digest.
- Pass `source_cache` and `gifski_log` to the new worker encoder signature.
- Remove FIFO and FFmpeg-log paths from candidate cleanup.

Delete all FIFO-specific code from the worker encoder:

- `mkfifo`.
- `.mkfifo` stderr files.
- FIFO removal.
- Direct background process creation.
- Direct writes to `worker_active_pids`.
- The two-PID child record.
- The paired gifski and FFmpeg waits.
- The explicit FFmpeg termination after gifski failure.

Do not redesign the generic worker child helpers. `worker_run_stderr` already records and
reaps the one gifski child that each candidate now owns.

### 4. Regenerate the winning cache in the parent

After selection sets `best_fps` and before `encode_candidate_parent`, define:

```bash
winner_source="$work_dir/source-f${best_fps}.y4m"
winner_source_log="$work_dir/winner-source-ffmpeg.log"
```

Remove `winner_source` first. This is required when `KEEP_WORK=1` retained the worker's
copy. Regenerate it with `parent_run_stderr`, the task name `winner-source`, and the exact
FFmpeg arguments from section 2. Substitute `best_fps` for `fps`.

If parent source preparation fails, terminate with:

```bash
die regeneration_failed 'winner source preparation failed'
```

Change `encode_candidate_parent` to accept these arguments in this order:

1. Task name.
2. FPS.
3. Overall quality.
4. Motion quality.
5. Lossy quality.
6. Candidate output path.
7. Source-cache path.

Inside the function, keep `local gifski_log="$work_dir/${task}-gifski.log"`. Remove all
FIFO and FFmpeg locals. Remove only a stale candidate. Then call:

```bash
parent_run_stderr "$task" "$gifski_log" \
  gifski --quiet --fps "$fps" --width "$gif_size" --height "$gif_size" \
    --quality "$quality" --motion-quality "$motion_quality" \
    --lossy-quality "$lossy_quality" --repeat 0 --output "$candidate" - \
    < "$source_cache"
```

Pass `winner_source` to the call that regenerates `winner-regenerated.gif`.

Delete all FIFO-specific parent code. This includes `mkfifo`, paired PID records, direct
background jobs, paired waits, and producer termination. Do not redesign the generic
parent helpers. `parent_run_stderr` supplies the required one-child tracking.

Leave `winner_source` in the work directory. Normal top-level cleanup removes it with the
directory. `KEEP_WORK=1` must retain it for inspection.

### 5. Preserve and document determinism checks

Keep the selected digest in each seven-field result row. Keep the regenerated-size,
digest, and VMAF comparisons.

Replace the unsupported determinism assertion with a comment that records all these facts:

- The measurement used gifski 1.34.0.
- Ten sequential encodes matched.
- Ten concurrent encodes, run as five simultaneous pairs, matched.
- Determinism is observed behavior and is not a documented gifski guarantee.
- A future mismatch can indicate a gifski version change or a source-cache mismatch.

Do not put this evidence in a runtime message. It belongs immediately before the digest
comparison.

### 6. Apply the four small script fixes

In `score_candidate_parent`, add `|| return 1` to the VMAF FFmpeg call before
`extract_vmaf_parent`. This must match `score_candidate_worker` failure propagation.

The `seen_file` and `result_file` declarations in section 2 must be local. Do not leave
global assignments for those paths in `search_fps_worker`.

For publication, keep `parent_run` and its existing stderr filenames. Replace each compact
`parent_run ... || die ...` call with an `if ! ...; then` block.

For copy failure, read `$work_dir/publish-copy.stderr.log` with shell input redirection.
Use this condition text:

```text
could not prepare the destination temporary file: <captured stderr>
```

For final move failure, read `$work_dir/final-publish.stderr.log`. Use this condition text:

```text
could not atomically publish the verified GIF: <captured stderr>
```

Command substitution removes trailing newlines. Preserve internal diagnostic text. If a
command produces no stderr, append `command failed without stderr` instead of an empty
suffix. Do not put work-directory paths in the remedy field.

Keep the destination temporary-file creation failure unchanged because it has no
`parent_run` stderr log.

### 7. Update `SKILL.md`

In the workflow runtime warning:

- Replace the incorrect 29-profile claim.
- State that the default 1 through 100 range tests at most 28 distinct profiles per FPS.
- State that candidate deduplication can reduce the actual count.
- State that gifski mode caps concurrent encoders at `max(1, JOBS / 3)`.
- Explain that each gifski encoder is internally multithreaded.

In the gifski tuning table, change the default quality range from `20 / 100` to `1 / 100`.

Replace the later fixed two-encoder statement with the same `max(1, JOBS / 3)` rule. Do
not imply that encoder concurrency grows one-for-one with `JOBS`.

Keep the claim that gifski often improves perceptual quality at the same byte ceiling.
Append this limitation: very high-entropy sources can still fail in gifski mode when the
FFmpeg mode fits through low color counts.

Do not change mode selection. Gifski must remain an explicit secondary mode.

## Required test changes

Use the existing Node test file and helpers. Do not add a second test file or a dependency.

### Test A. Preflight no longer requires `mkfifo`

Extend the help or preflight coverage only if needed to prevent a regression. At minimum,
make a source assertion that the final script does not list `mkfifo` in
`required_commands`.

Do not mock `mkfifo`. The test must prove that it is absent, not only available.

### Test B. Normal cleanup and retained cache behavior

Rename the current retained-work test so it refers to caches, not pipes.

For `KEEP_WORK=1`, keep the existing assertions for:

- `all-results.txt`.
- `result-f8.txt`.
- `f8-q80-m80-l80.gif`.
- `winner-regenerated.gif`.
- A verified destination GIF.

Replace the FIFO assertion with an assertion for `source-f8.y4m`. Also assert that no
retained name ends with `.pipe` and no name contains `.mkfifo`.

Keep cleanup in a `finally` block so a failed assertion does not leave the retained tree.

Add a normal-run cleanup test. Create a dedicated temporary `TMPDIR`, run a successful
conversion without `KEEP_WORK`, and assert that this temporary directory is empty after
the process exits. This proves the normal path removes the entire work directory and all
y4m caches. Remove the dedicated temporary directory in `finally`.

### Test C. Exercise the real quality search and selection

Run one fixed FPS with these overrides:

```text
MIN_FPS=8
MAX_FPS=8
MIN_QUALITY=60
MAX_QUALITY=100
MAX_BYTES=1000000
KEEP_WORK=1
```

Use the existing one-second test video. Require exit 0 and parse the kept work-directory
path from stderr.

Read `result-f8.txt`. Remove blank lines and require more than one row. Each row must have
seven pipe-separated fields in this order:

1. VMAF score.
2. Bytes.
3. FPS.
4. Overall quality.
5. Motion quality.
6. Lossy quality.
7. SHA-256 digest.

Select the expected row in JavaScript with the production order:

1. Higher numeric VMAF.
2. Higher numeric FPS when VMAF is equal.
3. Higher numeric overall quality when FPS is equal.
4. Higher numeric motion quality when overall quality is equal.
5. Higher numeric lossy quality when motion quality is equal.
6. Lower numeric bytes when lossy quality is equal.

Do not use the highest overall quality as a proxy for the winner.

Parse the `Selected:` stdout line. Compare its FPS, overall quality, motion quality, lossy
quality, and VMAF with the expected row. Use `finally` to remove the kept work directory.

### Test D. Source preparation failure uses its own code

Create a temporary executable named `ffmpeg` and put its directory first in `PATH`. Resolve
the real FFmpeg path before changing `PATH`.

The wrapper must inspect all arguments. If an argument matches `source-f*.y4m`, print
`forced source preparation failure` to stderr and exit nonzero. For all other calls, use
`exec` with the resolved real FFmpeg path and the original arguments.

Run the script with `--json`. Assert exit 1. Parse stderr JSON and assert:

- `error.code` is `source_prepare_failed`.
- `error.condition` identifies the tested FPS.
- The destination does not exist or an existing destination remains byte-for-byte intact.

Do not fail the VMAF reference command. The wrapper must isolate source-cache preparation.

### Test E. Publication errors include captured stderr

Test copy and move failures as two cases in one table-driven test.

For the copy case, put an executable named `cp` first in `PATH`. It must print
`forced cp publication failure` to stderr and exit nonzero.

For the move case, put an executable named `mv` first in `PATH`. It must print
`forced mv publication failure` to stderr and exit nonzero.

The wrappers do not need to delegate because each command is used only for the publication
operation in this script. Keep the rest of `PATH` unchanged so preflight finds the other
commands.

For each case, start with a destination that contains `existing output\n`. Run with
`--json` and assert:

- Exit status is 1.
- `error.code` is `publication_failed`.
- `error.condition` contains the case's exact forced stderr text.
- The destination still contains `existing output\n`.
- No `.mov-to-gif-gifski-output.*` temporary file remains in the destination directory.

### Test F. Interruption tracks one child

Keep both SIGINT and SIGTERM tests and their expected exit statuses 130 and 143.

Target source-cache preparation. Use the existing long input with one FPS. Poll every 10
milliseconds until both conditions are true:

- `active-child-search-f20.pid` exists and contains one numeric PID.
- `source-f20.y4m` exists, which proves the source-preparation phase started.

Use a 20-second deadline. Require exactly one recorded PID, not two.

Send the requested signal to the script. Then assert:

- The script exits with the expected signal status.
- `process.kill(pid, 0)` throws `ESRCH` for the recorded child.
- The existing destination remains `existing output\n`.
- No destination temporary file exists.
- The kept work directory exists because this test uses `KEEP_WORK=1`.

Rename the test descriptions so they say `active child`. Do not claim that each candidate
has an FFmpeg and gifski pair.

Always remove the interruption temporary root after the assertions.

## Static review after edits

Run these checks before the test suite:

```sh
bash -n plugins/harness/skills/convert-video-to-gif/scripts/mov-to-gif-gifski.sh
rg -n 'mkfifo|y4m[.]pipe|[.]mkfifo' \
  plugins/harness/skills/convert-video-to-gif/scripts/mov-to-gif-gifski.sh \
  tests/convert-video-to-gif/mov-to-gif-gifski.test.js
rg -n 'format=yuv444p|-pix_fmt yuv444p|source-f.*[.]y4m' \
  plugins/harness/skills/convert-video-to-gif/scripts/mov-to-gif-gifski.sh
git diff --exit-code -- \
  plugins/harness/skills/convert-video-to-gif/scripts/mov-to-gif.sh
```

The first command must exit 0. The FIFO search must return no matches. The yuv444p search
must show both worker and parent preparation. The final command must exit 0.

Do not replace the VMAF reference's yuv420p format. A general search for `yuv420p` must
still find that reference command.

Check ShellCheck availability with:

```sh
command -v shellcheck
```

ShellCheck is not installed on the reviewed machine. If the command still fails, report
`Skipped: ShellCheck is not installed`. Do not report a ShellCheck pass.

## Automated verification

Run the complete suite:

```sh
node --test tests/convert-video-to-gif/*.test.js
```

All tests must pass. The suite must include the real-range search test and both updated
signal tests. Do not accept skipped, cancelled, or todo tests.

If a test fails, preserve its stdout, stderr, and kept work path. Fix the implementation
or test cause. Do not weaken strict byte, digest, VMAF, cleanup, or interruption assertions.

## Direct yuv444p determinism verification

Use a temporary directory outside the repository. Generate the one-second motion input
from the benchmark section below.

For iterations 1 and 2, run the exact worker source-preparation command at 15 FPS and
128 by 128 pixels. Write `source-1.y4m` and `source-2.y4m`. Encode both with these fixed
gifski settings:

```text
--fps 15
--width 128
--height 128
--quality 80
--motion-quality 80
--lossy-quality 80
--repeat 0
```

Then run:

```sh
shasum -a 256 source-1.y4m source-2.y4m
shasum -a 256 candidate-1.gif candidate-2.gif
cmp -s source-1.y4m source-2.y4m
cmp -s candidate-1.gif candidate-2.gif
```

Both `cmp` commands must exit 0. Record both cache hashes and both GIF hashes. A cache
mismatch identifies FFmpeg regeneration as the first suspect. Equal cache hashes with a
GIF mismatch identify gifski behavior as the first suspect.

The successful normal suite must also pass the production worker-to-parent digest check.

## Required head-to-head benchmark

Create an isolated benchmark directory:

```sh
benchmark_dir=$(mktemp -d /tmp/gifski-sibling-benchmark.XXXXXX)
```

Generate the motion clip:

```sh
ffmpeg -v error -f lavfi \
  -i 'testsrc2=size=256x192:rate=30:duration=1' \
  -an -c:v libx264 -pix_fmt yuv420p \
  "$benchmark_dir/motion.mp4"
```

Generate the high-entropy clip:

```sh
ffmpeg -v error -f lavfi \
  -i 'mandelbrot=size=256x192:rate=30,noise=alls=30:allf=t' \
  -t 4 -an -c:v libx264 -pix_fmt yuv420p \
  "$benchmark_dir/high-entropy.mp4"
```

Run both scripts on both clips. Use these environment values for all four runs:

```text
MAX_BYTES=120000
GIF_SIZE=128
MIN_FPS=15
MAX_FPS=15
JOBS=8
```

Do not set `MIN_QUALITY` or `MAX_QUALITY` for the new gifski runs. This verifies the new
defaults. Use `/usr/bin/time -p` and capture each command's stdout and stderr separately.

For each run, record:

- Exit status.
- `real` wall time.
- Selected FPS.
- Selected palette and dither for `mov-to-gif.sh`.
- Selected overall, motion, and lossy quality for `mov-to-gif-gifski.sh`.
- VMAF.
- Verified byte count.

Use these pre-change measurements only as comparison evidence. Do not hard-code them in
tests:

| Clip | Mode | Selected parameters | VMAF | Bytes | Wall time |
| --- | --- | --- | ---: | ---: | ---: |
| Motion | FFmpeg | 15 FPS, 256 colors, dither 5 | 77.404213 | 57,521 | 10.73 s |
| Motion | gifski yuv420p | quality 100/100/100 | 79.157897 | 74,057 | 2.23 s |
| High entropy | FFmpeg | 15 FPS, 5 colors, dither 5 | 25.290997 | 88,352 | 29.63 s |
| High entropy | gifski yuv420p with quality floor 1 | quality 1/11/1 | 32.824414 | 106,949 | 3.37 s |

The high-entropy fixture was also calibrated directly with yuv444p. Balanced quality 20
produced 220,778 bytes. Balanced quality 1 produced 111,447 bytes. Thus the old quality
floor cannot fit under 120,000 bytes, while the new floor can fit.

Accept the benchmark only when all these conditions hold:

- Both modes succeed on the motion clip.
- Both modes succeed on the high-entropy clip.
- The new gifski run uses its default quality floor and succeeds on high entropy.
- Each output is strictly smaller than 120,000 bytes.
- The new gifski motion VMAF is not below 79.157897.
- Each command reports selected parameters, VMAF, bytes, and wall time.

Do not require gifski to beat FFmpeg on every recorded value. Report actual measurements.
If motion VMAF regresses, first compare the worker and parent cache hashes. Then inspect
the yuv444p source path and do not change the VMAF reference.

## Cache lifecycle verification

Run one normal gifski conversion with a dedicated `TMPDIR`. Confirm that the temporary
root is empty after success. This confirms the work directory and all caches are gone.

Run the same conversion with `KEEP_WORK=1`. Parse `Kept work directory:` from stderr.
Confirm that the directory contains `source-f${fps}.y4m`. Confirm that it contains no FIFO
or `.mkfifo` artifact. Remove the retained directory after recording the result.

The retained winner cache can have the same path as the worker cache because the parent
must remove and regenerate it before the final encode.

## Documentation verification

Check the changed prose with the repository's installed technical-writing checker:

```sh
python3 \
  /Users/kyle/.codex/plugins/cache/harness-plugin/harness/0.1.0/skills/write-asd-ste100/scripts/ste_check.py \
  fix-gifski-sibling-plan.md \
  plugins/harness/skills/convert-video-to-gif/SKILL.md \
  --mode mixed --json
```

Review the plan result and the `SKILL.md` result separately. Apply findings that improve
the prose without changing technical meaning. Keep exact commands, paths, identifiers,
diagnostics, and established project terms unchanged. Describe the final prose as
`STE-aligned` unless lexical, mechanical, and semantic review proves full compliance.

## Final acceptance checklist

- [ ] Only the three allowed implementation files and this plan changed.
- [ ] `mov-to-gif.sh` has no diff.
- [ ] `DEFAULT_MIN_QUALITY` is 1.
- [ ] `encoder_jobs` is `max(1, JOBS / 3)` by integer division.
- [ ] Preflight no longer requires `mkfifo`.
- [ ] Each FPS worker prepares one yuv444p y4m cache.
- [ ] Candidates read the cache through standard input.
- [ ] Worker caches are removed on success and failure unless `KEEP_WORK=1`.
- [ ] Parent winner regeneration rebuilds the same yuv444p cache.
- [ ] Candidate encoders track one child and contain no FIFO process logic.
- [ ] Parent VMAF FFmpeg failure returns before score extraction.
- [ ] Search result paths are local to the worker.
- [ ] Copy and move failures include captured stderr.
- [ ] The determinism comment records versioned measured evidence and its limitation.
- [ ] `SKILL.md` documents 1 through 100, 28 profiles, and the `JOBS / 3` cap.
- [ ] The real-range search test validates the production selection order.
- [ ] SIGINT and SIGTERM tests prove that one recorded child is reaped.
- [ ] `bash -n` passes.
- [ ] The full Node test suite passes with no skipped or cancelled tests.
- [ ] Direct cache and GIF determinism checks pass.
- [ ] Normal cleanup and `KEEP_WORK=1` behavior are confirmed.
- [ ] Both benchmark modes succeed on both generated clips.
- [ ] The high-entropy gifski run succeeds with the new default quality floor.
- [ ] The motion gifski VMAF is at least 79.157897.
- [ ] ShellCheck is reported as passed only if it was installed and run.

## Final handoff format

Report each review finding as completed or not completed. For completed findings, cite the
changed file and line. For a finding not completed, give the exact technical blocker.

Report syntax, automated tests, direct determinism, cache lifecycle, and benchmark results
as separate verification facts. Include exact commands. Label ShellCheck `Skipped` when
it is unavailable.

Do not claim a benchmark result before running it. Do not claim a clean worktree because
the implementation changes and this plan are expected to remain uncommitted unless the
user separately requests a commit.
