---
name: create-discord-emoji-gif
description: Create an animated 128x128 GIF for a Discord emoji, with a strict target of fewer than 256000 bytes and VMAF-based quality selection. Use when the user asks for a Discord emoji GIF or an equivalent animated 128x128 GIF under 256 KB. Prefer clips of 3 seconds or less for better quality. Do not use for general video-to-GIF requests without these size and dimension targets, or when the user wants a video file rather than a GIF.
compatibility: Requires Node.js 22.0.0 or newer, ffmpeg built with libvmaf, ffprobe, and either gifski or gifsicle. Deprecated Bash alternatives remain for hosts without Node.js 22.
---

# Create a Discord emoji GIF

Create a looping 128x128 GIF that is strictly smaller than 256000 bytes. Clips of 3
seconds or less usually produce better quality within that limit. If the user asks what
this skill is or why it exists, state both the Discord size target and this duration
guidance.

The Node.js converters are the default and the only routed runtime. Both implement the
same two backend searches, regenerate the winner, score it with VMAF, verify the
published file, and publish it atomically. Use gifski by default. Use FFmpeg and
gifsicle as the defined fallback.

Both backends need `ffmpeg` built with `libvmaf` and `ffprobe`. The default backend also
needs `gifski`. The fallback needs `gifsicle`. Each converter reports all missing or
unsuitable tools and gives platform-specific remedies.

## Select an entrypoint

Resolve paths relative to this skill directory, not the caller's current directory.

| Request | Entrypoint |
| --- | --- |
| Default | `node scripts/node/mov-to-gif-gifski.js` |
| Explicit gifsicle | `node scripts/node/mov-to-gif.js` |

Use this procedure:

1. Dispatch the matching entrypoint directly. Do not probe `node --version` first: the
   entrypoint validates its own runtime as part of the one dispatch.
2. If the shell reports the `node` command itself as not found, that is a shell error,
   not a `code`/`condition`/`remedy` triple from the script. Tell the user Node.js
   22.0.0 or newer must be installed and stop there. Do not fall back to the deprecated
   Bash converters below and do not invent a remedy.
3. If `node` exists but is older than 22, the script itself exits 2 with
   `node_version_unsupported` and a remedy. Relay it like any other failure.
4. A default gifski attempt that fails before work starts (exit 2) can fall through to
   gifsicle only for `command_missing` for gifski, `gifski_probe_failed`, or
   `gifski_capability_missing`.
5. Do not fall through on argument, input, output, FFmpeg, ffprobe, platform, or work
   directory failures.
6. After conversion work starts, fall through only from gifski `no_candidate` to
   gifsicle. Never fall from a started run to the other backend.
7. A normal backend comparison runs both entrypoints.

Node.js 22.0.0 is the supported runtime floor. `os.availableParallelism()`, used to
calculate the default `JOBS`, has an API floor of Node.js 18.14.0. The older API floor
does not change the supported runtime floor.

## Deprecated

`scripts/bash/mov-to-gif-gifski.sh` and `scripts/bash/mov-to-gif.sh` implement the same
two backends without Node.js. They exist only for hosts that cannot run Node.js 22 or
newer, and are superseded by the entrypoints above. Use them only on an explicit request
naming Bash, never as a silent fallback. They verify the pre-rename file with ffprobe the
same way the Node.js converters verify the temporary file, and print only the three
summary lines from Read the result (`Selected:`, `Output:`, `Verified:`). Relay those
three lines and stop; they do not get a `Report:` block or a post-rename digest
confirmation, and their `--json` flag affects only preflight and error output, not the
success summary, so there is nothing further to relay.

## Workflow

1. Warn the user before a broad search because it can take several minutes and use
   most CPU cores. Narrow the search with environment variables when the user wants a
   faster result.

2. One dispatch does the entire job: search, regenerate the winner, score it with VMAF,
   verify it against expectations, and publish it. After a **successful** dispatch, do
   not run any further command against the input or the output, and do not open the
   GIF — this covers `ffprobe`, `ffmpeg`, `gifsicle`, `file`, `stat`, `ls`, `wc`, `du`,
   `shasum`, an image viewer, or any other inspection tool, not only the ones named here.
   The dispatch's own report already measured the published file's codec, dimensions,
   frame count, duration, byte count, and digest, and confirmed the digest again after
   the atomic rename. Relaying those fields from the report is expected; re-deriving any
   of them with another command is not.

3. Convert with the selected entrypoint:

   ```sh
   node scripts/node/mov-to-gif-gifski.js INPUT_VIDEO [OUTPUT.gif]
   node scripts/node/mov-to-gif.js INPUT_VIDEO [OUTPUT.gif]
   ```

   The converter validates the environment and the video before doing any conversion
   work, so this one dispatch also serves as the readiness check. It reports a nonfatal
   `input_duration_long` warning on stderr when the clip is longer than 3 seconds. Without
   an output path, every converter writes `<input-basename>_<size>x<size>.gif` next to the
   input. Progress and warnings go to stderr. The result summary and report go to stdout.
   A long-input warning does not reject, trim, or modify the input.

4. Relay a failure diagnosis verbatim, including each stable `code`, `condition`, and
   `remedy`. Do not independently replace its remedy. Ask the user before running an
   installation command because it changes the machine.

   Run `--preflight` as its own dispatch only when a check is wanted without attempting a
   conversion, for example confirming the environment before the user hands over a video.
   `--preflight` without an input checks only the environment; with an input, it also
   validates the video.

   ```sh
   node scripts/node/mov-to-gif-gifski.js --preflight --json INPUT_VIDEO
   ```

## Tuning

Set these environment variables, not command flags:

| Variable | Default | Effect |
| --- | --- | --- |
| `MAX_BYTES` | 256000 | Strict byte ceiling. The output must be smaller. |
| `GIF_SIZE` | 128 | Square output width and height in pixels |
| `MIN_FPS` / `MAX_FPS` | 15 / 24 | Frame-rate range. Gifski accepts at most 100 FPS. |
| `JOBS` | logical CPUs minus 2, minimum 1 | Parallel work limit |
| `KEEP_WORK` | unset | Set to `1` to keep the intermediate work directory |

All positive integer values must be no greater than `9007199254740991`, the largest
integer that Node.js represents exactly. Backend-specific limits, such as gifski's
100 FPS and quality maximums, still apply.

The gifski backend also accepts:

| Variable | Default | Effect |
| --- | --- | --- |
| `MIN_QUALITY` / `MAX_QUALITY` | 1 / 100 | Gifski quality search bounds |

The gifski backend uses `min(FPS count, max(1, floor(JOBS / 2)))` simultaneous
encoder workers. Each gifski child receives
`RAYON_NUM_THREADS = clamp(floor(JOBS / encoder workers), 2, 8)`.

To reduce runtime, pin the frame rate with `MIN_FPS=15 MAX_FPS=15`.

## Read the result

- Exit `0` means the preflight passed or the conversion succeeded.
- Exit `2` means work did not start because of usage, runtime, environment, input, or
  output validation. Relay the reported remedy.
- Exit `1` means conversion work started and failed. Apply only the backend fallback
  rules above.
- `SIGHUP`, `SIGINT`, and `SIGTERM` exit with `129`, `130`, and `143` after tracked
  child processes close and cleanup finishes.

A successful run prints `Selected:`, `Output:`, and `Verified:` lines, then a `Report:`
block with the source and output paths, dimensions, frame count, duration, frame rate,
byte count against `MAX_BYTES` with the remaining headroom, loop mode, the winning
backend parameters, the VMAF score, and a SHA-256 digest of the published file, followed
by one `Check: PASS ...` line per assertion the converter made and a closing
`Verification: complete` line. Pass `--json` to get the same fields as a `result` object
instead, for example when relaying structured data or piping to another tool.

Tell the user the output path, the byte count against the limit, and the VMAF score, then
stop. The full report is already in the terminal if they want the rest. Do not describe
the GIF as visually identical to the source. Its frame rate can differ from the source.
Each GIF frame uses a palette with at most 256 entries.

## Platform verification

- macOS: all four direct converters and same-backend Node.js/Bash output parity are
  verified with a real generated fixture.
- Ubuntu Linux: supported, but a disposable real-toolchain run is not yet verified.
- WSL2: supported by design through the Linux branch. Signal, process-group, mounted
  filesystem, and real-conversion verification are blocked until an actual WSL2 host is
  available. Do not describe WSL2 as verified from Docker or mocked platform tests.
