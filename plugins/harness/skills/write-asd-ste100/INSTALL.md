# Set up the write-asd-ste100 skill

This skill installs with the `harness` plugin (see the repository root `README.md` for the
marketplace-add and plugin-install commands for Codex and Claude Code). After install, the skill
has no local reference data yet.

## Initialize the local reference bundle

Run this command once, on macOS or Linux:

```sh
python3 <skill-directory>/scripts/initialize_references.py
```

Replace `<skill-directory>` with this skill's installed path (for example, the plugin cache path
your harness reports, or `plugins/harness/skills/write-asd-ste100` in a local clone of this
repository). The command needs the `pypdfium2` package and a network connection on first run. See
`README.md` for the install command, and for the `--pdf` and `--force` options.

The generated bundle is written under `~/.harness-plugin/write-asd-ste100/bundles/`. The final
directory name is the SHA-256 of the tracked `references/source-config.json`. Codex and Claude Code
therefore share the same bundle, and a plugin version bump does not remove it.

To import a valid bundle from an older installation without a download or `pypdfium2`, run:

```sh
python3 <skill-directory>/scripts/initialize_references.py \
  --import-from <old-skill-directory>/references/generated
```

The initializer validates the old bundle against the current source configuration before it
copies the three generated files. Use `--force` with `--import-from` only when a valid shared
bundle must be replaced.

To check the selected source, configuration, and initialization dependency without creating or
replacing a bundle, use `--preflight`. Add `--json` to a preflight or real run for machine-readable
errors and success metadata.

## Verify

```sh
python3 <skill-directory>/scripts/validate_references.py
```

An exit status of `0` means the reference bundle is valid.

## Update

Update the skill through your harness's plugin update mechanism (for example,
`codex plugin marketplace upgrade harness-plugin`). A normal plugin version bump reuses the shared
bundle. Run `initialize_references.py` only when the current source configuration has no valid
bundle.
