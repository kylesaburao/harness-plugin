'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const subject = require('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-video-frames-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('publication atomically refuses a racing output directory without changing it', async t => {
  const root = temporaryRoot(t);
  const temporary = path.join(root, '.partial');
  const output = path.join(root, 'clip-frames');
  fs.mkdirSync(temporary);
  fs.writeFileSync(path.join(temporary, 'frame-000001.png'), 'frame');
  const manager = { run: async () => {
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'competitor.txt'), 'unchanged');
    return { code: 0, stdout: 'collision\n', stderr: '' };
  } };
  const state = { platform: { os: 'macos' }, commands: { publisher: '/fake/publisher' }, paths: { output } };
  await assert.rejects(subject.publishDirectoryNoReplace(manager, state, temporary), { code: 'publication_failed' });
  assert.equal(fs.readFileSync(path.join(output, 'competitor.txt'), 'utf8'), 'unchanged');
  assert.equal(fs.readFileSync(path.join(temporary, 'frame-000001.png'), 'utf8'), 'frame');
});

test('publication exposes the completed frame set and removes partial work', async t => {
  const root = temporaryRoot(t);
  const temporary = path.join(root, '.partial');
  const output = path.join(root, 'clip-frames');
  fs.mkdirSync(temporary);
  fs.writeFileSync(path.join(temporary, 'frame-000001.png'), 'one');
  fs.writeFileSync(path.join(temporary, 'frame-000002.png'), 'two');

  const manager = { run: async () => {
    fs.renameSync(temporary, output);
    return { code: 0, stdout: 'published\n', stderr: '' };
  } };
  const state = { platform: { os: 'macos' }, commands: { publisher: '/fake/publisher' }, paths: { output } };
  await subject.publishDirectoryNoReplace(manager, state, temporary);

  assert.deepEqual(fs.readdirSync(output), ['frame-000001.png', 'frame-000002.png']);
  assert.equal(fs.existsSync(temporary), false);
});

test('macOS publisher integration moves a directory and refuses replacement', { skip: process.platform !== 'darwin' }, async t => {
  const root = temporaryRoot(t);
  const source = path.join(root, 'source');
  const competitor = path.join(root, 'competitor');
  const output = path.join(root, 'output');
  fs.mkdirSync(source);
  fs.mkdirSync(competitor);
  const manager = new subject.ProcessManager();
  const state = { platform: { os: 'macos' }, commands: { publisher: '/usr/bin/osascript' }, paths: { output } };

  await subject.publishDirectoryNoReplace(manager, state, source);
  await assert.rejects(subject.publishDirectoryNoReplace(manager, state, competitor), { code: 'publication_failed' });
  assert.equal(fs.existsSync(competitor), true);
});

test('process interruption terminates the active child and records the signal', async () => {
  const manager = new subject.ProcessManager();
  const running = manager.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise(resolve => setTimeout(resolve, 25));
  manager.interrupt('SIGTERM');
  const result = await running;
  assert.equal(manager.signal, 'SIGTERM');
  assert.equal(result.code, null);
});

test('source mutation is rejected after preflight', t => {
  const input = path.join(temporaryRoot(t), 'clip.mov');
  fs.writeFileSync(input, 'before');
  const paths = { supplied: input, sourceIdentity: subject.identity(fs.statSync(input)) };
  fs.appendFileSync(input, ' after');
  assert.throws(() => subject.assertSourceUnchanged(paths), { code: 'source_changed', exitCode: 1 });
});

test('raw preflight failures become stable exit-2 diagnostics', async () => {
  const manager = { run: async () => { throw new Error('spawn exploded'); } };
  await assert.rejects(subject.prepare(manager, { input: null }), { code: 'preflight_failed', exitCode: 2 });
});

for (const [signal, exitCode] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`CLI ${signal} terminates extraction, cleans owned artifacts, and exits ${exitCode}`, async t => {
    const root = temporaryRoot(t);
    const bin = path.join(root, 'bin');
    const input = path.join(root, 'clip.mov');
    const started = path.join(root, 'started');
    const terminated = path.join(root, 'terminated');
    fs.mkdirSync(bin);
    fs.writeFileSync(input, 'stable input');
    writeExecutable(path.join(bin, 'sw_vers'), '#!/bin/sh\necho 26.0\n');
    writeExecutable(path.join(bin, 'osascript'), '#!/bin/sh\necho failed\n');
    writeExecutable(path.join(bin, 'ffprobe'), fakeFfprobe());
    writeExecutable(path.join(bin, 'ffmpeg'), fakeFfmpeg(started, terminated));
    const script = path.resolve(__dirname, '../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js');
    const child = spawn(process.execPath, [script, '--json', input], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForPath(started);
    child.kill(signal);
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });

    assert.equal(status, exitCode);
    assert.equal(fs.existsSync(terminated), true);
    assert.equal(fs.existsSync(path.join(root, 'clip-frames')), false);
    assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.clip-frames.partial-')), []);
  });
}

function writeExecutable(filename, contents) {
  fs.writeFileSync(filename, contents, { mode: 0o755 });
}

function fakeFfprobe() {
  return `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('-show_program_version')) process.stdout.write('{"program_version":{"version":"test"}}');
else if (args.includes('-show_frames')) process.stdout.write('{"frames":[{"best_effort_timestamp":"0","duration":1},{"best_effort_timestamp":"1","duration":1}]}');
else process.stdout.write('{"streams":[{"index":0,"codec_type":"video","disposition":{"attached_pic":0},"width":16,"height":16,"pix_fmt":"yuv420p","color_primaries":"bt709","color_transfer":"bt709","color_space":"bt709","color_range":"tv","time_base":"1/1","sample_aspect_ratio":"1:1","display_aspect_ratio":"1:1","field_order":"progressive"}]}');
`;
}

function fakeFfmpeg(started, terminated) {
  return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('-filters')) process.stdout.write('zscale select setpts format transpose hflip vflip\\n');
else if (args.includes('-encoders')) process.stdout.write('png exr\\n');
else if (args.includes('-muxers')) process.stdout.write('image2\\n');
else if (args.includes('-pix_fmts')) process.stdout.write('rgb24 rgb48le rgba rgba64le gbrpf32le gbrapf32le\\n');
else if (args.includes('encoder=exr')) process.stdout.write('-compression zip16 -format float\\n');
else if (args.includes('null')) process.stdout.write('frame=1\\nprogress=end\\n');
else {
  const output = args.at(-1).replace('%06d', '000001');
  fs.writeFileSync(output, 'frame');
  fs.writeFileSync(${JSON.stringify(started)}, 'started');
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, () => {
    fs.writeFileSync(${JSON.stringify(terminated)}, signal);
    process.exit(0);
  });
  setInterval(() => {}, 1000);
}
`;
}

async function waitForPath(filename) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(filename)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filename}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('structural checks reject a wrong frame count', async t => {
  const root = temporaryRoot(t);
  fs.writeFileSync(path.join(root, 'frame-000001.png'), 'one');
  fs.writeFileSync(path.join(root, 'frame-000002.png'), 'two');
  const manager = { run: async () => ({ code: 0, stdout: '{"streams":[{"codec_name":"png","width":320,"height":240}]}', stderr: '' }) };
  const state = { commands: { ffprobe: '/fake/ffprobe' }, media: { expectedFrames: 2, width: 320, height: 240, color: { extension: 'png', codec: 'png' } } };
  assert.equal((await subject.structuralChecks(manager, state, root)).probes.length, 2);
  state.media.expectedFrames = 3;
  await assert.rejects(subject.structuralChecks(manager, state, root), { code: 'structural_check_failed' });
});

test('result truthfully reports the artifact contract', () => {
  const state = {
    paths: { supplied: '/tmp/clip.mov', resolved: '/private/tmp/clip.mov', output: '/tmp/clip-frames' },
    media: {
      stream: { index: 1 },
      color: { dynamicRange: 'hdr-hlg', primaries: 'bt2020', transfer: 'arib-std-b67', matrix: 'bt2020nc', range: 'tv', bitDepth: 10, codec: 'exr', extension: 'exr', outputPixelFormat: 'gbrpf32le', outputDepth: 'float32', outputColor: 'linear-bt2020', alpha: false },
      transform: { rotationDegrees: 270, flips: ['horizontal'], filters: ['hflip', 'transpose=clock'] },
      width: 1080, height: 1920, sampleAspectRatio: '1:1', displayAspectRatio: '9:16', fieldOrder: 'progressive',
      start: 0n, end: 1000000000n, firstPts: 0n, lastPts: 1000000000n, expectedFrames: 2,
    },
  };
  const result = subject.resultPayload(state, { probes: [] });
  assert.deepEqual([result.output.format, result.frames, result.orientation.filters], ['openexr', 2, ['hflip', 'transpose=clock']]);
});
