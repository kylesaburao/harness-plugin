'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('bumpVersion: patch increments the last component', () => {
  assert.equal(bumpVersion('0.1.0', 'patch'), '0.1.1');
});

test('bumpVersion: minor increments and resets patch', () => {
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
});

test('bumpVersion: major increments and resets minor and patch', () => {
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
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

test('run: an unwritable manifest is MANIFEST_UNWRITABLE and nothing is changed', { skip: RUNNING_AS_ROOT }, () => {
  const repoRoot = makeFixture(['0.1.0']);
  const target = path.join(repoRoot, MANIFEST_RELATIVE_PATHS[0]);
  fs.chmodSync(target, 0o444);
  try {
    assert.equal(startupCode(() => run(['--bump-patch', '--repo-root', repoRoot])), 'MANIFEST_UNWRITABLE');
    assert.deepEqual(readVersions(repoRoot), ['0.1.0', '0.1.0'], 'the write loop never started');
  } finally {
    fs.chmodSync(target, 0o644);
  }
});

test('run: a write failure on the second manifest rolls the first back to its previous content', () => {
  const repoRoot = makeFixture(['0.1.0']);
  const originalWriteFileSync = fs.writeFileSync;
  let calls = 0;
  fs.writeFileSync = (...args) => {
    calls += 1;
    if (calls === 2) {
      throw new Error('simulated disk failure');
    }
    return originalWriteFileSync(...args);
  };
  let code = null;
  let raised = null;
  try {
    try {
      run(['--bump-patch', '--repo-root', repoRoot]);
    } catch (error) {
      code = error.code;
      raised = error;
    }
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  assert.equal(code, 'MANIFEST_WRITE_FAILED_ROLLED_BACK');
  assert.equal(raised.exitCode, 1);
  const [codexRaw, claudeRaw] = MANIFEST_RELATIVE_PATHS.map((relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
  const expectedRaw = `${JSON.stringify({ name: 'harness', version: '0.1.0' }, null, 2)}\n`;
  assert.equal(codexRaw, expectedRaw, 'the manifest written before the failure was rolled back byte-for-byte');
  assert.equal(claudeRaw, expectedRaw, 'the manifest that never got written is untouched');
});

test('run: a failed rollback reports which files are left inconsistent, and how to fix them', () => {
  const repoRoot = makeFixture(['0.1.0']);
  const originalWriteFileSync = fs.writeFileSync;
  let calls = 0;
  fs.writeFileSync = (...args) => {
    calls += 1;
    // Call 1: the real first-manifest write, succeeds. Call 2: the second-manifest write, fails.
    // Call 3: the rollback attempt on the first manifest, also fails - modeling a rollback that
    // can't recover (e.g. the filesystem went read-only for the whole write).
    if (calls === 2 || calls === 3) {
      throw new Error('simulated disk failure');
    }
    return originalWriteFileSync(...args);
  };
  let code = null;
  let remedy = null;
  try {
    try {
      run(['--bump-patch', '--repo-root', repoRoot]);
    } catch (error) {
      code = error.code;
      remedy = error.remedy;
    }
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  assert.equal(code, 'MANIFEST_WRITE_FAILED_INCONSISTENT');
  assert.match(remedy, /0\.1\.0/, 'the remedy names the version to restore');
  assert.match(remedy, new RegExp(MANIFEST_RELATIVE_PATHS[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the remedy names the specific file left inconsistent');
});
