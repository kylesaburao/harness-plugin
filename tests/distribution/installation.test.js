'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inventory } = require('../../scripts/build');
const { artifactRoot } = require('../helpers/plugin-paths');

test('isolated artifact runs beneath an ESM parent and installs backup dependencies locally', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness installé ')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  const plugin = path.join(root, 'plugin with spaces');
  for (const [name, entry] of inventory(artifactRoot, { overlays: true })) {
    const destination = path.join(plugin, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(entry.absolute, destination); fs.chmodSync(destination, entry.mode);
  }
  const env = { ...process.env, HOME: path.join(root, 'home'), NODE_PATH: '', NODE_OPTIONS: '', npm_config_cache: path.join(root, 'npm-cache') };
  fs.mkdirSync(env.HOME);
  const run = (relative, args, input = '') => spawnSync(process.execPath, [path.join(plugin, relative), ...args], { cwd: root, env, input, encoding: 'utf8', timeout: 30000 });
  for (const cli of [
    'back-up-directories/scripts/backup.js',
    'create-discord-emoji-gif/scripts/node/mov-to-gif.js',
    'create-discord-emoji-gif/scripts/node/mov-to-gif-gifski.js',
    'extract-video-frames/scripts/extract-video-frames.js',
    'harness-advisor/scripts/advisor-config.js',
    'harness-advisor/scripts/claude-advisor.js',
    'random-sampler/scripts/sample.mjs',
    'wake-desktop/scripts/manage-targets.js',
    'wake-desktop/scripts/wake-desktop.js',
  ]) {
    const result = run(`skills/${cli}`, ['--help']);
    assert.equal(result.status, 0, `${cli}: ${result.stderr}`);
  }
  const sampler = run('skills/random-sampler/scripts/sample.mjs', ['--json'], '{"op":"integer","min":0,"maxExclusive":1}');
  assert.equal(sampler.status, 0, sampler.stderr);
  assert.equal(JSON.parse(sampler.stdout).value, 0);
  const preflight = run('skills/random-sampler/scripts/sample.mjs', ['--preflight', '--json']);
  assert.equal(preflight.status, 0, preflight.stderr);
  const backup = 'skills/back-up-directories/scripts/backup.js';
  const missing = run(backup, ['--preflight', '--json']);
  assert.equal(missing.status, 2, missing.stderr);
  assert.equal(JSON.parse(missing.stderr).error.code, 'dependency_missing');
  assert.ok(JSON.parse(missing.stderr).error.remedy.includes(path.join(plugin, 'skills/back-up-directories')));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n[ "$1" = "--version" ] || exit 99\necho test-cli\n', { mode: 0o755 });
  env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const prompt = path.join(root, 'prompt'); fs.writeFileSync(prompt, 'preflight only');
  const advisor = run('skills/harness-advisor/scripts/claude-advisor.js', ['--native-absent', '--model', 'opus', '--reasoning-effort', 'high', '--prompt', prompt, '--preflight', '--json']);
  assert.equal(advisor.status, 0, advisor.stderr);
  assert.ok(JSON.parse(advisor.stdout).checks.includes('advisor_contract_readable_nonempty'));
  assert.equal(JSON.parse(advisor.stdout).runtime_controls, 'unverified');
  for (const name of ['skills/extract-video-frames/scripts/tiff-to-heic.swift', 'skills/write-asd-ste100/scripts/ste_check.py']) assert.ok(fs.statSync(path.join(plugin, name)).isFile());
  const python = spawnSync('python3', [path.join(plugin, 'skills/write-asd-ste100/scripts/ste_check.py'), '--help'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  const install = spawnSync('npm', ['ci', '--omit=dev', '--prefix', path.join(plugin, 'skills/back-up-directories')], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(install.status, 0, install.stderr);
  fs.mkdirSync(path.join(root, 'source')); fs.writeFileSync(path.join(root, 'source/hello.txt'), 'isolated backup\n');
  fs.mkdirSync(path.join(root, 'target'));
  const config = path.join(root, 'backup.json');
  fs.writeFileSync(config, JSON.stringify({ sourceDirectory: './source', outputDirectory: './output', targetDirectories: ['./target'] }));
  const result = run(backup, ['--json', config], 'y\n');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.readdirSync(path.join(root, 'target')).some(name => name.endsWith('.zip')));
});
