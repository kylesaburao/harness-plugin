'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { temporaryDirectory, skillDir, runEntrypoint, narrowSearch, tinyGif } = require('./test-helpers');
const shared = require(require('../helpers/plugin-paths').artifactPath('skills/create-discord-emoji-gif/scripts/node/shared'));
const { ProcessManager } = require(require('../helpers/plugin-paths').artifactPath('skills/create-discord-emoji-gif/scripts/node/process-manager'));
function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
for (const size of [1, 63, 64, 65]) test(`VMAF dimension boundary ${size}`, async () => {
  const dir = temporaryDirectory('vmaf-boundary.');
  try {
    const ref = path.join(dir, 'vmaf-reference.mkv');
    const gif = path.join(dir, 'candidate.gif');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=80x80:rate=24:duration=0.5', '-vf', `scale=${size}:${size}`, '-c:v', 'ffv1', '-pix_fmt', 'yuv444p', ref]);
    ffmpeg(['-i', ref, gif]);
    assert.match(await shared.scoreCandidate(new ProcessManager(), { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, dir, gif, 'boundary', 12, 24), /^-?\d+\.\d{6}$/);
    assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
for (const seconds of [0.25, 3]) test(`VMAF rejects ${seconds}s candidate against 2s reference`, async () => {
  const dir = temporaryDirectory('vmaf-coverage.');
  try {
    const ref = path.join(dir, 'vmaf-reference.mkv');
    const gif = path.join(dir, 'candidate.gif');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=24:duration=2', '-c:v', 'ffv1', ref]);
    ffmpeg(['-f', 'lavfi', '-i', `testsrc2=size=64x64:rate=24:duration=${seconds}`, gif]);
    await assert.rejects(shared.scoreCandidate(new ProcessManager(), { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, dir, gif, 'coverage', 48, 24), { code: 'vmaf_failed' });
    const output = path.join(dir, 'output.gif');
    fs.writeFileSync(output, 'existing');
    await assert.rejects(shared.publishVerified(gif, output, 'duration', file => shared.verifyFinalGif(new ProcessManager(), { ffprobe: 'ffprobe' }, file, { size: 64, maxBytes: 1000000, referenceFrames: 48, fps: 24 })), /duration/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'existing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
for (const report of [undefined, '{', '{"frames":[]}', '{"frames":[{}],"pooled_metrics":{"vmaf":{"mean":1e999}}}', '{"frames":[{}],"pooled_metrics":{"vmaf":{"mean":null}}}']) test(`reject invalid VMAF report ${report}`, async () => {
  const dir = temporaryDirectory('vmaf-json.');
  try {
    const manager = { runOwned: async (_task, _command, args, options) => {
      if (!args.includes('-lavfi')) return { code: 0, signal: null, stdout: String(1 / 24), stderr: '' };
      const name = args[args.indexOf('-lavfi') + 1].match(/log_path=([^;]+)/)[1];
      if (report !== undefined) fs.writeFileSync(path.join(options.cwd, name), report);
      return { code: 0, signal: null, stderr: '' };
    } };
    await assert.rejects(shared.scoreCandidate(manager, { ffmpeg: 'unused' }, dir, 'unused.gif', 'report', 12, 24), { code: 'vmaf_nonnumeric' });
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('concurrent tasks use separate score files and KEEP_WORK retains them', async () => {
  const dir = temporaryDirectory('vmaf-logs.');
  const candidates = temporaryDirectory('vmaf-log-candidates.');
  try {
    const candidate = path.join(candidates, 'one-frame.gif');
    fs.writeFileSync(candidate, tinyGif([4])); // One frame at 24 FPS, rounded to GIF centiseconds.
    const names = [];
    const manager = { runOwned: async (task, _command, args, options) => {
      if (!args.includes('-lavfi')) assert.fail(`unexpected child process ${task}`);
      const name = args[args.indexOf('-lavfi') + 1].match(/log_path=([^;]+)/)[1];
      names.push(name);
      fs.writeFileSync(path.join(options.cwd, name), JSON.stringify({ frames: [{}], pooled_metrics: { vmaf: { mean: names.length } } }));
      await new Promise(resolve => setTimeout(resolve, 10));
      return { code: 0, signal: null, stderr: '' };
    } };
    const scores = await Promise.all(Array.from({ length: 8 }, () => shared.scoreCandidate(manager, { ffmpeg: 'unused' }, dir, candidate, 'same-task', 1, 24, true)));
    assert.equal(new Set(names).size, 8);
    assert.equal(new Set(scores).size, 8);
    assert.equal(fs.readdirSync(dir).length, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(candidates, { recursive: true, force: true });
  }
});
test('candidate duration is read from the GIF and unreadable timing fails scoring', async () => {
  const dir = temporaryDirectory('vmaf-duration.');
  try {
    const manager = { runOwned: async (task, _command, args, options) => {
      if (!args.includes('-lavfi')) assert.fail(`unexpected child process ${task}`);
      const name = args[args.indexOf('-lavfi') + 1].match(/log_path=([^;]+)/)[1];
      fs.writeFileSync(path.join(options.cwd, name), JSON.stringify({ frames: Array(12).fill({}), pooled_metrics: { vmaf: { mean: 80 } } }));
      return { code: 0, signal: null, stderr: '' };
    } };
    const score = file => shared.scoreCandidate(manager, { ffmpeg: 'unused' }, dir, file, 'timing', 12, 8);
    const write = (name, data) => { const file = path.join(dir, name); fs.writeFileSync(file, data); return file; };
    assert.equal(await score(write('covering.gif', tinyGif([13, 12, 13, 12]))), '80.000000');
    // Zero delays read as FFmpeg's 10 cs default, so two frames last 0.2 s, short of 0.5 s at 8 FPS.
    await assert.rejects(score(write('zero-delays.gif', tinyGif([0, 0]))), error => error.code === 'vmaf_failed' && /candidate duration 0\.200000s differs/.test(error.condition));
    await assert.rejects(score(write('untimed.gif', tinyGif([null, null]))), error => error.code === 'vmaf_failed' && /candidate duration 0\.000000s/.test(error.condition));
    await assert.rejects(score(write('truncated.gif', tinyGif([13, 12, 13, 12]).subarray(0, 40))), error => error.code === 'vmaf_failed' && /could not read the duration of timing: invalid GIF timing: truncated block/.test(error.condition));
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.json')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
for (const backend of ['gifski', 'gifsicle']) for (const fps of [15, 24]) test(`${backend} accepts ${fps} FPS GIF timestamp rounding`, () => {
  const dir = temporaryDirectory('gif-rounding.');
  try {
    const input = path.join(dir, 'input.mkv');
    const output = path.join(dir, 'output.gif');
    const preload = narrowSearch(dir, [32]);
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=24:duration=0.625', '-c:v', 'ffv1', input]);
    const result = runEntrypoint(process.execPath, path.join(skillDir, 'scripts/node', backend === 'gifski' ? 'mov-to-gif-gifski.js' : 'mov-to-gif.js'), ['--json', input, output], { NODE_OPTIONS: `--require=${preload}`, GIF_SIZE: '64', MIN_FPS: String(fps), MAX_FPS: String(fps), MIN_QUALITY: '80', MAX_QUALITY: '80', JOBS: '2', MAX_BYTES: '1000000', KEEP_WORK: '0' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).result.checks.some(check => check.name === 'duration agrees with the decoded reference' && check.status === 'pass'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('FFV1 CRC errors with exit zero fail both GIF backends and preserve destinations', () => {
  const dir = temporaryDirectory('gif-damaged.');
  try {
    const input = path.join(dir, 'damaged.mkv');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=24:duration=3', '-c:v', 'ffv1', '-level', '3', '-slicecrc', '1', input]);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_packets', '-show_entries', 'packet=pos,size', '-of', 'json', input], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    // Keep corruption beyond decoder read-ahead during the first-frame probe.
    const packet = JSON.parse(probe.stdout).packets[60];
    const bytes = fs.readFileSync(input);
    bytes[Number(packet.pos) + Number(packet.size) - 1] ^= 1;
    fs.writeFileSync(input, bytes);
    const reproduction = ffmpeg(['-xerror', '-i', input, '-f', 'null', '-']);
    assert.match(reproduction.stderr, /CRC mismatch/);
    for (const backend of ['mov-to-gif.js', 'mov-to-gif-gifski.js']) {
      const output = path.join(dir, `${backend}.gif`);
      fs.writeFileSync(output, 'existing');
      const result = runEntrypoint(process.execPath, path.join(skillDir, 'scripts/node', backend), ['--json', input, output], { GIF_SIZE: '64', MIN_FPS: '24', MAX_FPS: '24', JOBS: '1', KEEP_WORK: '0' });
      assert.equal(result.status, 1, result.stderr);
      let error;
      assert.doesNotThrow(() => { error = JSON.parse(result.stderr).error; }, result.stderr);
      assert.equal(error.childExitCode, 0);
      assert.match(error.stderr, /CRC mismatch/);
      assert.equal(fs.readFileSync(output, 'utf8'), 'existing');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
