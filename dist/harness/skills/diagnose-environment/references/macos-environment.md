# macOS environment resolution reference

## Shell init order

Which files load depends on whether the shell is login/non-login and interactive/non-interactive - this is the single most common source of "works in my terminal, fails when a tool runs it."

- **zsh** (default since Catalina): `/etc/zprofile` and `~/.zprofile` load for login shells, `/etc/zshrc` and `~/.zshrc` load for interactive shells. A login+interactive terminal loads both. A script run via `sh script.sh` or invoked by a GUI app or launchd job is typically non-login and non-interactive, so it loads neither, and any PATH modification that only lives in `.zshrc` won't be visible there.
- **bash**: login shells read `~/.bash_profile` (or `~/.bash_login`, or `~/.profile`, first one found) and not `~/.bashrc` unless `.bash_profile` explicitly sources it. Non-login interactive shells read `~/.bashrc` directly. macOS Terminal.app launches login shells by default; other launchers may not.
- Check which file actually set a given PATH entry or alias by grepping the candidate init files directly, rather than assuming: `grep -n <thing> ~/.zshrc ~/.zprofile ~/.bashrc ~/.bash_profile /etc/zshrc /etc/zprofile 2>/dev/null`.
- GUI apps and launchd-invoked processes do not inherit the interactive shell's PATH at all unless it was set via `launchctl setenv` or a `/etc/launchd.conf`-style mechanism. If a tool behaves differently when double-clicked versus run from Terminal, this is why.

## Architecture (Apple Silicon)

- `arch` and `uname -m` show the current process's architecture; a binary or shell can be running under Rosetta 2 translation even on Apple Silicon. Check with `sysctl sysctl.proc_translated` (1 means translated/Rosetta, 0 means native).
- Homebrew installs to different prefixes by architecture: `/opt/homebrew` on Apple Silicon (arm64), `/usr/local` on Intel (x86_64). A machine migrated from Intel or running mixed toolchains can have both present, with PATH order determining which wins. Check with `brew --prefix` and confirm it matches the shell's actual arch.
- A version manager (nvm, pyenv, rbenv, etc.) or a language's own installer can silently install an x86_64 binary under Rosetta even on an arm64 machine, particularly for older package versions with no native build. `file $(which <cmd>)` shows the actual binary architecture.

## Version managers

- Confirm the manager's shim is actually first in PATH: `echo $PATH` and compare order against `which -a <cmd>`, which lists every match in PATH order, not just the first.
- Confirm the manager is reading the pin file it's supposed to (`.nvmrc`, `.python-version`, `.ruby-version`, `.tool-versions` for asdf/mise) from the actual working directory, not a parent or unrelated one.
- A manager installed via Homebrew and the same manager installed via its own installer script can coexist, each with its own shim directory and its own idea of the active version.

## Permissions and quarantine

- A file downloaded via a browser or transferred with quarantine metadata intact can fail to execute or trigger a Gatekeeper prompt even with correct Unix permissions. Check with `xattr -l <path>`; the presence of `com.apple.quarantine` is the tell. Clear with `xattr -d com.apple.quarantine <path>` only once the file's origin is trusted.
- A mix of `sudo npm install -g` / `sudo pip install` and user-level installs of the same tool commonly leaves ownership conflicts under directories like `/usr/local/lib`. `ls -la` on the relevant install directory shows whether root-owned files are blocking a user-level update.

## Caches and stale artifacts

- Common cache locations worth clearing explicitly rather than guessing: `~/Library/Caches/<tool>`, `~/.cache/<tool>`, a build tool's own `.cache` or `dist` directory, and Xcode's derived data (`~/Library/Developer/Xcode/DerivedData`) for anything touching the Apple toolchain.
- Clear the specific cache implicated by the symptom, not caches broadly, so the fix and the diagnosis stay attached to each other.
