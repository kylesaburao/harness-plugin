'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const base = path.resolve(__dirname, '../../plugins/harness/skills/create-discord-emoji-gif/scripts/node');

for (const failed of [false, true]) {
  test(`runner preserves ${failed ? 'conversion failure' : 'published result'} when cleanup fails`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-cleanup-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const shared = require(${JSON.stringify(base + '/shared')});
      const { runConverter } = require(${JSON.stringify(base + '/converter-runner')});
      shared.validateInput = () => {};
      shared.inspectInput = async () => [];
      shared.checkGifskiPreflight = async () => ({ commands: {} });
      shared.preflightError = () => null;
      shared.validateOutput = () => ({ output: ${JSON.stringify(root + '/output.gif')} });
      const remove = fs.rmSync;
      fs.rmSync = (target, options) => {
        if (target.includes('work-')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return remove(target, options);
      };
      runConverter({ argv: ['--json', 'input'], env: { TMPDIR: ${JSON.stringify(root)} }, backend: 'gifski', defaultScriptName: 'test.js', workPrefix: 'work-', convert: async state => {
        if (${failed}) throw new shared.RunError('candidate_encode_failed', 'original failure', 'repair encoder');
        fs.writeFileSync(state.output, 'published');
        return { output: state.output };
      } }).then(code => { process.exitCode = code; });
    `], { encoding: 'utf8' });
    assert.equal(child.status, 1, child.stderr);
    const payload = JSON.parse(failed ? child.stderr : child.stdout)[failed ? 'error' : 'result'];
    assert.equal(payload.cleanupFailures[0].code, 'EACCES');
    assert.equal(fs.existsSync(payload.cleanupFailures[0].path), true);
    if (failed) assert.equal(payload.code, 'candidate_encode_failed');
    else assert.equal(fs.readFileSync(payload.output, 'utf8'), 'published');
  });
}

for (const mode of ['exit', 'signal', 'launch']) {
  for (const json of [true, false]) {
    test(`${mode} evidence survives VMAF and worker wrapping in ${json ? 'JSON' : 'plain'} output`, () => {
      const result = spawnSync(process.execPath, ['-e', `
        const shared = require(${JSON.stringify(base + '/shared')});
        const { ProcessManager } = require(${JSON.stringify(base + '/process-manager')});
        const manager = new ProcessManager();
        const mode = ${JSON.stringify(mode)};
        const run = manager.runOwned.bind(manager);
        manager.runOwned = task => run(task, mode === 'launch' ? '/nonexistent/encoder' : process.execPath,
          ['-e', mode === 'signal' ? "process.kill(process.pid, 'SIGSEGV')" : 'process.exit(7)'], { stderr: 'capture' });
        shared.scoreCandidate(manager, { ffmpeg: 'unused' }, '/tmp', 'candidate.gif', 'candidate-42')
          .catch(error => shared.emitError(new shared.RunError('worker_failed', 'worker failed', 'retry', { cause: error }), ${json}));
      `], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      if (json) {
        const cause = JSON.parse(result.stderr).error.cause;
        assert.match(cause.task, /candidate-42/);
        if (mode === 'exit') assert.equal(cause.childExitCode, 7);
        if (mode === 'signal') assert.equal(cause.childSignal, 'SIGSEGV');
        if (mode === 'launch') assert.equal(cause.code, 'ENOENT');
      } else {
        assert.match(result.stderr, /candidate-42/);
        assert.match(result.stderr, mode === 'exit' ? /"childExitCode":7/ : mode === 'signal' ? /SIGSEGV/ : /ENOENT/);
      }
    });
  }
}
