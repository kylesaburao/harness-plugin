#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateArtifact, inventory, classify, outputPath } = require('./build');
const {
  DEFAULT_TARGET,
  ArtifactArgumentError,
  validateTarget,
  artifactRoot,
  parseArtifactTarget,
} = require('./artifact-paths');
const { indexEntries, readBlobs } = require('./release-policy');

function validateTracked(root, files)
{
  const tracked = indexEntries(root, ['dist']);
  for (const [name, entry] of tracked)
  {
    if (!name.startsWith('dist/harness/'))
    {
      throw new Error(`Forbidden/stale tracked artifact: ${name}`);
    }
    const relative = name.slice('dist/harness/'.length);
    if (!files.has(relative))
    {
      throw new Error(`Forbidden/stale tracked artifact: ${name}`);
    }
    if (!['100644', '100755'].includes(entry.mode))
    {
      throw new Error(`Unsupported tracked artifact mode: ${name} (${entry.mode})`);
    }
  }

  for (const [name, entry] of files)
  {
    const trackedName = `dist/harness/${name}`;
    const indexed = tracked.get(trackedName);
    const expectedMode = entry.mode === 0o755 ? '100755' : '100644';
    if (!indexed)
    {
      throw new Error(`Distribution file missing from index: ${name}`);
    }
    if (indexed.mode !== expectedMode)
    {
      throw new Error(`Distribution file has wrong indexed executable mode: ${name}`);
    }
  }

  const blobs = readBlobs(root, [...tracked.values()].map(entry => entry.objectId));
  for (const [name, entry] of files)
  {
    const indexed = tracked.get(`dist/harness/${name}`);
    const bytes = blobs.get(indexed.objectId);
    if (!bytes.equals(fs.readFileSync(entry.absolute)))
    {
      throw new Error(`Indexed distribution blob differs from tested file: ${name}`);
    }
  }
}

function validateOptions(options)
{
  if (options === null || typeof options !== 'object' || Array.isArray(options))
  {
    throw new TypeError('validation options must be an object');
  }
  const unexpected = Object.keys(options).filter(key => !['target', 'tracked'].includes(key));
  if (unexpected.length)
  {
    throw new TypeError(`unknown validation option: ${unexpected[0]}`);
  }
  const target = validateTarget(options.target ?? DEFAULT_TARGET);
  const tracked = options.tracked ?? false;
  if (typeof tracked !== 'boolean')
  {
    throw new TypeError('tracked validation option must be a boolean');
  }
  if (tracked && target !== 'distribution')
  {
    throw new ArtifactArgumentError(
      'TRACKED_TARGET_REQUIRED',
      'tracked validation applies only to the distribution target',
      'use --target distribution --tracked',
    );
  }
  return { target, tracked };
}

function validate(root, options = {})
{
  const { target, tracked } = validateOptions(options);
  const files = validateArtifact(artifactRoot(root, target));
  const source = inventory(path.join(root, 'src/harness'));
  const expected = new Set();
  for (const [name, entry] of source)
  {
    const kind = classify(name);
    const output = kind === 'typescript' ? outputPath(name) : name;
    if (output === null)
    {
      continue;
    }
    expected.add(output);
    const installed = files.get(output);
    if (!installed || installed.mode !== entry.mode)
    {
      throw new Error(`Missing artifact or wrong mode: ${output}`);
    }
    if (kind === 'asset' && !fs.readFileSync(entry.absolute).equals(fs.readFileSync(installed.absolute)))
    {
      throw new Error(`Asset differs from source: ${name}`);
    }
  }
  for (const name of files.keys())
  {
    if (!expected.has(name))
    {
      throw new Error(`Unexpected artifact: ${name}`);
    }
  }
  if (tracked)
  {
    validateTracked(root, files);
  }
  return files.size;
}

const USAGE = `Usage: node scripts/validate-dist.js [--target development|distribution] [--tracked]

Validate the development artifact by default. --tracked reads and verifies the Git
index and is valid only with an explicit --target distribution.`;

function parseArguments(argv)
{
  const parsed = parseArtifactTarget(argv);
  let tracked = false;
  let help = false;
  for (const argument of parsed.remaining)
  {
    if (argument === '--tracked')
    {
      if (tracked)
      {
        throw new ArtifactArgumentError('DUPLICATE_TRACKED', '--tracked was supplied more than once', 'supply --tracked once');
      }
      tracked = true;
    }
    else if (argument === '--help' || argument === '-h')
    {
      if (help)
      {
        throw new ArtifactArgumentError('DUPLICATE_HELP', 'help was supplied more than once', 'supply --help once');
      }
      help = true;
    }
    else
    {
      throw new ArtifactArgumentError('UNKNOWN_ARGUMENT', `unrecognized argument: ${argument}`, 'node scripts/validate-dist.js --help');
    }
  }
  if (help && (tracked || parsed.explicitTarget))
  {
    throw new ArtifactArgumentError('INVALID_ARGUMENTS', '--help cannot be combined with validation options', 'node scripts/validate-dist.js --help');
  }
  if (tracked && (!parsed.explicitTarget || parsed.target !== 'distribution'))
  {
    throw new ArtifactArgumentError(
      'TRACKED_TARGET_REQUIRED',
      '--tracked requires an explicit --target distribution',
      'use node scripts/validate-dist.js --target distribution --tracked',
    );
  }
  return { target: parsed.target, tracked, help };
}

function main(argv)
{
  try
  {
    const options = parseArguments(argv);
    if (options.help)
    {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const count = validate(path.resolve(__dirname, '..'), { target: options.target, tracked: options.tracked });
    process.stdout.write(`${options.target === 'development' ? 'Development artifact' : 'Distribution'} validation passed: ${count} files.\n`);
    return 0;
  }
  catch (error)
  {
    if (error instanceof ArtifactArgumentError)
    {
      process.stderr.write(`ERROR [${error.code}]: ${error.message}\nRemedy: ${error.remedy}\n`);
      return error.exitCode;
    }
    process.stderr.write(`ERROR [invalid_artifact]: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module)
{
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  validate,
  validateTracked,
  parseArguments,
  main,
};
