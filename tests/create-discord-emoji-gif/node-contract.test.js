'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const shared = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/shared');
const { runConverter } = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/converter-runner');
const gifski = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/mov-to-gif-gifski');
const gifsicle = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/mov-to-gif');
const { temporaryDirectory } = require('./test-helpers');

test('shared Node runner preserves backend-specific help and explicit option parsing', async () => {
  const originalScript = process.argv[1];
  const originalWrite = process.stdout.write;
  try {
    process.argv[1] = undefined;
    for (const spec of [
      { backend: 'gifski', script: 'mov-to-gif-gifski.js', quality: true },
      { backend: 'gifsicle', script: 'mov-to-gif.js', quality: false },
    ]) {
      let stdout = '';
      process.stdout.write = chunk => { stdout += chunk; return true; };
      const code = await runConverter({
        argv: ['--help'],
        env: {},
        backend: spec.backend,
        defaultScriptName: spec.script,
        workPrefix: 'unused.',
        convert: async () => assert.fail('help must not start conversion'),
      });
      assert.equal(code, 0);
      assert.match(stdout, new RegExp(`^Usage: ${spec.script.replaceAll('.', '\\.')}`));
      assert.match(stdout, /--preflight/);
      assert.match(stdout, /129  SIGHUP/);
      assert.equal(stdout.includes('MIN_QUALITY'), spec.quality);
    }
  } finally {
    process.argv[1] = originalScript;
    process.stdout.write = originalWrite;
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

test('gifski high-FPS configuration directs users to the supported Node gifsicle entrypoint', () => {
  assert.throws(
    () => shared.readConfiguration({ MAX_FPS: '101' }, 'gifski'),
    {
      code: 'config_invalid',
      remedy: 'set MAX_FPS to 100 or lower, or use mov-to-gif.js for higher frame rates',
    },
  );
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

test('a non-GIF verification result preserves the destination and removes the publication temporary', async () => {
  const directory = temporaryDirectory('node-wrong-codec.');
  const source = path.join(directory, 'source.gif');
  const output = path.join(directory, 'output.gif');
  fs.writeFileSync(source, 'new output');
  fs.writeFileSync(output, 'old output');
  const manager = {
    async runOwned(task) {
      assert.equal(task, 'output codec');
      return { code: 0, stdout: 'png|video\n', stderr: '' };
    },
  };
  try {
    await assert.rejects(
      shared.publishVerified(source, output, 'test', temporary => shared.verifyFinalGif(
        manager,
        { ffprobe: 'ffprobe' },
        temporary,
        { size: 64, maxBytes: 256000 },
      )),
      {
        code: 'verification_failed',
        condition: 'verification failed, expected a GIF video stream, got png|video',
      },
    );
    assert.equal(fs.readFileSync(output, 'utf8'), 'old output');
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith('.test-output.')), false);
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

test('VMAF parser uses the pooled JSON mean', () => {
  assert.deepEqual(shared.parseVmafScore(JSON.stringify({ frames: [{}], pooled_metrics: { vmaf: { mean: 97.125 } } })), { score: '97.125000', frames: 1 });
  assert.throws(() => shared.parseVmafScore('no score'), { code: 'vmaf_nonnumeric' });
});

test('publishVerified skips the post-rename digest check when verify() returns no digest', async () => {
  const directory = temporaryDirectory('node-publication-no-digest.');
  const source = path.join(directory, 'source.gif');
  const output = path.join(directory, 'output.gif');
  fs.writeFileSync(source, 'plain output');
  try {
    const verified = await shared.publishVerified(source, output, 'test', async () => 'verified');
    assert.equal(verified, 'verified');
    assert.equal(fs.readFileSync(output, 'utf8'), 'plain output');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('resultPayload and emitResult report the file that was actually published, both backends', () => {
  const gifskiConfig = { gifSize: 128, maxBytes: 256000 };
  const gifskiWinner = { fps: 15, quality: 90, motionQuality: 90, lossyQuality: 90, score: '85.587572' };
  const gifskiVerified = { dimensions: '128x128', frameCount: 60, duration: '2.500000', bytes: 227780, digest: 'a'.repeat(64) };
  const gifskiPayload = shared.resultPayload({
    script: 'mov-to-gif-gifski.js', backend: 'gifski',
    input: '/tmp/clip.mov', output: '/tmp/clip_128x128.gif',
    config: gifskiConfig, winner: gifskiWinner, verified: gifskiVerified,
  });
  assert.equal(gifskiPayload.selected, '15 FPS, quality 90, motion quality 90, lossy quality 90, VMAF 85.587572');
  assert.equal(gifskiPayload.headroomBytes, 256000 - 227780);
  assert.deepEqual(gifskiPayload.parameters, { quality: 90, motionQuality: 90, lossyQuality: 90 });
  assert.equal(gifskiPayload.sha256, gifskiVerified.digest);
  assert.ok(gifskiPayload.checks.length > 0);
  assert.ok(gifskiPayload.checks.every(check => check.status === 'pass'));

  const gifsicleConfig = { gifSize: 64, maxBytes: 100000 };
  const gifsicleWinner = { fps: 8, colors: 100, dither: 2, score: '80.1' };
  const gifsicleVerified = { dimensions: '64x64', frameCount: 4, duration: '0.500000', bytes: 5000, digest: 'b'.repeat(64) };
  const gifsiclePayload = shared.resultPayload({
    script: 'mov-to-gif.js', backend: 'gifsicle',
    input: '/tmp/clip.mov', output: '/tmp/clip_64x64.gif',
    config: gifsicleConfig, winner: gifsicleWinner, verified: gifsicleVerified,
  });
  assert.equal(gifsiclePayload.selected, '8 FPS, 100 colors, dither 2, VMAF 80.1');
  assert.deepEqual(gifsiclePayload.parameters, { colors: 100, dither: 2 });

  const originalWrite = process.stdout.write;
  let captured = '';
  process.stdout.write = chunk => { captured += chunk; return true; };
  try { shared.emitResult(gifskiPayload, false); } finally { process.stdout.write = originalWrite; }
  const lines = captured.split('\n');
  assert.equal(lines[0], 'Selected: 15 FPS, quality 90, motion quality 90, lossy quality 90, VMAF 85.587572');
  assert.equal(lines[1], 'Output: /tmp/clip_128x128.gif');
  assert.equal(lines[2], 'Verified: 128x128, 60 frames, 2.500000s, 227780 bytes');
  assert.ok(lines.some(line => line.startsWith('Report: mov-to-gif-gifski.js, gifski backend')));
  assert.equal(lines.filter(line => line.startsWith('Check: PASS')).length, gifskiPayload.checks.length);
  assert.ok(lines.some(line => line.includes('sha256')));

  let jsonCaptured = '';
  process.stdout.write = chunk => { jsonCaptured += chunk; return true; };
  try { shared.emitResult(gifskiPayload, true); } finally { process.stdout.write = originalWrite; }
  const parsed = JSON.parse(jsonCaptured);
  assert.deepEqual(parsed.result, gifskiPayload);
});

test('default output names use only the input filename extension', () => {
  const directory = temporaryDirectory('input.dotted.');
  try {
    for (const [name, stem] of [['clip', 'clip'], ['clip.mp4', 'clip'], ['clip.part.mov', 'clip.part'], ['.clip', '.clip']]) {
      const input = path.join(directory, name);
      fs.writeFileSync(input, 'input');
      assert.equal(shared.validateOutput(input, undefined, 128).output, path.join(directory, `${stem}_128x128.gif`));
      assert.equal(shared.validateOutput(input, path.join(directory, 'explicit.gif'), 128).output, path.join(directory, 'explicit.gif'));
      assert.throws(() => shared.validateOutput(input, input, 128), { code: 'output_unusable' });
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('every ranking field wins independently of completion order', () => {
  for (const [backend, base, improvements] of [
    [gifski, { score: '90', fps: 8, quality: 80, motionQuality: 80, lossyQuality: 80, bytes: 100 }, { score: '91', fps: 9, quality: 90, motionQuality: 90, lossyQuality: 90, bytes: 99 }],
    [gifsicle, { score: '90', fps: 8, colors: 4, dither: 3 }, { score: '91', fps: 9, colors: 5, dither: 2 }],
  ]) {
    assert.equal(backend.selectWinner([]), undefined);
    for (const [field, value] of Object.entries(improvements)) {
      const better = { ...base, [field]: value };
      assert.equal(backend.selectWinner([base, better]), better, field);
      assert.equal(backend.selectWinner([better, base]), better, field);
    }
  }
});
