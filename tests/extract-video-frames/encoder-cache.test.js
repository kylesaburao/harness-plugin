'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const subject = require(require('../helpers/plugin-paths').artifactPath('skills/extract-video-frames/scripts/extract-video-frames.js'));

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-video-frames-cache-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// A fake compiler toolchain: `swiftc --version` reports a fixed version, compilation
// writes a stand-in helper that embeds the source text, and the helper self-check
// succeeds only for files that exist and do not contain `broken`.
function fakeManager({ version = { code: 0, stdout: 'Fake Swift version 1.0\nTarget: arm64-apple-macosx26.0\n', stderr: '' }, brokenOutput = false } = {}) {
  const calls = [];
  return {
    calls,
    compiles: () => calls.filter(call => call.command === 'swiftc' && call.args[0] !== '--version').length,
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === 'swiftc' && args[0] === '--version') return { signal: null, ...version };
      if (command === 'swiftc') {
        fs.writeFileSync(args[2], `#!/bin/sh\n# ${brokenOutput ? 'broken' : 'ok'} ${fs.readFileSync(args[0], 'utf8')}\n`, { mode: 0o755 });
        return { code: 0, signal: null, stdout: '', stderr: '' };
      }
      if (args[0] === '--preflight') {
        const ready = fs.existsSync(command) && !fs.readFileSync(command, 'utf8').includes('broken');
        return { code: ready ? 0 : 1, signal: null, stdout: ready ? 'READY\n' : '', stderr: '' };
      }
      throw new Error(`unexpected command ${command}`);
    },
  };
}

function fixture(t) {
  const root = temporaryRoot(t);
  const source = path.join(root, 'tiff-to-heic.swift');
  fs.writeFileSync(source, 'print("v1")\n');
  return { root, source, cacheRoot: path.join(root, 'home', '.harness-plugin', 'extract-video-frames', 'encoder') };
}

function runDirectory(root) {
  return fs.mkdtempSync(path.join(root, 'extract-video-frames-encoder-'));
}

function state() {
  return { commands: { swiftc: 'swiftc' } };
}

function entries(cacheRoot) {
  return fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot).sort() : [];
}

test('two consecutive preparations with the same compiler compile the helper once', async t => {
  const { root, source, cacheRoot } = fixture(t);
  const manager = fakeManager();
  const first = state();
  const firstRun = runDirectory(root);
  await subject.compileEncoder(manager, first, firstRun, { root: cacheRoot, source });
  assert.equal(first.commands.encoder, path.join(firstRun, 'tiff-to-heic'));
  assert.equal(first.encoderDirectory, firstRun);
  const [key] = entries(cacheRoot);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.deepEqual(entries(cacheRoot), [key], 'no staging directory remains');
  const manifest = JSON.parse(fs.readFileSync(path.join(cacheRoot, key, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.key, key);
  assert.equal(manifest.encoder.bytes, fs.statSync(path.join(cacheRoot, key, 'tiff-to-heic')).size);

  const second = state();
  const secondRun = runDirectory(root);
  await subject.compileEncoder(manager, second, secondRun, { root: cacheRoot, source });
  assert.equal(manager.compiles(), 1);
  assert.equal(second.commands.encoder, path.join(cacheRoot, key, 'tiff-to-heic'));
  assert.equal(second.encoderDirectory, secondRun, 'per-run scratch files still use the invocation directory');
  assert.deepEqual(fs.readdirSync(secondRun), []);
});

test('a changed helper source or compiler version recompiles under a new key', async t => {
  const { root, source, cacheRoot } = fixture(t);
  const manager = fakeManager();
  await subject.compileEncoder(manager, state(), runDirectory(root), { root: cacheRoot, source });
  const [original] = entries(cacheRoot);
  fs.writeFileSync(source, 'print("v2")\n');
  const changed = state();
  await subject.compileEncoder(manager, changed, runDirectory(root), { root: cacheRoot, source });
  assert.equal(manager.compiles(), 2);
  assert.equal(entries(cacheRoot).length, 2);
  assert.ok(entries(cacheRoot).includes(original), 'the previous entry is never pruned');

  const upgraded = fakeManager({ version: { code: 0, stdout: 'Fake Swift version 2.0\n', stderr: '' } });
  await subject.compileEncoder(upgraded, state(), runDirectory(root), { root: cacheRoot, source });
  assert.equal(upgraded.compiles(), 1);
  assert.equal(entries(cacheRoot).length, 3);
});

test('an unwritable cache root falls back to the per-run helper without failing', async t => {
  const { root, source } = fixture(t);
  const blocker = path.join(root, 'home-is-a-file');
  fs.writeFileSync(blocker, 'not a directory');
  const cacheRoot = path.join(blocker, '.harness-plugin', 'extract-video-frames', 'encoder');
  const manager = fakeManager();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = state();
    const run = runDirectory(root);
    await subject.compileEncoder(manager, current, run, { root: cacheRoot, source });
    assert.equal(current.commands.encoder, path.join(run, 'tiff-to-heic'));
    assert.ok(fs.existsSync(current.commands.encoder));
  }
  assert.equal(manager.compiles(), 2);
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'not a directory');
});

test('a read-only cache root falls back to the per-run helper', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const { root, source, cacheRoot } = fixture(t);
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.chmodSync(cacheRoot, 0o555);
  t.after(() => { try { fs.chmodSync(cacheRoot, 0o755); } catch {} });
  const current = state();
  const run = runDirectory(root);
  await subject.compileEncoder(fakeManager(), current, run, { root: cacheRoot, source });
  assert.equal(current.commands.encoder, path.join(run, 'tiff-to-heic'));
  assert.deepEqual(entries(cacheRoot), []);
});

test('an invalid cached entry is not reused or replaced', async t => {
  const { root, source, cacheRoot } = fixture(t);
  const manager = fakeManager();
  await subject.compileEncoder(manager, state(), runDirectory(root), { root: cacheRoot, source });
  const [key] = entries(cacheRoot);
  const cached = path.join(cacheRoot, key, 'tiff-to-heic');
  fs.appendFileSync(cached, '# tampered\n');
  const tampered = fs.readFileSync(cached, 'utf8');
  const current = state();
  const run = runDirectory(root);
  await subject.compileEncoder(manager, current, run, { root: cacheRoot, source });
  assert.equal(manager.compiles(), 2);
  assert.equal(current.commands.encoder, path.join(run, 'tiff-to-heic'));
  assert.equal(fs.readFileSync(cached, 'utf8'), tampered);
  assert.deepEqual(entries(cacheRoot), [key]);
});

test('an unusable compiler version or failed helper self-check never populates the cache', async t => {
  const { root, source, cacheRoot } = fixture(t);
  for (const manager of [
    fakeManager({ version: { code: 1, stdout: '', stderr: 'no version' } }),
    fakeManager({ version: { code: 0, stdout: '', stderr: '' } }),
    fakeManager({ brokenOutput: true }),
  ]) {
    const current = state();
    const run = runDirectory(root);
    await subject.compileEncoder(manager, current, run, { root: cacheRoot, source });
    assert.equal(manager.compiles(), 1);
    assert.equal(current.commands.encoder, path.join(run, 'tiff-to-heic'));
  }
  assert.deepEqual(entries(cacheRoot), []);
});

test('a compilation failure still reports the stable diagnosis', async t => {
  const { root, source, cacheRoot } = fixture(t);
  const manager = { run: async (command, args) => args[0] === '--version' ? { code: 0, signal: null, stdout: 'Fake Swift\n', stderr: '' } : { code: 1, signal: null, stdout: '', stderr: 'compile sentinel' } };
  await assert.rejects(subject.compileEncoder(manager, state(), runDirectory(root), { root: cacheRoot, source }), error => error.code === 'heic_encoder_unavailable' && error.exitCode === 2 && error.condition.includes('compile sentinel'));
  assert.deepEqual(entries(cacheRoot), []);
});
