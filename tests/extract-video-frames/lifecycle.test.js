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

for (const kind of ['sdr', 'hdr', 'synthetic']) {
  test(`preflight ${kind === 'sdr' ? 'decodes SDR without compiling' : `compiles for ${kind} HDR`}`, { skip: process.platform !== 'darwin' || !realFfmpeg }, async t => {
    const root = temporaryRoot(t);
    const input = kind === 'synthetic' ? null : path.join(root, 'clip.mov');
    if (input) {
      const hdr = kind === 'hdr';
      const generated = spawnSync(realFfmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=16x16:r=2:d=1', '-c:v', 'libx265', '-x265-params', hdr ? 'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc' : 'log-level=error:colorprim=bt709:transfer=bt709:colormatrix=bt709', '-pix_fmt', hdr ? 'yuv420p10le' : 'yuv420p', '-color_primaries', hdr ? 'bt2020' : 'bt709', '-color_trc', hdr ? 'arib-std-b67' : 'bt709', '-colorspace', hdr ? 'bt2020nc' : 'bt709', '-color_range', 'tv', input], { encoding: 'utf8' });
      assert.equal(generated.status, 0, generated.stderr);
    }
    const realManager = new subject.ProcessManager();
    const calls = [];
    const manager = { assertRunning: () => realManager.assertRunning(), run: async (command, args, options) => {
      calls.push({ command, args });
      if (path.basename(command) === 'swiftc') return { code: 1, stdout: '', stderr: 'intentional compilation sentinel' };
      return realManager.run(command, args, options);
    } };
    const preparing = subject.prepare(manager, { input, start: null, end: null }, root);
    if (kind === 'sdr') {
      const state = await preparing;
      assert.equal(state.media.color.dynamicRange, 'sdr');
      assert.equal(calls.some(call => path.basename(call.command) === 'swiftc'), false);
      assert.ok(calls.some(call => call.args.includes('-progress') && call.args.includes('null')));
    } else {
      await assert.rejects(preparing, error => error.code === 'heic_encoder_unavailable' && error.condition.includes('intentional compilation sentinel'));
      const compileIndex = calls.findIndex(call => path.basename(call.command) === 'swiftc');
      assert.ok(compileIndex >= 0);
      if (input) assert.ok(calls.slice(0, compileIndex).some(call => call.args.includes('-show_frames')));
    }
    assert.equal(calls.filter(call => call.args.includes('-show_pixel_formats')).length, 1);
    if (input) {
      const reports = calls.filter(call => call.args.includes('-show_frames'));
      assert.equal(reports.length, 1);
      const args = reports[0].args;
      assert.equal(args[args.indexOf('-threads') + 1], '0');
      assert.equal(args[args.indexOf('-select_streams') + 1], '0');
      assert.equal(args[args.indexOf('-show_entries') + 1], 'frame=best_effort_timestamp,duration,pkt_duration,color_range,color_space,color_primaries,color_transfer,pix_fmt');
      assert.ok(args.indexOf('-threads') < args.indexOf(input));
    }
  });
}

for (const [signal, exitCode, phase] of [['SIGTERM', 143, 'encoding'], ['SIGTERM', 143, 'verification']]) {
  test(`CLI ${signal} terminates HDR ${phase}, cleans TIFF/HEIC/helper partials, and exits ${exitCode}`, { skip: process.platform !== 'darwin' || !realFfmpeg }, async t => {
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
    writeExecutable(fakeEncoder, fakeEncoderScript(started, terminated, phase === 'verification'));
    writeExecutable(path.join(bin, 'swiftc'), `#!/bin/sh\ncp ${JSON.stringify(fakeEncoder)} "$3"\nchmod +x "$3"\n`);
    writeExecutable(path.join(bin, 'sips'), `#!/bin/sh\necho "$6"\necho '  pixelWidth: 16'\necho '  pixelHeight: 16'\necho '  bitsPerSample: 10'\necho '  profile: Rec. ITU-R BT.2100 HLG'\n`);
    if (phase === 'verification') writeExecutable(path.join(bin, 'sips'), `#!${process.execPath}
const fs = require('node:fs');
const file = process.argv.at(-1);
process.stdout.write(file + '\\n  pixelWidth: 16\\n  pixelHeight: 16\\n  bitsPerSample: 10\\n  profile: Rec. ITU-R BT.2100 HLG\\n');
if (file.includes('.partial-') && file.endsWith('frame-000002.heic')) {
  fs.writeFileSync(${JSON.stringify(terminated)}, 'SIGTERM');
  process.kill(process.ppid, 'SIGTERM');
}
`);
    const script = path.resolve(__dirname, '../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js');
    const child = spawn(process.execPath, [script, '--json', input], { env: { ...process.env, TMPDIR: root, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    if (phase === 'encoding') try { await waitForPath(started); } catch (error) {
      child.kill('SIGKILL');
      if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve));
      assert.fail(`${error.message}\n${stderr}`);
    }
    if (phase === 'encoding') child.kill(signal);
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

function fakeEncoderScript(started, terminated, finish = false) {
  return `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(args[1], 'partial heic');
if (${finish} || args[1].includes('preflight-frame')) process.exit(0);
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
  const manager = { run: async () => ({ code: 0, stdout: '{"streams":[{"codec_name":"png","pix_fmt":"rgb24","width":320,"height":240}]}', stderr: '' }) };
  const state = { pixelDescriptors: subject.descriptorMap(require('./pixel-formats.json')), commands: { ffprobe: '/fake/ffprobe' }, media: { expectedFrames: 2, width: 320, height: 240, color: { extension: 'png', codec: 'png', alpha: false, outputDepth: '8' } } };
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

test('interruption is terminal and preserves the first signal', async () => {
  const manager = new subject.ProcessManager();
  await manager.interrupt('SIGINT');
  await manager.interrupt('SIGTERM');
  await assert.rejects(manager.run(process.execPath, ['-e', 'process.exit(0)']), { code: 'interrupted', exitCode: 130 });
  assert.equal(manager.signal, 'SIGINT');
});

test('interruption escalates and waits for an uncooperative child to close', async () => {
  const manager = new subject.ProcessManager({ killTimeout: 50 });
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const running = manager.run(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { progress: ready });
  await started;
  const stopped = manager.interrupt('SIGTERM');
  const result = await running;
  await stopped;
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(manager.active.size, 0);
});

for (const json of [false, true]) test(`child signal survives extraction error reporting (${json ? 'JSON' : 'plain'})`, () => {
  const script = `
const subject = require(${JSON.stringify(require.resolve('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js'))});
const manager = new subject.ProcessManager();
const state = { commands: { ffmpeg: 'unused' }, paths: { supplied: '/tmp/input' }, media: {
  stream: { index: 0 }, firstTick: 0n, transform: { filters: [] },
  color: { dynamicRange: 'sdr', codec: 'png', primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv', outputPixelFormat: 'rgb24' }
} };
const run = manager.run.bind(manager);
manager.run = () => run(process.execPath, ['-e', "process.stderr.write('decoder evidence'); process.kill(process.pid, 'SIGTERM')"]);
subject.representativeDecodePreflight(manager, state).catch(error => { subject.emitError(error, ${json}); process.exitCode = error.exitCode; });
`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  if (json) {
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.task, 'input_decode_failed');
    assert.equal(error.childExitCode, null);
    assert.equal(error.childSignal, 'SIGTERM');
    assert.equal(error.stderr, 'decoder evidence');
  } else {
    assert.match(result.stderr, /task: "input_decode_failed"/);
    assert.match(result.stderr, /childExitCode: null/);
    assert.match(result.stderr, /childSignal: "SIGTERM"/);
    assert.match(result.stderr, /stderr: "decoder evidence"/);
  }
});

test('process manager routes stdout progress without contaminating diagnostics', async () => {
  let progress = '';
  const result = await new subject.ProcessManager().run(process.execPath, ['-e', "process.stdout.write('frame=1\\nprogress=end\\n')"], { progress: chunk => { progress += chunk; } });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(progress, 'frame=1\nprogress=end\n');
});

for (const json of [false, true]) test(`extraction CLI preserves crash diagnostics (${json ? 'JSON' : 'plain'})`, { skip: process.platform !== 'darwin' || !realFfmpeg }, t => {
  const root = temporaryRoot(t);
  const input = path.join(root, 'input.mp4');
  const generated = spawnSync(realFfmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=24:duration=0.25', '-c:v', 'libx264', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', input], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const preload = path.join(root, 'crash.cjs');
  fs.writeFileSync(preload, `
const childProcess = require('node:child_process');
const spawn = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  if (args.includes('-start_number')) return spawn(process.execPath, ['-e', "process.stderr.write('extraction crash'); process.kill(process.pid, 'SIGTERM')"], options);
  return spawn(command, args, options);
};`);
  const script = require.resolve('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js');
  const result = spawnSync(process.execPath, ['--require', preload, script, ...(json ? ['--json'] : []), input], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  if (json) {
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.code, 'extraction_failed');
    assert.equal(error.task, 'extraction');
    assert.equal(error.childExitCode, null);
    assert.equal(error.childSignal, 'SIGTERM');
    assert.equal(error.stderr, 'extraction crash');
  } else {
    assert.match(result.stderr, /ERROR \[extraction_failed\]/);
    assert.match(result.stderr, /childExitCode: null/);
    assert.match(result.stderr, /childSignal: "SIGTERM"/);
    assert.match(result.stderr, /stderr: "extraction crash"/);
  }
  assert.equal(fs.existsSync(path.join(root, 'input-frames')), false);
  assert.equal(fs.readdirSync(root).some(name => name.includes('.partial-')), false);
});

for (const format of ['rgb48be', 'rgba64be', 'gray16be', 'yuv420p']) {
  test(`real ${format} extraction preserves depth and fractional duration`, { skip: process.platform !== 'darwin' || !realFfmpeg }, t => {
    const root = temporaryRoot(t);
    const input = path.join(root, 'depth.mov');
    const high = format !== 'yuv420p';
    const channels = format === 'rgba64be' ? 4 : format === 'gray16be' ? 1 : 3;
    const raw = Buffer.alloc(512 * 2 * channels * 2);
    for (let pixel = 0; pixel < 1024; pixel++) {
      for (let channel = 0; channel < channels; channel++) raw.writeUInt16BE(channel === 3 ? 32768 : (pixel % 512) * 128, (pixel * channels + channel) * 2);
    }
    const rawPath = path.join(root, 'ramp.raw');
    fs.writeFileSync(rawPath, raw);
    const source = high ? ['-f', 'rawvideo', '-pixel_format', format, '-video_size', '512x2', '-framerate', '30', '-i', rawPath] : ['-f', 'lavfi', '-i', 'testsrc2=size=512x2:rate=30'];
    const generated = spawnSync(realFfmpeg, ['-v', 'error', ...source, ...(high ? ['-vf', 'setparams=range=full:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=gbr'] : []), '-frames:v', '1', '-c:v', high ? 'png' : 'libx264', '-pix_fmt', format, ...(high ? [] : ['-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709']), '-color_primaries', 'bt709', '-color_trc', high ? 'iec61966-2-1' : 'bt709', '-colorspace', high ? 'rgb' : 'bt709', '-color_range', high ? 'pc' : 'tv', input], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const probe = spawnSync(path.join(path.dirname(realFfmpeg), 'ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', input], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const stream = JSON.parse(probe.stdout).streams[0];
    assert.equal(stream.pix_fmt, format);
    if (high) assert.ok(!(Number(stream.bits_per_raw_sample) > 0 || Number(stream.bits_per_coded_sample) > 0));
    const result = spawnSync(process.execPath, [require.resolve('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js'), '--json', input], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout).result;
    assert.equal(report.output.depth, high ? '16' : '8');
    assert.equal(report.sourceColor.bitDepth, high ? 16 : 8);
    const files = fs.readdirSync(path.join(root, 'depth-frames'));
    assert.equal(files.length, 1);
    const output = path.join(root, 'depth-frames', files[0]);
    const png = fs.readFileSync(output);
    assert.equal(png[24], high ? 16 : 8);
    assert.equal(png.readUInt32BE(16), 512);
    assert.equal(png.readUInt32BE(20), 2);
    if (format === 'rgba64be') {
      assert.equal(png[25], 6);
      assert.equal(report.output.alpha, true);
      const decoded = spawnSync(realFfmpeg, ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgba64be', '-']);
      assert.equal(decoded.status, 0, decoded.stderr.toString());
      for (let i = 6; i < decoded.stdout.length; i += 8) assert.equal(decoded.stdout.readUInt16BE(i), 32768);
    }
    if (format === 'rgb48be') {
      const decoded = spawnSync(realFfmpeg, ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb48be', '-']);
      assert.equal(decoded.status, 0, decoded.stderr.toString());
      const values = new Set();
      for (let i = 0; i < decoded.stdout.length; i += 6) values.add(decoded.stdout.readUInt16BE(i));
      assert.ok(values.size > 256, `only ${values.size} channel values survived`);
    }
  });
}

for (const [transfer, dynamicRange] of [['smpte2084', 'hdr-pq'], ['arib-std-b67', 'hdr-hlg']]) {
  test(`native ${dynamicRange} publishes verified HEIC10 frames`, { skip: process.platform !== 'darwin' || !realFfmpeg }, t => {
    const root = temporaryRoot(t);
    const input = path.join(root, 'hdr.mov');
    const generated = spawnSync(realFfmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=2:d=1', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-x265-params', `log-level=error:colorprim=bt2020:transfer=${transfer}:colormatrix=bt2020nc`, '-color_primaries', 'bt2020', '-color_trc', transfer, '-colorspace', 'bt2020nc', '-color_range', 'tv', input], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const result = spawnSync(process.execPath, [require.resolve('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js'), '--json', input], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout).result;
    assert.equal(report.dynamicRange, dynamicRange);
    assert.equal(report.output.depth, '10');
    assert.equal(report.output.alpha, false);
    assert.equal(report.frames, 2);
    assert.deepEqual(fs.readdirSync(report.outputDirectory), ['frame-000001.heic', 'frame-000002.heic']);
    assert.equal(report.checks.find(check => check.probes).probes.length, 2);
  });
}

test('native HEIC10 encoder drops TIFF alpha and HDR alpha CLI rejects during preparation', { skip: process.platform !== 'darwin' || !realFfmpeg }, t => {
  const root = temporaryRoot(t);
  const tiff = path.join(root, 'alpha.tiff');
  const heic = path.join(root, 'alpha.heic');
  const encoder = path.join(root, 'encoder');
  const generated = spawnSync(realFfmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red@0.5:s=64x64,format=rgba64le', '-frames:v', '1', tiff], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const alpha = spawnSync('sips', ['-g', 'hasAlpha', tiff], { encoding: 'utf8' });
  assert.equal(alpha.status, 0, alpha.stderr);
  assert.match(alpha.stdout, /hasAlpha: yes/);
  const compiled = spawnSync('swiftc', [path.resolve(__dirname, '../../plugins/harness/skills/extract-video-frames/scripts/tiff-to-heic.swift'), '-o', encoder], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  for (const transfer of ['hlg', 'pq']) {
    const encoded = spawnSync(encoder, ['--json', tiff, heic, transfer], { encoding: 'utf8' });
    assert.equal(encoded.status, 0, encoded.stderr);
    const inspected = spawnSync('sips', ['-g', 'hasAlpha', '-g', 'bitsPerSample', heic], { encoding: 'utf8' });
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.match(inspected.stdout, /hasAlpha: no/, `native ${transfer} alpha support changed`);
    assert.match(inspected.stdout, /bitsPerSample: 10/);
    fs.rmSync(heic);
  }
  const input = path.join(root, 'alpha.mov');
  const video = spawnSync(realFfmpeg, ['-v', 'error', '-loop', '1', '-i', tiff, '-vf', 'setparams=range=limited:color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc', '-frames:v', '2', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-color_range', 'pc', input], { encoding: 'utf8' });
  assert.equal(video.status, 0, video.stderr);
  const result = spawnSync(process.execPath, [require.resolve('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js'), '--json', input], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, 'hdr_alpha_unsupported');
  assert.equal(fs.existsSync(path.join(root, 'alpha-frames')), false);
  assert.equal(fs.readdirSync(root).some(name => name.includes('.partial-')), false);
});
