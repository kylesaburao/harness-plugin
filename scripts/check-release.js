#!/usr/bin/env node
'use strict';

const {
  PolicyError,
  UsageError,
  bumpVersion,
  validateCommittedRelease,
  validateStagedRelease,
} = require('./release-policy');

const USAGE = `Usage:
  node scripts/check-release.js --base SOURCE_SHA --level patch|minor|major --next VERSION --staged
  node scripts/check-release.js --base SOURCE_SHA --level patch|minor|major --next VERSION --commit RELEASE_SHA --run-id RUN_ID

Validate the final staged release index or the newly created release commit. This
command is read-only: it never stages files, creates commits, or changes the index.

Exit status: 0 validation passed, 2 bad usage, or 1 validation/Git inspection failure.`;

function parseArguments(argv)
{
  const options = {
    base: null,
    level: null,
    next: null,
    staged: false,
    commit: null,
    runId: null,
    help: false,
  };
  const values = new Map([
    ['--base', 'base'],
    ['--level', 'level'],
    ['--next', 'next'],
    ['--commit', 'commit'],
    ['--run-id', 'runId'],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1)
  {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h')
    {
      options.help = true;
      continue;
    }
    if (argument === '--staged')
    {
      if (options.staged)
      {
        throw new UsageError(
          'DUPLICATE_ARGUMENT',
          '--staged was supplied more than once',
          'choose exactly one staged or committed validation mode',
        );
      }
      options.staged = true;
      continue;
    }
    const property = values.get(argument);
    if (!property)
    {
      throw new UsageError(
        'UNKNOWN_ARGUMENT',
        `unrecognized argument: ${argument}`,
        'node scripts/check-release.js --help',
      );
    }
    if (seen.has(argument))
    {
      throw new UsageError(
        'DUPLICATE_ARGUMENT',
        `argument supplied more than once: ${argument}`,
        'pass every release argument exactly once',
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('-'))
    {
      throw new UsageError(
        'MISSING_VALUE',
        `${argument} requires a value`,
        'node scripts/check-release.js --help',
      );
    }
    options[property] = value;
    seen.add(argument);
    index += 1;
  }
  if (options.help)
  {
    if (argv.length !== 1)
    {
      throw new UsageError(
        'INVALID_HELP_USAGE',
        '--help cannot be combined with validation arguments',
        'run node scripts/check-release.js --help by itself',
      );
    }
    return options;
  }
  if (!options.base || !options.level || !options.next)
  {
    throw new UsageError(
      'MISSING_ARGUMENT',
      '--base, --level, and --next are required',
      'node scripts/check-release.js --help',
    );
  }
  if (options.staged === Boolean(options.commit))
  {
    throw new UsageError(
      'INVALID_VALIDATION_MODE',
      'choose exactly one of --staged and --commit RELEASE_SHA',
      'node scripts/check-release.js --help',
    );
  }
  if (options.staged && options.runId !== null)
  {
    throw new UsageError(
      'UNEXPECTED_RUN_ID',
      '--run-id is valid only with --commit',
      'omit --run-id for staged validation',
    );
  }
  if (options.commit && options.runId === null)
  {
    throw new UsageError(
      'MISSING_RUN_ID',
      '--run-id is required with --commit',
      'pass the validated decimal GITHUB_RUN_ID',
    );
  }
  bumpVersion(options.next, options.level);
  if (options.runId !== null && !/^\d+$/.test(options.runId))
  {
    throw new UsageError('INVALID_RUN_ID', 'run ID must be decimal', 'pass GITHUB_RUN_ID');
  }
  return options;
}

function reportError(error, stderr)
{
  if (error && error.code && error.condition && error.remedy)
  {
    stderr.write(`ERROR [${error.code}]: ${error.condition}\nRemedy: ${error.remedy}\n`);
    return;
  }
  stderr.write(`ERROR [UNEXPECTED]: ${error.stack || error.message}\n`);
}

function main(argv, {
  repositoryRoot = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {})
{
  try
  {
    const options = parseArguments(argv);
    if (options.help)
    {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (options.staged)
    {
      const result = validateStagedRelease(repositoryRoot, options);
      stdout.write(`Staged release passed: ${result.previous} -> ${result.next} (${result.level}), ${result.files} files.\n`);
    }
    else
    {
      const result = validateCommittedRelease(repositoryRoot, options);
      stdout.write(`Release commit passed: ${result.commit} (${result.version}, run ${result.runId}).\n`);
    }
    return 0;
  }
  catch (error)
  {
    reportError(error, stderr);
    if (error instanceof UsageError || error instanceof PolicyError)
    {
      return error.exitCode;
    }
    return 1;
  }
}

if (require.main === module)
{
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArguments };
