'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parseArguments,
  bumpVersion,
  run,
  MANIFEST_RELATIVE_PATHS,
} = require('../../scripts/bump-version.js');

// chmod-based permission tests don't hold under root (some CI images run as root, and root
// bypasses the mode bits chmod sets), so they're skipped there rather than silently passing as a
// no-op that never actually exercised the permission check.
const RUNNING_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

function makeFixture(versions) {
  // versions: array of one or two version strings, one per manifest, in MANIFEST_RELATIVE_PATHS order.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-version-'));
  MANIFEST_RELATIVE_PATHS.forEach((relative, index) => {
    const absolutePath = path.join(repoRoot, relative);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const version = versions[index] ?? versions[0];
    fs.writeFileSync(absolutePath, `${JSON.stringify({ name: 'harness', version }, null, 2)}\n`, 'utf8');
  });
  return repoRoot;
}

function readVersions(repoRoot) {
  return MANIFEST_RELATIVE_PATHS.map((relative) => JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8')).version);
}

function startupCode(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

test('bumpVersion applies each level', () => {
  for (const [version, level, expected] of [
    ['0.1.0', 'patch', '0.1.1'],
    ['1.2.3', 'minor', '1.3.0'],
    ['1.2.3', 'major', '2.0.0'],
  ]) assert.equal(bumpVersion(version, level), expected);
});

test('run: writes the same next version to both manifests', () => {
  const repoRoot = makeFixture(['0.1.0']);
  run(['--bump-patch', '--repo-root', repoRoot]);
  assert.deepEqual(readVersions(repoRoot), ['0.1.1', '0.1.1']);
});

test('parseArguments: no bump flag is NO_LEVEL', () => {
  assert.equal(startupCode(() => parseArguments([])), 'NO_LEVEL');
});

test('parseArguments: more than one bump flag is AMBIGUOUS_LEVEL', () => {
  assert.equal(startupCode(() => parseArguments(['--bump-patch', '--bump-minor'])), 'AMBIGUOUS_LEVEL');
});

test('run: manifests disagreeing on version is VERSION_MISMATCH', () => {
  const repoRoot = makeFixture(['0.1.0', '0.2.0']);
  assert.equal(startupCode(() => run(['--bump-patch', '--repo-root', repoRoot])), 'VERSION_MISMATCH');
});

test('run: a non-semver version is INVALID_VERSION', () => {
  const repoRoot = makeFixture(['not-a-version']);
  assert.equal(startupCode(() => run(['--bump-patch', '--repo-root', repoRoot])), 'INVALID_VERSION');
});

test('run: --json reports previous and next', () => {
  const repoRoot = makeFixture(['1.2.3']);
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk) => {
    captured += chunk;
    return true;
  };
  try {
    run(['--bump-minor', '--repo-root', repoRoot, '--json']);
  } finally {
    process.stdout.write = originalWrite;
  }
  const result = JSON.parse(captured.trim());
  assert.equal(result.previous, '1.2.3');
  assert.equal(result.next, '1.3.0');
  assert.equal(result.level, 'minor');
});

test('run: an unreadable manifest is MANIFEST_UNREADABLE, not a raw exception', { skip: RUNNING_AS_ROOT }, () => {
  const repoRoot = makeFixture(['0.1.0']);
  const target = path.join(repoRoot, MANIFEST_RELATIVE_PATHS[0]);
  fs.chmodSync(target, 0o000);
  try {
    assert.equal(startupCode(() => run(['--bump-patch', '--repo-root', repoRoot])), 'MANIFEST_UNREADABLE');
  } finally {
    fs.chmodSync(target, 0o644);
  }
});

test('CLI: a second-manifest write failure rolls the first back byte-for-byte', () => {
  const repoRoot = makeFixture(['0.1.0']);
  const manifestPaths = MANIFEST_RELATIVE_PATHS.map(relative => path.join(repoRoot, relative));
  const originals = manifestPaths.map(file => fs.readFileSync(file));
  const preload = path.join(repoRoot, 'fail-second-write.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs');
const original = fs.writeFileSync;
let manifestWrites = 0;
fs.writeFileSync = function(file, ...args) {
  if (!String(file).endsWith('plugin.json')) return original.call(this, file, ...args);
  manifestWrites += 1;
  const result = original.call(this, file, ...args);
  if (manifestWrites === 2) throw new Error('injected second write failure after touching the file');
  return result;
};
`);
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '../../scripts/bump-version.js'),
    '--bump-patch', '--repo-root', repoRoot, '--json',
  ], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stderr).error;
  assert.equal(report.code, 'MANIFEST_WRITE_FAILED_ROLLED_BACK');
  assert.equal(report.remedy, 're-run bump-version.js once the underlying write failure is fixed');
  assert.deepEqual(manifestPaths.map(file => fs.readFileSync(file)), originals);
});
