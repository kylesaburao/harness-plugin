# Platform validation records

[Development](README.md) / Historical evidence

These dated records preserve the environments, commands, results, and limitations of prior runs. Use [testing](testing.md) for current contributor instructions.

## Verified on 2026-09-06

Docker Desktop Linux ARM64 was tested with 16 CPUs and approximately 8 GB of Docker memory. These are execution results for this platform, not inferred coverage of the other targets.

| Check | Result |
|---|---|
| Fresh image build and dependency setup | Passed. Setup and a cached rebuild also ran with a minimal host PATH without Node or Python. |
| `./scripts/dev exec node scripts/run-tests.js` | Passed. 266 Node tests and 109 Python tests passed. Nine platform-specific frame-extraction tests were skipped. Both GIF preflights and real converter/VMAF tests passed. |
| libx264 fixture encoding | Passed with a 60-second H.264 fixture. |
| SIGTERM during each real converter's FFmpeg work | Passed. Each returned 143, published no GIF, and left no container or subprocess namespace. |
| Launcher lifecycle | Passed. Quoting, stdin, separate output streams, exit 37, interactive TTY, source visibility, container-created file UID/GID, dependency isolation, cross-container persistence, busy-volume refusal, repeat setup, and reset. |
| Setup failure | Passed. Forced npm permission failure returned 243 and stopped setup. Restoring permissions and rerunning setup succeeded. |
| Host state | Passed. Existing dependency markers and checkout Git configuration remained unchanged. |
| Independent checkout | Passed. Separate dependency state and source paths containing spaces, a comma, and a double quote worked without Git history. |
| Toolchain cache after source-only edits | Passed. All toolchain layers were cached after documentation changes. |
| Linux amd64 | Skipped. No native amd64 host available. |
| Native Linux ARM64 | Not available: no native Linux ARM64 host. ARM64 container verification uses Docker Desktop on Apple silicon; native Linux host integration remains untested and is not a blocking verification task. |
| Windows through WSL2 | Skipped. No WSL2 host available. |
| macOS HEIC execution | Skipped. Requires separate macOS validation. |

The first media gate exposed missing VMAF models. Adding the builder's `xxd` dependency fixed it. The Dockerfile now exercises VMAF scoring and libx264 encoding during every uncached final-image build.

## Linux amd64 verified on 2026-09-08

Native Linux Docker on Ubuntu 26.04.1 LTS was tested at commit `a2a54a7a57d20bdc8a7232cd1dc0d9ee02e93de8`, with 4 CPUs and 7,392,616,448 bytes (approximately 6.9 GiB) of Docker memory. The daemon reported `linux/x86_64` and container Node reported `x64`.

The agent process retained an old supplementary group list after the account was added to `docker`. Commands ran through `sg docker -c './scripts/dev ...'`, using UID 1000 and GID 983; direct Docker access from that process still failed. This exercised the normal non-root launcher with Docker group access.

| Check | Result |
|---|---|
| Fresh image build and dependency setup | Passed. Built the amd64 toolchain from source, including the final-image VMAF/libx264 runtime check. Installed backup dependencies, pypdfium2, and the validated 2,195-row ASD reference bundle. |
| `./scripts/dev exec node scripts/run-tests.js` | Passed in 44.632 seconds: 308 Node tests and 112 Python tests passed, none failed, and 13 macOS-specific frame-extraction tests were skipped. Both GIF preflights and real converter/VMAF tests passed. Node pool and full-search workers: 4; retained-scenario concurrency: 1. |
| libx264 fixture encoding | Passed with a 60-second, 640×360, 30 FPS H.264 fixture. |
| SIGTERM during each real converter's FFmpeg work | Passed. Each returned 143, published no GIF, and left no container. |
| Launcher lifecycle | Passed against real Docker: argument quoting, stdin, separate output streams, exit 37, interactive TTY, source visibility, container-created file UID/GID, dependency isolation, cross-container persistence, active-volume setup/reset refusal, repeat setup, and reset. |
| Setup failure | Passed. An injected npm permission failure returned 243 and stopped before Python/reference setup. Restoring permissions and rerunning setup succeeded. |
| Host state and independent checkout | Passed. A temporary checkout without Git history, with spaces, a comma, and a double quote in its path, used separate dependency state. Host dependency markers survived setup and reset. The primary checkout's Git configuration remained unchanged; Docker created only empty host dependency mount-point directories. |
| Minimal host PATH and toolchain cache | Passed. Repeat setup and a rebuild after a source-only change worked with no host Node or Python on PATH. All toolchain layers were cached. |

Reset and failure injection used only the temporary checkout's volumes. Those three volumes and its temporary image tag were removed afterward; the primary checkout's image and initialized dependency volumes were retained. The earlier ARM64 results above remain historical results for their recorded revision. Native Linux ARM64, WSL2, and macOS HEIC execution were not verified by this run.

## Native macOS verified on 2026-09-07 (PDT)

Tested revision: `f095c544982bd1d7906ff4854daac99fe9cb2f4a`, with a clean starting checkout. Commands ran directly on macOS, without Docker. The host reported macOS 26.6.2 (25G83), ARM64, model Mac17,9, 18 CPUs, and 51,539,607,552 bytes (48 GiB) of memory. This date is local PDT (2026-09-08 UTC).

Environment checks used `sw_vers`, `uname -m`, `sysctl -n hw.model hw.ncpu hw.memsize`, `xcode-select -p`, `pkgutil --pkg-info com.apple.pkg.CLTools_Executables`, `xcrun swiftc --version`, and `xcrun --show-sdk-version`. Command Line Tools were installed at `/Library/Developer/CommandLineTools`, package version 26.6.0.0.1781586589, with Swift 6.3.3 and SDK 26.5. Node was v26.5.0, Python (host and `.venv`) 3.14.7, pypdfium2 5.13.0, archiver 8.0.0, gifski 1.34.0, and gifsicle 1.96.

The extraction readiness report selected the matching FFmpeg/ffprobe pair under `/opt/homebrew/Cellar/ffmpeg-full/9.0.1_1/bin/`. The PATH pair used by GIF tests was Homebrew FFmpeg 9.0.1 (`ffmpeg/9.0.1_1`). Extraction capability checks passed for `zscale`, `select`, `setpts`, `format`, `transpose`, `hflip`, `vflip`, PNG/TIFF encoders, image2, and RGB/RGBA pixel formats. Real fixture generation exercised libx264 and libx265.

| Check | Observed result |
|---|---|
| `node scripts/setup-tests.js --check` | Passed. Existing dependencies were usable, so initialization was unnecessary. The full gate also validated the ASD reference bundle and both GIF converter preflights. |
| `node scripts/run-tests.js` | Passed with native host access in 18.192 seconds: 321 Node tests and 112 Python tests, zero failures, skips, cancellations, or todos. Node pool and full-search workers: 18, retained-scenario concurrency: 4. The initial sandboxed gate also passed all 433 tests in 18.876 seconds. |
| macOS frame-extraction tests | Passed: 57 tests, zero skips, including all 13 cases skipped on Linux. Native host-access group elapsed time: 7.165 seconds. |
| SDR depth and duration | Passed real `rgb48be`, `rgba64be`, `gray16be`, and `yuv420p` extraction. Tests checked 16-bit versus 8-bit PNG output, fractional source duration, more than 256 surviving RGB values, and exact 16-bit alpha preservation. |
| Native publication | Passed real `/usr/bin/osascript` publication and refusal to replace an existing empty directory. SDR and supplemental HDR CLI runs published their output directories. |
| HDR preflight routing | Passed SDR decode without Swift compilation and HDR/synthetic compilation dispatch. These two compilation-dispatch tests deliberately inject a compiler failure sentinel, so they alone do not verify HEIC encoding. |
| Interruption cleanup | Passed SIGTERM during HDR encoding and verification, exit 143, no published output, and removal of TIFF/HEIC partial directories and helper directories. These tests use real FFmpeg fixtures with injected encoder/compiler/sips behavior to control interruption timing. |
| Crash diagnostics | Passed plain and JSON CLI tests with an injected child SIGTERM: exit 1, `extraction_failed`, task `extraction`, null child exit code, signal and stderr retained, no published output or partial directory. Portable tests also cover SIGSEGV evidence and exit-zero media diagnostics. |
| Real HDR/HEIC processing | Passed environment-only synthetic HLG preflight, then input-aware preflight and full extraction for separate HLG and PQ fixtures using real Swift/Core Image. Each published two 64×64 10-bit HEIC frames, PTS 0 and 0.5 seconds. Entrypoint structural reports confirmed matching BT.2100 HLG/PQ profiles on both frames, nonempty files, and unchanged source identity. |

The first environment-only HEIC preflight in the managed sandbox returned exit 2, `heic_encode_failed`, with Core Image `nilError`. Repeating the identical command with native host media-service access passed. This isolates an execution-environment restriction, not a demonstrated repository defect. No production or test changes were needed. The full test gate can pass inside that sandbox because its HDR lifecycle tests inject the HEIC helper, which is why the additional real encoding checks matter.

Supplemental commands (run with native host media-service access):

```sh
node plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js --preflight --json
fixture_dir=$(mktemp -d /private/tmp/harness-native-hdr-XXXXXX)
for transfer in arib-std-b67 smpte2084; do
  /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg -hide_banner -v error \
    -f lavfi -i 'testsrc2=s=64x64:r=2:d=1' -c:v libx265 \
    -x265-params "log-level=error:colorprim=bt2020:transfer=$transfer:colormatrix=bt2020nc" \
    -pix_fmt yuv420p10le -color_primaries bt2020 -color_trc "$transfer" \
    -colorspace bt2020nc -color_range tv "$fixture_dir/$transfer.mov"
  node plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js \
    --preflight --json "$fixture_dir/$transfer.mov"
  node plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js \
    --json "$fixture_dir/$transfer.mov"
done
```

The recorded run used equivalent argument arrays with fixture names `hlg.mov` and `pq.mov`. Local session evidence is in `/private/tmp/harness-macos-native-gate.log`, `/private/tmp/harness-macos-gate.log`, and `/private/tmp/harness-native-hdr-check.log`. These temporary logs are not repository artifacts.

Remaining coverage gaps: no real-camera HDR footage or human HDR-display/Preview assessment, no quantitative HDR color-fidelity measurement, and no interruption of the actual Core Image encoder (the controlled interruption tests use a substitute). Synthetic HEIC metadata and structural checks do not establish visual HDR rendering. Linux amd64 verification above remains complete. Native Linux ARM64 is unavailable and non-blocking. Windows was outside this run's scope. Earlier container results remain historical results for their recorded revisions.
