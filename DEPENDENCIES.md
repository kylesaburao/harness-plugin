# Dependencies

This is the authoritative dependency inventory for repository development and plugin use. It distinguishes runtime requirements, setup-only tools, generated data, and platform restrictions. Package manifests, lockfiles, executable preflights, and the Dockerfile implement these requirements. Keep this document consistent with them. Skill-local instructions remain self-contained because this root document is not shipped with the plugin.

## 1. Development

On macOS, run development commands and tests directly on the host. On Linux, including WSL2, use the development container. Editing and Git operations stay on the host. Container lifecycle commands and failure remedies are in [CONTAINER.md](CONTAINER.md).

### macOS host

| Install or provide | Requirement and purpose |
| --- | --- |
| Git, POSIX shell, and standard command-line utilities | Checkout operations, shell-based tests, and hooks. Backup integration tests also require `unzip`. `ripgrep` is used for repository searches. |
| Node.js and npm | Node.js **26.0.0 or newer** satisfies the highest Node minimum across the full test gate, including `wake-desktop`. npm installs the backup dependencies. |
| Python 3 with `venv` and pip | Creates the repository's `.venv` and runs the ASD-STE100 tests and reference tools. Python and `pypdfium2` versions are not pinned by the setup script. Use an interpreter supported by the installed `pypdfium2` package. |
| `archiver` | Direct npm dependency `^8.0.0`, with exact resolved packages in the backup skill's `package-lock.json`. Installed by setup in that skill's `node_modules`. |
| `pypdfium2` and the generated ASD reference bundle | Setup installs `pypdfium2` into `.venv` and initializes the bundle under `~/.harness-plugin/write-asd-ste100/bundles/`. Both are required by the full development gate. |
| FFmpeg and matching `ffprobe` | GIF tests require working `libvmaf` with its built-in models, including `vmaf_v0.6.1`, plus the media capabilities described under plugin use below. Test fixtures additionally require `libx264` encoding. |
| Both `gifski` and `gifsicle` | The full gate runs both converter preflights and backend tests. Installing only the default backend is insufficient for development. |
| macOS **26.0 or newer**, Command Line Tools, and `ffmpeg-full` | Required for native frame-extraction execution and its platform-specific tests. Command Line Tools supply `swiftc` and the macOS SDK. The FFmpeg build needs `zscale`, PNG, TIFF, and `libx265` for frame-test fixtures. System `sw_vers`, `sips`, and `/usr/bin/osascript` must be available. |
| Network access and writable storage | Initial npm/pip installation and reference download need network access. Allow space for dependencies, generated references, temporary media, and test outputs. |

Expose the intended `ffmpeg` and its matching `ffprobe` on `PATH` for GIF commands and tests. Frame extraction also searches the standard Homebrew `ffmpeg-full` installation paths. Homebrew is the documented provisioning route for `ffmpeg-full`, not an additional requirement when equivalent usable binaries are already installed.

Once host runtimes and media tools are installed, run from the checkout:

```sh
node scripts/setup-tests.js
node scripts/run-tests.js
```

Setup runs `npm ci --omit=dev` for backup, creates or reuses `.venv`, installs `pypdfium2`, and initializes references. It does not install Node, Python, or media executables. Rerun setup after dependency or reference-configuration changes. The test command validates dependencies without installing them. `--skip-gif` omits GIF tests and preflights only. Platform-specific skips do not establish macOS frame-extraction coverage.

### Linux host and container

The host needs local Docker with a working daemon, Git, a POSIX shell and standard POSIX utilities, a checkout, and a normal non-root account with Docker access. WSL2 needs Docker integration enabled. Host Node, Python, npm, and media tools are not required.

```sh
./scripts/dev build
./scripts/dev setup
./scripts/dev exec node scripts/run-tests.js
```

The [Dockerfile](Dockerfile) supplies the following development toolchain. These image selections are not minimum versions required of plugin users.

| Layer | Installed items |
| --- | --- |
| Runtime image | `node:26-trixie` with Node and npm, Debian Python 3 and venv support, Git, ripgrep, CA certificates, gifsicle, and the inherited shell/system utilities, including `unzip`. |
| Media runtime | FFmpeg **8.0.3**, VMAF **3.2.0**, and gifski **1.34.0**. FFmpeg is built with `--enable-libvmaf --enable-gpl --enable-libx264`. The image includes libvmaf and Debian `libx264-164` runtime libraries. |
| C/C++ builder only | `build-essential`, curl, CA certificates, Meson, Ninja, NASM, pkg-config, `libx264-dev`, and `xxd`. `xxd` embeds the VMAF models. Source unpacking uses tar and xz from the base image. |
| Rust builder only | Rust and Cargo from `rust:1-trixie`, used to build gifski with its locked dependency graph. |
| Setup volumes | The same backup npm dependencies, Python virtual environment, `pypdfium2`, and ASD reference bundle as native development. |

Dependencies persist in volumes masking `.venv`, the backup skill's `node_modules`, and `/home/node`. They do not replace host dependencies. Setup needs network access. Ordinary commands never build or install implicitly. After incompatible runtime changes, stop development commands, reset the dependency volumes, rebuild, and run setup again.

The Linux container cannot execute the macOS-only frame-extraction skill. It runs the portable tests and reports platform skips. See [CONTAINER.md](CONTAINER.md#verified-on-2026-09-06) for recorded platform verification. Docker Desktop on macOS remains available for explicit container development and validation, while ordinary macOS development runs natively.

Development requirements are implemented by [setup-tests.js](scripts/setup-tests.js), [run-tests.js](scripts/run-tests.js), [scripts/dev](scripts/dev), and the [Dockerfile](Dockerfile).

## 2. Using the plugin

Install the plugin into Codex or Claude Code using the [README installation instructions](README.md#install). The harness must support the plugin format and have the tools and permissions needed by the selected skill. There is no plugin-wide npm or Python installation step. Install only the dependencies for the skills you use. Docker is development tooling, not a plugin runtime requirement.

| Skill or component | Runtime and other requirements |
| --- | --- |
| `back-up-directories` | Node.js **22.12.0 or newer** and `archiver` **^8.0.0**. npm and network access are needed to install it. Requires a user-owned backup configuration, readable source files, writable destinations, enough free space, and interactive user confirmation. See [backup setup](plugins/harness/skills/back-up-directories/INSTALL.md). No system ZIP executable is required by the skill. |
| `create-discord-emoji-gif` | Node.js **22.0.0 or newer**, FFmpeg with working libvmaf models, matching `ffprobe`, and **gifski** for the default backend or **gifsicle** for the alternate backend. No npm packages. macOS and Linux are supported, including the Linux path under WSL2. Native Windows is unsupported. Requires decodable input and writable output/temporary storage. |
| `extract-video-frames` | Node.js **20.6.0 or newer**, macOS **26.0 or newer**, Command Line Tools (`swiftc` and SDK), and `ffmpeg-full` with matching `ffprobe`. Requires `zscale`, PNG and TIFF encoding, and the system `sw_vers`, `sips`, and `/usr/bin/osascript` commands. Its Swift helper uses the system CoreGraphics, CoreImage, Foundation, and ImageIO frameworks for HEIC. These platform requirements apply to SDR as well as HDR. No npm packages. See the [skill contract](plugins/harness/skills/extract-video-frames/SKILL.md). |
| `wake-desktop` | Node.js **26.0.0 or newer** on macOS or Linux, with UDP broadcast access to the target LAN. Waiting additionally needs system `ping` on PATH and ICMP permission, neither is needed for `--no-wait`. The target needs a wake-capable adapter and firmware/network settings. WSL2 NAT and container networking can prevent delivery despite a successful send. No npm packages. Optional named targets live at `~/.harness-plugin/wake-desktop/config.json` (schema version 1). `manage-targets.js` owns atomic writes and needs only Node and filesystem access, on any platform. Wake execution reads this file only with `--target` and never writes it. Tests simulate networking and need no ping installation or physical target. |
| `write-asd-ste100` | Python 3 and a valid generated ASD-STE100 reference bundle. Normal checking, lookup, and validation use only the Python standard library and do not use the network. Reference generation additionally requires `pypdfium2` and the pinned source PDF. See initialization below. |
| `diagnose-environment` | No fixed additional runtime or package. Needs shell and filesystem access to the environment being diagnosed, using its available tools. |
| `inspect-development-environment` | No fixed additional runtime or package. Needs local, unprivileged shell/filesystem access on macOS or Linux and a writable report directory. Inventories available tools without installing missing ones. |
| `record-decision` | No additional runtime or package. Needs access to the decision context and permission to write the requested record. |
| `research-precedent` | No fixed additional runtime or package. Needs repository/history access (Git for local history) and the available search/retrieval tools for external evidence. Unreachable source classes are reported as coverage gaps. |
| Output styles | Claude Code only, with no additional runtime or package dependencies. Codex consumes the skills and ignores these styles. |

### Media capabilities

FFmpeg, gifski, and gifsicle do not have a numeric minimum enforced by the converters. Their executable preflights check required capabilities. The container versions above are a verified combination, not a replacement for those checks.

For both GIF backends, FFmpeg needs `fps`, `scale`, `format`, `setpts`, and `libvmaf`, plus rawvideo, FFV1, GIF decoding, Matroska, and null output. The gifski path also needs YUV4MPEG pipe support. The gifsicle path adds `palettegen`, `paletteuse`, PNG/GIF encoding, PNG decoding, NUT, and image2 support. Input-specific codecs must also be available. `ffprobe` must support JSON output, stream selection, entry selection, and frame counting. The backend tools must expose the options checked by [shared.js](plugins/harness/skills/create-discord-emoji-gif/scripts/node/shared.js).

For frame extraction, FFmpeg additionally needs `select`, `transpose`, `hflip`, `vflip`, image2 output, and the RGB/RGBA pixel formats checked by [extract-video-frames.js](plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js). `libx264` and `libx265` are development fixture dependencies, not universal prerequisites for converting an existing supported input.

### Initialization and upgrades

For backup, run `npm install --omit=dev --prefix <installed-backup-skill-directory>` as detailed in its [INSTALL.md](plugins/harness/skills/back-up-directories/INSTALL.md). `node_modules` is not shipped. Repeat installation if a plugin upgrade replaces the installed cache directory.

For ASD-STE100, use a Python virtual environment with pip and `pypdfium2` to run `<installed-writer-skill-directory>/scripts/initialize_references.py`. The initializer downloads the PDF pinned by [source-config.json](plugins/harness/skills/write-asd-ste100/references/source-config.json), or accepts that PDF through `--pdf PATH`. Importing a valid existing bundle with `--import-from DIR` needs neither `pypdfium2` nor a download. See [writer setup](plugins/harness/skills/write-asd-ste100/INSTALL.md).

The reference bundle lives under `~/.harness-plugin/write-asd-ste100/bundles/<source-config-sha256>/`, shared between harnesses and retained across plugin upgrades. A changed source configuration requires a matching valid bundle. Keep any initialization virtual environment outside the installed plugin directory so cache replacement does not discard it.

Skill commands perform their own preflight on normal execution. Follow each skill's dispatch contract and relay its exact failure diagnosis and remedy. A standalone preflight is for an explicit readiness check or a skill-specific requirement, not an automatic extra step before every run.
