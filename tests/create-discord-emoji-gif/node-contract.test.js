'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const shared = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/shared');
const gifski = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/mov-to-gif-gifski');
const gifsicle = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/mov-to-gif');
const { skillDir, temporaryDirectory, runEntrypoint } = require('./test-helpers');

test('Node help and option parsing preserve the direct CLI contract', () => {
  for (const script of ['mov-to-gif-gifski.js', 'mov-to-gif.js']) {
    for (const flag of ['--help', '-h']) {
      const result = runEntrypoint(process.execPath, path.join(skillDir, 'scripts/node', script), [flag]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /--preflight/);
      assert.match(result.stdout, /129  SIGHUP/);
    }
  }
  assert.deepEqual(shared.parseArguments(['--json', '--', '-input.mp4'], 'tool.js').positional, ['-input.mp4']);
});

test('Node version and configuration errors are stable startup errors', () => {
  assert.throws(() => shared.validateNodeVersion('21.9.0'), { code: 'node_version_unsupported', exitCode: 2 });
  assert.doesNotThrow(() => shared.validateNodeVersion('22.0.0'));
  assert.throws(() => shared.readConfiguration({ MAX_BYTES: '0' }, 'gifsicle'), { code: 'config_invalid' });
  assert.throws(() => shared.readConfiguration({ MIN_FPS: '10', MAX_FPS: '8' }, 'gifsicle'), { code: 'config_invalid' });
  assert.throws(() => shared.readConfiguration({ MAX_FPS: '101' }, 'gifski'), { code: 'config_invalid' });
  assert.doesNotThrow(() => shared.readConfiguration({ MAX_BYTES: '9007199254740991' }, 'gifsicle'));
  assert.throws(() => shared.readConfiguration({ MAX_BYTES: '9007199254740992' }, 'gifsicle'), { code: 'config_invalid' });
  assert.throws(() => shared.readConfiguration({ MAX_BYTES: '9007199254740993' }, 'gifsicle'), { code: 'config_invalid' });
});

test('platform policy exposes exact macOS and Linux remedies', () => {
  assert.equal(shared.platformPolicy('darwin', 'gifski').commandRemedy('gifski'), 'brew install gifski');
  assert.equal(shared.platformPolicy('linux', 'gifski').commandRemedy('ffmpeg'), 'sudo apt install ffmpeg (or use a build with libvmaf if the VMAF filter check fails)');
  assert.equal(shared.platformPolicy('linux', 'gifsicle').commandRemedy('gifsicle'), 'sudo apt install gifsicle');
  assert.throws(() => shared.platformPolicy('win32', 'gifski'), { code: 'platform_unsupported' });
});

test('publication verifies a destination-local temporary file before rename', async () => {
  const directory = temporaryDirectory('node-publication.');
  const source = path.join(directory, 'source.gif');
  const output = path.join(directory, 'output.gif');
  fs.writeFileSync(source, 'new output');
  fs.writeFileSync(output, 'old output');
  try {
    await assert.rejects(shared.publishVerified(source, output, 'test', async temporary => {
      assert.equal(path.dirname(temporary), directory);
      assert.equal(fs.readFileSync(temporary, 'utf8'), 'new output');
      throw new shared.RunError('verification_failed', 'forced verification failure', 'retry');
    }));
    assert.equal(fs.readFileSync(output, 'utf8'), 'old output');
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith('.test-output.')), false);
    const verified = await shared.publishVerified(source, output, 'test', async () => 'verified');
    assert.equal(verified, 'verified');
    assert.equal(fs.readFileSync(output, 'utf8'), 'new output');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('gifski worker allocation and candidate ordering are deterministic', () => {
  const config = { minFps: 7, maxFps: 9, jobs: 8, minQuality: 80, maxQuality: 100 };
  assert.equal(gifski.calculateGifskiWorkers(config), 3);
  assert.equal(gifski.calculateRayonThreads(config), 2);
  assert.deepEqual(gifski.candidateSequence(config).map(row => row.quality), [100, 90, 80]);
  const identities = gifski.candidateSequence(config, 90).map(row => `${row.quality}|${row.motionQuality}|${row.lossyQuality}`);
  assert.equal(new Set(identities).size, identities.length);
  assert.deepEqual(identities.slice(0, 3), ['100|100|100', '90|90|90', '80|80|80']);
});

test('backend selection tie-breakers and gifsicle task order are deterministic', () => {
  assert.equal(gifski.selectWinner([
    { score: '90', fps: 8, quality: 80, motionQuality: 80, lossyQuality: 80, bytes: 10 },
    { score: '90', fps: 9, quality: 70, motionQuality: 70, lossyQuality: 70, bytes: 20 },
  ]).fps, 9);
  const tasks = gifsicle.candidateTasks({ minFps: 8, maxFps: 9 });
  assert.deepEqual(tasks[0], { fps: 8, colors: 4 });
  assert.deepEqual(tasks[252], { fps: 8, colors: 256 });
  assert.deepEqual(tasks[253], { fps: 9, colors: 4 });
  assert.equal(gifsicle.selectWinner([
    { score: '80', fps: 8, colors: 100, dither: 4 },
    { score: '80', fps: 8, colors: 100, dither: 2 },
  ]).dither, 2);
});

test('VMAF parser uses the final numeric score', () => {
  assert.equal(shared.parseVmafScore('VMAF score: 1.0\nVMAF score: 97.125\n'), '97.125');
  assert.throws(() => shared.parseVmafScore('no score'), { code: 'vmaf_nonnumeric' });
});
