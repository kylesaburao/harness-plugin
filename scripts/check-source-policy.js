#!/usr/bin/env node
'use strict';

const {
  PolicyError,
  UsageError,
  validateIncomingChanges,
} = require('./release-policy');

const USAGE = `Usage: node scripts/check-source-policy.js --base BASE --head HEAD [--integration MERGE]

Validate submitted commits before dependency installation or candidate generation.
BASE, HEAD, and optional MERGE must resolve to commit objects. With --integration,
MERGE must contain BASE and HEAD and inherit BASE's complete release-owned pair.

Options:
  --base BASE          Event base or validated unreleased-range anchor
  --head HEAD          Submitted source head
  --integration MERGE  Pinned pull-request integration commit
  -h, --help           Print this message

Exit status: 0 policy passed, 2 bad usage, or 1 rejected content/Git inspection failure.`;

function parseArguments(argv)
{
  const options = {
    base: null,
    head: null,
    integration: null,
    help: false,
  };
  const names = new Map([
    ['--base', 'base'],
    ['--head', 'head'],
    ['--integration', 'integration'],
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
    const property = names.get(argument);
    if (!property)
    {
      throw new UsageError(
        'UNKNOWN_ARGUMENT',
        `unrecognized argument: ${argument}`,
        'node scripts/check-source-policy.js --help',
      );
    }
    if (seen.has(argument))
    {
      throw new UsageError(
        'DUPLICATE_ARGUMENT',
        `argument supplied more than once: ${argument}`,
        'pass each revision option exactly once',
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('-'))
    {
      throw new UsageError(
        'MISSING_VALUE',
        `${argument} requires a value`,
        'node scripts/check-source-policy.js --help',
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
        '--help cannot be combined with policy arguments',
        'run node scripts/check-source-policy.js --help by itself',
      );
    }
    return options;
  }
  if (!options.base || !options.head)
  {
    throw new UsageError(
      'MISSING_ARGUMENT',
      '--base and --head are required',
      'node scripts/check-source-policy.js --help',
    );
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
    const result = validateIncomingChanges(repositoryRoot, options);
    stdout.write(
      `Source policy passed: ${result.commits.length} submitted commit(s), ${result.base} -> ${result.head}`
      + `${result.integration ? ` via ${result.integration}` : ''}.\n`,
    );
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
