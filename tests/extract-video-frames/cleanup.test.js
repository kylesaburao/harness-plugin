'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = require.resolve('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js');
const ffmpeg = ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/usr/local/opt/ffmpeg-full/bin/ffmpeg'].find(fs.existsSync);

for (const json of [false, true]) {
  for (const phase of ['preflight failure', 'preflight success', 'extraction', 'structural', 'publication', 'interruption']) {
    const masks = phase.startsWith('preflight') || phase === 'publication' ? [['encoder'], []] : [['partial'], ['encoder'], ['partial', 'encoder'], []];
    for (const denied of masks) test(`${phase}, denied ${denied.join('+') || 'none'}, ${json ? 'JSON' : 'plain'}`, { skip: process.platform !== 'darwin' || !ffmpeg }, t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-cleanup-test-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const input = path.join(root, 'clip.mov');
      const journal = path.join(root, 'journal.jsonl');
      const sentinel = path.join(root, 'unowned.txt');
      fs.writeFileSync(sentinel, 'preserved');
      const generated = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=16x16:r=2:d=1', '-c:v', 'libx264', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', input], { encoding: 'utf8' });
      assert.equal(generated.status, 0, generated.stderr);
      const preload = path.join(root, 'inject.cjs');
      fs.writeFileSync(preload, `
const fs = require('node:fs');
const cp = require('node:child_process');
const log = event => fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify(event) + '\\n');
const rm = fs.rmSync;
fs.rmSync = function(file, options) {
  const kind = file.includes('.partial-') ? 'partial' : file.includes('extract-video-frames-encoder-') ? 'encoder' : 'unowned';
  log({event: 'remove', path: file, kind});
  if (${JSON.stringify(denied)}.includes(kind)) throw Object.assign(new Error('injected removal denial'), {code: kind === 'partial' ? 'EACCES' : 'EBUSY'});
  return rm(file, options);
};
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (...args) => { log({event: 'emit'}); return write(...args); };
}
const spawn = cp.spawn;
cp.spawn = function(command, args, options) {
  if (${JSON.stringify(phase)} === 'preflight failure' && args.includes('-frames:v') && args.includes('null')) {
    return spawn(process.execPath, ['-e', "process.stderr.write('preflight evidence'); process.exit(7)"], options);
  }
  if (args.includes('-start_number')) {
    if (${JSON.stringify(phase)} === 'extraction') return spawn(process.execPath, ['-e', "process.stderr.write('extraction evidence'); process.kill(process.pid, 'SIGTERM')"], options);
    if (${JSON.stringify(phase)} === 'structural') return spawn(process.execPath, ['-e', 'process.exit(0)'], options);
    if (${JSON.stringify(phase)} === 'interruption') return spawn(process.execPath, ['-e', ${JSON.stringify(`const fs = require('node:fs'); process.on('SIGTERM', () => { setTimeout(() => { fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify({event:'child closed'}) + String.fromCharCode(10)); process.exit(0); }, 40); }); process.kill(process.ppid, 'SIGTERM'); setInterval(() => {}, 1000);`)}], options);
  }
  return spawn(command, args, options);
};
`);
      const result = spawnSync(process.execPath, ['--require', preload, script, ...(json ? ['--json'] : []), ...(phase.startsWith('preflight') ? ['--preflight'] : []), input], { encoding: 'utf8', env: { ...process.env, TMPDIR: root }, timeout: 30000 });
      const success = ['preflight success', 'publication'].includes(phase);
      const expectedStatus = phase === 'interruption' ? 143 : phase === 'preflight failure' ? 2 : success && !denied.length ? 0 : 1;
      assert.equal(result.status, expectedStatus, result.stderr);
      const events = fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse);
      const removals = events.filter(event => event.event === 'remove');
      const owned = phase.startsWith('preflight') || phase === 'publication' ? ['encoder'] : ['partial', 'encoder'];
      assert.deepEqual(removals.map(event => event.kind), owned);
      for (const removal of removals) assert.equal(fs.existsSync(removal.path), denied.includes(removal.kind));
      const firstEmission = events.findIndex(event => event.event === 'emit');
      if (firstEmission !== -1) assert.ok(firstEmission > events.findLastIndex(event => event.event === 'remove'));
      if (phase === 'interruption') assert.ok(events.findIndex(event => event.event === 'child closed') < events.findIndex(event => event.event === 'remove'));
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserved');
      assert.equal(fs.existsSync(path.join(root, 'clip-frames')), phase === 'publication');
      if (phase === 'publication') assert.equal(fs.readdirSync(path.join(root, 'clip-frames')).length, 2);
      const failedPaths = removals.filter(removal => denied.includes(removal.kind));
      if (json) {
        const report = success ? JSON.parse(result.stdout)[phase === 'publication' ? 'result' : 'preflight'] : result.stderr ? JSON.parse(result.stderr).error : null;
        if (denied.length) assert.deepEqual(report.cleanupFailures, failedPaths.map(removal => ({path: removal.path, code: removal.kind === 'partial' ? 'EACCES' : 'EBUSY', condition: 'injected removal denial'})));
        else if (report) assert.equal(report.cleanupFailures, undefined);
        if (phase === 'publication') assert.equal(report.frames, 2);
        if (phase === 'preflight failure' || phase === 'extraction') {
          assert.equal(report.code, phase === 'extraction' ? 'extraction_failed' : 'input_decode_failed');
          assert.equal(report.task, phase === 'extraction' ? 'extraction' : 'input_decode_failed');
          assert.equal(report.childExitCode, phase === 'extraction' ? null : 7);
          assert.equal(report.childSignal, phase === 'extraction' ? 'SIGTERM' : null);
          assert.equal(report.stderr, phase === 'extraction' ? 'extraction evidence' : 'preflight evidence');
        }
        if (phase === 'structural') assert.equal(report.code, 'structural_check_failed');
        if (phase === 'interruption' && denied.length) assert.equal(report.code, 'interrupted');
      } else {
        for (const removal of failedPaths) {
          assert.ok(result.stderr.includes(removal.path));
          assert.ok(result.stderr.includes(removal.kind === 'partial' ? '[EACCES]' : '[EBUSY]'));
        }
        if (denied.length) assert.match(result.stderr, /Cleanup incomplete:/);
        else assert.doesNotMatch(result.stderr, /Cleanup incomplete:/);
        if (phase === 'publication') assert.match(result.stdout, /Frames: 2/);
        if (phase === 'preflight failure' || phase === 'extraction') {
          assert.match(result.stderr, phase === 'extraction' ? /ERROR \[extraction_failed\]/ : /ERROR \[input_decode_failed\]/);
          assert.match(result.stderr, phase === 'extraction' ? /childSignal: "SIGTERM"/ : /childExitCode: 7/);
          assert.match(result.stderr, phase === 'extraction' ? /extraction evidence/ : /preflight evidence/);
        }
        if (phase === 'structural') assert.match(result.stderr, /ERROR \[structural_check_failed\]/);
        if (phase === 'interruption' && denied.length) assert.match(result.stderr, /ERROR \[interrupted\]/);
      }
    });
  }
}
