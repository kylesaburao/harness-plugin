'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  MANIFEST_RELATIVE_PATHS,
  bumpVersion,
  mutateVersion,
  parseArguments,
  run,
} = require('../../scripts/bump-version.js');

const RUNNING_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const releaseEnvironment = Object.freeze({
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'kylesaburao/harness-plugin',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'push',
  HARNESS_RELEASE_WRITE: '1',
});

function makeFixture(version = '1.2.3')
{
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-version-'));
  const absolute = path.join(repositoryRoot, MANIFEST_RELATIVE_PATHS[0]);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify({
    name: 'harness',
    version,
    private: true,
    type: 'commonjs',
  }, null, 2)}\n`);
  return repositoryRoot;
}

function version(repositoryRoot)
{
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, MANIFEST_RELATIVE_PATHS[0]))).version;
}

function capturedRun(argv, options)
{
  let output = '';
  const status = run(argv, {
    ...options,
    stdout: {
      write: (chunk) =>
      {
        output += chunk;
        return true;
      },
    },
  });
  return { output, status };
}

function startupCode(callback)
{
  try
  {
    callback();
  }
  catch (error)
  {
    return error.code;
  }
  return null;
}

test('bumpVersion applies exactly one patch, minor, or major increment', () =>
{
  for (const [before, level, after] of [
    ['0.1.0', 'patch', '0.1.1'],
    ['1.2.3', 'minor', '1.3.0'],
    ['1.2.3', 'major', '2.0.0'],
  ])
  {
    assert.equal(bumpVersion(before, level), after);
  }
  assert.equal(
    bumpVersion('9007199254740993.0.0', 'patch'),
    '9007199254740993.0.1',
  );
});

test('pure mutation changes only the canonical source package version', (t) =>
{
  const repositoryRoot = makeFixture('0.1.0');
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
  const report = mutateVersion(repositoryRoot, 'patch');
  assert.equal(version(repositoryRoot), '0.1.1');
  assert.equal(report.previous, '0.1.0');
  assert.equal(report.next, '0.1.1');
  assert.deepEqual(report.files, [path.join(repositoryRoot, 'src/harness/package.json')]);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'dist')), false);
});

test('argument parsing rejects no level, multiple levels, duplicates, and missing values', () =>
{
  assert.equal(startupCode(() => parseArguments([])), 'NO_LEVEL');
  assert.equal(startupCode(() => parseArguments(['--bump-patch', '--bump-minor'])), 'AMBIGUOUS_LEVEL');
  assert.equal(startupCode(() => parseArguments(['--bump-patch', '--json', '--json'])), 'DUPLICATE_ARGUMENT');
  assert.equal(startupCode(() => parseArguments(['--bump-patch', '--repo-root'])), 'MISSING_VALUE');
});

test('public mutation rejects CI=true alone before reading or writing the package', (t) =>
{
  const repositoryRoot = makeFixture('1.2.3');
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
  const before = fs.readFileSync(path.join(repositoryRoot, MANIFEST_RELATIVE_PATHS[0]));
  assert.equal(startupCode(() => capturedRun([
    '--bump-patch', '--repo-root', repositoryRoot, '--json',
  ], {
    environment: { CI: 'true' },
  })), 'RELEASE_WRITE_REQUIRED');
  assert.deepEqual(fs.readFileSync(path.join(repositoryRoot, MANIFEST_RELATIVE_PATHS[0])), before);
});

test('public JSON report is machine-readable in the complete release context', (t) =>
{
  const repositoryRoot = makeFixture('1.2.3');
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
  const result = capturedRun([
    '--bump-minor', '--repo-root', repositoryRoot, '--json',
  ], {
    environment: releaseEnvironment,
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.output), {
    level: 'minor',
    previous: '1.2.3',
    next: '1.3.0',
    files: [path.join(repositoryRoot, 'src/harness/package.json')],
  });
});

test('help performs no release-context check or filesystem access', () =>
{
  const result = capturedRun(['--help'], { environment: {} });
  assert.equal(result.status, 0);
  assert.match(result.output, /HARNESS_RELEASE_WRITE=1/);
});

test('malformed versions and changed canonical metadata fail before mutation', (t) =>
{
  const malformed = makeFixture('not-a-version');
  const changed = makeFixture('1.2.3');
  t.after(() => fs.rmSync(malformed, { recursive: true, force: true }));
  t.after(() => fs.rmSync(changed, { recursive: true, force: true }));
  const changedPath = path.join(changed, MANIFEST_RELATIVE_PATHS[0]);
  const manifest = JSON.parse(fs.readFileSync(changedPath));
  manifest.dependencies = {};
  fs.writeFileSync(changedPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(startupCode(() => mutateVersion(malformed, 'patch')), 'INVALID_VERSION');
  assert.equal(startupCode(() => mutateVersion(changed, 'patch')), 'INVALID_PACKAGE_BOUNDARY');
});

test('non-object and symlinked canonical packages fail before a write', (t) =>
{
  const nonObject = makeFixture('1.2.3');
  const symlinked = makeFixture('1.2.3');
  t.after(() => fs.rmSync(nonObject, { recursive: true, force: true }));
  t.after(() => fs.rmSync(symlinked, { recursive: true, force: true }));

  const nonObjectPath = path.join(nonObject, MANIFEST_RELATIVE_PATHS[0]);
  fs.writeFileSync(nonObjectPath, 'null\n');
  assert.equal(startupCode(() => mutateVersion(nonObject, 'patch')), 'INVALID_PACKAGE_BOUNDARY');

  const symlinkPath = path.join(symlinked, MANIFEST_RELATIVE_PATHS[0]);
  const outside = path.join(symlinked, 'outside-package.json');
  const outsideBytes = fs.readFileSync(symlinkPath);
  fs.renameSync(symlinkPath, outside);
  fs.symlinkSync(outside, symlinkPath);
  assert.equal(startupCode(() => capturedRun([
    '--bump-patch', '--repo-root', symlinked, '--json',
  ], {
    environment: releaseEnvironment,
  })), 'INVALID_MANIFEST_TYPE');
  assert.deepEqual(fs.readFileSync(outside), outsideBytes);
});

test('an unreadable canonical package is diagnosed', { skip: RUNNING_AS_ROOT }, (t) =>
{
  const repositoryRoot = makeFixture('0.1.0');
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
  const target = path.join(repositoryRoot, MANIFEST_RELATIVE_PATHS[0]);
  fs.chmodSync(target, 0o000);
  try
  {
    assert.equal(startupCode(() => mutateVersion(repositoryRoot, 'patch')), 'MANIFEST_UNREADABLE');
  }
  finally
  {
    fs.chmodSync(target, 0o644);
  }
});

test('CLI write failure restores the original package bytes', (t) =>
{
  const repositoryRoot = makeFixture('0.1.0');
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
  const manifest = path.join(repositoryRoot, MANIFEST_RELATIVE_PATHS[0]);
  const original = fs.readFileSync(manifest);
  const preload = path.join(repositoryRoot, 'fail-write.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs');
const original = fs.writeFileSync;
let writes = 0;
fs.writeFileSync = function(file, ...args) {
  if (!String(file).endsWith('src/harness/package.json')) return original.call(this, file, ...args);
  writes += 1;
  const result = original.call(this, file, ...args);
  if (writes === 1) throw new Error('injected write failure after touching the package');
  return result;
};
`);
  const cli = path.resolve(__dirname, '../../scripts/bump-version.js');
  const result = spawnSync(process.execPath, [
    cli,
    '--bump-patch',
    '--repo-root', repositoryRoot,
    '--json',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...releaseEnvironment,
      NODE_OPTIONS: `--require=${preload}`,
    },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, 'MANIFEST_WRITE_FAILED_ROLLED_BACK');
  assert.deepEqual(fs.readFileSync(manifest), original);
});
