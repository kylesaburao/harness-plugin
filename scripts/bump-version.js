#!/usr/bin/env node
'use strict';

// Deterministically updates only the canonical plugin package version. The CLI
// is release-writer-only; pure mutation helpers remain usable with fixture roots.

const fs = require('node:fs');
const path = require('node:path');
const { ArtifactArgumentError } = require('./artifact-paths');
const {
  PolicyError,
  assertReleaseWriteIntent,
  bumpVersion,
} = require('./release-policy');

const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1,
  CANNOT_START: 2,
});

const MANIFEST_RELATIVE_PATHS = Object.freeze([
  'src/harness/package.json',
]);

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

const USAGE = `Usage: bump-version.js (--bump-major | --bump-minor | --bump-patch) [OPTIONS]

Release-writer command: update only the canonical source package version. The
versioned distribution is generated afterward with npm run build:dist.

Bump semantics: bumping a higher-priority value resets lower-priority values to 0.
  --bump-patch   1.2.3 -> 1.2.4
  --bump-minor   1.2.3 -> 1.3.0
  --bump-major   1.2.3 -> 2.0.0

Options:
  --repo-root DIR  Fixture/repository root (default: parent of this script directory)
  --json           Report the result, or any error, as JSON
  -h, --help       Print this message

The public command requires the canonical GitHub Actions publication context and
HARNESS_RELEASE_WRITE=1. Help is always read-only and requires no release context.

Exit status: 0 success, 2 cannot start, or 1 after a write failure.`;

class StartupError extends Error
{
  constructor(code, condition, remedy)
  {
    super(condition);
    this.name = 'StartupError';
    this.code = code;
    this.condition = condition;
    this.remedy = remedy;
    this.exitCode = EXIT.CANNOT_START;
  }
}

class WriteFailedError extends Error
{
  constructor(code, condition, remedy)
  {
    super(condition);
    this.name = 'WriteFailedError';
    this.code = code;
    this.condition = condition;
    this.remedy = remedy;
    this.exitCode = EXIT.FAILED;
  }
}

function parseArguments(argv)
{
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

  for (let index = 0; index < argv.length; index += 1)
  {
    const argument = argv[index];
    if (levelFlags.has(argument))
    {
      options.level = levelFlags.get(argument);
      levelFlagCount += 1;
    }
    else if (argument === '--repo-root')
    {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--'))
      {
        throw new StartupError(
          'MISSING_VALUE',
          `${argument} requires a value`,
          'bump-version.js --repo-root DIR ...',
        );
      }
      if (options.repoRoot !== null)
      {
        throw new StartupError(
          'DUPLICATE_ARGUMENT',
          '--repo-root was supplied more than once',
          'pass exactly one fixture/repository root',
        );
      }
      options.repoRoot = value;
      index += 1;
    }
    else if (argument === '--json')
    {
      if (options.json)
      {
        throw new StartupError(
          'DUPLICATE_ARGUMENT',
          '--json was supplied more than once',
          'pass --json at most once',
        );
      }
      options.json = true;
    }
    else if (argument === '-h' || argument === '--help')
    {
      options.help = true;
    }
    else
    {
      throw new StartupError(
        'UNKNOWN_ARGUMENT',
        `unrecognized argument: ${argument}`,
        'bump-version.js --help',
      );
    }
  }

  if (options.help)
  {
    if (argv.length !== 1)
    {
      throw new StartupError(
        'INVALID_HELP_USAGE',
        '--help cannot be combined with mutation arguments',
        'run bump-version.js --help by itself',
      );
    }
    return options;
  }
  if (levelFlagCount === 0)
  {
    throw new StartupError(
      'NO_LEVEL',
      'no bump level given',
      'bump-version.js (--bump-major | --bump-minor | --bump-patch)',
    );
  }
  if (levelFlagCount > 1)
  {
    throw new StartupError(
      'AMBIGUOUS_LEVEL',
      'more than one bump level flag given',
      'bump-version.js (--bump-major | --bump-minor | --bump-patch), choose exactly one',
    );
  }
  return options;
}

function readManifest(absolutePath)
{
  let stat;
  try
  {
    stat = fs.lstatSync(absolutePath);
  }
  catch (error)
  {
    if (error.code === 'ENOENT')
    {
      throw new StartupError(
        'MANIFEST_MISSING',
        `manifest not found: ${absolutePath}`,
        'run from a checkout containing src/harness/package.json',
      );
    }
    throw new StartupError(
      'MANIFEST_UNREADABLE',
      `cannot inspect manifest: ${absolutePath} (${error.code || error.message})`,
      `check access permissions on ${absolutePath}`,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink())
  {
    throw new StartupError(
      'INVALID_MANIFEST_TYPE',
      `canonical package is not a regular non-symlink file: ${absolutePath}`,
      'restore src/harness/package.json as the tracked regular package file',
    );
  }

  let raw;
  try
  {
    raw = fs.readFileSync(absolutePath, 'utf8');
  }
  catch (error)
  {
    throw new StartupError(
      'MANIFEST_UNREADABLE',
      `cannot read manifest: ${absolutePath} (${error.code || error.message})`,
      `check read permissions on ${absolutePath}`,
    );
  }
  let manifest;
  try
  {
    manifest = JSON.parse(raw);
  }
  catch (error)
  {
    throw new StartupError(
      'MANIFEST_MALFORMED',
      `manifest is not valid JSON: ${absolutePath}`,
      `fix the JSON syntax in ${absolutePath}`,
    );
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest))
  {
    throw new StartupError(
      'INVALID_PACKAGE_BOUNDARY',
      `canonical package must contain one JSON object: ${absolutePath}`,
      'restore name, version, private, and type; publication changes only version',
    );
  }
  const keys = Object.keys(manifest).sort();
  const expectedKeys = ['name', 'version', 'private', 'type'].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
      || manifest.name !== 'harness'
      || manifest.private !== true
      || manifest.type !== 'commonjs')
  {
    throw new StartupError(
      'INVALID_PACKAGE_BOUNDARY',
      `canonical package metadata is not the fixed harness boundary: ${absolutePath}`,
      'restore name, version, private, and type; publication changes only version',
    );
  }
  if (typeof manifest.version !== 'string' || !SEMVER_PATTERN.test(manifest.version))
  {
    throw new StartupError(
      'INVALID_VERSION',
      `manifest "version" is not M.m.p: ${absolutePath}`,
      `set "version" to a plain M.m.p string in ${absolutePath}`,
    );
  }
  return { absolutePath, raw, manifest };
}

function mutateVersion(repositoryRoot, level)
{
  const manifestPaths = MANIFEST_RELATIVE_PATHS.map((relative) => path.join(repositoryRoot, relative));
  const entry = readManifest(manifestPaths[0]);
  const previous = entry.manifest.version;
  const next = bumpVersion(previous, level);
  entry.manifest.version = next;
  try
  {
    fs.writeFileSync(entry.absolutePath, `${JSON.stringify(entry.manifest, null, 2)}\n`, 'utf8');
  }
  catch (writeError)
  {
    try
    {
      fs.writeFileSync(entry.absolutePath, entry.raw, 'utf8');
    }
    catch (rollbackError)
    {
      throw new WriteFailedError(
        'MANIFEST_WRITE_FAILED_INCONSISTENT',
        `canonical version write failed (${writeError.message}) and rollback failed (${rollbackError.message})`,
        `manually restore ${entry.absolutePath} before retrying`,
      );
    }
    throw new WriteFailedError(
      'MANIFEST_WRITE_FAILED_ROLLED_BACK',
      `canonical version write failed (${writeError.message}); original bytes were restored`,
      're-run bump-version.js once the underlying write failure is fixed',
    );
  }
  return {
    level,
    previous,
    next,
    files: manifestPaths,
  };
}

function run(argv, {
  environment = process.env,
  stdout = process.stdout,
  enforceReleaseIntent = true,
} = {})
{
  const options = parseArguments(argv);
  if (options.help)
  {
    stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }
  if (enforceReleaseIntent)
  {
    assertReleaseWriteIntent(environment);
  }
  const repositoryRoot = options.repoRoot
    ? path.resolve(options.repoRoot)
    : path.resolve(__dirname, '..');
  const result = mutateVersion(repositoryRoot, options.level);
  if (options.json)
  {
    stdout.write(`${JSON.stringify(result)}\n`);
  }
  else
  {
    stdout.write(`${result.previous} -> ${result.next} (${result.level})\n`);
    for (const filePath of result.files)
    {
      stdout.write(`  ${filePath}\n`);
    }
  }
  return EXIT.OK;
}

function reportError(error, json)
{
  const known = error instanceof StartupError
    || error instanceof WriteFailedError
    || error instanceof PolicyError
    || error instanceof ArtifactArgumentError;
  if (!known)
  {
    if (json)
    {
      process.stderr.write(`${JSON.stringify({
        error: {
          code: 'UNEXPECTED',
          condition: error.message || String(error),
          remedy: 'inspect the unexpected failure and retry only after resolving it',
        },
      })}\n`);
    }
    else
    {
      process.stderr.write(`ERROR [UNEXPECTED]: ${error.stack || error.message}\n`);
    }
    return;
  }
  if (json)
  {
    process.stderr.write(`${JSON.stringify({
      error: {
        code: error.code,
        condition: error.condition,
        remedy: error.remedy,
      },
    })}\n`);
  }
  else
  {
    process.stderr.write(`ERROR [${error.code}]: ${error.condition}\nRemedy: ${error.remedy}\n`);
  }
}

function main()
{
  const arguments_ = process.argv.slice(2);
  const json = arguments_.includes('--json');
  try
  {
    process.exitCode = run(arguments_);
  }
  catch (error)
  {
    reportError(error, json);
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : EXIT.FAILED;
  }
}

if (require.main === module)
{
  main();
}

module.exports = {
  MANIFEST_RELATIVE_PATHS,
  bumpVersion,
  mutateVersion,
  parseArguments,
  readManifest,
  run,
};
