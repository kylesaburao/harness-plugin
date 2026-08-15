---
name: convert-video-to-gif
description: Convert a video to a small looping GIF on macOS by searching frame rate, palette size, and dither for the highest VMAF quality that still fits a byte budget. Use when the user asks to turn a .mov, .mp4, or screen recording into a GIF, to shrink an existing GIF under a size limit, or to produce a GIF small enough to attach to an issue, a pull request, or a chat message. Do not use on Linux or Windows, and do not use when the user wants a video file rather than a GIF.
---

# Convert a video to a GIF

The script is a quality search, not a one-shot encode. It generates every combination of
frame rate, palette size, and dither strength inside the configured ranges, scores each
candidate that fits the byte budget with VMAF, and keeps the highest scoring one. It then
regenerates the winner and verifies the published file before writing it.

macOS only. It needs `ffmpeg` (with `libvmaf`), `ffprobe`, and `gifsicle`.

## Workflow

1. Every path below is relative to the skill directory, not the current working directory.
   When they differ, prefix the script with the absolute skill directory path, for example
   `bash /path/to/convert-video-to-gif/scripts/mov-to-gif.sh --preflight --json`.

2. Run the preflight first, before you promise the user anything:

   ```sh
   bash scripts/mov-to-gif.sh --preflight --json
   ```

   Exit status 0 means the machine can run the conversion. Exit status 2 means it cannot.

3. If the preflight fails, relay its `failures` list verbatim, each `condition` with its
   `remedy`. Do not run your own diagnosis, do not inspect `ffmpeg` yourself, and do not
   try the conversion anyway to see what happens. The preflight already checked the
   operating system, all ten required commands, and the `ffmpeg` filters, encoders,
   decoders, muxers, and demuxers the search depends on, including `libvmaf`.

4. Ask the user before installing anything. `brew install ffmpeg gifsicle` modifies their
   machine.

5. Convert:

   ```sh
   bash scripts/mov-to-gif.sh INPUT_VIDEO [OUTPUT.gif]
   ```

   Without an output path the script writes `<input-basename>_<size>x<size>.gif` next to
   the input. Progress goes to stderr and the result summary to stdout.

6. Warn the user first if the run will be long. The default search is 10 frame rates x 253
   palette sizes x 4 dither strengths, so it can take several minutes and will use most of
   the machine's cores. Narrow it with the environment variables below when the user wants
   a faster answer.

## Tuning

Set these as environment variables, not flags:

| Variable | Default | Effect |
| --- | --- | --- |
| `MAX_BYTES` | 256000 | Byte budget the output must come in under |
| `GIF_SIZE` | 128 | Output width and height in pixels, always square |
| `MIN_FPS` / `MAX_FPS` | 15 / 24 | Frame-rate range to search |
| `JOBS` | logical CPUs minus 2 | Parallel workers |
| `KEEP_WORK` | unset | Set to `1` to keep the intermediate work directory |

To cut runtime, pin the frame rate with `MIN_FPS=15 MAX_FPS=15`.

## Reading the result

Exit status tells you what happened without parsing prose:

- `0`, and stdout reports the selected frame rate, palette size, dither, VMAF score,
  output path, and the verified dimensions, frame count, duration, and byte size.
- `2`, cannot start. Bad usage, a failed preflight, an unreadable input, or an unusable
  output path. The `remedy` field says what to change.
- `1`, the search ran and failed. The most common cause is `no_candidate`, meaning nothing
  fit under `MAX_BYTES`. Raise `MAX_BYTES` or lower `GIF_SIZE` and say so, rather than
  silently retrying with different settings.

Report the VMAF score the script selected. Do not describe the output as visually
identical to the source: it is a 256-color GIF at a reduced frame rate, and VMAF is the
only quality claim available here.
