---
name: extract-video-frames
description: "Extract all video frames, or every frame in an inclusive time range, at full resolution. Preserve PQ/HLG HDR as 10-bit HEIC and SDR as lossless PNG. Not for sampled frames, resizing, frame-rate conversion, deinterlacing, or tone mapping."
compatibility: Requires Node.js 20.6.0 or newer, macOS 26.0 or newer, the macOS Command Line Tools, and ffmpeg-full with ffprobe, zscale, PNG, and TIFF support.
---

# Extract full-quality video frames

Extract each presented frame once at its coded resolution. SDR becomes lossless sRGB
PNG, using 8-bit channels for an 8-bit source and 16-bit channels for a higher-depth
source. PQ and HLG HDR become quality-1.0 10-bit HEIC with the matching BT.2100 PQ or
HLG transfer. HEIC encoding is lossy. The conversion never tone-maps HDR.

The entrypoint is the only supported execution path. It inspects the input, selects the
first non-attached-picture video stream, constructs the FFmpeg filter graph, extracts
into a temporary sibling, checks the result, and publishes the completed directory.
Do not recreate or modify its FFmpeg commands.

## Constraints

- Output is always `<input-stem>-frames` beside the path the caller supplied. There is
  no output override. A symlink input therefore publishes beside the symlink, not its
  resolved target.
- Existing output is never replaced. Move or remove an existing output only when the
  user explicitly asks. Publication reserves the destination atomically and fails if a
  file, directory, or symlink appears there first.
- Frames are named `frame-000001.png` or `frame-000001.heic`. There is no manifest and
  no per-frame timestamp map. The result reports only the first and last included PTS.
- Every decoded presentation frame in the selected interval is emitted once. Sample
  aspect ratio and interlacing are preserved. Exact right-angle rotations and axis
  flips are applied explicitly by FFmpeg. Scale, shear, perspective, and arbitrary
  rotations are rejected.
- Color metadata must be complete and internally consistent. Ambiguous SDR or HDR,
  unsupported HDR conversion, and Dolby Vision without a usable PQ or HLG base layer
  are rejected instead of guessed, tone-mapped, or degraded.

## Time windows

`--start` and `--end` are independently optional and inclusive. Values are decimal
seconds or `HH:MM:SS[.fraction]`, with at most nine fractional digits. Time zero is the
first presented frame, regardless of the container's starting timestamp.

The script rejects negative, malformed, reversed, or out-of-range bounds. A point
window is valid only when a frame exists exactly at that timestamp. A valid interval
containing no frame fails during preflight with `window_empty` and creates nothing.

## Workflow

Resolve the script relative to this skill directory, not the caller's working directory.

1. Run an input-aware preflight because a full extraction can create many large files:

   ```sh
   node scripts/extract-video-frames.js --preflight --json [--start TIME] [--end TIME] INPUT_VIDEO
   ```

   This checks metadata, timestamps, the requested window, and the complete display
   matrix. For HDR it converts one representative frame through the same TIFF-to-HEIC
   path used by extraction, validates its 10-bit BT.2100 profile with `sips`, and removes
   both files. For SDR it decodes one representative frame to a null sink. It creates no
   output artifact.

2. If preflight succeeds, dispatch the same request without `--preflight`:

   ```sh
   node scripts/extract-video-frames.js --json [--start TIME] [--end TIME] INPUT_VIDEO
   ```

   The normal command repeats the same preflight before it writes anything. In plain
   mode it emits periodic progress to stderr. JSON mode suppresses progress and reserves
   stdout for one final result object.

3. On failure, relay every reported `code`, `condition`, and `remedy` verbatim. Do not
   independently replace the remedy. Ask before running any installation command.

4. On success, relay the output directory, frame count, format/depth, dynamic-range
   classification, dimensions, and actual first/last PTS from the script's report. Do
   not run ffprobe, ffmpeg, file, stat, a viewer, a checksum tool, or another inspection
   command afterward. The entrypoint already reports the published artifact.

Use `--preflight --json` without an input to check the complete toolchain with a synthetic
HLG TIFF-to-HEIC conversion. Window flags require an input.

## Result contract

- Exit `0`: passed preflight or completed and published.
- Exit `2`: work never started because usage, environment, input, color, transform,
  window, or destination validation failed.
- Exit `1`: extraction, structural checking, source-stability checking, or publication
  failed after work began.
- `SIGHUP`, `SIGINT`, and `SIGTERM` exit `129`, `130`, and `143` after child termination
  and temporary-output cleanup.

Plain failures use `ERROR [code]: condition` followed by `Remedy: ...`. JSON failures
use `{"error":{"code","condition","remedy"}}`. A capability preflight can include a
`failures` array containing the same stable triples.

A successful JSON run returns `{"result": ...}` with supplied and resolved input paths,
selected stream, output directory, source and output color properties, PNG or HEIC
encoding, alpha, dimensions, orientation, aspect ratios, requested window, actual first
and last PTS, frame count, and structural checks. No field claims per-frame hashing or
complete image decoding.

## Platform status

- macOS 26.0 or newer: supported.
- Older macOS, Linux, WSL2, and native Windows: rejected.

Node.js 20.6.0 is the supported runtime floor. The script has no npm dependencies.

Media processing fails on a child signal, a nonzero exit, or any FFmpeg/ffprobe error-level diagnostic, including exit zero.
Capability listings are exempt. FFmpeg progress uses stdout internally and does not count as a media diagnostic.
On failure, also relay `task`, `childExitCode`, `childSignal`, and captured `stderr` when present.
Preserve zero exit codes and null signal values in the diagnosis. Reported decode errors prevent publication.
