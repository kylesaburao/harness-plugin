#!/usr/bin/env node
'use strict';

// Shared, dependency-free release and incoming-change policy. This module only
// inspects Git and the working checkout; it never mutates Git state or files.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');
const { assertReleaseWriteIntent } = require('./artifact-paths');
const { classify, outputPath } = require('./build');

const CANONICAL_PACKAGE = 'src/harness/package.json';
const DISTRIBUTION_ROOT = 'dist/harness';
const DISTRIBUTION_PREFIX = `${DISTRIBUTION_ROOT}/`;
const RELEASE_SUBJECT_PREFIX = 'chore: bump version to ';
const RELEASE_SUBJECT_PATTERN = /^chore: bump version to (\d+\.\d+\.\d+)$/;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const FIXED_COMMIT_EPOCH = '946713540';
const SOURCE_TRAILER = 'Harness-Source';
const RUN_TRAILER = 'Harness-Release-Run';
const MIGRATED_RELEASE_MARKER = 'scripts/check-release.js';
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

const GENERATED_VERSION_PATHS = Object.freeze([
  'dist/harness/package.json',
  'dist/harness/.claude-plugin/plugin.json',
  'dist/harness/.codex-plugin/plugin.json',
]);

const RELEVANT_DIRECTORY_PREFIXES = Object.freeze([
  'src/harness/',
  '.claude-plugin/',
  '.agents/plugins/',
]);

const RELEVANT_EXACT_PATHS = Object.freeze([
  'scripts/build.js',
  'scripts/artifact-paths.js',
  'tsconfig.json',
  'package.json',
  'package-lock.json',
  '.gitattributes',
  '.github/workflows/bump-version.yml',
]);

const ASSET_EXTENSIONS = new Set([
  '.md',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.py',
  '.swift',
]);

const FORBIDDEN_ARTIFACT_COMPONENTS = new Set([
  'node_modules',
  '__pycache__',
  'tests',
  'fixtures',
  'benchmarks',
  'evidence',
  '.git',
  '.build',
  '.venv',
  'generated',
]);

const OPAQUE_OVERLAYS = new Set([
  'skills/back-up-directories/node_modules',
  'skills/write-asd-ste100/scripts/__pycache__',
]);

class PolicyError extends Error
{
  constructor(code, condition, remedy, exitCode = 1)
  {
    super(condition);
    this.name = 'PolicyError';
    this.code = code;
    this.condition = condition;
    this.remedy = remedy;
    this.exitCode = exitCode;
  }
}

class UsageError extends PolicyError
{
  constructor(code, condition, remedy)
  {
    super(code, condition, remedy, 2);
    this.name = 'UsageError';
  }
}

function policyFailure(code, condition, remedy)
{
  throw new PolicyError(code, condition, remedy);
}

function runGit(repositoryRoot, arguments_, { input, allowedStatuses = [0] } = {})
{
  const result = spawnSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: null,
    input,
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error)
  {
    policyFailure(
      'GIT_EXECUTION_FAILED',
      `Git could not run: ${result.error.message}`,
      'install Git and retry from a complete repository checkout',
    );
  }
  if (!allowedStatuses.includes(result.status))
  {
    const detail = result.stderr.toString('utf8').trim()
      || result.stdout.toString('utf8').trim()
      || `Git exited ${result.status}`;
    policyFailure(
      'GIT_INSPECTION_FAILED',
      detail,
      'fetch the required history, repair the repository state, and retry',
    );
  }
  return result;
}

function gitBuffer(repositoryRoot, arguments_)
{
  return runGit(repositoryRoot, arguments_).stdout;
}

function gitText(repositoryRoot, arguments_)
{
  return gitBuffer(repositoryRoot, arguments_).toString('utf8');
}

function assertCompleteHistory(repositoryRoot)
{
  const shallow = trimOneLineEnding(gitText(
    repositoryRoot,
    ['rev-parse', '--is-shallow-repository'],
  ));
  if (shallow === 'true')
  {
    policyFailure(
      'INCOMPLETE_GIT_HISTORY',
      'release policy cannot validate a shallow repository',
      'fetch complete commit history before checking source or release ancestry',
    );
  }
  if (shallow !== 'false')
  {
    policyFailure(
      'GIT_INSPECTION_FAILED',
      `Git returned an invalid shallow-repository state: ${JSON.stringify(shallow)}`,
      'repair the repository state and retry with complete history',
    );
  }
}

function trimOneLineEnding(value)
{
  return value.endsWith('\r\n')
    ? value.slice(0, -2)
    : value.endsWith('\n')
      ? value.slice(0, -1)
      : value;
}

function splitNul(buffer)
{
  const values = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1)
  {
    if (buffer[index] !== 0)
    {
      continue;
    }
    values.push(buffer.subarray(start, index).toString('utf8'));
    start = index + 1;
  }
  if (start < buffer.length)
  {
    values.push(buffer.subarray(start).toString('utf8'));
  }
  return values.filter((value) => value.length > 0);
}

function resolveCommit(repositoryRoot, revision)
{
  if (typeof revision !== 'string' || revision.length === 0)
  {
    throw new UsageError(
      'INVALID_REVISION',
      'a nonempty Git revision is required',
      'pass a revision that resolves to a commit',
    );
  }
  const result = runGit(
    repositoryRoot,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`],
    { allowedStatuses: [0, 1] },
  );
  if (result.status !== 0)
  {
    policyFailure(
      'INVALID_REVISION',
      `revision does not resolve to a commit: ${revision}`,
      'fetch the required commit history and pass an existing commit revision',
    );
  }
  const objectId = trimOneLineEnding(result.stdout.toString('ascii'));
  if (!/^[0-9a-f]{40,64}$/.test(objectId))
  {
    policyFailure(
      'INVALID_GIT_OBJECT_ID',
      `Git returned an invalid commit object ID for ${revision}`,
      'repair the repository object database and retry',
    );
  }
  return objectId;
}

function commitParents(repositoryRoot, commit)
{
  const line = trimOneLineEnding(gitText(
    repositoryRoot,
    ['rev-list', '--parents', '--max-count=1', commit],
  ));
  const fields = line.split(' ');
  if (fields[0] !== commit)
  {
    policyFailure(
      'COMMIT_INSPECTION_FAILED',
      `Git returned unexpected parent data for ${commit}`,
      'repair the repository object database and retry',
    );
  }
  return fields.slice(1);
}

function commitSubject(repositoryRoot, commit)
{
  return trimOneLineEnding(gitText(repositoryRoot, ['show', '--no-patch', '--format=%s', commit]));
}

function commitMessage(repositoryRoot, commit)
{
  return trimOneLineEnding(gitText(repositoryRoot, ['show', '--no-patch', '--format=%B', commit]));
}

function commitTimestamps(repositoryRoot, commit)
{
  const value = trimOneLineEnding(gitText(
    repositoryRoot,
    ['show', '--no-patch', '--format=%at%x00%ct%x00%aI%x00%cI', commit],
  ));
  const [authorEpoch, committerEpoch, authorIso, committerIso] = value.split('\0');
  return {
    authorEpoch,
    committerEpoch,
    authorIso,
    committerIso,
  };
}

function commitIdentity(repositoryRoot, commit)
{
  const value = trimOneLineEnding(gitText(
    repositoryRoot,
    ['show', '--no-patch', '--format=%an%x00%ae%x00%cn%x00%ce', commit],
  ));
  const [authorName, authorEmail, committerName, committerEmail] = value.split('\0');
  return { authorName, authorEmail, committerName, committerEmail };
}

function isAncestor(repositoryRoot, ancestor, descendant)
{
  const result = runGit(
    repositoryRoot,
    ['merge-base', '--is-ancestor', ancestor, descendant],
    { allowedStatuses: [0, 1] },
  );
  return result.status === 0;
}

function changedPathsBetween(repositoryRoot, base, head)
{
  return splitNul(gitBuffer(
    repositoryRoot,
    ['diff', '--name-only', '-z', '--no-renames', base, head, '--'],
  ));
}

function changedPathsInCommit(repositoryRoot, commit)
{
  const parents = commitParents(repositoryRoot, commit);
  if (parents.length === 0)
  {
    return splitNul(gitBuffer(
      repositoryRoot,
      ['diff-tree', '--root', '--no-commit-id', '-r', '-z', '--no-renames', '--name-only', commit, '--'],
    ));
  }
  return changedPathsBetween(repositoryRoot, parents[0], commit);
}

function parseTreeRecords(buffer, label)
{
  const entries = new Map();
  for (const record of splitNul(buffer))
  {
    const separator = record.indexOf('\t');
    if (separator < 0)
    {
      policyFailure(
        'MALFORMED_GIT_RECORD',
        `Git returned a malformed ${label} record`,
        'repair the repository object database and retry',
      );
    }
    const metadata = record.slice(0, separator).split(' ');
    const name = record.slice(separator + 1);
    if (metadata.length !== 3 || entries.has(name))
    {
      policyFailure(
        'MALFORMED_GIT_RECORD',
        `Git returned invalid or duplicate ${label} data for ${JSON.stringify(name)}`,
        'repair the repository object database and retry',
      );
    }
    const [mode, type, objectId] = metadata;
    entries.set(name, { mode, type, objectId, name });
  }
  return entries;
}

function treeEntries(repositoryRoot, commit, paths = ['dist', CANONICAL_PACKAGE])
{
  return parseTreeRecords(gitBuffer(
    repositoryRoot,
    ['ls-tree', '--full-tree', '-r', '-z', commit, '--', ...paths],
  ), 'tree');
}

function protectedSignature(repositoryRoot, commit)
{
  const entries = treeEntries(repositoryRoot, commit);
  return [...entries.values()].map((entry) => (
    `${entry.mode} ${entry.type} ${entry.objectId}\t${entry.name}\0`
  )).join('');
}

function parseIndexRecords(buffer)
{
  const entries = new Map();
  for (const record of splitNul(buffer))
  {
    const separator = record.indexOf('\t');
    if (separator < 0)
    {
      policyFailure(
        'MALFORMED_INDEX_RECORD',
        'Git returned a malformed index record',
        'repair the Git index and retry',
      );
    }
    const metadata = record.slice(0, separator).split(' ');
    const name = record.slice(separator + 1);
    if (metadata.length !== 3)
    {
      policyFailure(
        'MALFORMED_INDEX_RECORD',
        `Git returned malformed index metadata for ${JSON.stringify(name)}`,
        'repair the Git index and retry',
      );
    }
    const [mode, objectId, stage] = metadata;
    if (stage !== '0')
    {
      policyFailure(
        'UNMERGED_INDEX_ENTRY',
        `the index contains an unmerged entry: ${JSON.stringify(name)}`,
        'resolve every index conflict before validating a release',
      );
    }
    if (entries.has(name))
    {
      policyFailure(
        'DUPLICATE_INDEX_ENTRY',
        `the index contains duplicate data for ${JSON.stringify(name)}`,
        'repair the Git index and retry',
      );
    }
    entries.set(name, { mode, type: 'blob', objectId, name });
  }
  return entries;
}

function indexEntries(repositoryRoot, paths = ['dist', CANONICAL_PACKAGE])
{
  return parseIndexRecords(gitBuffer(
    repositoryRoot,
    ['ls-files', '--stage', '-z', '--', ...paths],
  ));
}

function readBlobs(repositoryRoot, objectIds)
{
  const unique = [...new Set(objectIds)];
  if (unique.length === 0)
  {
    return new Map();
  }
  const result = runGit(
    repositoryRoot,
    ['cat-file', '--batch'],
    { input: Buffer.from(`${unique.join('\n')}\n`, 'ascii') },
  );
  const output = result.stdout;
  const blobs = new Map();
  let cursor = 0;
  for (const requested of unique)
  {
    const lineEnd = output.indexOf(0x0a, cursor);
    if (lineEnd < 0)
    {
      policyFailure(
        'MALFORMED_CAT_FILE_OUTPUT',
        `Git omitted blob metadata for ${requested}`,
        'repair the repository object database and retry',
      );
    }
    const header = output.subarray(cursor, lineEnd).toString('ascii');
    const fields = header.split(' ');
    if (fields.length !== 3 || fields[0] !== requested || fields[1] !== 'blob' || !/^\d+$/.test(fields[2]))
    {
      policyFailure(
        'INVALID_INDEX_OBJECT',
        `indexed object ${requested} is missing or is not a blob`,
        'repair the Git index/object database and retry',
      );
    }
    const size = Number(fields[2]);
    const start = lineEnd + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end >= output.length || output[end] !== 0x0a)
    {
      policyFailure(
        'MALFORMED_CAT_FILE_OUTPUT',
        `Git returned incomplete blob data for ${requested}`,
        'repair the repository object database and retry',
      );
    }
    blobs.set(requested, Buffer.from(output.subarray(start, end)));
    cursor = end + 1;
  }
  if (cursor !== output.length)
  {
    policyFailure(
      'MALFORMED_CAT_FILE_OUTPUT',
      'Git returned unexpected trailing blob data',
      'repair the repository object database and retry',
    );
  }
  return blobs;
}

function entriesWithBytes(repositoryRoot, entries)
{
  const blobs = readBlobs(repositoryRoot, [...entries.values()].map((entry) => entry.objectId));
  return new Map([...entries].map(([name, entry]) => [name, {
    ...entry,
    bytes: blobs.get(entry.objectId),
  }]));
}

function requireEntry(entries, name, label)
{
  const entry = entries.get(name);
  if (!entry)
  {
    policyFailure(
      'REQUIRED_PATH_MISSING',
      `${label} is missing ${name}`,
      'rebuild and stage the complete versioned distribution before retrying',
    );
  }
  return entry;
}

function parseJson(bytes, label)
{
  let value;
  try
  {
    value = JSON.parse(bytes.toString('utf8'));
  }
  catch (error)
  {
    policyFailure(
      'INVALID_JSON',
      `${label} is not valid JSON: ${error.message}`,
      'restore or regenerate the file from trusted source and retry',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
  {
    policyFailure(
      'INVALID_JSON_OBJECT',
      `${label} must contain a JSON object`,
      'restore or regenerate the file from trusted source and retry',
    );
  }
  return value;
}

function parseVersion(version, label = 'version')
{
  if (typeof version !== 'string')
  {
    throw new UsageError(
      'INVALID_VERSION',
      `${label} must be a plain M.m.p version`,
      'pass a plain semantic version such as 1.2.3',
    );
  }
  const match = SEMVER_PATTERN.exec(version);
  if (!match)
  {
    throw new UsageError(
      'INVALID_VERSION',
      `${label} must be a plain M.m.p version: ${version}`,
      'pass a plain semantic version such as 1.2.3',
    );
  }
  return match.slice(1).map((component) => BigInt(component));
}

function bumpVersion(version, level)
{
  const [major, minor, patch] = parseVersion(version, 'source version');
  if (level === 'patch')
  {
    return `${major}.${minor}.${patch + 1n}`;
  }
  if (level === 'minor')
  {
    return `${major}.${minor + 1n}.0`;
  }
  if (level === 'major')
  {
    return `${major + 1n}.0.0`;
  }
  throw new UsageError(
    'INVALID_LEVEL',
    `release level must be patch, minor, or major: ${level}`,
    'pass exactly one supported release level',
  );
}

function inferBumpLevel(previous, next)
{
  for (const level of ['patch', 'minor', 'major'])
  {
    if (bumpVersion(previous, level) === next)
    {
      return level;
    }
  }
  policyFailure(
    'INVALID_VERSION_INCREMENT',
    `${previous} -> ${next} is not one patch, minor, or major increment`,
    'publish exactly one valid semantic-version increment',
  );
}

function validateCanonicalBoundary(manifest, label)
{
  const keys = Object.keys(manifest).sort();
  const expectedKeys = ['name', 'private', 'type', 'version'].sort();
  if (!isDeepStrictEqual(keys, expectedKeys)
      || manifest.name !== 'harness'
      || manifest.private !== true
      || manifest.type !== 'commonjs'
      || typeof manifest.version !== 'string'
      || !SEMVER_PATTERN.test(manifest.version))
  {
    policyFailure(
      'INVALID_CANONICAL_PACKAGE',
      `${label} does not preserve the fixed harness package boundary`,
      'restore the canonical package metadata; publication may change only version',
    );
  }
}

function validateCanonicalTransition(previousBytes, nextBytes, declaredLevel, declaredNext)
{
  const previous = parseJson(previousBytes, 'source canonical package');
  const next = parseJson(nextBytes, 'release canonical package');
  validateCanonicalBoundary(previous, 'source canonical package');
  validateCanonicalBoundary(next, 'release canonical package');
  const expectedNext = bumpVersion(previous.version, declaredLevel);
  if (expectedNext !== declaredNext || next.version !== declaredNext)
  {
    policyFailure(
      'VERSION_INCREMENT_MISMATCH',
      `declared ${declaredLevel} release ${declaredNext} does not match source version ${previous.version}`,
      'derive the next version from the selected source snapshot and requested level',
    );
  }
  const expectedBytes = Buffer.from(`${JSON.stringify({ ...previous, version: declaredNext }, null, 2)}\n`, 'utf8');
  if (!nextBytes.equals(expectedBytes))
  {
    policyFailure(
      'CANONICAL_PACKAGE_CHANGED',
      'the canonical package changed by more than its deterministic version update',
      'restore all canonical package bytes except the release-owned version change',
    );
  }
  return { previous: previous.version, next: next.version, level: declaredLevel };
}

function artifactRelativeEntries(entries)
{
  const artifact = new Map();
  for (const [name, entry] of entries)
  {
    if (name === CANONICAL_PACKAGE)
    {
      continue;
    }
    if (!name.startsWith(DISTRIBUTION_PREFIX))
    {
      policyFailure(
        'FORBIDDEN_DISTRIBUTION_PATH',
        `distribution content lies outside ${DISTRIBUTION_ROOT}/: ${JSON.stringify(name)}`,
        'remove every dist path outside the generated harness artifact',
      );
    }
    artifact.set(name.slice(DISTRIBUTION_PREFIX.length), entry);
  }
  return artifact;
}

function validateArtifactEntries(entries, label)
{
  const artifact = artifactRelativeEntries(entries);
  const foldedPaths = new Map();
  for (const [relative, entry] of artifact)
  {
    const folded = relative.normalize('NFC').toLowerCase();
    if (foldedPaths.has(folded))
    {
      policyFailure(
        'ARTIFACT_PATH_COLLISION',
        `${label} contains colliding paths: ${JSON.stringify(foldedPaths.get(folded))} and ${JSON.stringify(relative)}`,
        'regenerate the distribution from a collision-free source tree',
      );
    }
    foldedPaths.set(folded, relative);
    if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob')
    {
      policyFailure(
        'INVALID_ARTIFACT_MODE',
        `${label} contains an unsupported entry mode at ${JSON.stringify(relative)}: ${entry.mode}`,
        'regenerate the distribution from source and stage only regular generated files',
      );
    }
    if (relative.endsWith('.local.json'))
    {
      policyFailure(
        'FORBIDDEN_ARTIFACT_PATH',
        `${label} contains local configuration: ${JSON.stringify(relative)}`,
        'remove local configuration from the generated distribution',
      );
    }
    const components = relative.split('/');
    if (components.some((component) => FORBIDDEN_ARTIFACT_COMPONENTS.has(component)))
    {
      policyFailure(
        'FORBIDDEN_ARTIFACT_PATH',
        `${label} contains development-only content: ${JSON.stringify(relative)}`,
        'remove caches, dependencies, tests, fixtures, and source-only content from dist',
      );
    }
    if (/\.(?:ts|mts|cts)$/.test(relative))
    {
      policyFailure(
        'FORBIDDEN_ARTIFACT_SOURCE',
        `${label} contains TypeScript source: ${JSON.stringify(relative)}`,
        'publish compiled JavaScript, not TypeScript source',
      );
    }
    if (/\.(?:js|mjs|cjs)$/.test(relative))
    {
      if (!/^(?:shared\/node\/|skills\/[^/]+\/scripts\/)/.test(relative))
      {
        policyFailure(
          'UNEXPECTED_ARTIFACT_JAVASCRIPT',
          `${label} contains JavaScript outside an installed runtime boundary: ${JSON.stringify(relative)}`,
          'regenerate the distribution with the repository builder',
        );
      }
    }
    else if (!ASSET_EXTENSIONS.has(path.posix.extname(relative)))
    {
      policyFailure(
        'UNSUPPORTED_ARTIFACT_FILE',
        `${label} contains an unsupported file: ${JSON.stringify(relative)}`,
        'regenerate the distribution with the repository builder',
      );
    }
  }

  const packageEntry = requireEntry(artifact, 'package.json', label);
  const claudeEntry = requireEntry(artifact, '.claude-plugin/plugin.json', label);
  const codexEntry = requireEntry(artifact, '.codex-plugin/plugin.json', label);
  const packageManifest = parseJson(packageEntry.bytes, `${label} package.json`);
  const claudeManifest = parseJson(claudeEntry.bytes, `${label} Claude manifest`);
  const codexManifest = parseJson(codexEntry.bytes, `${label} Codex manifest`);
  validateCanonicalBoundary(packageManifest, `${label} package.json`);
  if (claudeManifest.name !== packageManifest.name
      || codexManifest.name !== packageManifest.name
      || claudeManifest.version !== packageManifest.version
      || codexManifest.version !== packageManifest.version
      || codexManifest.skills !== './skills/')
  {
    policyFailure(
      'GENERATED_VERSION_MISMATCH',
      `${label} package and host manifests do not share one valid name/version boundary`,
      'regenerate the complete distribution after updating the canonical version',
    );
  }
  return { files: artifact, version: packageManifest.version };
}

function validateSourceArtifactBoundary(
  repositoryRoot,
  sourceCommit,
  releaseEntries,
  version,
  { canonicalEntry = null } = {},
)
{
  const sourcePrefix = 'src/harness/';
  const sourceEntries = entriesWithBytes(
    repositoryRoot,
    treeEntries(repositoryRoot, sourceCommit, ['src/harness']),
  );
  const artifact = artifactRelativeEntries(releaseEntries);
  const expected = new Map();
  const foldedSources = new Map();
  const foldedOutputs = new Map();

  for (const [name, originalEntry] of sourceEntries)
  {
    if (!name.startsWith(sourcePrefix))
    {
      policyFailure(
        'INVALID_SOURCE_PATH',
        `source tree contains a path outside ${sourcePrefix}: ${JSON.stringify(name)}`,
        'restore the canonical source tree before publishing',
      );
    }
    const relative = name.slice(sourcePrefix.length);
    const sourceFolded = relative.normalize('NFC').toLowerCase();
    if (foldedSources.has(sourceFolded))
    {
      policyFailure(
        'SOURCE_PATH_COLLISION',
        `source tree contains colliding paths: ${JSON.stringify(foldedSources.get(sourceFolded))} and ${JSON.stringify(relative)}`,
        'rename the colliding source paths before publishing',
      );
    }
    foldedSources.set(sourceFolded, relative);

    let entry = originalEntry;
    if (relative === 'package.json' && canonicalEntry !== null)
    {
      entry = canonicalEntry;
    }
    if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob')
    {
      policyFailure(
        'INVALID_SOURCE_MODE',
        `source artifact input has an unsupported type or mode: ${JSON.stringify(relative)}`,
        'restore regular source files with their intended executable modes',
      );
    }

    const components = relative.split('/');
    if (relative.endsWith('.local.json')
        || components.some((component) => FORBIDDEN_ARTIFACT_COMPONENTS.has(component)))
    {
      policyFailure(
        'FORBIDDEN_SOURCE_ARTIFACT_INPUT',
        `source tree contains non-distributable content: ${JSON.stringify(relative)}`,
        'remove development-only content from src/harness before publishing',
      );
    }

    let kind;
    try
    {
      kind = classify(relative);
    }
    catch (error)
    {
      policyFailure(
        'UNCLASSIFIED_SOURCE_ARTIFACT_INPUT',
        `source tree contains an unsupported artifact input: ${JSON.stringify(relative)} (${error.message})`,
        'remove or classify the source resource before publishing',
      );
    }

    let output = relative;
    let expectedBytes = entry.bytes;
    if (kind === 'template')
    {
      const template = parseJson(entry.bytes, `source host manifest ${relative}`);
      if (Object.hasOwn(template, 'version'))
      {
        policyFailure(
          'SOURCE_MANIFEST_OWNS_VERSION',
          `source host manifest contains a version: ${relative}`,
          'remove the generated version field from the source template',
        );
      }
      expectedBytes = Buffer.from(`${JSON.stringify({ ...template, version }, null, 2)}\n`, 'utf8');
    }
    else if (kind === 'typescript')
    {
      output = outputPath(relative);
      expectedBytes = null;
    }

    if (output === null)
    {
      continue;
    }
    const outputFolded = output.normalize('NFC').toLowerCase();
    if (foldedOutputs.has(outputFolded))
    {
      policyFailure(
        'ARTIFACT_OUTPUT_COLLISION',
        `source paths produce the same artifact path: ${JSON.stringify(foldedOutputs.get(outputFolded))} and ${JSON.stringify(relative)}`,
        'rename the colliding source paths before publishing',
      );
    }
    foldedOutputs.set(outputFolded, relative);
    expected.set(output, {
      source: relative,
      mode: entry.mode,
      bytes: expectedBytes,
    });
  }

  for (const [output, expectedEntry] of expected)
  {
    const actual = artifact.get(output);
    if (!actual)
    {
      policyFailure(
        'ARTIFACT_OUTPUT_MISSING',
        `artifact is missing output ${JSON.stringify(output)} for source ${JSON.stringify(expectedEntry.source)}`,
        'regenerate and publish the complete source-derived distribution',
      );
    }
    if (actual.mode !== expectedEntry.mode)
    {
      policyFailure(
        'ARTIFACT_OUTPUT_MODE_MISMATCH',
        `artifact mode differs from source for ${JSON.stringify(output)}`,
        'regenerate and stage the source-derived executable modes',
      );
    }
    if (expectedEntry.bytes !== null && !actual.bytes.equals(expectedEntry.bytes))
    {
      policyFailure(
        'ARTIFACT_ASSET_MISMATCH',
        `artifact bytes differ from source-derived bytes for ${JSON.stringify(output)}`,
        'regenerate and publish the exact source-derived distribution',
      );
    }
  }
  for (const output of artifact.keys())
  {
    if (!expected.has(output))
    {
      policyFailure(
        'UNEXPECTED_ARTIFACT_OUTPUT',
        `artifact contains output with no source input: ${JSON.stringify(output)}`,
        'remove fabricated or obsolete output by rebuilding the complete distribution',
      );
    }
  }
}

function pathAppearsInAncestry(repositoryRoot, commit, repositoryPath)
{
  const commits = gitText(
    repositoryRoot,
    ['rev-list', '--max-count=1', commit, '--', repositoryPath],
  );
  return commits.length > 0;
}

function releaseTrailers(message)
{
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '')
  {
    lines.pop();
  }
  const separator = lines.lastIndexOf('');
  const footer = separator > 0 ? lines.slice(separator + 1) : [];
  const isTrailerLine = (line) => /^[A-Za-z0-9-]+: .+$/u.test(line);
  const validFooter = footer.length > 0 && footer.every(isTrailerLine);
  const trailerLines = validFooter ? footer : [];
  const sources = trailerLines.filter((line) => line.startsWith(`${SOURCE_TRAILER}: `));
  const runs = trailerLines.filter((line) => line.startsWith(`${RUN_TRAILER}: `));
  return {
    sourceLines: sources,
    runLines: runs,
    source: sources.length === 1 ? sources[0].slice(`${SOURCE_TRAILER}: `.length) : null,
    runId: runs.length === 1 ? runs[0].slice(`${RUN_TRAILER}: `.length) : null,
  };
}

function validateReleaseRecord(repositoryRoot, revision, { requireTrailers } = {})
{
  assertCompleteHistory(repositoryRoot);
  const commit = resolveCommit(repositoryRoot, revision);
  const subject = commitSubject(repositoryRoot, commit);
  const subjectMatch = RELEASE_SUBJECT_PATTERN.exec(subject);
  if (!subjectMatch)
  {
    policyFailure(
      'INVALID_RELEASE_SUBJECT',
      `release-looking commit ${commit} has an invalid subject: ${subject}`,
      'use exactly "chore: bump version to X.Y.Z" for a release commit',
    );
  }
  const parents = commitParents(repositoryRoot, commit);
  if (parents.length !== 1)
  {
    policyFailure(
      'INVALID_RELEASE_PARENTS',
      `release commit ${commit} must have exactly one parent`,
      'publish from one tested source snapshot without merging or rewriting history',
    );
  }
  const parent = parents[0];
  const changed = changedPathsBetween(repositoryRoot, parent, commit);
  if (changed.length === 0
      || changed.some((name) => name !== CANONICAL_PACKAGE && !name.startsWith(DISTRIBUTION_PREFIX)))
  {
    policyFailure(
      'INVALID_RELEASE_DIFF',
      `release commit ${commit} changes paths outside the canonical package and generated distribution`,
      'create one release commit containing only the canonical version and dist/harness',
    );
  }
  for (const required of [CANONICAL_PACKAGE, ...GENERATED_VERSION_PATHS])
  {
    if (!changed.includes(required))
    {
      policyFailure(
        'INCOMPLETE_RELEASE_DIFF',
        `release commit ${commit} does not update ${required}`,
        'build and commit the complete versioned distribution together',
      );
    }
  }

  const currentEntries = entriesWithBytes(repositoryRoot, treeEntries(repositoryRoot, commit));
  const parentEntries = entriesWithBytes(repositoryRoot, treeEntries(repositoryRoot, parent));
  const currentPackage = requireEntry(currentEntries, CANONICAL_PACKAGE, `release commit ${commit}`);
  const parentPackage = requireEntry(parentEntries, CANONICAL_PACKAGE, `release parent ${parent}`);
  if (currentPackage.mode !== '100644'
      || currentPackage.type !== 'blob'
      || currentPackage.mode !== parentPackage.mode
      || currentPackage.type !== parentPackage.type)
  {
    policyFailure(
      'CANONICAL_PACKAGE_MODE_CHANGED',
      `release commit ${commit} changes the canonical package entry type or mode`,
      'restore the canonical package mode; publication may change only its version bytes',
    );
  }
  const currentManifest = parseJson(currentPackage.bytes, `release canonical package at ${commit}`);
  const parentManifest = parseJson(parentPackage.bytes, `release canonical package at ${parent}`);
  validateCanonicalBoundary(currentManifest, `release canonical package at ${commit}`);
  validateCanonicalBoundary(parentManifest, `release canonical package at ${parent}`);
  const parentArtifact = validateArtifactEntries(parentEntries, `release parent ${parent}`);
  if (parentArtifact.version !== parentManifest.version)
  {
    policyFailure(
      'PUBLISHED_VERSION_MISMATCH',
      `release parent ${parent} has inconsistent published version fields`,
      'repair the published pair explicitly before attempting another release',
    );
  }
  const level = inferBumpLevel(parentManifest.version, currentManifest.version);
  validateCanonicalTransition(parentPackage.bytes, currentPackage.bytes, level, currentManifest.version);
  if (currentManifest.version !== subjectMatch[1])
  {
    policyFailure(
      'RELEASE_SUBJECT_VERSION_MISMATCH',
      `release subject names ${subjectMatch[1]} but the canonical package contains ${currentManifest.version}`,
      'make the subject and all four release version fields agree',
    );
  }
  const artifact = validateArtifactEntries(currentEntries, `release commit ${commit}`);
  if (artifact.version !== currentManifest.version)
  {
    policyFailure(
      'GENERATED_VERSION_MISMATCH',
      `release commit ${commit} does not use canonical version ${currentManifest.version} throughout dist`,
      'regenerate the complete distribution from the versioned canonical package',
    );
  }
  validateSourceArtifactBoundary(
    repositoryRoot,
    commit,
    currentEntries,
    currentManifest.version,
  );

  const trailerPolicy = requireTrailers === undefined
    ? pathAppearsInAncestry(repositoryRoot, parent, MIGRATED_RELEASE_MARKER)
    : requireTrailers;
  const trailers = releaseTrailers(commitMessage(repositoryRoot, commit));
  if (trailerPolicy)
  {
    if (trailers.sourceLines.length !== 1
        || trailers.runLines.length !== 1
        || trailers.source !== parent
        || !/^\d+$/.test(trailers.runId || ''))
    {
      policyFailure(
        'INVALID_RELEASE_TRAILERS',
        `release commit ${commit} does not contain one matching source trailer and one decimal run trailer`,
        'create the release with Harness-Source and Harness-Release-Run trailers from the validated transaction',
      );
    }
  }
  else if ((trailers.sourceLines.length !== 0 || trailers.runLines.length !== 0)
      && (trailers.sourceLines.length !== 1
        || trailers.runLines.length !== 1
        || trailers.source !== parent
        || !/^\d+$/.test(trailers.runId || '')))
  {
    policyFailure(
      'INVALID_RELEASE_TRAILERS',
      `legacy release commit ${commit} contains incomplete or malformed release trailers`,
      'repair the malformed release history before continuing',
    );
  }

  return {
    commit,
    parent,
    previous: parentManifest.version,
    version: currentManifest.version,
    level,
    subject,
    source: trailers.source,
    runId: trailers.runId,
    requiresTrailers: trailerPolicy,
  };
}

function firstParentCommits(repositoryRoot, head)
{
  return gitText(repositoryRoot, ['rev-list', '--first-parent', head])
    .split('\n')
    .filter(Boolean);
}

function findReleaseAnchor(repositoryRoot, head = 'HEAD', { required = false } = {})
{
  assertCompleteHistory(repositoryRoot);
  const resolvedHead = resolveCommit(repositoryRoot, head);
  for (const commit of firstParentCommits(repositoryRoot, resolvedHead))
  {
    const subject = commitSubject(repositoryRoot, commit);
    if (!subject.startsWith(RELEASE_SUBJECT_PREFIX))
    {
      continue;
    }
    try
    {
      return validateReleaseRecord(repositoryRoot, commit);
    }
    catch (error)
    {
      if (error instanceof PolicyError)
      {
        policyFailure(
          'INVALID_RELEASE_ANCHOR',
          `nearest release-looking commit ${commit} is invalid: ${error.condition}`,
          'repair the release history explicitly; do not skip past the invalid record',
        );
      }
      throw error;
    }
  }
  if (required)
  {
    policyFailure(
      'RELEASE_ANCHOR_MISSING',
      `no valid release record exists on ${resolvedHead}'s first-parent history`,
      'restore/fetch the established release history before publishing',
    );
  }
  return null;
}

function findReleaseByRunId(repositoryRoot, head, runId)
{
  if (typeof runId !== 'string' || !/^\d+$/.test(runId))
  {
    throw new UsageError(
      'INVALID_RUN_ID',
      'release run ID must be a nonempty decimal value',
      'pass the current GITHUB_RUN_ID',
    );
  }
  assertCompleteHistory(repositoryRoot);
  const resolvedHead = resolveCommit(repositoryRoot, head);
  const candidates = gitText(repositoryRoot, [
    'log',
    '--first-parent',
    '--format=%H',
    '--fixed-strings',
    `--grep=${RUN_TRAILER}: ${runId}`,
    resolvedHead,
  ]).split('\n').filter(Boolean);
  for (const commit of candidates)
  {
    const subject = commitSubject(repositoryRoot, commit);
    if (!subject.startsWith(RELEASE_SUBJECT_PREFIX))
    {
      continue;
    }
    const trailers = releaseTrailers(commitMessage(repositoryRoot, commit));
    if (trailers.runLines.includes(`${RUN_TRAILER}: ${runId}`))
    {
      return validateReleaseRecord(repositoryRoot, commit, { requireTrailers: true });
    }
  }
  return null;
}

function isRelevantPath(repositoryPath)
{
  return RELEVANT_EXACT_PATHS.includes(repositoryPath)
    || RELEVANT_DIRECTORY_PREFIXES.some((prefix) => repositoryPath.startsWith(prefix));
}

function deriveBumpLevel(subjects)
{
  let minor = false;
  for (const subject of subjects)
  {
    if (subject.includes('[bump:major]'))
    {
      return 'major';
    }
    if (subject.includes('[bump:minor]'))
    {
      minor = true;
    }
  }
  return minor ? 'minor' : 'patch';
}

function deriveFromRange({ subjects, paths })
{
  if (!paths.some(isRelevantPath))
  {
    return 'none';
  }
  return deriveBumpLevel(subjects);
}

function releaseRange(repositoryRoot, { head = 'HEAD', requireAnchor = false } = {})
{
  assertCompleteHistory(repositoryRoot);
  const resolvedHead = resolveCommit(repositoryRoot, head);
  const anchor = findReleaseAnchor(repositoryRoot, resolvedHead, { required: requireAnchor });
  const arguments_ = ['rev-list', '--topo-order', resolvedHead];
  if (anchor)
  {
    arguments_.push(`^${anchor.commit}`);
  }
  const commits = gitText(repositoryRoot, arguments_).split('\n').filter(Boolean);
  const subjects = [];
  const paths = [];
  for (const commit of commits)
  {
    subjects.push(commitSubject(repositoryRoot, commit));
    paths.push(...changedPathsInCommit(repositoryRoot, commit));
  }
  return {
    head: resolvedHead,
    anchor,
    commits,
    subjects,
    paths,
    level: deriveFromRange({ subjects, paths }),
  };
}

function validateIncomingChanges(repositoryRoot, { base, head, integration = null })
{
  assertCompleteHistory(repositoryRoot);
  const resolvedBase = resolveCommit(repositoryRoot, base);
  const resolvedHead = resolveCommit(repositoryRoot, head);
  let resolvedIntegration = null;
  if (integration === null)
  {
    if (!isAncestor(repositoryRoot, resolvedBase, resolvedHead))
    {
      policyFailure(
        'NON_ANCESTOR_SOURCE_RANGE',
        `${resolvedBase} is not an ancestor of ${resolvedHead}`,
        'fetch complete main history and select an explicit valid push baseline',
      );
    }
  }
  else
  {
    resolvedIntegration = resolveCommit(repositoryRoot, integration);
    if (!isAncestor(repositoryRoot, resolvedBase, resolvedIntegration)
        || !isAncestor(repositoryRoot, resolvedHead, resolvedIntegration))
    {
      policyFailure(
        'INVALID_INTEGRATION_COMMIT',
        `integration ${resolvedIntegration} does not contain both base ${resolvedBase} and head ${resolvedHead}`,
        'check out and validate the pinned PR integration commit',
      );
    }
  }

  const commits = gitText(
    repositoryRoot,
    ['rev-list', '--topo-order', '--reverse', resolvedHead, `^${resolvedBase}`],
  ).split('\n').filter(Boolean);
  for (const commit of commits)
  {
    const subject = commitSubject(repositoryRoot, commit);
    if (subject.startsWith(RELEASE_SUBJECT_PREFIX))
    {
      policyFailure(
        'RESERVED_RELEASE_SUBJECT',
        `submitted commit ${commit} uses the release-owned subject namespace: ${subject}`,
        'recreate the change as a source-only commit with an ordinary subject',
      );
    }
    const parents = commitParents(repositoryRoot, commit);
    const signature = protectedSignature(repositoryRoot, commit);
    if (parents.length === 0)
    {
      if (signature !== '')
      {
        policyFailure(
          'PROTECTED_ROOT_CHANGE',
          `submitted root commit ${commit} introduces release-owned content`,
          'reconstruct the submitted range on the established repository history',
        );
      }
      continue;
    }
    const inherited = parents.some((parent) => protectedSignature(repositoryRoot, parent) === signature);
    if (!inherited)
    {
      const kind = parents.length > 1 ? 'merge' : 'developer';
      policyFailure(
        'PROTECTED_CONTENT_CHANGED',
        `submitted ${kind} commit ${commit} does not inherit the complete protected pair from a parent`,
        'reconstruct the change as source-only work and inherit published output unchanged',
      );
    }
  }

  const comparisonCommit = resolvedIntegration || resolvedHead;
  if (protectedSignature(repositoryRoot, comparisonCommit) !== protectedSignature(repositoryRoot, resolvedBase))
  {
    policyFailure(
      'PROTECTED_PAIR_MISMATCH',
      `${comparisonCommit}'s protected pair does not match base ${resolvedBase}`,
      'restore the exact base-branch published pair before building any candidate',
    );
  }
  return {
    base: resolvedBase,
    head: resolvedHead,
    integration: resolvedIntegration,
    commits,
  };
}

function fileMode(stat)
{
  return stat.mode & 0o111 ? '100755' : '100644';
}

function workingDistributionEntries(repositoryRoot)
{
  const distRoot = path.join(repositoryRoot, 'dist');
  const distStat = fs.lstatSync(distRoot);
  if (!distStat.isDirectory() || distStat.isSymbolicLink())
  {
    policyFailure(
      'INVALID_DISTRIBUTION_ROOT',
      `${distRoot} must be a real directory`,
      'restore the tracked dist/harness directory before publishing',
    );
  }
  for (const name of fs.readdirSync(distRoot))
  {
    if (name !== 'harness')
    {
      policyFailure(
        'FORBIDDEN_DISTRIBUTION_PATH',
        `unexpected working-tree path under dist: ${JSON.stringify(name)}`,
        'remove every dist path outside the generated harness artifact',
      );
    }
  }
  const artifactRoot = path.join(distRoot, 'harness');
  const rootStat = fs.lstatSync(artifactRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
  {
    policyFailure(
      'INVALID_DISTRIBUTION_ROOT',
      `${artifactRoot} must be a real directory`,
      'rebuild the complete versioned distribution before publishing',
    );
  }
  const entries = new Map();
  function walk(relative)
  {
    for (const name of fs.readdirSync(path.join(artifactRoot, relative)).sort())
    {
      const child = relative ? `${relative}/${name}` : name;
      const absolute = path.join(artifactRoot, child);
      const stat = fs.lstatSync(absolute);
      if (OPAQUE_OVERLAYS.has(child))
      {
        if (!stat.isDirectory() || stat.isSymbolicLink())
        {
          policyFailure(
            'INVALID_LOCAL_OVERLAY',
            `local overlay must be a real directory: ${absolute}`,
            'restore the dependency/cache mount as a directory before retrying',
          );
        }
        continue;
      }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      {
        policyFailure(
          'INVALID_WORKING_ARTIFACT_ENTRY',
          `working distribution contains a non-regular entry: ${JSON.stringify(child)}`,
          'regenerate the complete distribution from source',
        );
      }
      if (stat.isDirectory())
      {
        walk(child);
      }
      else
      {
        entries.set(`${DISTRIBUTION_PREFIX}${child}`, {
          name: `${DISTRIBUTION_PREFIX}${child}`,
          mode: fileMode(stat),
          type: 'blob',
          bytes: fs.readFileSync(absolute),
        });
      }
    }
  }
  walk('');
  return entries;
}

function compareWorkingArtifact(index, working)
{
  for (const [name, entry] of index)
  {
    if (!name.startsWith(DISTRIBUTION_PREFIX))
    {
      continue;
    }
    const actual = working.get(name);
    if (!actual || actual.mode !== entry.mode || !actual.bytes.equals(entry.bytes))
    {
      policyFailure(
        'INDEX_WORKTREE_MISMATCH',
        `indexed distribution entry differs from the tested working file: ${JSON.stringify(name)}`,
        'stage the exact tested bytes and executable mode before retrying',
      );
    }
  }
  for (const name of working.keys())
  {
    if (!index.has(name))
    {
      policyFailure(
        'UNSTAGED_GENERATED_OUTPUT',
        `generated output is missing from the index: ${JSON.stringify(name)}`,
        'stage additions and deletions across the complete dist directory',
      );
    }
  }
}

function assertNoUnmergedEntries(repositoryRoot)
{
  const output = gitBuffer(repositoryRoot, ['ls-files', '--unmerged', '-z']);
  if (output.length !== 0)
  {
    policyFailure(
      'UNMERGED_INDEX_ENTRY',
      'the Git index contains unmerged entries',
      'resolve every conflict before validating a release',
    );
  }
}

function assertNoUnexpectedUntracked(repositoryRoot)
{
  const paths = splitNul(gitBuffer(
    repositoryRoot,
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ));
  if (paths.length !== 0)
  {
    policyFailure(
      'UNEXPECTED_UNTRACKED_PATH',
      `the checkout contains unexpected non-ignored content: ${JSON.stringify(paths[0])}`,
      'remove invocation residue or commit the intended source change before publishing',
    );
  }
}

function assertOnlyReleasePaths(paths, label)
{
  const forbidden = paths.find((name) => name !== CANONICAL_PACKAGE && !name.startsWith(DISTRIBUTION_PREFIX));
  if (forbidden)
  {
    policyFailure(
      'UNEXPECTED_RELEASE_CHANGE',
      `${label} contains an unrelated change: ${JSON.stringify(forbidden)}`,
      'restore unrelated checkout changes and repeat the release attempt from fresh main',
    );
  }
}

function validateStagedRelease(repositoryRoot, { base, level, next })
{
  parseVersion(next, 'declared next version');
  bumpVersion('0.0.0', level);
  const resolvedBase = resolveCommit(repositoryRoot, base);
  const resolvedHead = resolveCommit(repositoryRoot, 'HEAD');
  if (resolvedHead !== resolvedBase)
  {
    policyFailure(
      'SOURCE_HEAD_MOVED',
      `active HEAD ${resolvedHead} does not equal selected source ${resolvedBase}`,
      'restart the attempt from the freshly selected main snapshot',
    );
  }
  assertNoUnmergedEntries(repositoryRoot);

  const stagedPaths = splitNul(gitBuffer(
    repositoryRoot,
    ['diff', '--cached', '--name-only', '-z', '--no-renames', resolvedBase, '--'],
  ));
  assertOnlyReleasePaths(stagedPaths, 'the staged release');
  for (const required of [CANONICAL_PACKAGE, ...GENERATED_VERSION_PATHS])
  {
    if (!stagedPaths.includes(required))
    {
      policyFailure(
        'INCOMPLETE_RELEASE_INDEX',
        `the staged release does not update ${required}`,
        'stage the canonical version and complete generated distribution together',
      );
    }
  }

  const workingPaths = splitNul(gitBuffer(
    repositoryRoot,
    ['diff', '--name-only', '-z', '--no-renames', resolvedBase, '--'],
  ));
  assertOnlyReleasePaths(workingPaths, 'the working release checkout');
  assertNoUnexpectedUntracked(repositoryRoot);

  const rawIndex = indexEntries(repositoryRoot);
  const index = entriesWithBytes(repositoryRoot, rawIndex);
  const canonical = requireEntry(index, CANONICAL_PACKAGE, 'release index');
  const baseEntries = entriesWithBytes(repositoryRoot, treeEntries(repositoryRoot, resolvedBase));
  const baseCanonical = requireEntry(baseEntries, CANONICAL_PACKAGE, `source commit ${resolvedBase}`);
  if (canonical.mode !== '100644'
      || canonical.type !== 'blob'
      || canonical.mode !== baseCanonical.mode
      || canonical.type !== baseCanonical.type)
  {
    policyFailure(
      'CANONICAL_PACKAGE_MODE_CHANGED',
      'the staged release changes the canonical package entry type or mode',
      'restore the canonical package mode; publication may change only its version bytes',
    );
  }
  const transition = validateCanonicalTransition(baseCanonical.bytes, canonical.bytes, level, next);
  const artifact = validateArtifactEntries(index, 'release index');
  if (artifact.version !== next)
  {
    policyFailure(
      'GENERATED_VERSION_MISMATCH',
      `staged distribution version ${artifact.version} does not equal declared version ${next}`,
      'rebuild and stage the distribution after the canonical version update',
    );
  }
  validateSourceArtifactBoundary(
    repositoryRoot,
    resolvedBase,
    index,
    next,
    { canonicalEntry: canonical },
  );

  const canonicalPath = path.join(repositoryRoot, CANONICAL_PACKAGE);
  const canonicalStat = fs.lstatSync(canonicalPath);
  if (!canonicalStat.isFile()
      || canonicalStat.isSymbolicLink()
      || fileMode(canonicalStat) !== canonical.mode
      || !fs.readFileSync(canonicalPath).equals(canonical.bytes))
  {
    policyFailure(
      'INDEX_WORKTREE_MISMATCH',
      'indexed canonical package differs from the working release package',
      'stage the exact tested canonical package before retrying',
    );
  }
  const working = workingDistributionEntries(repositoryRoot);
  compareWorkingArtifact(index, working);
  return {
    base: resolvedBase,
    level,
    previous: transition.previous,
    next,
    files: artifact.files.size,
  };
}

function gitQuiet(repositoryRoot, arguments_)
{
  const result = runGit(repositoryRoot, arguments_, { allowedStatuses: [0, 1] });
  return result.status === 0;
}

function validateCommittedRelease(repositoryRoot, { base, level, next, commit, runId })
{
  if (typeof runId !== 'string' || !/^\d+$/.test(runId))
  {
    throw new UsageError(
      'INVALID_RUN_ID',
      'release run ID must be a nonempty decimal value',
      'pass the current GITHUB_RUN_ID',
    );
  }
  parseVersion(next, 'declared next version');
  bumpVersion('0.0.0', level);
  const resolvedBase = resolveCommit(repositoryRoot, base);
  const resolvedCommit = resolveCommit(repositoryRoot, commit);
  const record = validateReleaseRecord(repositoryRoot, resolvedCommit, { requireTrailers: true });
  if (record.parent !== resolvedBase
      || record.level !== level
      || record.version !== next
      || record.source !== resolvedBase
      || record.runId !== runId)
  {
    policyFailure(
      'RELEASE_TRANSACTION_MISMATCH',
      `release commit ${resolvedCommit} does not match the declared source, level, next version, and run ID`,
      'discard the disposable attempt and rebuild one release from fresh main',
    );
  }
  const timestamps = commitTimestamps(repositoryRoot, resolvedCommit);
  const expectedIso = '1999-12-31T23:59:00-08:00';
  if (timestamps.authorEpoch !== FIXED_COMMIT_EPOCH
      || timestamps.committerEpoch !== FIXED_COMMIT_EPOCH
      || timestamps.authorIso !== expectedIso
      || timestamps.committerIso !== expectedIso)
  {
    policyFailure(
      'RELEASE_TIMESTAMP_MISMATCH',
      `release commit ${resolvedCommit} does not use the required fixed author and committer timestamps`,
      'create the release commit with both required date environment variables',
    );
  }
  const identity = commitIdentity(repositoryRoot, resolvedCommit);
  const expectedName = 'github-actions[bot]';
  const expectedEmail = '41898282+github-actions[bot]@users.noreply.github.com';
  if (identity.authorName !== expectedName
      || identity.committerName !== expectedName
      || identity.authorEmail !== expectedEmail
      || identity.committerEmail !== expectedEmail)
  {
    policyFailure(
      'RELEASE_IDENTITY_MISMATCH',
      `release commit ${resolvedCommit} does not use the configured GitHub Actions bot identity`,
      'configure the publisher identity before creating the release commit',
    );
  }
  const head = resolveCommit(repositoryRoot, 'HEAD');
  if (head !== resolvedCommit
      || !gitQuiet(repositoryRoot, ['diff', '--cached', '--quiet', '--no-ext-diff', resolvedCommit, '--'])
      || !gitQuiet(repositoryRoot, ['diff', '--quiet', '--no-ext-diff', resolvedCommit, '--']))
  {
    policyFailure(
      'RELEASE_TREE_CHANGED_AFTER_VALIDATION',
      `checkout/index no longer exactly represent release commit ${resolvedCommit}`,
      'do not mutate the tested/staged tree between final validation and push',
    );
  }
  assertNoUnexpectedUntracked(repositoryRoot);
  return record;
}


function inspectPublication(repositoryRoot, { head = 'HEAD', runId, workflowSha, manualLevel = null })
{
  if (manualLevel !== null)
  {
    bumpVersion('0.0.0', manualLevel);
  }
  const source = resolveCommit(repositoryRoot, head);
  const existing = findReleaseByRunId(repositoryRoot, source, runId);
  if (existing)
  {
    return {
      status: 'already published',
      release: existing.commit,
      next: existing.version,
      source: existing.parent,
    };
  }
  const executed = resolveCommit(repositoryRoot, workflowSha);
  const workflowPath = '.github/workflows/bump-version.yml';
  const executedBlob = gitText(repositoryRoot, ['rev-parse', `${executed}:${workflowPath}`]);
  const sourceBlob = gitText(repositoryRoot, ['rev-parse', `${source}:${workflowPath}`]);
  if (executedBlob !== sourceBlob)
  {
    policyFailure(
      'STALE_WORKFLOW',
      `executed workflow ${executed} differs from selected source ${source}`,
      'run the current-main workflow',
    );
  }
  const range = releaseRange(repositoryRoot, { head: source, requireAnchor: true });
  validateIncomingChanges(repositoryRoot, { base: range.anchor.commit, head: source });
  const entries = entriesWithBytes(repositoryRoot, treeEntries(repositoryRoot, source));
  const artifact = validateArtifactEntries(entries, `source snapshot ${source}`);
  const canonical = parseJson(requireEntry(entries, CANONICAL_PACKAGE, source).bytes, CANONICAL_PACKAGE);
  validateCanonicalBoundary(canonical, CANONICAL_PACKAGE);
  if (canonical.version !== artifact.version)
  {
    policyFailure(
      'PUBLISHED_VERSION_MISMATCH',
      `source ${source} has inconsistent published version fields`,
      'repair the published pair explicitly before attempting publication',
    );
  }
  const level = manualLevel ?? range.level;
  return {
    status: level === 'none' ? 'no eligible changes' : 'ready',
    source,
    anchor: range.anchor.commit,
    previous: canonical.version,
    level,
    workflow: sourceBlob,
  };
}

function testedInventory(repositoryRoot)
{
  const entries = workingDistributionEntries(repositoryRoot);
  const canonical = path.join(repositoryRoot, CANONICAL_PACKAGE);
  const stat = fs.lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink())
  {
    policyFailure(
      'INVALID_CANONICAL_PACKAGE',
      'canonical package must be a regular file',
      'restore the canonical package boundary',
    );
  }
  entries.set(CANONICAL_PACKAGE, { mode: fileMode(stat), bytes: fs.readFileSync(canonical) });
  return [...entries]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => ({
      name,
      mode: entry.mode,
      sha256: createHash('sha256').update(entry.bytes).digest('hex'),
    }));
}

function validateWorkingRelease(repositoryRoot, { base, level, next })
{
  const source = resolveCommit(repositoryRoot, base);
  const changed = splitNul(gitBuffer(repositoryRoot, [
    'diff',
    '--name-only',
    '-z',
    '--no-ext-diff',
    '--no-renames',
    source,
    '--',
  ]));
  assertOnlyReleasePaths(changed, 'post-test checkout');
  const untracked = splitNul(gitBuffer(
    repositoryRoot,
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ));
  const unexpected = untracked.find((name) => !name.startsWith(DISTRIBUTION_PREFIX));
  if (unexpected)
  {
    policyFailure(
      'UNEXPECTED_UNTRACKED_PATH',
      `post-test checkout contains ${JSON.stringify(unexpected)}`,
      'discard the attempt and preserve the failure evidence',
    );
  }
  const entries = entriesWithBytes(repositoryRoot, treeEntries(repositoryRoot, source));
  const previous = requireEntry(entries, CANONICAL_PACKAGE, source);
  const canonicalPath = path.join(repositoryRoot, CANONICAL_PACKAGE);
  const canonicalStat = fs.lstatSync(canonicalPath);
  if (!canonicalStat.isFile()
      || canonicalStat.isSymbolicLink()
      || fileMode(canonicalStat) !== previous.mode)
  {
    policyFailure(
      'CANONICAL_PACKAGE_MODE_CHANGED',
      'post-test canonical package mode changed',
      'retain the source snapshot canonical package mode',
    );
  }
  const canonicalEntry = {
    mode: fileMode(canonicalStat),
    type: 'blob',
    bytes: fs.readFileSync(canonicalPath),
  };
  validateCanonicalTransition(previous.bytes, canonicalEntry.bytes, level, next);
  const distribution = workingDistributionEntries(repositoryRoot);
  const artifact = validateArtifactEntries(distribution, 'post-test distribution');
  validateSourceArtifactBoundary(
    repositoryRoot,
    source,
    distribution,
    artifact.version,
    { canonicalEntry },
  );
}

function assertTestedInventory(repositoryRoot, expected)
{
  if (!isDeepStrictEqual(testedInventory(repositoryRoot), expected))
  {
    policyFailure(
      'TESTED_CONTENT_CHANGED',
      'release files changed after the post-test inventory was captured',
      'discard the attempt and test a fresh versioned artifact',
    );
  }
}

module.exports = {
  CANONICAL_PACKAGE,
  DISTRIBUTION_PREFIX,
  FIXED_COMMIT_EPOCH,
  GENERATED_VERSION_PATHS,
  PolicyError,
  RELEASE_SUBJECT_PATTERN,
  RELEASE_SUBJECT_PREFIX,
  RELEVANT_DIRECTORY_PREFIXES,
  RELEVANT_EXACT_PATHS,
  UsageError,
  assertReleaseWriteIntent,
  inspectPublication,
  testedInventory,
  validateWorkingRelease,
  assertTestedInventory,
  bumpVersion,
  deriveBumpLevel,
  deriveFromRange,
  findReleaseAnchor,
  findReleaseByRunId,
  inferBumpLevel,
  isRelevantPath,
  protectedSignature,
  releaseRange,
  resolveCommit,
  validateCommittedRelease,
  validateIncomingChanges,
  validateReleaseRecord,
  validateStagedRelease,
};
