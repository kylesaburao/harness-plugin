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
it. `--force` still builds or imports and validates a fresh stage, but keeps an already valid
installed directory unchanged and discards the stage. Readers keep using the same valid bundle.

Publication uses a mode-0600 sibling lock named `.<source-config-sha256>.publish.lock`. Building
runs outside the lock. The initializer revalidates the destination while holding it and publishes
only if the destination is missing or invalid. An absent destination needs one rename. Invalid
data is moved aside and restored if publication fails, when restoration is possible.

`initialization_busy` exits with status 1 after staging. There are no retries or automatic stale-lock
removals. Follow the reported absolute lock path and remedy: confirm no initializer is active before
manually removing a stale lock. A killed publisher can also leave an invalid backup and a stage
beside the destination. This does not interrupt an already valid bundle.

Publication failures preserve the primary diagnosis and add `rollbackFailure` when restoration
fails. Cleanup failures report absolute retained paths in `cleanupFailures`. A ready report with
`cleanupFailures` means the bundle is available but cleanup is incomplete, and exits with status 1.
Relay these details without deleting retained paths or retrying initialization automatically.

## Verify

```sh
python3 <skill-directory>/scripts/validate_references.py
```

Exit status `0` means the bundle is valid.

## Update

Update through your harness's plugin mechanism. A normal version bump reuses the shared bundle; run
`initialize_references.py` again only when the current source configuration has no valid bundle.
