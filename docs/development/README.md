# Developing harness-plugin

[Documentation](../README.md) / Development

Work from the repository root for all commands in these guides. Read [AGENTS.md](../../AGENTS.md) before changing the repository. Shared skills live under `plugins/harness/skills/`, while tests and development tooling remain outside the installed plugin.

## Prepare and verify a change

1. Check [dependencies](dependencies.md) for your host and affected skills.
2. On macOS, use the native [testing workflow](testing.md). On Linux or WSL2, prepare the [development container](container.md).
3. Run focused checks during development and the [full gate](testing.md#full-gate) before delivery.
4. Follow [versioning and commit conventions](versioning.md) when committing or releasing.

Keep Git operations on the host. Enable the repository's timestamp hook once per clone:

```sh
git config core.hooksPath .githooks
```

## Documentation changes

The root README provides installation, discovery, and navigation. Human usage guides live under `docs/`, and development guidance lives here. Link to installed skill contracts and existing skill-local setup documents for exact behavior.

When moving documentation, check incoming references across the repository, fix relative links from their new locations, and run the [documentation checks](testing.md#focused-checks). Inventory checks protect agreement with the actual plugin tree without fixing the catalog's headings or layout.

Historical platform evidence is in [validation records](validation.md). Those results do not replace testing the current change.
