'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inventory } = require('../../scripts/build');
const { artifactRoot } = require('../helpers/plugin-paths');

test('isolated artifact runs beneath an ESM parent', t => {
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
    'create-discord-emoji-gif/scripts/node/mov-to-gif.js',
    'create-discord-emoji-gif/scripts/node/mov-to-gif-gifski.js',
    'harness-advisor/scripts/advisor-config.js',
    'harness-advisor/scripts/claude-advisor.js',
    'random-sampler/scripts/sample.mjs',
    'write-asd-ste100/scripts/extract-js-comments.js',
  ]) {
    const result = run(`skills/${cli}`, ['--help']);
    assert.equal(result.status, 0, `${cli}: ${result.stderr}`);
  }
  const sampler = run('skills/random-sampler/scripts/sample.mjs', ['--json'], '{"op":"integer","min":0,"maxExclusive":1}');
  assert.equal(sampler.status, 0, sampler.stderr);
  assert.equal(JSON.parse(sampler.stdout).result.value, 0);
  const preflight = run('skills/random-sampler/scripts/sample.mjs', ['--preflight', '--json']);
  assert.equal(preflight.status, 0, preflight.stderr);
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(root, 'claude-calls');
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(process.env.ADVISOR_INSTALL_CALLS, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] !== '--version') process.exit(99);
process.stdout.write('test-cli');
`, { mode: 0o755 });
  env.ADVISOR_INSTALL_CALLS = calls;
  env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const prompt = path.join(root, 'prompt'); fs.writeFileSync(prompt, 'preflight only');
  const removed = run('skills/harness-advisor/scripts/claude-advisor.js', ['--workspace=/tmp/review', '--help', '--json']);
  assert.equal(removed.status, 2, removed.stderr);
  assert.equal(removed.stdout, '');
  assert.equal(JSON.parse(removed.stderr).error.code, 'usage_error');
  assert.equal(JSON.parse(removed.stderr).error.condition, '--workspace is no longer supported; Harness Advisor uses executor-supplied evidence only.');
  assert.equal(fs.existsSync(calls), false);
  const advisor = run('skills/harness-advisor/scripts/claude-advisor.js', ['--native-absent', '--model', 'opus', '--reasoning-effort', 'high', '--prompt', prompt, '--preflight', '--json']);
  assert.equal(advisor.status, 0, advisor.stderr);
  assert.ok(JSON.parse(advisor.stdout).checks.includes('advisor_contract_readable_nonempty'));
  assert.equal(JSON.parse(advisor.stdout).status, 'ready');
  assert.equal(JSON.parse(advisor.stdout).runtimeControls, 'unverified');
  assert.deepEqual(JSON.parse(advisor.stdout).tools, []);
  assert.equal(Object.hasOwn(JSON.parse(advisor.stdout), 'workspace'), false);
  assert.equal(Object.hasOwn(JSON.parse(advisor.stdout), 'observations'), false);
  assert.equal(fs.readFileSync(calls, 'utf8'), '--version\n');
  for (const name of ['skills/write-asd-ste100/scripts/ste_check.py',
    'skills/write-asd-ste100/scripts/ste_source.py', 'skills/write-asd-ste100/package.json', 'skills/write-asd-ste100/package-lock.json']) assert.ok(fs.statSync(path.join(plugin, name)).isFile());
  assert.equal(fs.existsSync(path.join(plugin, 'skills/write-asd-ste100/node_modules')), false);
  // The comment helper runs as CommonJS beneath the ESM parent and reports its missing parser.
  const parser = run('skills/write-asd-ste100/scripts/extract-js-comments.js', ['--preflight', '--json']);
  assert.equal(parser.status, 2, parser.stderr);
  assert.equal(JSON.parse(parser.stderr).error.code, 'dependency_missing');
  const python = spawnSync('python3', [path.join(plugin, 'skills/write-asd-ste100/scripts/ste_check.py'), '--help'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
});
