'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = require.resolve('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames');
const ffmpeg = ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/usr/local/opt/ffmpeg-full/bin/ffmpeg'].find(fs.existsSync);
for (const phase of ['malformed', 'write ENOSPC', 'read EIO', 'interruption']) {
  for (const denied of [false, true]) test(`metadata ${phase}, cleanup ${denied ? 'denied' : 'complete'}`, { skip: process.platform !== 'darwin' || !ffmpeg }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-lifecycle-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const input = path.join(root, 'clip.mov');
    const result = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=16x16:r=2:d=1', '-c:v', 'libx264', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', input], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const journal = path.join(root, 'journal.json');
    const preload = path.join(root, 'inject.cjs');
    const childCode = phase === 'interruption' ? `process.kill(process.ppid, 'SIGTERM'); setInterval(() => {}, 1000);` : phase === 'write ENOSPC' ? `const fs = require('node:fs'); const write = fs.writeSync; let writes = 0; fs.writeSync = (...args) => { if (++writes === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), {code:'ENOSPC'}); return write(...args); }; fs.writeSync(1, '{"frames":['); fs.writeSync(1, '{}]}');` : `process.stdout.write('{"frames":[');`;
    fs.writeFileSync(preload, `
const fs = require('node:fs'); const cp = require('node:child_process');
const spawn = cp.spawn; const rm = fs.rmSync; const read = fs.createReadStream;
cp.spawn = (command, args, options) => {
 if (args.includes('-show_frames')) {
   fs.writeFileSync(${JSON.stringify(journal)}, JSON.stringify({path: require('node:path').join(${JSON.stringify(root)}, fs.readdirSync(${JSON.stringify(root)}).find(name => name.startsWith('extract-video-frames-encoder-')), 'frame-metadata.json'), mode: fs.fstatSync(options.stdio[1]).mode & 0o777}));
   if (${JSON.stringify(phase)} !== 'read EIO') return spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], options);
 }
 return spawn(command, args, options);
};
fs.createReadStream = (filename, ...args) => { if (${JSON.stringify(phase)} === 'read EIO' && filename.endsWith('frame-metadata.json')) throw Object.assign(new Error('injected EIO'), {code:'EIO'}); return read(filename, ...args); };
fs.rmSync = (filename, ...args) => { if (${denied} && filename.includes('extract-video-frames-encoder-')) throw Object.assign(new Error('injected retained spool'), {code:'EACCES'}); return rm(filename, ...args); };
`);
    const run = spawnSync(process.execPath, ['--require', preload, script, '--preflight', '--json', input], { encoding: 'utf8', env: { ...process.env, TMPDIR: root }, timeout: 30000 });
    assert.equal(run.status, phase === 'interruption' ? 143 : 2, run.stderr);
    const spool = JSON.parse(fs.readFileSync(journal, 'utf8'));
    assert.equal(spool.mode, 0o600);
    assert.equal(fs.existsSync(path.dirname(spool.path)), denied);
    assert.equal(fs.existsSync(path.join(root, 'clip-frames')), false);
    const error = run.stderr ? JSON.parse(run.stderr).error : null;
    if (phase !== 'interruption') assert.equal(error.code, phase === 'malformed' ? 'input_unusable' : 'frame_metadata_storage_failed');
    if (phase === 'write ENOSPC') { assert.equal(error.childExitCode, 1); assert.match(error.stderr, /ENOSPC/); assert.ok(error.condition.includes(spool.path)); }
    if (denied) {
      assert.deepEqual(error.cleanupFailures, [{ path: path.dirname(spool.path), code: 'EACCES', condition: 'injected retained spool' }]);
      assert.ok(fs.existsSync(spool.path));
      if (phase === 'interruption') assert.equal(error.code, 'interrupted');
    }
  });
}
