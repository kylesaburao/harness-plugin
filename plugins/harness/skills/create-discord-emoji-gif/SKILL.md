---
name: create-discord-emoji-gif
description: Create an animated 128x128 GIF for a Discord emoji, with a strict target of fewer than 256000 bytes and VMAF-based quality selection. Use when the user asks for a Discord emoji GIF or an equivalent animated 128x128 GIF under 256 KB. Prefer clips of 3 seconds or less for better quality. Do not use for general video-to-GIF requests without these size and dimension targets, or when the user wants a video file rather than a GIF.
compatibility: Requires ffmpeg built with libvmaf, plus ffprobe and either gifski or gifsicle. macOS, Linux, or WSL2.
---

# Create a Discord emoji GIF

Create a looping 128x128 GIF that is strictly smaller than 256000 bytes. Clips of 3
seconds or less usually produce better quality within that limit. If the user asks what
this skill is or why it exists, state both the Discord size target and this duration
guidance.

Both scripts search quality settings, score fitting candidates with VMAF, regenerate the
winner, and verify it before publication. Use gifski by default. Use FFmpeg and gifsicle
as the defined fallback.

Both modes need `ffmpeg` built with `libvmaf` and `ffprobe`. The default mode also needs
`gifski`. The fallback needs `gifsicle`. The preflight below detects and reports whichever
of these is missing; it is not scoped to any one operating system.

## Workflow

1. Resolve every path relative to this skill directory, not the current working
   directory. For example:

   ```sh
   bash /path/to/create-discord-emoji-gif/scripts/mov-to-gif-gifski.sh --preflight --json INPUT_VIDEO
   ```

2. If the user explicitly requests FFmpeg and gifsicle, use `mov-to-gif.sh` directly. If
   the user requests a comparison, run both modes. Otherwise, start with gifski:

   ```sh
   bash scripts/mov-to-gif-gifski.sh --preflight --json INPUT_VIDEO
   ```

   `--preflight` without an input checks only the environment. With an input, it also
   validates the video and reports a nonfatal `input_duration_long` warning when the clip
   is longer than 3 seconds.

3. If the gifski preflight exits 2, run the FFmpeg and gifsicle preflight for the same
   input. Use `mov-to-gif.sh` only if that preflight passes. If both preflights fail, relay
   each `failures` list verbatim, including every `condition` and `remedy`.

4. Ask the user before installing anything. Relay the preflight's `remedy` verbatim rather
   than guessing an install command; it already accounts for the platform (for example
   `brew install ffmpeg gifski` on macOS or `sudo apt install ffmpeg gifsicle` plus
   `cargo install gifski` on Linux), and any of these modify the machine.

5. Convert with the selected mode:

   ```sh
   bash scripts/mov-to-gif-gifski.sh INPUT_VIDEO [OUTPUT.gif]
   # Explicit request or fallback:
   bash scripts/mov-to-gif.sh INPUT_VIDEO [OUTPUT.gif]
   ```

   Without an output path, either script writes `<input-basename>_<size>x<size>.gif` next
   to the input. Progress and warnings go to stderr. The result summary goes to stdout.
   A long-clip warning does not reject, trim, or modify the input.

6. If gifski returns `no_candidate`, try `mov-to-gif.sh`. Treat other gifski runtime
   failures as failures. Do not run both modes unless fallback is required or the user
   requests a comparison.

7. Warn the user before a broad search because it can take several minutes and use most
   of the machine's cores. Narrow the search with the environment variables below when
   the user wants a faster result.

## Tuning

Set these as environment variables, not flags:

| Variable | Default | Effect |
| --- | --- | --- |
| `MAX_BYTES` | 256000 | Strict byte ceiling. The output must be smaller. |
| `GIF_SIZE` | 128 | Square output width and height in pixels |
| `MIN_FPS` / `MAX_FPS` | 15 / 24 | Frame-rate range. Gifski accepts at most 100 FPS. |
| `JOBS` | logical CPUs minus 2 | Parallel work limit |
| `KEEP_WORK` | unset | Set to `1` to keep the intermediate work directory |

The gifski mode also accepts:

| Variable | Default | Effect |
| --- | --- | --- |
| `MIN_QUALITY` / `MAX_QUALITY` | 1 / 100 | Gifski quality search bounds |

The gifski mode uses `min(FPS count, max(1, JOBS / 2))` simultaneous encoder workers.
Each encoder receives `RAYON_NUM_THREADS = clamp(JOBS / encoder workers, 2, 8)`.

To reduce runtime, pin the frame rate with `MIN_FPS=15 MAX_FPS=15`.

## Reading the result

- Exit `0` means the preflight passed or the conversion succeeded.
- Exit `2` means work did not start because of usage, environment, input, or output
  validation. Relay the reported remedy.
- Exit `1` means conversion work started and failed. Fall back from gifski only when the
  error code is `no_candidate`.

Report the selected VMAF score. Do not describe the GIF as visually identical to the
source. Its frame rate can differ from the source. Each GIF frame uses a palette with at
most 256 entries.
