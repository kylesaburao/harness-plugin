# Set up the write-asd-ste100 skill

This skill installs with the `harness` plugin (repository root `README.md` has the marketplace and
plugin commands). After install it has no local reference data yet.

## Initialize the local reference bundle

Run once, on macOS or Linux, from the skill's installed path:

```sh
python3 <skill-directory>/scripts/initialize_references.py
```

`<skill-directory>` is the plugin cache path your harness reports, or
`plugins/harness/skills/write-asd-ste100` in a clone. First run needs the `pypdfium2` package and a
network connection. `README.md` covers the virtual-environment setup and the `--pdf` / `--force`
options.

The bundle is written under `~/.harness-plugin/write-asd-ste100/bundles/`, in a directory named for
the SHA-256 of the tracked `references/source-config.json`. Codex and Claude Code share it, and a
plugin version bump does not remove it.

To import a valid bundle from an older install without a download or `pypdfium2`:

```sh
python3 <skill-directory>/scripts/initialize_references.py \
  --import-from <old-skill-directory>/references/generated
```

The initializer validates the old bundle against the current source configuration before copying
it. Add `--force` only to replace a bundle that is already valid.

## Verify

```sh
python3 <skill-directory>/scripts/validate_references.py
```

Exit status `0` means the bundle is valid.

## Update

Update through your harness's plugin mechanism. A normal version bump reuses the shared bundle; run
`initialize_references.py` again only when the current source configuration has no valid bundle.
