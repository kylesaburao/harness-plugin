#!/usr/bin/env node
'use strict';

// Select the release range by validated first-parent ancestry, then derive the
// level from every subject and changed path in that range. Standard library only.

const {
  deriveBumpLevel,
  deriveFromRange,
  isRelevantPath,
  releaseRange,
} = require('./release-policy');

const USAGE = `Usage: node scripts/derive-bump-level.js [--json] [--require-anchor]

Derive none, patch, minor, or major from every commit after the nearest valid
first-parent release record. Anchorless history is supported for standalone
fixtures unless --require-anchor is supplied.

Options:
  --json            Print range metadata as JSON instead of only the level
  --require-anchor  Fail when no structurally valid release record exists
  -h, --help        Print this message`;

function parseArguments(argv)
{
  const allowed = new Set(['--json', '--require-anchor', '--help', '-h']);
  const unknown = argv.find((argument) => !allowed.has(argument));
  if (unknown)
  {
    const error = new Error(`unrecognized argument: ${unknown}`);
    error.code = 'UNKNOWN_ARGUMENT';
    throw error;
  }
  if (new Set(argv).size !== argv.length
      || (argv.includes('--help') && argv.length !== 1)
      || (argv.includes('-h') && argv.length !== 1))
  {
    const error = new Error('duplicate arguments and combined --help are not supported');
    error.code = 'INVALID_ARGUMENTS';
    throw error;
  }
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    json: argv.includes('--json'),
    requireAnchor: argv.includes('--require-anchor'),
  };
}

function readReleaseRange(repositoryRoot, options = {})
{
  return releaseRange(repositoryRoot, options);
}

function main(argv = process.argv.slice(2), {
  repositoryRoot = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {})
{
  let options;
  try
  {
    options = parseArguments(argv);
  }
  catch (error)
  {
    stderr.write(`ERROR [${error.code}]: ${error.message}\nRemedy: node scripts/derive-bump-level.js --help\n`);
    return 2;
  }
  if (options.help)
  {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try
  {
    const selected = readReleaseRange(repositoryRoot, { requireAnchor: options.requireAnchor });
    if (options.json)
    {
      stdout.write(`${JSON.stringify({
        level: selected.level,
        head: selected.head,
        anchor: selected.anchor,
        commits: selected.commits,
      })}\n`);
    }
    else
    {
      stdout.write(`${selected.level}\n`);
    }
    return 0;
  }
  catch (error)
  {
    if (error && error.code && error.condition && error.remedy)
    {
      stderr.write(`ERROR [${error.code}]: ${error.condition}\nRemedy: ${error.remedy}\n`);
    }
    else
    {
      stderr.write(`${error.stderr || error.message}\n`);
    }
    return error.exitCode === 2 ? 2 : 1;
  }
}

if (require.main === module)
{
  process.exitCode = main();
}

module.exports = {
  deriveBumpLevel,
  deriveFromRange,
  isRelevantPath,
  main,
  parseArguments,
  readReleaseRange,
};
