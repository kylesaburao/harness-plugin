'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { acquireDirectoryLock, withDirectoryLock, writeJsonAtomic } =
  require(require('../helpers/plugin-paths').artifactPath('shared/node/config-store'));

class FixtureError extends Error {
  constructor(code, condition, remedy) { super(condition); Object.assign(this, { code, condition, remedy }); }
}
const policy = {
  busyCode: 'fixture_busy', failedCode: 'fixture_lock_failed', cleanupCode: 'fixture_cleanup_failed',
  recovery: 'fixture recovery', error: (code, condition, remedy) => new FixtureError(code, condition, remedy),
};
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'config-store-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'skill/config.json');
  return { home, file, lock: `${file}.lock` };
}
function expectError(code) {
  return error => {
    assert.ok(error instanceof FixtureError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.remedy, 'fixture recovery');
    return true;
  };
}
function withPatched(object, key, replacement, fn) {
  const original = object[key];
  object[key] = replacement(original);
  try { return fn(); } finally { object[key] = original; }
}

test('lock creates the parent, runs the operation, returns its result and releases', t => {
  const f = fixture(t);
  assert.equal(withDirectoryLock(f.lock, policy, () => {
    assert.ok(fs.statSync(f.lock).isDirectory());
    return 'result';
  }), 'result');
  assert.equal(fs.existsSync(f.lock), false);
});

test('an existing lock is contention and is never removed', t => {
  const f = fixture(t);
  fs.mkdirSync(f.lock, { recursive: true });
  let ran = false;
  assert.throws(() => withDirectoryLock(f.lock, policy, () => { ran = true; }), error => {
    expectError('fixture_busy')(error);
    assert.ok(error.condition.includes(f.lock));
    return true;
  });
  assert.equal(ran, false);
  assert.ok(fs.statSync(f.lock).isDirectory());
});

test('an obstructed parent is an acquisition failure, not contention', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'skill'), 'unrelated file');
  assert.throws(() => acquireDirectoryLock(f.lock, policy), error => {
    expectError('fixture_lock_failed')(error);
    assert.match(error.condition, /cannot prepare configuration directory/);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(f.home, 'skill'), 'utf8'), 'unrelated file');
});

test('a throwing operation releases the lock and rethrows its own error', t => {
  const f = fixture(t);
  const failure = new Error('operation failure');
  assert.throws(() => withDirectoryLock(f.lock, policy, () => { throw failure; }), error => error === failure);
  assert.equal(fs.existsSync(f.lock), false);
});

test('a replaced lock is not released and reports lost ownership', t => {
  const f = fixture(t);
  assert.throws(() => withDirectoryLock(f.lock, policy, () => {
    fs.renameSync(f.lock, `${f.lock}.original`);
    fs.mkdirSync(f.lock);
  }), error => {
    expectError('fixture_cleanup_failed')(error);
    assert.match(error.condition, /ownership changed/);
    assert.match(error.condition, /may already be published/);
    return true;
  });
  assert.ok(fs.existsSync(f.lock));
  assert.ok(fs.existsSync(`${f.lock}.original`));
});

test('release reports publication state and retains a combined operation failure', t => {
  const f = fixture(t);
  const failRelease = original => function(target, ...args) {
    if (target === f.lock) throw new Error('injected release failure');
    return original.call(this, target, ...args);
  };
  for (const [published, operationFailure, pattern] of [
    [true, undefined, /configuration was saved; cannot release/],
    [false, undefined, /: cannot release/],
    [false, Object.assign(new Error('missing'), { code: 'fixture_unknown', condition: 'unknown entry' }),
      /operation also failed: fixture_unknown: unknown entry/],
  ]) {
    const release = acquireDirectoryLock(f.lock, policy);
    assert.throws(() => withPatched(fs, 'rmdirSync', failRelease, () => release(published, operationFailure)), error => {
      expectError('fixture_cleanup_failed')(error);
      assert.match(error.condition, pattern);
      assert.match(error.condition, /injected release failure/);
      assert.doesNotMatch(error.condition, /may already be published/);
      return true;
    });
    fs.rmdirSync(f.lock);
  }
});

test('atomic write publishes text with the requested mode and leaves no temporary file', t => {
  const f = fixture(t);
  writeJsonAtomic(f.file, '{"a":1}\n', { mode: 0o600 });
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{"a":1}\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  writeJsonAtomic(f.file, '{"a":2}\n');
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{"a":2}\n');
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['config.json']);
});

test('failed publication preserves the original and removes the temporary file', t => {
  const f = fixture(t);
  writeJsonAtomic(f.file, 'original\n');
  assert.throws(() => withPatched(fs, 'renameSync', () => () => { throw new Error('injected publication failure'); },
    () => writeJsonAtomic(f.file, 'replacement\n')), error => {
    assert.equal(error.condition, undefined);
    assert.equal(error.message, 'injected publication failure');
    return true;
  });
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['config.json']);
});
