'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skillDir, temporaryDirectory, runEntrypoint, assertPublishedResult } = require('./test-helpers');
const { sha256File } = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/shared');

test('gifsicle full search publishes complete JSON and retains KEEP_WORK artifacts', { timeout: 120000 }, t => {
  const directory = temporaryDirectory('gifsicle-full-search.');
  try {
    const input = path.join(directory, 'fixture.mkv');
    const output = path.join(directory, 'output.gif');
    const temporaryRoot = path.join(directory, 'work');
    fs.mkdirSync(temporaryRoot);
    const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=6:duration=0.5', '-an', '-c:v', 'ffv1', input], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const result = runEntrypoint(process.execPath, path.join(skillDir, 'scripts/node/mov-to-gif.js'), ['--json', input, output], {
      MAX_BYTES: '1000000', GIF_SIZE: '64', MIN_FPS: '6', MAX_FPS: '6', JOBS: String(os.availableParallelism()),
      KEEP_WORK: '1', TMPDIR: temporaryRoot,
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout).result;
    assertPublishedResult(payload, 'gifsicle', input, output, 1000000);
    assert.match(result.stderr, /^Kept work directory: .+\n$/);
    assert.equal(fs.readdirSync(temporaryRoot).length, 1);
    const kept = result.stderr.match(/^Kept work directory: (.+)$/m)[1];
    const candidates = fs.readdirSync(kept).filter(name => /^f6-c\d+-d\d+\.gif$/.test(name));
    assert.equal(candidates.length, 1012);
    assert.equal(sha256File(output), payload.sha256);
    assert.equal(sha256File(path.join(kept, `f6-c${payload.parameters.colors}-d${payload.parameters.dither}.gif`)), payload.sha256);
    t.diagnostic(`Full-search result: ${JSON.stringify({ sha256: payload.sha256, vmaf: payload.vmaf, parameters: payload.parameters, bytes: payload.bytes, candidates: candidates.length })}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(fs.existsSync(directory), false);
  }
});
