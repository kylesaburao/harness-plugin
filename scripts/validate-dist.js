#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateArtifact, inventory, classify, outputPath } = require('./build');
const {
  DEFAULT_TARGET,
  ArtifactArgumentError,
  validateTarget,
  artifactRoot,
  parseArtifactTarget,
} = require('./artifact-paths');

function git(root, args, options = {})
{
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
  {
    const detail = result.error?.message || result.stderr?.toString('utf8').trim() || `exit ${result.status}`;
    throw new Error(`Git inspection failed (${args[0]}): ${detail}`);
  }
  return result.stdout;
}

function readIndexEntries(root)
{
  const output = git(root, ['ls-files', '--stage', '-z', '--', 'dist']);
  const entries = new Map();
  let offset = 0;
  while (offset < output.length)
  {
    const end = output.indexOf(0, offset);
    if (end === -1)
    {
      throw new Error('Git index output is not NUL terminated');
    }
    const record = output.subarray(offset, end);
    const separator = record.indexOf(0x09);
    if (separator === -1)
    {
      throw new Error('Malformed Git index record');
    }
    const metadata = record.subarray(0, separator).toString('ascii');
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])$/.exec(metadata);
    if (!match)
    {
      throw new Error(`Malformed Git index metadata: ${metadata}`);
    }
    const name = record.subarray(separator + 1).toString('utf8');
    if (!name)
    {
      throw new Error('Git index contains an empty distribution path');
    }
    const [, mode, objectId, stage] = match;
    if (stage !== '0')
    {
      throw new Error(`Unmerged distribution path: ${name}`);
    }
    if (entries.has(name))
    {
      throw new Error(`Duplicate distribution index path: ${name}`);
    }
    entries.set(name, { mode, objectId });
    offset = end + 1;
  }
  return entries;
}

function readIndexedBlobs(root, objectIds)
{
  const unique = [...new Set(objectIds)];
  if (!unique.length)
  {
    return new Map();
  }
  const output = git(root, ['cat-file', '--batch'], {
    input: Buffer.from(`${unique.join('\n')}\n`, 'ascii'),
  });
  const blobs = new Map();
  let offset = 0;
  for (const expected of unique)
  {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1)
    {
      throw new Error(`Truncated Git blob header: ${expected}`);
    }
    const header = output.subarray(offset, headerEnd).toString('ascii');
    if (header === `${expected} missing`)
    {
      throw new Error(`Missing indexed Git object: ${expected}`);
    }
    const match = /^([0-9a-f]+) (\S+) (\d+)$/.exec(header);
    if (!match || match[1] !== expected || match[2] !== 'blob')
    {
      throw new Error(`Unexpected Git blob header for ${expected}: ${header}`);
    }
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size))
    {
      throw new Error(`Invalid Git blob size for ${expected}: ${match[3]}`);
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a)
    {
      throw new Error(`Truncated indexed Git blob: ${expected}`);
    }
    blobs.set(expected, Buffer.from(output.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
  }
  if (offset !== output.length)
  {
    throw new Error('Unexpected trailing data from Git blob inspection');
  }
  return blobs;
}

function validateTracked(root, files)
{
  const tracked = readIndexEntries(root);
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

  const blobs = readIndexedBlobs(root, [...tracked.values()].map(entry => entry.objectId));
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
  readIndexEntries,
  readIndexedBlobs,
  parseArguments,
  main,
};
