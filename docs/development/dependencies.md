# Dependencies

This is the authoritative dependency inventory for repository development and plugin use. It distinguishes runtime requirements, setup-only tools, generated data, and platform restrictions. Package manifests, lockfiles, executable preflights, and the Dockerfile implement these requirements. Keep this document consistent with them. Skill-local instructions remain self-contained because this repository document is not shipped with the plugin.

## 1. Development

On macOS, run development commands and tests directly on the host. On Linux, including WSL2, use the development container. Editing and Git operations stay on the host. Container lifecycle commands and failure remedies are in [container guide](container.md).

### macOS host

| Install or provide | Requirement and purpose |
| --- | --- |
| Git, POSIX shell, and standard command-line utilities | Checkout operations, shell-based tests, and hooks. `ripgrep` is used for repository searches. |
| Node.js and npm | Node.js **24.x**, declared in the root [`.nvmrc`](../../.nvmrc), satisfies the full development gate and every skill runtime floor. npm installs the root build toolchain and the ASD-STE100 comment-parser dependencies. |
| Python 3 with `venv` and pip | Creates the repository's `.venv` and runs the ASD-STE100 tests and reference tools. The Python version is not pinned locally; CI uses Python 3.12. The ASD-STE100 Python source-comment tests need Python 3.12 or newer. Use an interpreter supported by the pinned `pypdfium2` release. |
| TypeScript and Node type definitions | Root development-only exact pins: `typescript` **7.0.2** and `@types/node` **24.19.1**, installed with `npm ci --include=dev`. The type definitions track the Node.js 24 runtime floor; they do not ship and do not raise skill runtime floors. |
| `@babel/parser` | Exact direct npm dependency **7.29.11** in the `write-asd-ste100` skill's `package.json`, with exact resolved packages (`@babel/types` and two helper packages) in its `package-lock.json`. Installed by setup from the selected artifact's lockfile into `~/.harness-plugin/write-asd-ste100/node_modules`, where the comment helper resolves it; setup probes it with that helper's `--preflight`. Change the version only together with requalification at the Node.js floor. |
| `pypdfium2` and the generated ASD reference bundle | Development-only exact pin `pypdfium2==5.14.0` in the root [`requirements-dev.txt`](../../requirements-dev.txt). Setup installs that file into `.venv` with `pip install -r` and initializes the bundle under `~/.harness-plugin/write-asd-ste100/bundles/`. Both are required by the full development gate. Change the pin only together with a from-scratch initialization that validates the pinned dictionary hash. |
| FFmpeg and matching `ffprobe` | GIF tests require working `libvmaf` with its built-in models, including `vmaf_v0.6.1`, plus the media capabilities described under plugin use below. Test fixtures additionally require `libx264` encoding. |
| Both `gifski` and `gifsicle` | The full gate runs both converter preflights and backend tests. Installing only the default backend is insufficient for development. |
| Network access and writable storage | Initial npm/pip installation and reference download need network access. Allow space for dependencies, the ignored `.build/harness/` candidate, generated references, temporary media, and test outputs. Ordinary Git commit guards do not use the network. |

Expose the intended `ffmpeg` and its matching `ffprobe` on `PATH` for GIF commands and tests.

After provisioning these tools, follow [test setup and the full gate](testing.md). Root `npm ci --include=dev` and `npm run build` are explicit preparation steps; `setup-tests.js` does not perform either one.

The enabled [commit hooks](build.md#local-commit-policy) use only Git and POSIX shell to inspect the active index. They do not run a build, install dependencies, start Docker, or access the network. Linux/WSL2 therefore needs no host Node, npm, Python, or active container merely to commit an ordinary source change.

### Node runtime bootstrap

The optional host bootstrap uses an existing [nvm installation](https://github.com/nvm-sh/nvm#installing-and-updating). nvm is unnecessary for plugin installation, CI, Docker, or an already-provisioned Node 24 environment. Linux/WSL2 development uses the container workflow below.

From the repository root, execute the Bash helper (compatible with macOS Bash 3.2):

```sh
./scripts/setup-node
```

It uses an available nvm shell function first. Otherwise it loads `nvm.sh` from an explicit `NVM_DIR`, then the default `$XDG_CONFIG_HOME/nvm` when XDG is set, or `$HOME/.nvm` otherwise. It runs `nvm install` from the repository root so `.nvmrc` selects the version, then reports `node --version`. It requires no working Node or npm beforehand and does not install nvm, edit shell profiles, or install repository dependencies.

An executed helper cannot activate its parent terminal. If nvm is not already loaded there, initialize it using the same directory selection:

```sh
if ! command -v nvm >/dev/null 2>&1; then
    if [ -z "${NVM_DIR:-}" ]; then
        NVM_DIR="$HOME/.nvm"
        if [ -n "${XDG_CONFIG_HOME:-}" ]; then
            NVM_DIR="$XDG_CONFIG_HOME/nvm"
        fi
    fi
    export NVM_DIR
    . "$NVM_DIR/nvm.sh" --no-use
fi
nvm use
node --version
```

Run this from the repository root and verify `v24.*`. Then install the locked root toolchain separately:

```sh
npm ci --include=dev
```

Continue with [build and test setup](testing.md#setup). The helper's `--help` prints usage without initialization or installation; failures retain a nonzero status.

### Linux host and container

The host needs local Docker with a working daemon, Git, a POSIX shell and standard POSIX utilities, a checkout, and a normal non-root account with Docker access. WSL2 needs Docker integration enabled. Host Node, Python, npm, and media tools are not required.

Follow the [container guide](container.md) to build, set up, and run the gate.

The [Dockerfile](../../Dockerfile) supplies the following development toolchain. These image selections are not minimum versions required of plugin users. Base images are pinned by digest and source downloads by SHA-256. Changing a tag or source version requires updating its digest in the Dockerfile and here.

| Layer | Installed items |
| --- | --- |
| Runtime image | `node:24-trixie`, pinned to index digest `sha256:1278a37eb510ec1606fba0e80f554bcc941ae0b44f35ae373c4822ae7717c64d`, with Node and npm, Debian Python 3 and venv support, Git, ripgrep, CA certificates, gifsicle, and the inherited shell/system utilities. |
| Media runtime | FFmpeg **8.0.3**, VMAF **3.2.0**, and gifski **1.34.0**. FFmpeg is built with `--enable-libvmaf --enable-gpl --enable-libx264`. The build verifies the source tarballs by SHA-256: FFmpeg `ffmpeg-8.0.3.tar.xz` `6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818` and VMAF `v3.2.0.tar.gz` `a28f93f3b4fa65601be324587072e32a6a704a304ba7b1aec9b70b3f709bc1dc`. The image includes libvmaf and Debian `libx264-164` runtime libraries. |
| C/C++ builder only | `build-essential`, curl, CA certificates, Meson, Ninja, NASM, pkg-config, `libx264-dev`, and `xxd`. `xxd` embeds the VMAF models. Source unpacking uses tar and xz from the base image. |
| Rust builder only | Rust and Cargo from `rust:1-trixie`, pinned to index digest `sha256:6ff07edce8775d0f64be7aba9197229407301bddf2054d62c27b541a6238a181`, used to build gifski with its locked dependency graph. |
| Setup volumes | The root toolchain, disposable Python virtual environment with `pypdfium2`, and a home volume holding the ASD-STE100 comment parser and reference bundle under `/home/node/.harness-plugin/`. |

See [container persistence and reset](container.md#persistence-and-reset) for dependency volumes and lifecycle.

CI workflows cache npm downloads, pip downloads keyed on `requirements-dev.txt`, and the generated ASD bundle directory keyed on the hash of the source `source-config.json`. A restored bundle is still validated by the initializer before use; a cache miss regenerates it from the pinned PDF.

Development requirements are implemented by [setup-tests.js](../../scripts/setup-tests.js), [run-tests.js](../../scripts/run-tests.js), [requirements-dev.txt](../../requirements-dev.txt), [scripts/dev](../../scripts/dev), and the [Dockerfile](../../Dockerfile).

## 2. Using the plugin

Install the plugin into Codex or Claude Code using the [README installation instructions](../../README.md#install). The harness must support the plugin format and have the tools and permissions needed by the selected skill. There is no plugin-wide npm or Python installation step. Install only the dependencies for the skills you use. Docker is development tooling, not a plugin runtime requirement.

| Skill or component | Runtime and other requirements |
| --- | --- |
| `harness-advisor` | Node.js **24.0.0 or newer**, no npm packages. Codex needs fresh-agent dispatch with explicit model/effort. Claude fallback needs a local Claude Code CLI compatible with the [skill contract](../../dist/harness/skills/harness-advisor/SKILL.md). Each host needs authentication and access to the selected family/effort. See the [human guide](../skills/harness-advisor.md) for integration and the [evaluation](../../tests/harness-advisor/EVALUATION.md) for qualification limits. |
| `install-harness-plugin-capabilities` | Instruction-only, no dedicated runtime, package, or host CLI requirement. Needs ordinary agent filesystem access to the effective user instructions and host user directory. Planning and conceptual-first activation each also require verified discovery and loading of their skill in the selected host. See [integration](../skills/harness-advisor.md#enable-integration). |
| `create-discord-emoji-gif` | Node.js **24.0.0 or newer**, FFmpeg with working libvmaf models, matching `ffprobe`, and **gifski** for the default backend or **gifsicle** for the alternate backend. No npm packages. macOS and Linux are supported, including the Linux path under WSL2. Native Windows is unsupported. Requires decodable input and writable output/temporary storage. |
| `random-sampler` | Node.js **24.0.0 or newer** with built-in `node:crypto` and callable `randomInt`. Local execution, no npm dependencies, no network access, and no persistent state. Requests arrive through stdin. |
| `write-implementation-plan` | Instruction-only, no dedicated runtime or package. Uses available host capabilities; an explicitly authorized handoff needs access to a permitted durable destination. No initialization artifact is required. |
| `conceptual-first` | Instruction-only, no dedicated runtime or package. Uses authorized task evidence and available host capabilities. No initialization artifact, persistent state, or external reference is required. See the [evaluation](../../tests/conceptual-first/EVALUATION.md) for qualification limits. |
| `write-compact-prompt` | Instruction-only, no dedicated runtime or package. Produces text for the user to paste and writes no files. No initialization artifact, persistent state, or external reference is required. See the [evaluation](../../tests/write-compact-prompt/EVALUATION.md) for qualification limits. |
| `write-asd-ste100` | Python 3 and a valid generated ASD-STE100 reference bundle. Prose checking, lookup, and validation use only the Python standard library and do not use the network. Checking Python source comments needs Python **3.12 or newer**. Checking JavaScript, TypeScript, JSX, or TSX comments additionally needs Node.js **24.0.0 or newer** and `@babel/parser` **7.29.11**, installed from the skill's lockfile (npm and network access are needed to install it). Prose and Python checks do not need Node.js. Reference generation additionally requires `pypdfium2` and the pinned source PDF. See initialization below. |
| `diagnose-environment` | No fixed additional runtime or package. Needs shell and filesystem access to the environment being diagnosed, using its available tools. |
| `inspect-development-environment` | No fixed additional runtime or package. Needs local, unprivileged shell/filesystem access on macOS or Linux and a writable report directory. Inventories available tools without installing missing ones. |
| `demonstrate-workflow` | Instruction-only, no additional runtime or package. Uses ordinary host tools and available session evidence. Codex 0.154.0 uses `$harness:demonstrate-workflow` and `policy.allow_implicit_invocation: false`. Quoted mentions can load instructions but do not authorize formalization. Shared frontmatter retains the narrowly approved `disable-model-invocation: true` extension, which `write-asd-ste100` shares. On Claude Code, one sample per case qualified that the extension prevents model-initiated invocation. |

### Media capabilities

FFmpeg, gifski, and gifsicle do not have a numeric minimum enforced by the converters. Their executable preflights check required capabilities. The container versions above are a verified combination, not a replacement for those checks.

For both GIF backends, FFmpeg needs `fps`, `scale`, `format`, `setpts`, and `libvmaf`, plus rawvideo, FFV1, GIF decoding, Matroska, and null output. The gifski path also needs YUV4MPEG pipe support. The gifsicle path adds `palettegen`, `paletteuse`, GIF encoding and muxing, and NUT support. Input-specific codecs must also be available. `ffprobe` must support JSON output, stream selection, entry selection, and frame counting. The backend tools must expose the options checked by [preflight.js](../../dist/harness/skills/create-discord-emoji-gif/scripts/node/preflight.js).

### Initialization and upgrades

User-level configuration and generated data under `~/.harness-plugin/` are shared by both harnesses and survive plugin upgrades and uninstallation. Remove a skill's subtree manually only when you no longer need its saved settings or generated data. See [persistence contracts](../../AGENTS.md#user-level-persistence) for repository invariants.

For ASD-STE100, use a Python virtual environment with pip and `pypdfium2` to run `<installed-writer-skill-directory>/scripts/initialize_references.py`. The initializer downloads the PDF pinned by [source-config.json](../../dist/harness/skills/write-asd-ste100/references/source-config.json), or accepts that PDF through `--pdf PATH`. Importing a valid existing bundle with `--import-from DIR` needs neither `pypdfium2` nor a download. See [writer setup](../../dist/harness/skills/write-asd-ste100/INSTALL.md).

For JavaScript-family comment checking, copy the installed writer skill's `package.json` and `package-lock.json` into `~/.harness-plugin/write-asd-ste100/` and run `npm ci --omit=dev --prefix ~/.harness-plugin/write-asd-ste100`, as detailed in the [writer setup](../../dist/harness/skills/write-asd-ste100/INSTALL.md). The helper's `dependency_missing` and `dependency_invalid` remedies print that command with the paths filled in. `node_modules` is not shipped, and the helper does not resolve the parser from its installed directory, a checked project, `NODE_PATH`, or any other `node_modules`. The install survives plugin upgrades; repeat it when an upgrade changes the skill's lockfile, because the helper rejects an install made from a different lockfile. This install and the reference bundle are independent: neither one rebuilds or needs the other.

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
