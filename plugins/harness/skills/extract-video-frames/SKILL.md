---
name: extract-video-frames
description: Extract every presented frame from a video as lossless full-resolution images, preserving HDR as linear float OpenEXR and SDR as PNG. Use when the user wants all video frames, or all frames inside an inclusive time window, without frame-rate conversion, resizing, deinterlacing, or tone mapping.
compatibility: Untested working draft. Requires Node.js 20.6.0 or newer, macOS 26.0 or newer or Linux/WSL2, plus ffmpeg and ffprobe with zscale, PNG, and OpenEXR support.
---

# Extract full-quality video frames

> **Status: untested working draft.** The deterministic entrypoint and its tests have
> been authored but not executed. Do not describe this skill as verified.

Extract each presented frame once at its coded resolution. SDR becomes lossless sRGB
PNG, using 8-bit channels for an 8-bit source and 16-bit channels for a higher-depth
source. PQ and HLG HDR become losslessly compressed, linear-light BT.2020 OpenEXR with
32-bit floating-point RGB or RGBA channels. The conversion never tone-maps HDR.

The entrypoint is the only supported execution path. It inspects the input, selects the
first non-attached-picture video stream, constructs the FFmpeg filter graph, extracts
into a temporary sibling, checks the result, and publishes the completed directory.
Do not recreate or modify its FFmpeg commands.

## Constraints

- Output is always `<input-stem>-frames` beside the path the caller supplied. There is
  no output override. A symlink input therefore publishes beside the symlink, not its
  resolved target.
- Existing output is never replaced. Move or remove an existing output only when the
  user explicitly asks.
- Frames are named `frame-000001.png` or `frame-000001.exr`. There is no manifest and
  no per-frame timestamp map. The result reports only the first and last included PTS.
- Every decoded presentation frame in the selected interval is emitted once. Sample
  aspect ratio and interlacing are preserved. Exact right-angle display transforms are
  applied by FFmpeg; other rotations are rejected.
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

Use `--preflight --json` without an input only to check Node, the platform, FFmpeg, and
ffprobe. Window flags require an input.

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
selected stream, output directory, source and output color properties, PNG or OpenEXR
encoding, alpha, dimensions, orientation, aspect ratios, requested window, actual first
and last PTS, frame count, and structural checks. No field claims per-frame hashing or
complete image decoding.

## Platform status

- macOS 26.0 or newer: supported by design; this draft has not been executed there.
- Linux and WSL2: supported by design; this draft has not been executed there.
- Older macOS and native Windows: rejected.

Node.js 20.6.0 is the supported runtime floor. The script has no npm dependencies.
