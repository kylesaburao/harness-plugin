---
name: convert-video-to-gif
description: Convert a video to a small looping GIF on macOS with a strict byte budget and VMAF-based quality selection. Use the established FFmpeg and gifsicle mode by default, or the secondary gifski mode only when the user explicitly asks for or suggests gifski. Use when the user asks to turn a .mov, .mp4, or screen recording into a GIF, to shrink an existing GIF under a size limit, or to produce a GIF small enough to attach to an issue, a pull request, or a chat message. Do not use on Linux or Windows, and do not use when the user wants a video file rather than a GIF.
---

# Convert a video to a GIF

Both modes are quality searches, not one-shot encodes. They measure completed candidates,
score every fitting candidate with VMAF, regenerate the winner, and verify it before
publication. The established mode searches FFmpeg palette and dither settings. The
secondary mode searches bounded gifski quality profiles.

macOS only. Both modes need `ffmpeg` with `libvmaf` and `ffprobe`. The default mode also
needs `gifsicle`. The secondary mode needs `gifski` instead.

## Workflow

1. Every path below is relative to the skill directory, not the current working directory.
   When they differ, prefix the script with the absolute skill directory path, for example
   `bash /path/to/convert-video-to-gif/scripts/mov-to-gif.sh --preflight --json`.

2. Select the mode before preflight. Use `mov-to-gif.sh` unless the user explicitly asks
   for or suggests gifski. In that case, use `mov-to-gif-gifski.sh`. Do not silently
   substitute one mode for the other.

3. Run only the selected mode's preflight before you promise the user anything:

   ```sh
   bash scripts/mov-to-gif.sh --preflight --json
   # Explicit gifski request only:
   bash scripts/mov-to-gif-gifski.sh --preflight --json
   ```

   Exit status 0 means the machine can run the conversion. Exit status 2 means it cannot.

4. If the preflight fails, relay its `failures` list verbatim, each `condition` with its
   `remedy`. Do not run your own diagnosis, do not inspect `ffmpeg` yourself, and do not
   try the conversion anyway. The selected preflight already checked the operating
   system, its required commands, and the media capabilities its search needs.

5. Ask the user before installing anything. `brew install ffmpeg gifsicle` and
   `brew install gifski` modify their machine.

6. Convert with the selected mode:

   ```sh
   bash scripts/mov-to-gif.sh INPUT_VIDEO [OUTPUT.gif]
   # Explicit gifski request only:
   bash scripts/mov-to-gif-gifski.sh INPUT_VIDEO [OUTPUT.gif]
   ```

   Without an output path the script writes `<input-basename>_<size>x<size>.gif` next to
   the input. Progress goes to stderr and the result summary to stdout.

7. Warn the user first if the run will be long. The default search is 10 frame rates x 253
   palette sizes x 4 dither strengths, so it can take several minutes and will use most of
   the machine's cores. With the default quality bounds, the gifski mode tests at most 29
   profiles per frame rate. It runs no more than two internally multithreaded gifski
   encoders at once. Narrow either mode with the environment variables below when the
   user wants a faster answer.

## Tuning

Set these as environment variables, not flags:

| Variable | Default | Effect |
| --- | --- | --- |
| `MAX_BYTES` | 256000 | Byte budget the output must come in under |
| `GIF_SIZE` | 128 | Output width and height in pixels, always square |
| `MIN_FPS` / `MAX_FPS` | 15 / 24 | Frame-rate range to search |
| `JOBS` | logical CPUs minus 2 | Parallel workers |
| `KEEP_WORK` | unset | Set to `1` to keep the intermediate work directory |

The gifski mode also accepts:

| Variable | Default | Effect |
| --- | --- | --- |
| `MIN_QUALITY` / `MAX_QUALITY` | 20 / 100 | Shared bounds for gifski's overall, motion, and lossy quality search |

The gifski mode treats `JOBS` as an upper bound and caps simultaneous encoders at two
because each gifski process is internally multithreaded.

To cut runtime, pin the frame rate with `MIN_FPS=15 MAX_FPS=15`.

## Reading the result

Exit status tells you what happened without parsing prose:

- `0`, and stdout reports the selected frame rate, encoder parameters, VMAF score, output
  path, and the verified dimensions, frame count, duration, and byte size.
- `2`, cannot start. Bad usage, a failed preflight, an unreadable input, or an unusable
  output path. The `remedy` field says what to change.
- `1`, the search ran and failed. The most common cause is `no_candidate`, meaning nothing
  fit under `MAX_BYTES`. Raise `MAX_BYTES` or lower `GIF_SIZE`. For gifski, narrowing the
  FPS range or lowering `MIN_QUALITY` can also help. Do not silently retry with different
  settings.

Report the VMAF score the script selected. Do not describe the output as visually
identical to the source: it is a 256-color GIF at a reduced frame rate, and VMAF is the
only quality claim available here.

Gifski often improves perceptual quality at the same byte ceiling, especially for motion,
gradients, and changing colors. Each encode can use more CPU, and gifski is not guaranteed
to outperform the default mode for every source.
