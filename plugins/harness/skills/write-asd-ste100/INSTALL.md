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

The generated bundle is written to `references/generated/` inside the skill directory and is not
distributed with the plugin. If your harness installs the skill into a versioned cache directory,
re-run this command after every plugin upgrade — an upgrade can replace the cache directory and
drop a previously generated bundle.

## Verify

```sh
python3 <skill-directory>/scripts/validate_references.py
```

An exit status of `0` means the reference bundle is valid.

## Update

Update the skill through your harness's plugin update mechanism (for example,
`codex plugin marketplace upgrade harness-plugin`). Re-run `initialize_references.py` when
`references/source-config.json` changed, or whenever the reference bundle did not survive the
update.
