# Set up the back-up-directories skill

This skill installs with the `harness` plugin (see the repository root `README.md` for the
marketplace-add and plugin-install commands for Codex and Claude Code). After install, its
one npm dependency is not present yet.

## Install the dependency

Run this once, with Node.js 22.12.0 or newer:

```sh
npm install --omit=dev --prefix <skill-directory>
```

Replace `<skill-directory>` with this skill's installed path (for example, the plugin cache
path your harness reports, or `plugins/harness/skills/back-up-directories` in a local clone
of this repository). The preflight prints the exact command with the path already filled
in, so prefer copying it from there:

```sh
node <skill-directory>/scripts/backup.js --preflight --json
```

The package is `archiver`, which writes the ZIP. Everything else the utility uses comes
from the Node.js standard library. Installation needs a network connection.

`node_modules/` is not distributed with the plugin. If your harness installs the skill into
a versioned cache directory, re-run this command after every plugin upgrade, since an
upgrade can replace the cache directory and drop the installed packages.

## Verify

```sh
node <skill-directory>/scripts/backup.js --preflight --json
```

`{"status":"ready", ...}` and exit status 0 mean the skill can run. Exit status 2 with
`dependency_missing` means the install has not happened or did not survive an upgrade.

## Run the tests

The tests are not distributed with the plugin. They live in `tests/back-up-directories/` in
the repository, and need only the dependency install above. From a clone of the repository:

```sh
node --test tests/back-up-directories/*.test.js
```
