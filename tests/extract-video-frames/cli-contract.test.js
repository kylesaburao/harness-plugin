'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js');

function run(args, env = process.env) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
}

test('help documents the deterministic interface and fixed sibling output', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /--start TIME/);
  assert.match(result.stdout, /--end TIME/);
  assert.match(result.stdout, /<input-stem>-frames/);
  assert.doesNotMatch(result.stdout, /--output|--replace|--stream/);
});

test('bad usage reports the stable JSON error contract without probing tools', () => {
  const result = run(['--json', '--start', 'later']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'window_invalid');
});

test('missing input is diagnosed before toolchain discovery', () => {
  const missing = path.join(__dirname, 'does-not-exist.mov');
  const result = run(['--json', missing], { ...process.env, PATH: '' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'input_unusable');
});

test('skill documentation defines the entrypoint and forbids redundant reinspection', () => {
  const fs = require('node:fs');
  const skill = fs.readFileSync(path.resolve(__dirname, '../../plugins/harness/skills/extract-video-frames/SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /untested working draft/i);
  assert.match(skill, /Do not recreate or modify its FFmpeg commands/);
  assert.match(skill, /Do\s+not run ffprobe, ffmpeg/);
});
