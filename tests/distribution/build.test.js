'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { build, inventory, compare } = require('../../scripts/build');
const { validate, validateTracked } = require('../../scripts/validate-dist');
const { repositoryRoot } = require('../helpers/plugin-paths');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(repositoryRoot, 'src'), path.join(root, 'src'), { recursive: true });
  for (const name of ['package.json', 'tsconfig.json']) fs.copyFileSync(path.join(repositoryRoot, name), path.join(root, name));
  fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'));
  return root;
}
function write(root, name, value) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), value); }
function snapshot(root) {
  return [...inventory(path.join(root, 'dist/harness'), { overlays: true })].map(([name, entry]) => [name, entry.mode, fs.readFileSync(entry.absolute).toString('base64')]);
}

test('fresh assembly is deterministic and includes every resource and executable mode', t => {
  const root = fixture(t);
  build(root);
  const first = snapshot(root);
  build(root);
  assert.deepEqual(snapshot(root), first);
  build(root, true);
  assert.ok(validate(root) > 0);
  for (const name of [
    '.claude-plugin/plugin.json', '.codex-plugin/plugin.json',
    'skills/harness-advisor/references/contract.md',
    'skills/extract-video-frames/scripts/tiff-to-heic.swift',
    'skills/write-asd-ste100/scripts/ste_check.py',
    'skills/back-up-directories/package-lock.json',
    'skills/back-up-directories/agents/openai.yaml',
  ]) assert.ok(fs.existsSync(path.join(root, 'dist/harness', name)), name);
  assert.ok(first.some(([name]) => name.endsWith('.jsonl')));
  for (const [name, source] of inventory(path.join(root, 'src/harness'))) {
    if (!fs.readFileSync(source.absolute).subarray(0, 2).equals(Buffer.from('#!'))) continue;
    const installed = path.join(root, 'dist/harness', name.replace(/\.mts$/, '.mjs').replace(/\.ts$/, '.js'));
    assert.equal(fs.readFileSync(installed).subarray(0, 2).toString(), '#!');
    assert.equal(fs.statSync(installed).mode & 0o111 ? 0o755 : 0o644, source.mode);
  }
});

test('check detects content, missing, extra and mode drift without repair', t => {
  const root = fixture(t); build(root);
  const file = path.join(root, 'dist/harness/shared/node/media-result.js');
  for (const alter of [
    () => fs.appendFileSync(file, '\n// drift\n'),
    () => fs.unlinkSync(file),
    () => write(root, 'dist/harness/extra.md', 'stale'),
    () => fs.chmodSync(file, 0o755),
  ]) {
    alter(); const before = snapshot(root);
    assert.throws(() => build(root, true), /Distribution is stale/);
    assert.deepEqual(snapshot(root), before);
    build(root);
  }
});

test('rename and deletion remove stale output while preserving opaque dependency overlays', t => {
  const root = fixture(t);
  write(root, 'src/harness/shared/node/temporary.ts', 'export const value = 1;\n');
  build(root);
  const overlay = 'dist/harness/skills/back-up-directories/node_modules';
  write(root, `${overlay}/keep`, 'dependency');
  fs.symlinkSync('/absent/opaque-dependency', path.join(root, overlay, 'link'));
  write(root, 'dist/harness/skills/write-asd-ste100/scripts/__pycache__/keep.pyc', 'cache');
  fs.renameSync(path.join(root, 'src/harness/shared/node/temporary.ts'), path.join(root, 'src/harness/shared/node/renamed.ts'));
  build(root);
  assert.equal(fs.existsSync(path.join(root, 'dist/harness/shared/node/temporary.js')), false);
  assert.equal(fs.readFileSync(path.join(root, overlay, 'keep'), 'utf8'), 'dependency');
  assert.equal(fs.lstatSync(path.join(root, overlay, 'link')).isSymbolicLink(), true);
  fs.unlinkSync(path.join(root, 'src/harness/shared/node/renamed.ts')); build(root);
  assert.equal(fs.existsSync(path.join(root, 'dist/harness/shared/node/renamed.js')), false);
  build(root, true);
});

test('type errors, output collisions and escaping links cannot publish', t => {
  const root = fixture(t); build(root); const before = snapshot(root);
  const bad = path.join(root, 'src/harness/shared/node/bad.ts');
  fs.writeFileSync(bad, 'export const value: number = "bad";');
  assert.throws(() => build(root), /Compilation failed/); assert.deepEqual(snapshot(root), before); fs.unlinkSync(bad);
  const collision = path.join(root, 'src/harness/shared/node/resolve-command.js');
  fs.mkdirSync(collision);
  fs.writeFileSync(path.join(collision, 'nested.md'), 'a directory cannot replace emitted JavaScript');
  assert.throws(() => build(root), /EEXIST|EISDIR|ENOTDIR/); assert.deepEqual(snapshot(root), before); fs.rmSync(collision, { recursive: true });
  fs.writeFileSync(collision, 'module.exports = {};');
  assert.throws(() => build(root), /Unclassified/); assert.deepEqual(snapshot(root), before); fs.unlinkSync(collision);
  fs.symlinkSync('/etc/passwd', bad);
  assert.throws(() => build(root), /Symlink/); assert.deepEqual(snapshot(root), before); fs.unlinkSync(bad);
  write(root, 'src/harness/unsupported.bin', 'bad');
  assert.throws(() => build(root), /Unclassified/); assert.deepEqual(snapshot(root), before);
});

test('source versions are rejected, canonical version is injected, and forbidden files fail', t => {
  const root = fixture(t); build(root);
  const template = path.join(root, 'src/harness/.claude-plugin/plugin.json');
  const original = fs.readFileSync(template, 'utf8');
  fs.writeFileSync(template, JSON.stringify({ ...JSON.parse(original), version: '9.0.0' }));
  assert.throws(() => build(root), /must not own a version/);
  fs.writeFileSync(template, original);
  const pkg = path.join(root, 'src/harness/package.json');
  fs.writeFileSync(pkg, JSON.stringify({ ...JSON.parse(fs.readFileSync(pkg)), version: '4.2.3' }));
  build(root);
  for (const host of ['.claude-plugin', '.codex-plugin']) assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'dist/harness', host, 'plugin.json'))).version, '4.2.3');
  write(root, 'dist/harness/tests/forbidden.js', 'bad');
  assert.throws(() => validate(root), /Unexpected JavaScript|Forbidden/);
  assert.throws(() => build(root), /Unexpected JavaScript|Forbidden/);
});

test('tracked validation detects missing index entries, executable changes and tracked dependencies', t => {
  const root = fixture(t); build(root);
  execFileSync('git', ['init', '-q', root]);
  const files = inventory(path.join(root, 'dist/harness'));
  assert.throws(() => validateTracked(root, files), /missing from index/);
  execFileSync('git', ['add', 'dist'], { cwd: root }); validateTracked(root, files);
  execFileSync('git', ['update-index', '--chmod=+x', 'dist/harness/package.json'], { cwd: root });
  assert.throws(() => validateTracked(root, files), /wrong executable bit/);
  execFileSync('git', ['update-index', '--chmod=-x', 'dist/harness/package.json'], { cwd: root });
  write(root, 'dist/harness/skills/back-up-directories/node_modules/bad.js', 'bad');
  execFileSync('git', ['add', 'dist'], { cwd: root });
  assert.throws(() => validateTracked(root, files), /Forbidden\/stale tracked artifact/);
});
