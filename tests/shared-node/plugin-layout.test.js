'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('copied plugin layout resolves shared imports for every media entrypoint', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-plugin-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.resolve(__dirname, '../../plugins/harness');
  for (const directory of ['skills/create-discord-emoji-gif', 'skills/extract-video-frames', 'shared/node']) {
    fs.cpSync(path.join(source, directory), path.join(root, directory), { recursive: true });
  }
  for (const entrypoint of [
    'skills/create-discord-emoji-gif/scripts/node/mov-to-gif.js',
    'skills/create-discord-emoji-gif/scripts/node/mov-to-gif-gifski.js',
    'skills/extract-video-frames/scripts/extract-video-frames.js',
  ]) {
    const result = spawnSync(process.execPath, [path.join(root, entrypoint), '--help'], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${entrypoint}: ${result.stderr}`);
    assert.equal(result.stderr, '', entrypoint);
    assert.ok(result.stdout.startsWith(`Usage: ${path.basename(entrypoint)} `), result.stdout);
    assert.match(result.stdout, /--preflight/);
  }
});
