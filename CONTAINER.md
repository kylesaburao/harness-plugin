# Development container

Run temporary command containers against the live host checkout. The agent and Git operations stay on the host. Source edits, including files created by container commands, affect the host checkout immediately.

## First use and daily work

Use a normal non-root account with local Docker, a POSIX shell, Git, and the checkout. Host Node, Python, and media tools are not required. On Windows, run these commands inside WSL2 with Docker integration enabled. On macOS, start Docker Desktop.

```sh
./scripts/dev build
./scripts/dev setup
./scripts/dev exec node scripts/run-tests.js
```

Build creates the toolchain image. Setup explicitly reinstalls the backup skill's npm dependencies with `npm ci`, creates or reuses the Python virtual environment, installs pypdfium2, and initializes ASD-STE100 references through `node scripts/setup-tests.js`. Initial build and setup require network access.

Run a focused test or open a shell with the same source and dependency mounts:

```sh
./scripts/dev exec node --test tests/inventory/readme-inventory.test.js
./scripts/dev shell
```

`exec` preserves argument boundaries, stdin, stdout, stderr, and command exit status without allocating a TTY. Use `sh -c '...'` explicitly when a command needs shell expansion. `shell` allocates an interactive TTY. Both use attached `docker run --rm --init --sig-proxy=true`, with Docker's [signal forwarding](https://docs.docker.com/reference/cli/docker/container/run/). Containers are removed when commands exit.

Ordinary commands never build or install implicitly. Source edits need no preparation. Rerun `setup` after dependency or reference-configuration changes. Run setup and reset only when no development commands are active. The launcher checks for containers using the volumes, but does not lock out concurrent launches.

## Persistence and reset

The checkout is bind-mounted at `/workspace/harness-plugin`. Three named volumes mask `.venv`, `plugins/harness/skills/back-up-directories/node_modules`, and `/home/node`. All use `volume-nocopy`, so host dependencies and image home contents are not imported. Host dependency directories remain untouched. Docker may create empty mount-point directories if they do not exist.

The home volume stores generated references under `/home/node/.harness-plugin/` and dependency caches. Commands use the invoking numeric UID/GID and `HOME=/home/node`. Setup initializes volume-root ownership in a temporary root container that mounts only the three volumes. The source checkout is never mounted into that root container.

Image and volume names use a hash of the checkout's canonical path and invoking UID/GID. Independent checkouts and users have separate dependency state. Moving a checkout or changing UID/GID selects new names and leaves the old resources in Docker. Symlink paths to the same checkout reuse its state.

After incompatible runtime changes, or to reproduce from empty dependency state:

```sh
./scripts/dev reset
./scripts/dev build
./scripts/dev setup
```

Reset removes only this checkout/user's three volumes, including cached dependencies and generated references. Source and image remain. It refuses removal while any container references those volumes, including a stopped container. Finish active commands and remove stopped containers using the volumes before retrying.

## Toolchain and limits

The root Dockerfile uses `node:26-trixie`, Python with venv support, Git, ripgrep, certificates, and Debian gifsicle. Builder stages supply [FFmpeg 8.0.3](https://ffmpeg.org/releases/) with libx264 and `--enable-libvmaf --enable-gpl --enable-libx264`, [VMAF 3.2.0](https://github.com/Netflix/vmaf/releases/tag/v3.2.0), and [gifski 1.34.0](https://github.com/ImageOptim/gifski/releases/tag/1.34.0). Runtime libraries are included in the final image.

Only the Dockerfile enters the build context. Source changes reuse the toolchain cache. Rebuild for toolchain changes. This isolates dependencies but is not an offline or bit-for-bit reproducible build.

Keep commits, pushes, authentication, and checkout Git configuration on the host. No SSH agent or credentials are forwarded. A linked worktree is usable for development commands, but its external Git metadata is not mounted for container Git operations. Development tooling stays outside the shipped plugin.

Targets are local Linux Docker, macOS Docker Desktop, and Windows through WSL2. Remote-daemon source transfer and native PowerShell are unsupported. macOS-only HEIC execution requires separate macOS validation.

## Failure handling

- Missing image: run `./scripts/dev build`.
- Missing volumes, dependencies, or invalid reference state: run `./scripts/dev setup` and inspect its failing command's diagnosis. Setup returns the first failing child's status and does not report partial initialization as success.
- Incompatible dependencies after a runtime change: stop commands, run `./scripts/dev reset`, then build and setup.
- Docker unavailable: start local Docker and check `docker context show`.
- A failed build or setup download requires restored network access and a retry of the same command.

Relay failures from the command that produced them. A failed setup can leave partial volume state, so fix the reported cause and rerun setup before testing. Run the complete gate with `./scripts/dev exec node scripts/run-tests.js`, including both converter preflights. Record platform checks separately and mark unavailable platforms as skipped.

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
