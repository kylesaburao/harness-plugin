'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { resolveCommand } = require('../../plugins/harness/shared/node/resolve-command');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function executable(root, directory, mode = 0o755) {
  const folder = path.join(root, directory);
  fs.mkdirSync(folder, { recursive: true });
  const command = path.join(folder, 'media-tool');
  fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode });
  return command;
}

test('first successful PATH entry wins', t => {
  const root = fixture(t);
  const first = executable(root, 'first');
  const second = executable(root, 'second');
  assert.equal(resolveCommand('media-tool', { PATH: [path.dirname(first), path.dirname(second)].join(path.delimiter) }), fs.realpathSync(first));
});

test('non-executable and unresolvable candidates do not prevent a later match', t => {
  const root = fixture(t);
  const blocked = executable(root, 'blocked', 0o644);
  const broken = path.join(root, 'broken');
  fs.mkdirSync(broken);
  fs.symlinkSync(path.join(root, 'absent'), path.join(broken, 'media-tool'));
  const good = executable(root, 'good');
  const PATH = [path.join(root, 'missing'), path.dirname(blocked), broken, path.dirname(good)].join(path.delimiter);
  assert.equal(resolveCommand('media-tool', { PATH }), fs.realpathSync(good));
});

test('symlinks resolve to the canonical target', t => {
  const root = fixture(t);
  const target = executable(root, 'target');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(target, path.join(bin, 'media-tool'));
  assert.equal(resolveCommand('media-tool', { PATH: bin }), fs.realpathSync(target));
});

test('empty, missing, and relative PATH entries retain current-directory behavior', t => {
  const root = fixture(t);
  const local = executable(root, '.');
  const relative = executable(root, 'bin');
  const modulePath = require.resolve('../../plugins/harness/shared/node/resolve-command');
  for (const [env, expected] of [
    [{ PATH: '' }, local],
    [{}, local],
    [{ PATH: `${path.delimiter}bin` }, local],
    [{ PATH: 'bin' }, relative],
  ]) {
    const result = spawnSync(process.execPath, ['-e', `const { resolveCommand } = require(${JSON.stringify(modulePath)}); process.stdout.write(JSON.stringify(resolveCommand('media-tool', ${JSON.stringify(env)})));`], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout), fs.realpathSync(expected));
  }
});

test('no match returns null', t => {
  const root = fixture(t);
  assert.equal(resolveCommand('media-tool', { PATH: root }), null);
});
