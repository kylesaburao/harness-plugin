# Dependencies

This is the authoritative dependency inventory for repository development and plugin use. It distinguishes runtime requirements, setup-only tools, generated data, and platform restrictions. Package manifests, lockfiles, executable preflights, and the Dockerfile implement these requirements. Keep this document consistent with them. Skill-local instructions remain self-contained because this repository document is not shipped with the plugin.

## 1. Development

On macOS, run development commands and tests directly on the host. On Linux, including WSL2, use the development container. Editing and Git operations stay on the host. Container lifecycle commands and failure remedies are in [container guide](container.md).

### macOS host

| Install or provide | Requirement and purpose |
| --- | --- |
| Git, POSIX shell, and standard command-line utilities | Checkout operations, shell-based tests, and hooks. Backup integration tests also require `unzip`. `ripgrep` is used for repository searches. |
| Node.js and npm | Node.js **26.0.0 or newer** satisfies the highest Node minimum across the full test gate, including `wake-desktop`. npm installs the root build toolchain and separate backup dependencies. |
| Python 3 with `venv` and pip | Creates the repository's `.venv` and runs the ASD-STE100 tests and reference tools. Python and `pypdfium2` versions are not pinned by the setup script. Use an interpreter supported by the installed `pypdfium2` package. |
| TypeScript and Node type definitions | Root development-only exact pins: `typescript` **7.0.2** and `@types/node` **20.19.43**, installed with `npm ci --include=dev`. They do not ship and do not raise skill runtime floors. |
| `archiver` | Direct npm dependency `^8.0.0`, with exact resolved packages in the backup skill's `package-lock.json`. Installed by setup in that skill's `node_modules`. |
| `pypdfium2` and the generated ASD reference bundle | Setup installs `pypdfium2` into `.venv` and initializes the bundle under `~/.harness-plugin/write-asd-ste100/bundles/`. Both are required by the full development gate. |
| FFmpeg and matching `ffprobe` | GIF tests require working `libvmaf` with its built-in models, including `vmaf_v0.6.1`, plus the media capabilities described under plugin use below. Test fixtures additionally require `libx264` encoding. |
| Both `gifski` and `gifsicle` | The full gate runs both converter preflights and backend tests. Installing only the default backend is insufficient for development. |
| macOS **26.0 or newer**, Command Line Tools, and `ffmpeg-full` | Required for native frame-extraction execution and its platform-specific tests. Command Line Tools supply `swiftc` and the macOS SDK. The FFmpeg build needs `zscale`, PNG, TIFF, `libx265`, and `prores_ks` for frame-test fixtures. System `sw_vers`, `sips`, and `/usr/bin/osascript` must be available. |
| Network access and writable storage | Initial npm/pip installation and reference download need network access. Allow space for dependencies, the ignored `.build/harness/` candidate, generated references, temporary media, and test outputs. Ordinary Git commit guards do not use the network. |

Expose the intended `ffmpeg` and its matching `ffprobe` on `PATH` for GIF commands and tests. Frame extraction also searches the standard Homebrew `ffmpeg-full` installation paths. Homebrew is the documented provisioning route for `ffmpeg-full`, not an additional requirement when equivalent usable binaries are already installed.

After provisioning these tools, follow [test setup and the full gate](testing.md). Root `npm ci --include=dev` and `npm run build` are explicit preparation steps; `setup-tests.js` does not perform either one.

The enabled [commit hooks](build.md#local-commit-policy) use only Git and POSIX shell to inspect the active index. They do not run a build, install dependencies, start Docker, or access the network. Linux/WSL2 therefore needs no host Node, npm, Python, or active container merely to commit an ordinary source change.

### Linux host and container

The host needs local Docker with a working daemon, Git, a POSIX shell and standard POSIX utilities, a checkout, and a normal non-root account with Docker access. WSL2 needs Docker integration enabled. Host Node, Python, npm, and media tools are not required.

Follow the [container guide](container.md) to build, set up, and run the gate.

The [Dockerfile](../../Dockerfile) supplies the following development toolchain. These image selections are not minimum versions required of plugin users.

| Layer | Installed items |
| --- | --- |
| Runtime image | `node:26-trixie` with Node and npm, Debian Python 3 and venv support, Git, ripgrep, CA certificates, gifsicle, and the inherited shell/system utilities, including `unzip`. |
| Media runtime | FFmpeg **8.0.3**, VMAF **3.2.0**, and gifski **1.34.0**. FFmpeg is built with `--enable-libvmaf --enable-gpl --enable-libx264`. The image includes libvmaf and Debian `libx264-164` runtime libraries. |
| C/C++ builder only | `build-essential`, curl, CA certificates, Meson, Ninja, NASM, pkg-config, `libx264-dev`, and `xxd`. `xxd` embeds the VMAF models. Source unpacking uses tar and xz from the base image. |
| Rust builder only | Rust and Cargo from `rust:1-trixie`, used to build gifski with its locked dependency graph. |
| Setup volumes | The root toolchain, candidate-local backup npm dependencies mounted at `.build/harness/skills/back-up-directories/node_modules`, disposable Python virtual environment with `pypdfium2`, and ASD reference bundle. |

See [container persistence and reset](container.md#persistence-and-reset) for dependency volumes and lifecycle.

The Linux container cannot execute the macOS-only frame-extraction skill. It runs the portable tests and reports platform skips. See [validation records](validation.md#verified-on-2026-09-06) for recorded platform verification. Docker Desktop on macOS remains available for explicit container development and validation, while ordinary macOS development runs natively.

Development requirements are implemented by [setup-tests.js](../../scripts/setup-tests.js), [run-tests.js](../../scripts/run-tests.js), [scripts/dev](../../scripts/dev), and the [Dockerfile](../../Dockerfile).

## 2. Using the plugin

Install the plugin into Codex or Claude Code using the [README installation instructions](../../README.md#install). The harness must support the plugin format and have the tools and permissions needed by the selected skill. There is no plugin-wide npm or Python installation step. Install only the dependencies for the skills you use. Docker is development tooling, not a plugin runtime requirement.

| Skill or component | Runtime and other requirements |
| --- | --- |
| `harness-advisor` | Node.js **22.0.0 or newer**, no npm packages. Codex needs fresh-agent dispatch with explicit model/effort. Claude fallback needs a local Claude Code CLI compatible with the [skill contract](../../dist/harness/skills/harness-advisor/SKILL.md). Each host needs authentication and access to the selected family/effort. See the [human guide](../skills/harness-advisor.md) for integration and the [evaluation](../../tests/harness-advisor/EVALUATION.md) for qualification limits. |
| `install-harness-plugin-capabilities` | Instruction-only, no dedicated runtime, package, or host CLI requirement. Needs ordinary agent filesystem access to the effective user instructions and host user directory. See [integration](../skills/harness-advisor.md#enable-integration). |
| `back-up-directories` | Node.js **22.12.0 or newer** and `archiver` **^8.0.0**. npm and network access are needed to install it. Requires a user-owned backup configuration, readable source files, writable destinations, enough free space, and interactive user confirmation. See [backup setup](../../dist/harness/skills/back-up-directories/INSTALL.md). No system ZIP executable is required by the skill. |
| `create-discord-emoji-gif` | Node.js **22.0.0 or newer**, FFmpeg with working libvmaf models, matching `ffprobe`, and **gifski** for the default backend or **gifsicle** for the alternate backend. No npm packages. macOS and Linux are supported, including the Linux path under WSL2. Native Windows is unsupported. Requires decodable input and writable output/temporary storage. |
| `extract-video-frames` | Node.js **20.6.0 or newer**, macOS **26.0 or newer**, Command Line Tools (`swiftc` and SDK), and `ffmpeg-full` with matching `ffprobe`. Requires `zscale`, PNG and TIFF encoding, and the system `sw_vers`, `sips`, and `/usr/bin/osascript` commands. Its Swift helper uses the system CoreGraphics, CoreImage, Foundation, and ImageIO frameworks for HEIC. These platform requirements apply to SDR as well as HDR. No npm packages. See the [skill contract](../../dist/harness/skills/extract-video-frames/SKILL.md). |
| `random-sampler` | Node.js **22.0.0 or newer** with built-in `node:crypto` and callable `randomInt`. Local execution, no npm dependencies, no network access, and no persistent state. Requests arrive through stdin. |
| `wake-desktop` | Node.js **26.0.0 or newer** on macOS or Linux, with UDP broadcast access to the target LAN. Waiting additionally needs system `ping` on PATH and ICMP permission, neither is needed for `--no-wait`. The target needs a wake-capable adapter and firmware/network settings. WSL2 NAT and container networking can prevent delivery despite a successful send. No npm packages. See the [wake guide](../skills/wake-desktop.md) for configuration. Target management needs only Node and filesystem access, on any platform. Tests simulate networking and need no ping installation or physical target. |
| `write-asd-ste100` | Python 3 and a valid generated ASD-STE100 reference bundle. Normal checking, lookup, and validation use only the Python standard library and do not use the network. Reference generation additionally requires `pypdfium2` and the pinned source PDF. See initialization below. |
| `diagnose-environment` | No fixed additional runtime or package. Needs shell and filesystem access to the environment being diagnosed, using its available tools. |
| `inspect-development-environment` | No fixed additional runtime or package. Needs local, unprivileged shell/filesystem access on macOS or Linux and a writable report directory. Inventories available tools without installing missing ones. |
| `record-decision` | No additional runtime or package. Needs access to the decision context and permission to write the requested record. |
| `demonstrate-workflow` | Instruction-only, no additional runtime or package. Uses ordinary host tools and available session evidence. Codex 0.154.0 uses `$harness:demonstrate-workflow` and `policy.allow_implicit_invocation: false`. Quoted mentions can load instructions but do not authorize formalization. Shared frontmatter retains the narrowly approved `disable-model-invocation: true` extension. Claude behavior is unqualified. |
| `research-precedent` | No fixed additional runtime or package. Needs repository/history access (Git for local history) and the available search/retrieval tools for external evidence. Unreachable source classes are reported as coverage gaps. |
| Output styles | Claude Code only, with no additional runtime or package dependencies. Codex consumes the skills and ignores these styles. |

### Media capabilities

FFmpeg, gifski, and gifsicle do not have a numeric minimum enforced by the converters. Their executable preflights check required capabilities. The container versions above are a verified combination, not a replacement for those checks.

For both GIF backends, FFmpeg needs `fps`, `scale`, `format`, `setpts`, and `libvmaf`, plus rawvideo, FFV1, GIF decoding, Matroska, and null output. The gifski path also needs YUV4MPEG pipe support. The gifsicle path adds `palettegen`, `paletteuse`, PNG/GIF encoding, PNG decoding, NUT, and image2 support. Input-specific codecs must also be available. `ffprobe` must support JSON output, stream selection, entry selection, and frame counting. The backend tools must expose the options checked by [shared.js](../../dist/harness/skills/create-discord-emoji-gif/scripts/node/shared.js).

Frame extraction requires FFprobe pixel-format descriptors (`-show_pixel_formats -of json`) for authoritative alpha and component depth. The native HEIC10 path rejects HDR inputs with alpha.

For frame extraction, FFmpeg additionally needs `select`, `transpose`, `hflip`, `vflip`, image2 output, and the RGB/RGBA pixel formats checked by [extract-video-frames.js](../../dist/harness/skills/extract-video-frames/scripts/extract-video-frames.js). `libx264`, `libx265`, and `prores_ks` are development fixture dependencies, not universal prerequisites for converting an existing supported input.

### Initialization and upgrades

User-level configuration and generated data under `~/.harness-plugin/` are shared by both harnesses and survive plugin upgrades and uninstallation. Remove a skill's subtree manually only when you no longer need its saved settings or generated data. See [persistence contracts](../../AGENTS.md#user-level-persistence) for repository invariants.

For backup, run `npm install --omit=dev --prefix <installed-backup-skill-directory>` as detailed in its [INSTALL.md](../../dist/harness/skills/back-up-directories/INSTALL.md). `node_modules` is not shipped. Repeat installation if a plugin upgrade replaces the installed cache directory.

For ASD-STE100, use a Python virtual environment with pip and `pypdfium2` to run `<installed-writer-skill-directory>/scripts/initialize_references.py`. The initializer downloads the PDF pinned by [source-config.json](../../dist/harness/skills/write-asd-ste100/references/source-config.json), or accepts that PDF through `--pdf PATH`. Importing a valid existing bundle with `--import-from DIR` needs neither `pypdfium2` nor a download. See [writer setup](../../dist/harness/skills/write-asd-ste100/INSTALL.md).

The reference bundle lives under `~/.harness-plugin/write-asd-ste100/bundles/<source-config-sha256>/`, shared between harnesses and retained across plugin upgrades. A changed source configuration requires a matching valid bundle. Keep any initialization virtual environment outside the installed plugin directory so cache replacement does not discard it.

Skill commands perform their own preflight on normal execution. Follow each skill's dispatch contract and relay its exact failure diagnosis and remedy. A standalone preflight is for an explicit readiness check or a skill-specific requirement, not an automatic extra step before every run.

### Advisor evidence-only execution

Harness Advisor receives executor-supplied evidence and makes no tool calls.
Claude fallback requires a local authenticated Claude Code CLI that supports the
complete retained evidence-only invocation. There is no workspace inspection
option, restricted-mode threshold, new package, or persisted initialization data
for Advisor. Preflight checks startup availability, not account access or runtime
enforcement. See the [host contract](../../dist/harness/skills/harness-advisor/references/host-claude.md).

Ordinary Codex children may inherit tools. Use actual per-child tool-disable
controls when exposed; otherwise the no-tools rule is instruction-bound, not a
mechanical guarantee. No named agent installation, Codex adapter, or parent
permission change is required. See the [human guide](../skills/harness-advisor.md).
