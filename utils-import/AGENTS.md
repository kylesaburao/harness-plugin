# Repository Guidelines

## Project Structure & Module Organization

Executable utilities live under `src/`. The backup CLI and its detailed usage guide are in `src/backup/`. The Wake-on-LAN utility is in `src/wake-desktop/`, and the macOS video converter is in `src/mov-to-gif/`. Backup tests mirror the source layout in `test/backup/`. Benchmark code and sample data belong in `scripts/` and `benchmark/`. Keep local credentials and machine-specific paths in ignored files such as `.env` and `backup-config.local.json`.

## Build, Test, and Development Commands

- `npm install` installs the Node.js dependencies. Use Node.js 20.6.0 or newer.
- `npm run backup -- ./backup-config.local.json` starts the interactive ZIP backup.
- `npm run wake-desktop` loads `.env` and runs the Wake-on-LAN utility.
- `npm run mov-to-gif -- input.mov output.gif` runs the macOS GIF converter.
- `npm test` runs all tests with the built-in Node.js test runner.
- `npm run test:backup:coverage` runs backup tests and reports coverage for `src/backup/backup.js`.

This repository has no separate build step. Run utilities directly through their package scripts.

## Coding Style & Naming Conventions

Use CommonJS modules and strict mode in JavaScript files. Match the indentation of the file you edit. Use `camelCase` for JavaScript functions and variables, and use uppercase snake case for constants. Shell scripts must use Bash, quote expansions, and keep `set -euo pipefail`. Use kebab-case for utility directories and scripts, such as `wake-desktop/`.

No formatter or linter is configured. Keep changes focused and run `git diff --check` before submission.

## Testing Guidelines

Use `node:test` with `node:assert/strict`. Name tests `*.test.js` and place backup tests in `test/backup/`. Add focused regression coverage for behavior changes, especially archive lifecycle, cleanup, interruption, and copy ordering. There is no enforced coverage threshold, but do not reduce relevant coverage without explanation.

## Commit & Pull Request Guidelines

Recent commits use short, lowercase summaries such as `more logging` and `simplification pass`. Follow that concise style and keep each commit limited to one coherent change. Pull requests must describe the behavior change, list the verification commands and results, and link an issue when one exists. Include terminal output for changes to prompts, progress messages, or errors. Do not commit `.env`, local backup configuration, generated archives, or `node_modules/`.
