'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const subject = require('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js');
const realFfmpeg = ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/usr/local/opt/ffmpeg-full/bin/ffmpeg'].find(fs.existsSync);

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-video-frames-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('publication refuses a racing output directory without changing it', async t => {
  const root = temporaryRoot(t);
  const temporary = path.join(root, '.partial');
  const output = path.join(root, 'clip-frames');
  fs.mkdirSync(temporary);
  fs.writeFileSync(path.join(temporary, 'frame-000001.png'), 'frame');
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'competitor.txt'), 'unchanged');
  const manager = { run: async () => ({ code: 0, stdout: 'collision\n', stderr: '' }) };
  const state = { commands: { publisher: '/fake/publisher' }, paths: { output } };
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
  const state = { commands: { publisher: '/fake/publisher' }, paths: { output } };
  await subject.publishDirectoryNoReplace(manager, state, temporary);

  assert.deepEqual(fs.readdirSync(output), ['frame-000001.png', 'frame-000002.png']);
  assert.equal(fs.existsSync(temporary), false);
});

test('macOS publisher moves a directory and refuses an empty-directory replacement', { skip: process.platform !== 'darwin' }, async t => {
  const root = temporaryRoot(t);
  const source = path.join(root, 'source');
  const competitor = path.join(root, 'competitor');
  const output = path.join(root, 'output');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'frame-000001.png'), 'published');
  fs.mkdirSync(competitor);
  const manager = new subject.ProcessManager();
  const state = { commands: { publisher: '/usr/bin/osascript' }, paths: { output } };

  await subject.publishDirectoryNoReplace(manager, state, source);
  state.paths.output = competitor;
  const temporary = path.join(root, 'second-source');
  fs.mkdirSync(temporary);
  fs.writeFileSync(path.join(temporary, 'frame-000002.png'), 'unchanged');
  await assert.rejects(subject.publishDirectoryNoReplace(manager, state, temporary), { code: 'publication_failed' });
  assert.deepEqual(fs.readdirSync(competitor), []);
  assert.deepEqual(fs.readdirSync(temporary), ['frame-000002.png']);
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

test('HDR conversion reuses the helper with at most 10 direct workers', async t => {
  const root = temporaryRoot(t);
  for (let index = 1; index <= 12; index += 1) fs.writeFileSync(path.join(root, `frame-${String(index).padStart(6, '0')}.tiff`), 'tiff');
  let active = 0;
  let maximum = 0;
  const manager = { run: async (_command, args) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    fs.writeFileSync(args[1], 'heic');
    active -= 1;
    return { code: 0, stdout: '', stderr: '' };
  } };
  const state = { commands: { encoder: '/fake/encoder' }, media: { expectedFrames: 12, color: { transfer: 'arib-std-b67' } } };

  await subject.convertHdrFrames(manager, state, root);

  assert.equal(maximum, 10);
  assert.deepEqual(fs.readdirSync(root), Array.from({ length: 12 }, (_, index) => `frame-${String(index + 1).padStart(6, '0')}.heic`));
});

test('source mutation is rejected after preflight', t => {
  const input = path.join(temporaryRoot(t), 'clip.mov');
  fs.writeFileSync(input, 'before');
  const paths = { supplied: input, sourceIdentity: subject.identity(fs.statSync(input)) };
  fs.appendFileSync(input, ' after');
  assert.throws(() => subject.assertSourceUnchanged(paths), { code: 'source_changed', exitCode: 1 });
});

test('raw preflight failures become stable exit-2 diagnostics', { skip: process.platform !== 'darwin' }, async t => {
  const manager = { run: async () => { throw new Error('spawn exploded'); } };
  const encoderDirectory = path.join(temporaryRoot(t), 'encoder');
  fs.mkdirSync(encoderDirectory);
  await assert.rejects(subject.prepare(manager, { input: null }, encoderDirectory), { code: 'preflight_failed', exitCode: 2 });
});

for (const [signal, exitCode] of [['SIGTERM', 143]]) {
  test(`CLI ${signal} terminates HDR encoding, cleans TIFF/HEIC/helper partials, and exits ${exitCode}`, { skip: process.platform !== 'darwin' || !realFfmpeg }, async t => {
    const root = temporaryRoot(t);
    const bin = path.join(root, 'bin');
    const input = path.join(root, 'clip.mov');
    const started = path.join(root, 'started');
    const terminated = path.join(root, 'terminated');
    fs.mkdirSync(bin);
    const generated = spawnSync(realFfmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=16x16:r=2:d=1', '-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-x265-params', 'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-color_range', 'tv', input], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    writeExecutable(path.join(bin, 'sw_vers'), '#!/bin/sh\necho 26.0\n');
    const fakeEncoder = path.join(bin, 'fake-encoder');
    writeExecutable(fakeEncoder, fakeEncoderScript(started, terminated));
    writeExecutable(path.join(bin, 'swiftc'), `#!/bin/sh\ncp ${JSON.stringify(fakeEncoder)} "$3"\nchmod +x "$3"\n`);
    writeExecutable(path.join(bin, 'sips'), `#!/bin/sh\necho "$6"\necho '  pixelWidth: 16'\necho '  pixelHeight: 16'\necho '  bitsPerSample: 10'\necho '  profile: Rec. ITU-R BT.2100 HLG'\n`);
    const script = path.resolve(__dirname, '../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js');
    const child = spawn(process.execPath, [script, '--json', input], { env: { ...process.env, TMPDIR: root, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    try { await waitForPath(started); } catch (error) {
      child.kill('SIGKILL');
      if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve));
      assert.fail(`${error.message}\n${stderr}`);
    }
    child.kill(signal);
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });

    assert.equal(status, exitCode);
    assert.equal(fs.existsSync(terminated), true);
    assert.equal(fs.existsSync(path.join(root, 'clip-frames')), false);
    assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.clip-frames.partial-')), []);
    assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('extract-video-frames-encoder-')), []);
  });
}

function writeExecutable(filename, contents) {
  fs.writeFileSync(filename, contents, { mode: 0o755 });
}

function fakeEncoderScript(started, terminated) {
  return `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(args[1], 'partial heic');
if (args[1].includes('preflight-frame')) process.exit(0);
else {
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
      color: { dynamicRange: 'hdr-hlg', primaries: 'bt2020', transfer: 'arib-std-b67', matrix: 'bt2020nc', range: 'tv', bitDepth: 10, codec: 'heic', extension: 'heic', outputPixelFormat: '10-bit', outputDepth: '10', outputColor: 'bt2100-hlg', alpha: false },
      transform: { rotationDegrees: 270, flips: ['horizontal'], filters: ['hflip', 'transpose=clock'] },
      width: 1080, height: 1920, sampleAspectRatio: '1:1', displayAspectRatio: '9:16', fieldOrder: 'progressive',
      start: 0n, end: 1000000000n, firstPts: 0n, lastPts: 1000000000n, expectedFrames: 2,
    },
  };
  const result = subject.resultPayload(state, { probes: [] });
  assert.deepEqual([result.output.format, result.frames, result.orientation.filters], ['heic', 2, ['hflip', 'transpose=clock']]);
});
