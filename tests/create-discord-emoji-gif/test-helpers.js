'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFile } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const skillDir = path.join(repoRoot, 'plugins/harness/skills/create-discord-emoji-gif');

function temporaryDirectory(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function makeExecutable(file, contents) { fs.writeFileSync(file, contents, { mode: 0o755 }); }
function runEntrypoint(command, file, args = [], env = {}) {
  return spawnSync(command, [file, ...args], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024 });
}

module.exports = { repoRoot, skillDir, temporaryDirectory, makeExecutable, runEntrypoint };

function assertPublishedResult(payload, backend, input, output, maxBytes) {
  assert.equal(payload.status, 'verified');
  assert.equal(payload.loop, 'infinite');
  assert.ok(payload.checks.some(check => /loop is infinite/.test(check.name) && check.status === 'pass'));
  assert.equal(payload.backend, backend);
  assert.equal(payload.input, input);
  assert.equal(payload.output, output);
  assert.equal(payload.dimensions, '64x64');
  assert.equal(payload.width, 64);
  assert.equal(payload.height, 64);
  assert.equal(typeof payload.bytes, 'number');
  assert.ok(Number.isInteger(payload.bytes));
  assert.match(payload.sha256, /^[0-9a-f]{64}$/);
  assert.match(payload.vmaf, /^-?[0-9]+(?:\.[0-9]+)?$/);
  assert.ok(Array.isArray(payload.checks));
  assert.ok(payload.checks.length > 0);
  assert.ok(payload.checks.every(check => typeof check.name === 'string' && check.status === 'pass'));
  assert.equal(fs.existsSync(output), true);
  assert.ok(payload.bytes < maxBytes);
}

function runEntrypointAsync(command, file, args = [], env = {}) {
  return new Promise(resolve => {
    execFile(command, [file, ...args], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, signal: error?.signal, error, stdout, stderr });
    });
  });
}

// Limit only the test search. Preparation, encoders, scoring, and publication remain real.
function narrowSearch(directory, colors = [4, 5]) {
  const preload = path.join(directory, 'narrow.cjs');
  fs.writeFileSync(preload, `
const { ProcessManager } = require(${JSON.stringify(path.join(skillDir, 'scripts/node/process-manager'))});
const original = ProcessManager.prototype.runOldestBounded;
ProcessManager.prototype.runOldestBounded = function(items, jobs, worker) {
  return original.call(this, items.filter(item => !item.colors || ${JSON.stringify(colors)}.includes(item.colors)), jobs, worker);
};
`);
  return preload;
}

Object.assign(module.exports, { assertPublishedResult, runEntrypointAsync, narrowSearch });
