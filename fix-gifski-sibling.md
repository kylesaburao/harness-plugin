# Fix: mov-to-gif-gifski.sh review findings

Fix seven review findings in the gifski GIF encoder sibling. Work only in these files:

- `plugins/harness/skills/convert-video-to-gif/scripts/mov-to-gif-gifski.sh`
- `plugins/harness/skills/convert-video-to-gif/SKILL.md`
- `tests/convert-video-to-gif/mov-to-gif-gifski.test.js`

Do not modify `mov-to-gif.sh`. It is the behavioral reference and must stay intact.

Baseline before you start: `node --test tests/convert-video-to-gif/*.test.js` passes 15/15.
It must still pass when you are done, with the test changes described below.

All facts below were verified empirically against the installed gifski 1.34.0. Trust them,
but re-run anything you change behavior around.

## 1. Cache one decode per FPS and delete the FIFO architecture (biggest change)

`encode_candidate_worker` currently runs a fresh `ffmpeg -i "$input" ...` for every
candidate and pipes it to gifski through a named FIFO. With ~29 quality profiles per FPS
value, that decodes the source ~29 times per FPS for no reason. The reference script caches
one decode per FPS (`mov-to-gif.sh:543-551`) and reads it for every candidate
(`mov-to-gif.sh:604`).

Replace it with a per-FPS y4m cache:

- At the top of `search_fps_worker`, produce `$work_dir/source-f${fps}.y4m` with a single
  ffmpeg run using the existing filter chain (`fps`, `scale`, `format`, `setpts`) and
  `-f yuv4mpegpipe`. Fail the worker via `worker_abort` with a distinct code (e.g.
  `source_prepare_failed`) if it fails.
- Each candidate then becomes a single process: `gifski ... --output "$candidate" - <
  "$work_dir/source-f${fps}.y4m"`. Verified working, this exact redirection form encodes
  correctly.
- Delete the FIFO machinery entirely from both `encode_candidate_worker` and
  `encode_candidate_parent`: `mkfifo`, the `.mkfifo` stderr side-files, the two-element
  `worker_active_pids`/`parent_active_pids` arrays, the `kill -TERM "$ffmpeg_pid"` on
  gifski failure, and the paired `wait` for both statuses. A candidate encode now tracks
  exactly one child and can use the existing `worker_run_stderr` / `parent_run_stderr`
  helpers.
- **Bound the disk cost.** yuv444p raw y4m is ~49 KB/frame at 128x128, so a long clip at a
  large `GIF_SIZE` across many FPS values could reach gigabytes if every cache lived for
  the whole run. Each `search_fps_worker` must therefore own its cache: create it at the
  start, `rm -f` it when that FPS finishes (skip the delete when `KEEP_WORK=1`). Peak usage
  is then bounded by the concurrency cap, not by the FPS range width.
- `encode_candidate_parent` (winner regeneration) needs the winning FPS's cache. Since the
  worker deletes it, regenerate the cache in the parent before re-encoding the winner, with
  the identical ffmpeg invocation. It must be byte-identical to what the worker produced or
  the digest check in step 6 will fail.

## 2. Stop subsampling chroma before gifski

Both the candidate and regeneration pipelines use `format=yuv420p` / `-pix_fmt yuv420p`.
gifski's y4m reader accepts full chroma (`C444`) cleanly, and it scores better: on a test
clip at identical settings, `yuv420p` gave VMAF 80.96 and `yuv444p` gave 83.18.

Change both the candidate path and the winner-regeneration path to `yuv444p`. They must
stay identical to each other. Leave the VMAF reference (`vmaf-reference.mkv`) exactly as it
is: it is the comparison baseline and matches the FFmpeg sibling's construction, so
changing it would make scores incomparable across the two modes.

## 3. Lower the default quality floor

`DEFAULT_MIN_QUALITY=20` makes the script give up on high-entropy sources that the FFmpeg
sibling still handles. Measured on a 256x192 fractal clip at `MAX_BYTES=120000`,
`GIF_SIZE=128`, 15 FPS: gifski at quality 20 produces 128587 bytes and the run exits 1 with
`no_candidate`, while the FFmpeg sibling succeeds by dropping to a 16-color palette (VMAF
45.29). With `MIN_QUALITY=1` gifski fits at 115510 bytes and VMAF 55.95, beating the FFmpeg
sibling.

Set `DEFAULT_MIN_QUALITY=1`. This is a deliberate behavior change for parity with the
FFmpeg sibling's 4-color floor. It widens the coarse ladder from 9 rungs to 11 (100, 90,
... 10, then clamped to 1), so update the SKILL.md profile count in step 7.

## 4. Scale the concurrency cap instead of hardcoding 2

`encoder_jobs` pins to 2 regardless of `JOBS`. The stated rationale (gifski is internally
multithreaded) applies only to the gifski process; the VMAF scoring inside each worker is
`-threads 1` / `n_threads=1` and is needlessly serialized to 2-wide.

Use `encoder_jobs = max(1, jobs / 3)` (integer division, gifski runs roughly 3-4 threads).
Keep the explanatory comment and update it to describe the ratio. Note `JOBS=8` still
yields 2, so the existing test asserting `with 2 encoder workers` continues to pass
unchanged.

## 5. Add a test that actually exercises the search

`BASE_ENV` pins `MIN_QUALITY: '80', MAX_QUALITY: '80'`, which collapses the ladder to one
rung and makes every refine offset clamp to the same identity, so `candidate_seen` dedupes
all 19 remaining calls. Every conversion test today runs exactly one gifski encode. The
ladder, anchor selection, refine profiles, dedupe, and the six-level awk tie-break are
untested.

Add a test that runs with a real range (e.g. `MIN_QUALITY=60 MAX_QUALITY=100` at one fixed
FPS, generous `MAX_BYTES`) and `KEEP_WORK=1`, then asserts that `result-f<fps>.txt` in the
kept work directory contains more than one row, and that the winning parameters printed on
stdout match the row with the highest VMAF score in that file (not simply the highest
quality value). Clean up the kept directory afterward, as the existing `KEEP_WORK` test
does.

Also update the interruption test: `verifyInterruption` waits for
`active-child-search-*.pid` to contain 2 PIDs, which was the ffmpeg+gifski pipeline. After
step 1 a candidate encode has one child, so that assertion must change. Either wait for 1
PID during the candidate phase, or target the per-FPS source-prep ffmpeg. Whichever you
pick, the test must still prove that the recorded children are dead after the signal and
that the destination file was left untouched.

## 6. Cite the determinism evidence instead of asserting it

The comment at the regeneration digest check says gifski is deterministic with no evidence.
It is true on this version: 10 sequential runs and 10 concurrent runs (5 simultaneous
pairs, matching the encoder cap) with identical input and parameters produced 20/20
identical SHA-256 digests on gifski 1.34.0.

Keep the digest checks. Rewrite the comment to record that this was measured, on which
version, and that it is observed behavior rather than a documented gifski guarantee, so a
future failure points at a version change rather than at a mystery.

One gap to close yourself: determinism was measured with a **yuv420p** source, and the
current script's passing tests separately show that ffmpeg's decode+scale is reproducible
(the existing regeneration digest check already re-runs ffmpeg and passes). Neither was
measured for the **yuv444p** cache this change introduces. After steps 1 and 2, confirm the
combination directly: encode the same candidate parameters twice from a freshly regenerated
yuv444p cache and verify the digests match. If they do not, the ffmpeg cache regeneration
in step 1 is the suspect before gifski is.

## 7. Four small fixes plus the doc updates

- `score_candidate_parent` is missing the `|| return 1` after its VMAF ffmpeg call that
  `score_candidate_worker` has. Currently masked by `|| die` at both call sites. Add it for
  symmetry.
- `seen_file` and `result_file` are assigned without `local` in `search_fps_worker`. Make
  them local, consistent with the rest of the file.
- `parent_run` sends `cp`/`mv` stderr to a work-dir log that cleanup deletes, so a real
  filesystem failure surfaces as a bare `publication_failed`. Include the captured stderr
  in the `die` message on the publication paths.
- SKILL.md: the profile-count sentence is wrong for non-default ranges and now wrong for
  the new default. State the real bound for the default range after step 3. Reword the
  `JOBS` sentence so it says plainly that gifski mode caps concurrent encoders (now
  `JOBS/3`) rather than implying `JOBS` scales freely. The existing "Gifski often improves
  perceptual quality at the same byte ceiling" claim is now supported: on two clips at
  `MAX_BYTES=120000 GIF_SIZE=128 MIN_FPS=MAX_FPS=15`, gifski won on VMAF, bytes, and wall
  time (motion clip: VMAF 75.84 vs 73.88, 110759 vs 119706 bytes, 3.0s vs 8.2s). Keep the
  claim but add the caveat that gifski's quality floor can fail on very high-entropy
  sources where the FFmpeg mode's low color counts still fit.

## Out of scope, do not change

- The coarse ladder running all the way to `min_quality` after finding the anchor. The
  original spec explicitly warned against assuming size is monotonic in quality, so
  exhausting the ladder is the deliberate conservative choice, and step 1 makes it cheap.
- The VMAF reference construction, the GIF centisecond delay/timing behavior (shared with
  `mov-to-gif.sh`), the preflight structure, the JSON error contract, the atomic
  publication flow, and the input-validation sequence. All were reviewed and are sound.
- `mov-to-gif.sh` itself.

## Definition of done

1. `bash -n` clean on the modified script. (ShellCheck is not installed on this machine, so
   skip it rather than reporting it as passing.)
2. `node --test tests/convert-video-to-gif/*.test.js` passes, including the new search test
   and the updated interruption test.
3. Re-run the head-to-head on a motion clip and a high-entropy clip at
   `MAX_BYTES=120000 GIF_SIZE=128 MIN_FPS=15 MAX_FPS=15`, comparing against `mov-to-gif.sh`.
   Report bytes, VMAF, selected parameters, and wall time for both modes. The gifski mode
   must now succeed on the high-entropy clip that previously returned `no_candidate`, and
   the yuv444p change should not regress VMAF on the motion clip.
4. Confirm the per-FPS caches are gone from the work directory after a normal run and
   present after a `KEEP_WORK=1` run.
5. Report any finding you chose not to fix, and why.
