'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const subject = require('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames');
const { frameRecords } = require('../../plugins/harness/skills/extract-video-frames/scripts/frame-records');
const { analyzeFixture } = require('./frame-spool-fixture');
const color = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' };
const options = { start: null, end: null, timeBase: '1/30' };
function fixture(t, contents = '{"frames":[]}') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-spool-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'frames.json');
  fs.writeFileSync(file, contents);
  return { root, file };
}
async function collect(file, settings) { const records = []; for await (const frame of frameRecords(file, settings)) records.push(frame); return records; }

test('frame reader handles nested records, escaped strings, arbitrary UTF-8 boundaries and whitespace', async t => {
  const frames = [{ best_effort_timestamp: '0', side_data_list: [{ nested: { text: 'é漢😀\\"}{,[]', array: [1, null, true, { x: '\n\r\t' }] } }] }, { best_effort_timestamp: 3 }];
  const { file } = fixture(t, JSON.stringify({ frames }, null, 2));
  for (const highWaterMark of [1, 2, 7, 65536]) assert.deepEqual(await collect(file, { highWaterMark }), frames);
});

test('malformed, truncated, unexpected records and trailing data reject instead of partial success', async t => {
  const { file } = fixture(t);
  for (const text of ['', '{', '{"frames":[', '{"frames":[{}', '{"frames":[{},]}', '{"frames":[null]}', '{"frames":[1]}', '{"frames":[[]]}', '{"frames":[{"a":[}]}', '{"frames":[]}x', '{"frames":[]}{}', '{"fra mes":[]}', '{"frames":[]}\v', '{"frames":[{"best_effort_timestamp":"0","color_range":"bad"}]}broken']) {
    fs.writeFileSync(file, text);
    for (const highWaterMark of [1, 7, 65536]) await assert.rejects(subject.analyzeFrameSpool(file, color, options, { highWaterMark }), { code: 'input_unusable', condition: 'ffprobe could not enumerate frame timestamps: output was not valid JSON' }, text);
  }
  for (const text of ['{}', '{"frames":[]}']) {
    fs.writeFileSync(file, text);
    await assert.rejects(subject.analyzeFrameSpool(file, color, options), { code: 'input_unusable', condition: 'selected video stream has no timestamped frames' });
  }
});

test('two replay passes equal complete baseline results and errors for 350 deterministic unusual reports', async () => {
  let seed = 906;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const timestamps = [undefined, null, 'N/A', 'bad', '', '-1', '0', '1', '1', '8', 2, 0.5, '9007199254740993'];
  const durations = [undefined, null, 'bad', '0', '1', '3', '-1'];
  for (let trial = 0; trial < 350; trial++) {
    const frames = Array.from({ length: random(14) }, () => ({ best_effort_timestamp: timestamps[random(timestamps.length)], duration: durations[random(durations.length)], pkt_duration: durations[random(durations.length)] }));
    if (frames.length && trial % 7 === 0) frames[random(frames.length)].color_transfer = 'smpte2084';
    const bounds = [null, 0n, 33333333n, 100000000n];
    try { await analyzeFixture({ frames }, color, { timeBase: trial % 3 ? '1/30' : '1/2', start: bounds[random(4)], end: bounds[random(4)] }); }
    catch (error) { if (!error.code || error.code === 'ERR_ASSERTION') throw error; }
  }
});

test('stdout spool is exclusive mode 0600, uncaptured, and stream stdout still collects', async t => {
  const { root, file } = fixture(t);
  const manager = new subject.ProcessManager();
  await assert.rejects(manager.run(process.execPath, ['-e', 'process.exit(99)'], { stdoutFile: file }), { code: 'frame_metadata_storage_failed' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"frames":[]}');
  const destination = path.join(root, 'new.json');
  const result = await manager.run(process.execPath, ['-e', 'process.stdout.write("{\\"frames\\":[]}"); process.stderr.write("x".repeat(100000))'], { stdoutFile: destination });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, undefined);
  assert.equal(result.stderr.length, 65536);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(destination, 'utf8'), '{"frames":[]}');
  assert.equal((await manager.run(process.execPath, ['-e', 'process.stdout.write("small")'])).stdout, 'small');
  const failed = await manager.run(process.execPath, ['-e', 'process.stderr.write("evidence"); process.exit(7)'], { stdoutFile: path.join(root, 'failed.json') });
  assert.deepEqual(failed, { code: 7, signal: null, stderr: 'evidence' });
  await assert.rejects(manager.run('/no/such/executable', [], { stdoutFile: path.join(root, 'launch.json') }), error => error.code === 'ENOENT' && error.task === '/no/such/executable' && error.childSignal === null);
  assert.equal(manager.active.size, 0);
});

test('spool child cancellation waits for close and retains signal', async t => {
  const { root } = fixture(t);
  const manager = new subject.ProcessManager();
  const running = manager.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdoutFile: path.join(root, 'cancel.json') });
  await manager.interrupt('SIGTERM');
  assert.equal((await running).signal, 'SIGTERM');
  assert.equal(manager.active.size, 0);
});

test('reader closes descriptors after cancellation, early return, malformed input and read errors', async t => {
  const { file } = fixture(t, JSON.stringify({ frames: Array.from({ length: 100 }, () => ({ best_effort_timestamp: 0 })) }));
  const original = fs.createReadStream;
  const streams = [];
  fs.createReadStream = (...args) => { const stream = original(...args); streams.push(stream); return stream; };
  try {
    let checks = 0;
    await assert.rejects(subject.analyzeFrameSpool(file, color, options, { highWaterMark: 10, assertRunning: () => { if (++checks === 4) throw Object.assign(new Error('cancelled'), { code: 'test_cancel' }); } }), /cancelled/);
    for await (const frame of frameRecords(file)) { assert.ok(frame); break; }
    await assert.rejects(collect(`${file}.missing`), { code: 'ENOENT' });
    fs.writeFileSync(file, '{');
    await assert.rejects(collect(file), SyntaxError);
    assert.ok(streams.every(stream => stream.closed && stream.destroyed));
  } finally { fs.createReadStream = original; }
});

function inspectionState(root) {
  return { encoderDirectory: root, paths: { supplied: '/fake/source.mov' }, commands: { ffprobe: '/fake/ffprobe' }, pixelDescriptors: subject.descriptorMap(require('./pixel-formats.json')) };
}
const metadata = { streams: [{ codec_type: 'video', index: 0, width: 16, height: 16, pix_fmt: 'yuv420p', color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709', color_range: 'tv', time_base: '1/30' }] };

test('frame child failures and deterministic ENOSPC preserve child evidence and prevent replay', async t => {
  const { root } = fixture(t);
  for (const result of [{ code: 7, signal: null, stderr: 'failed' }, { code: null, signal: 'SIGTERM', stderr: '' }, { code: 0, signal: null, stderr: 'error-level warning' }, { code: 1, signal: null, stderr: 'write: ENOSPC: no space left on device' }]) {
    const manager = { assertRunning() {}, run: async (_command, args, settings) => {
      if (!args.includes('-show_frames')) { assert.equal(settings, undefined); return { stdout: JSON.stringify(metadata), code: 0, stderr: '' }; }
      assert.equal(settings.stdoutFile, path.join(root, 'frame-metadata.json'));
      return result;
    } };
    await assert.rejects(subject.inspectInput(manager, inspectionState(root), options), error => {
      assert.equal(error.code, result.stderr.includes('ENOSPC') ? 'frame_metadata_storage_failed' : 'input_unusable');
      assert.equal(error.childExitCode, result.code);
      assert.equal(error.childSignal, result.signal);
      assert.equal(error.stderr, result.stderr);
      if (error.code === 'frame_metadata_storage_failed') { assert.ok(error.condition.includes(root)); assert.match(error.remedy, /free space/); }
      return true;
    });
  }
});

test('deterministic storage open/read failures include path, remedy, and exit 2', async t => {
  const { root, file } = fixture(t);
  await assert.rejects(subject.analyzeFrameSpool(`${file}.missing`, color, options), error => error.code === 'frame_metadata_storage_failed' && error.exitCode === 2 && error.condition.includes(`${file}.missing`));
  const open = fs.openSync;
  fs.openSync = (filename, ...args) => { if (filename === path.join(root, 'full.json')) throw Object.assign(new Error('ENOSPC injected'), { code: 'ENOSPC' }); return open(filename, ...args); };
  try { await assert.rejects(new subject.ProcessManager().run(process.execPath, ['-e', ''], { stdoutFile: path.join(root, 'full.json') }), error => error.code === 'frame_metadata_storage_failed' && error.exitCode === 2 && error.condition.includes('full.json') && error.remedy.includes('free space')); }
  finally { fs.openSync = open; }
});

test('spool parent descriptors close on successful launch and synchronous spawn failure', t => {
  const { root } = fixture(t);
  const script = `const fs = require('node:fs'); const cp = require('node:child_process'); const open = fs.openSync; const close = fs.closeSync; let opened = 0, closed = 0; const owned = new Set(); fs.openSync = (...args) => { const fd = open(...args); if (args[1] === 'wx') { opened++; owned.add(fd); } return fd; }; fs.closeSync = fd => { if (owned.delete(fd)) closed++; return close(fd); }; const spawn = cp.spawn; cp.spawn = (...args) => { if (args[0] === 'throw') throw Error('spawn injection'); return spawn(...args); }; const { ProcessManager } = require(${JSON.stringify(require.resolve('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames'))}); (async () => { const manager = new ProcessManager(); await manager.run(process.execPath, ['-e', ''], {stdoutFile: ${JSON.stringify(path.join(root, 'ok.json'))}}); try { await manager.run('throw', [], {stdoutFile: ${JSON.stringify(path.join(root, 'throw.json'))}}); } catch {} console.log(JSON.stringify({opened, closed, active: manager.active.size})); })();`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { opened: 2, closed: 2, active: 0 });
});

test('duplicate and non-monotonic timestamps preserve encounter order and exact point selection', async () => {
  const frames = [
    { best_effort_timestamp: '8', duration: '1' },
    { best_effort_timestamp: '10', duration: '1' },
    { best_effort_timestamp: '9', duration: '1' },
    { best_effort_timestamp: '9', duration: '1' },
    { best_effort_timestamp: '12', duration: null, pkt_duration: '2' },
  ];
  const full = await analyzeFixture({ frames }, color, { ...options, timeBase: '1/2' });
  assert.equal(full.expectedFrames, 5);
  assert.equal(full.duration, 3000000000n);
  const point = await analyzeFixture({ frames }, color, { timeBase: '1/2', start: 500000000n, end: 500000000n });
  assert.equal(point.expectedFrames, 2);
  assert.equal(point.firstTick, 1n);
  assert.equal(point.lastTick, 1n);
});

test('cancellation during the second replay preserves interruption status and closes the reader', async t => {
  const { file } = fixture(t, '{"frames":[{"best_effort_timestamp":0,"duration":1}]}');
  const manager = new subject.ProcessManager();
  const original = fs.createReadStream;
  const streams = [];
  fs.createReadStream = (...args) => { const stream = original(...args); streams.push(stream); return stream; };
  try {
    await assert.rejects(subject.analyzeFrameSpool(file, color, options, { assertRunning: () => { if (streams.length === 2) manager.interrupt('SIGTERM'); manager.assertRunning(); } }), { code: 'interrupted', exitCode: 143 });
    assert.equal(streams.length, 2);
    assert.ok(streams.every(stream => stream.closed));
  } finally { fs.createReadStream = original; }
});
