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
