#!/usr/bin/env node
'use strict';

// Bumps the plugin version in both manifests, deterministically.
//
// Repo tooling, not a skill script: it never ships inside plugins/harness/, so it does not
// follow the --preflight contract documented in AGENTS.md (that contract is scoped to scripts a
// skill runs). It still matches the house exit-code and error shape used everywhere else.
//
// Exit status:
//   0  bumped successfully, or a passed --help
//   2  the work never started: bad usage, missing/unreadable/malformed manifest, invalid or
//      mismatched version
//   1  a manifest write failed.
//
// Minimum Node: 18 (node:fs, node:path only).
//
// This script never runs `git`. Anything that touches repository/branch state (fetching,
// resetting, committing, pushing, retrying across a race) belongs in the caller - currently
// .github/workflows/bump-version.yml - so the destructive parts stay confined to a disposable CI
// checkout instead of a script someone might also run against their working tree.

const fs = require('node:fs');
const path = require('node:path');

const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1,
  CANNOT_START: 2,
});

const MANIFEST_RELATIVE_PATHS = Object.freeze([
  'plugins/harness/.codex-plugin/plugin.json',
  'plugins/harness/.claude-plugin/plugin.json',
]);

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

const USAGE = `Usage: bump-version.js (--bump-major | --bump-minor | --bump-patch) [OPTIONS]

Bumps the "version" field in both plugin manifests by the same amount, keeping them identical:
  ${MANIFEST_RELATIVE_PATHS.join('\n  ')}

Bump semantics: bumping a higher-priority value resets the lower-priority values to 0.
  --bump-patch   1.2.3 -> 1.2.4
  --bump-minor   1.2.3 -> 1.3.0
  --bump-major   1.2.3 -> 2.0.0

Options:
  --repo-root DIR  Repository root containing the manifests (default: two levels up from this script)
  --json           Report the result, or any error, as JSON
  -h, --help       Print this message

Exit status: 0 success, 2 cannot start (bad usage, missing/invalid/mismatched manifest), or 1
write failed.`;

class StartupError extends Error {
  constructor(code, condition, remedy) {
    super(condition);
    this.name = 'StartupError';
    this.code = code;
    this.condition = condition;
    this.remedy = remedy;
    this.exitCode = EXIT.CANNOT_START;
  }
}

class WriteFailedError extends Error {
  constructor(code, condition, remedy) {
    super(condition);
    this.name = 'WriteFailedError';
    this.code = code;
    this.condition = condition;
    this.remedy = remedy;
    this.exitCode = EXIT.FAILED;
  }
}

function parseArguments(argv) {
  const options = {
    level: null,
    repoRoot: null,
    json: false,
    help: false,
  };
  const levelFlags = new Map([
    ['--bump-major', 'major'],
    ['--bump-minor', 'minor'],
    ['--bump-patch', 'patch'],
  ]);
  let levelFlagCount = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (levelFlags.has(argument)) {
      options.level = levelFlags.get(argument);
      levelFlagCount += 1;
    } else if (argument === '--repo-root') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new StartupError('MISSING_VALUE', `${argument} requires a value`, 'bump-version.js --repo-root DIR ...');
      }
      options.repoRoot = value;
      index += 1;
    } else if (argument === '--json') {
      options.json = true;
    } else if (argument === '-h' || argument === '--help') {
      options.help = true;
    } else {
      throw new StartupError(
        'UNKNOWN_ARGUMENT',
        `unrecognized argument: ${argument}`,
        'bump-version.js --help',
      );
    }
  }

  if (options.help) {
    return options;
  }

  if (levelFlagCount === 0) {
    throw new StartupError(
      'NO_LEVEL',
      'no bump level given',
      'bump-version.js (--bump-major | --bump-minor | --bump-patch)',
    );
  }
  if (levelFlagCount > 1) {
    throw new StartupError(
      'AMBIGUOUS_LEVEL',
      'more than one bump level flag given',
      'bump-version.js (--bump-major | --bump-minor | --bump-patch), choose exactly one',
    );
  }

  return options;
}

function readManifest(absolutePath) {
  let raw;
  try {
    raw = fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new StartupError(
        'MANIFEST_MISSING',
        `manifest not found: ${absolutePath}`,
        'run from a checkout that contains plugins/harness/, or pass --repo-root',
      );
    }
    throw new StartupError(
      'MANIFEST_UNREADABLE',
      `cannot read manifest: ${absolutePath} (${error.code || error.message})`,
      `check read permissions on ${absolutePath}`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new StartupError(
      'MANIFEST_MALFORMED',
      `manifest is not valid JSON: ${absolutePath}`,
      `fix the JSON syntax in ${absolutePath}`,
    );
  }
  if (typeof manifest.version !== 'string' || !SEMVER_PATTERN.test(manifest.version)) {
    throw new StartupError(
      'INVALID_VERSION',
      `manifest "version" is not M.m.p: ${absolutePath}`,
      `set "version" to a plain M.m.p string in ${absolutePath}`,
    );
  }
  return { absolutePath, raw, manifest };
}

function bumpVersion(version, level) {
  const match = SEMVER_PATTERN.exec(version);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (level === 'major') {
    return `${major + 1}.0.0`;
  }
  if (level === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

function run(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }

  const repoRoot = options.repoRoot
    ? path.resolve(options.repoRoot)
    : path.resolve(__dirname, '..');
  const manifestPaths = MANIFEST_RELATIVE_PATHS.map((relative) => path.join(repoRoot, relative));
  const manifests = manifestPaths.map(readManifest);

  const versions = new Set(manifests.map((entry) => entry.manifest.version));
  if (versions.size > 1) {
    throw new StartupError(
      'VERSION_MISMATCH',
      `manifests disagree on version: ${manifests.map((entry) => `${entry.manifest.version} (${entry.absolutePath})`).join(', ')}`,
      'set both manifests to the same "version" by hand, then re-run',
    );
  }

  const previous = manifests[0].manifest.version;
  const next = bumpVersion(previous, options.level);

  const written = [];
  const attempted = [];
  try {
    for (const entry of manifests) {
      entry.manifest.version = next;
      attempted.push(entry);
      fs.writeFileSync(entry.absolutePath, `${JSON.stringify(entry.manifest, null, 2)}\n`, 'utf8');
      written.push(entry);
    }
  } catch (writeError) {
    const rollbackFailures = [];
    for (const entry of attempted) {
      try { fs.writeFileSync(entry.absolutePath, entry.raw, 'utf8'); }
      catch { rollbackFailures.push(entry.absolutePath); }
    }
    if (rollbackFailures.length === 0) {
      throw new WriteFailedError(
        'MANIFEST_WRITE_FAILED_ROLLED_BACK',
        `write failed after updating ${written.length} of ${manifests.length} manifest(s) (${writeError.message}); all were rolled back to ${previous}`,
        're-run bump-version.js once the underlying write failure is fixed',
      );
    }
    throw new WriteFailedError(
      'MANIFEST_WRITE_FAILED_INCONSISTENT',
      `write failed after updating ${written.length} of ${manifests.length} manifest(s) (${writeError.message}); rollback also failed for: ${rollbackFailures.join(', ')} - manifests are now inconsistent`,
      `manually restore the original contents in: ${rollbackFailures.join(', ')}, then re-run`,
    );
  }

  const result = {
    level: options.level,
    previous,
    next,
    files: manifestPaths,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${previous} -> ${next} (${options.level})\n`);
    for (const filePath of manifestPaths) {
      process.stdout.write(`  ${filePath}\n`);
    }
  }
  return EXIT.OK;
}

function reportError(error, json) {
  if (json) {
    process.stderr.write(`${JSON.stringify({ error: { code: error.code, condition: error.condition, remedy: error.remedy } })}\n`);
  } else {
    process.stderr.write(`ERROR [${error.code}]: ${error.condition}\n`);
    process.stderr.write(`Remedy: ${error.remedy}\n`);
  }
}

function main() {
  let json = false;
  try {
    json = process.argv.slice(2).includes('--json');
    const exitCode = run(process.argv.slice(2));
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof StartupError || error instanceof WriteFailedError) {
      reportError(error, json);
      process.exit(error.exitCode);
    }
    process.stderr.write(`ERROR [UNEXPECTED]: ${error.stack || error.message}\n`);
    process.exit(EXIT.FAILED);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArguments,
  bumpVersion,
  run,
  MANIFEST_RELATIVE_PATHS,
};
