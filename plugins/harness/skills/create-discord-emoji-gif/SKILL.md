---
name: create-discord-emoji-gif
description: Create an animated 128x128 GIF for a Discord emoji, with a strict target of fewer than 256000 bytes and VMAF-based quality selection. Use when the user asks for a Discord emoji GIF or an equivalent animated 128x128 GIF under 256 KB. Prefer clips of 3 seconds or less for better quality. Do not use for general video-to-GIF requests without these size and dimension targets, or when the user wants a video file rather than a GIF.
compatibility: Requires Node.js 22.0.0 or newer for the default flow, ffmpeg built with libvmaf, ffprobe, and either gifski or gifsicle. Bash alternatives support macOS, Linux, and WSL2 without Node.js.
---

# Create a Discord emoji GIF

Create a looping 128x128 GIF that is strictly smaller than 256000 bytes. Clips of 3
seconds or less usually produce better quality within that limit. If the user asks what
this skill is or why it exists, state both the Discord size target and this duration
guidance.

The Node.js converters are the default. The Bash converters remain supported direct
alternatives. Both runtimes implement the same two backend searches, regenerate the
winner, score it with VMAF, verify it, and publish it atomically. Use gifski by default.
Use FFmpeg and gifsicle as the defined fallback.

Both backends need `ffmpeg` built with `libvmaf` and `ffprobe`. The default backend also
needs `gifski`. The fallback needs `gifsicle`. Each preflight reports all missing or
unsuitable tools and gives platform-specific remedies.

## Select an entrypoint

Resolve paths relative to this skill directory, not the caller's current directory.

| Request and runtime | Entrypoint |
| --- | --- |
| Default, Node.js 22.0.0 or newer | `node scripts/node/mov-to-gif-gifski.js` |
| Explicit gifsicle, Node.js 22.0.0 or newer | `node scripts/node/mov-to-gif.js` |
| Explicit Bash gifski | `bash scripts/bash/mov-to-gif-gifski.sh` |
| Explicit Bash gifsicle | `bash scripts/bash/mov-to-gif.sh` |

Use this procedure:

1. An explicit Bash request selects Bash immediately. Do not probe Node.js.
2. Otherwise, run `command -v node` and `node --version`.
3. Node.js 22.0.0 or newer selects the matching Node.js converter.
4. Missing or older Node.js selects the matching Bash converter.
5. An explicit gifsicle request selects Node.js gifsicle unless Bash was also requested.
6. The default Node.js gifski preflight can fall through to Node.js gifsicle only for
   `command_missing` for gifski, `gifski_probe_failed`, or
   `gifski_capability_missing`.
7. Do not fall through on argument, input, output, FFmpeg, ffprobe, platform, or work
   directory failures.
8. After Node.js conversion work starts, fall through only from Node.js gifski
   `no_candidate` to Node.js gifsicle. Never fall from a started Node.js run to Bash.
9. A normal backend comparison runs both Node.js implementations.
10. A runtime parity comparison runs Node.js and Bash for each matching backend and
    labels all four outputs.

Node.js 22.0.0 is the supported runtime floor. `os.availableParallelism()`, used to
calculate the default `JOBS`, has an API floor of Node.js 18.14.0. The older API floor
does not change the supported runtime floor.

## Workflow

1. Preflight the selected converter. Include the input when one is available:

   ```sh
   node scripts/node/mov-to-gif-gifski.js --preflight --json INPUT_VIDEO
   node scripts/node/mov-to-gif.js --preflight --json INPUT_VIDEO
   bash scripts/bash/mov-to-gif-gifski.sh --preflight --json INPUT_VIDEO
   bash scripts/bash/mov-to-gif.sh --preflight --json INPUT_VIDEO
   ```

   `--preflight` without an input checks only the environment. With an input, it also
   validates the video and reports a nonfatal `input_duration_long` warning when the
   clip is longer than 3 seconds.

2. Relay every preflight diagnosis verbatim, including each stable `code`, `condition`,
   and `remedy`. Do not independently replace its remedy. Ask the user before running
   an installation command because it changes the machine.

3. Convert with the selected direct entrypoint:

   ```sh
   node scripts/node/mov-to-gif-gifski.js INPUT_VIDEO [OUTPUT.gif]
   node scripts/node/mov-to-gif.js INPUT_VIDEO [OUTPUT.gif]
   bash scripts/bash/mov-to-gif-gifski.sh INPUT_VIDEO [OUTPUT.gif]
   bash scripts/bash/mov-to-gif.sh INPUT_VIDEO [OUTPUT.gif]
   ```

   Without an output path, every converter writes
   `<input-basename>_<size>x<size>.gif` next to the input. Progress and warnings go to
   stderr. The result summary goes to stdout. A long-input warning does not reject,
   trim, or modify the input.

4. Warn the user before a broad search because it can take several minutes and use
   most CPU cores. Narrow the search with environment variables when the user wants a
   faster result.

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

Report the selected VMAF score. Do not describe the GIF as visually identical to the
source. Its frame rate can differ from the source. Each GIF frame uses a palette with at
most 256 entries.

## Platform verification

- macOS: all four direct converters and same-backend Node.js/Bash output parity are
  verified with a real generated fixture.
- Ubuntu Linux: supported, but a disposable real-toolchain run is not yet verified.
- WSL2: supported by design through the Linux branch. Signal, process-group, mounted
  filesystem, and real-conversion verification are blocked until an actual WSL2 host is
  available. Do not describe WSL2 as verified from Docker or mocked platform tests.
