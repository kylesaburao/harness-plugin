'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { skillDir, temporaryDirectory, runEntrypoint } = require('./test-helpers');

const SCRIPT = path.join(skillDir, 'scripts/node/mov-to-gif-gifski.js');
const ENV = {
  MAX_BYTES: '1000000',
  GIF_SIZE: '64',
  MIN_FPS: '8',
  MAX_FPS: '8',
  MIN_QUALITY: '80',
  MAX_QUALITY: '80',
  JOBS: '1',
};

function skipUnlessReady(t) {
  const preflight = runEntrypoint(process.execPath, SCRIPT, ['--preflight', '--json']);
  if (preflight.status !== 0) {
    const report = JSON.parse(preflight.stderr);
    const missing = report.error.failures?.[0];
    t.skip(`environment not ready: ${missing ? missing.condition : preflight.stderr}`);
    return false;
  }
  return true;
}

test('the Node gifski entrypoint reports a metadata report that describes the published file', { timeout: 120000 }, t => {
  if (!skipUnlessReady(t)) return;
  const directory = temporaryDirectory('result-report.');
  const input = path.join(directory, 'input.mkv');
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=8:duration=0.5', '-an', '-c:v', 'ffv1', input], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  try {
    const textOutput = path.join(directory, 'text.gif');
    const textResult = runEntrypoint(process.execPath, SCRIPT, [input, textOutput], ENV);
    assert.equal(textResult.status, 0, `${textResult.stdout}\n${textResult.stderr}`);
    const lines = textResult.stdout.split('\n');
    assert.match(lines[0], /^Selected: 8 FPS, quality 80, motion quality 80, lossy quality 80, VMAF /);
    assert.equal(lines[1], `Output: ${textOutput}`);
    assert.match(lines[2], /^Verified: 64x64, \d+ frames, [0-9.]+s, \d+ bytes$/);
    assert.match(textResult.stdout, /^Report: mov-to-gif-gifski\.js, gifski backend$/m);
    assert.match(textResult.stdout, /^  sha256      [0-9a-f]{64}$/m);
    const checkLines = lines.filter(line => line.startsWith('Check: '));
    assert.ok(checkLines.length >= 5);
    assert.ok(checkLines.every(line => line.startsWith('Check: PASS')));
    assert.match(textResult.stdout, /^Verification: complete\./m);

    const jsonOutput = path.join(directory, 'json.gif');
    const jsonResult = runEntrypoint(process.execPath, SCRIPT, ['--json', input, jsonOutput], ENV);
    assert.equal(jsonResult.status, 0, `${jsonResult.stdout}\n${jsonResult.stderr}`);
    const { result } = JSON.parse(jsonResult.stdout);
    const bytesOnDisk = fs.statSync(jsonOutput).size;
    const digestOnDisk = crypto.createHash('sha256').update(fs.readFileSync(jsonOutput)).digest('hex');
    assert.equal(result.bytes, bytesOnDisk);
    assert.equal(result.sha256, digestOnDisk);
    assert.equal(result.width, 64);
    assert.equal(result.height, 64);
    assert.equal(result.output, jsonOutput);
    assert.equal(result.headroomBytes, result.maxBytes - result.bytes);
    assert.ok(result.checks.every(check => check.status === 'pass'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
