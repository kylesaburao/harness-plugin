'use strict';
// Run directly with the qualified Node binary. This deliberately avoids modern
// test-runner/preload helpers that are outside installed CLI runtime contracts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const plugin = require('../helpers/plugin-paths').artifactPath('');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-floor-')));
const env = { ...process.env, HOME: home, NODE_OPTIONS: '', NODE_PATH: '' };
function run(relative, args, input = '') {
  const result = spawnSync(process.execPath, [path.join(plugin, relative), ...args], { cwd: home, env, input, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  return result;
}
function success(relative, args, input) {
  const result = run(relative, args, input);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function qualifyBackup() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major > 22 || (major === 22 && minor >= 12), 'Backup requires Node >=22.12.0');
  fs.writeFileSync(path.join(home, 'package.json'), '{"type":"module"}\n');
  const skill = path.join(home, 'backup installé');
  fs.cpSync(path.join(plugin, 'skills/back-up-directories'), skill, {
    recursive: true,
    filter: source => path.basename(source) !== 'node_modules',
  });
  const backup = path.join(skill, 'scripts/backup.js');
  const execute = (args, input = '') => {
    const result = spawnSync(process.execPath, [backup, ...args], { cwd: home, env, input, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    return result;
  };
  const missing = execute(['--preflight', '--json']);
  assert.equal(missing.status, 2, missing.stderr);
  // Node 22.12 may emit its require(esm) warning separately from the JSON error.
  const diagnostic = JSON.parse(missing.stderr.split('\n').find(line => line.startsWith('{')));
  assert.equal(diagnostic.error.code, 'dependency_missing');
  assert.ok(diagnostic.error.remedy.includes(skill));
  const npmEnv = { ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    npm_config_cache: path.join(home, 'npm-cache') };
  const installed = spawnSync('npm', ['ci', '--omit=dev', '--prefix', skill], { cwd: home, env: npmEnv, encoding: 'utf8', timeout: 120000 });
  assert.ifError(installed.error);
  assert.equal(installed.status, 0, installed.stderr);
  for (const name of ['source', 'target']) fs.mkdirSync(path.join(home, name));
  fs.writeFileSync(path.join(home, 'source/hello.txt'), 'runtime floor backup\n');
  const config = path.join(home, 'backup.json');
  fs.writeFileSync(config, JSON.stringify({ sourceDirectory: './source', outputDirectory: './output', targetDirectories: ['./target'] }));
  const preflight = execute(['--preflight', '--json', config]);
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.equal(JSON.parse(preflight.stdout).outputDirectoryCreated, true);
  const completed = execute(['--json', config], 'y\n');
  assert.equal(completed.status, 0, completed.stderr);
  const result = JSON.parse(completed.stdout).result;
  assert.equal(result.archive, null);
  assert.equal(result.stagingRemoved, true);
  assert.equal(result.copies.length, 1);
  assert.equal(fs.statSync(result.copies[0]).size, result.bytes);
  const contents = spawnSync('unzip', ['-p', result.copies[0], 'hello.txt'], { encoding: 'utf8' });
  assert.equal(contents.status, 0, contents.stderr);
  assert.equal(contents.stdout, 'runtime floor backup\n');
  assert.deepEqual(fs.readdirSync(path.join(home, 'output')), []);
  process.stdout.write(`Backup runtime floor passed on Node ${process.versions.node}: isolated generated plan, missing dependency, lockfile install, preflight output creation, real archive and replication.\n`);
}
try {
  if (process.argv.includes('--backup')) qualifyBackup();
  else {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'This Stage 2 qualification requires Node >=22');
  const sampler = 'skills/random-sampler/scripts/sample.mjs';
  success(sampler, ['--help']);
  assert.equal(JSON.parse(success(sampler, ['--preflight', '--json'])).preflight.status, 'passed');
  for (const [input, expected] of [
    ['{"op":"integer","min":-2,"maxExclusive":-1}', '{"op":"integer","value":-2}\n'],
    ['{"op":"choice","values":[9007199254740993]}', '{"op":"choice","index":0,"value":9007199254740993}\n'],
    ['{"op":"sample","values":[1e999],"count":0}', '{"op":"sample","indices":[],"values":[]}\n'],
    ['{"op":"shuffle","values":[1e999]}', '{"op":"shuffle","indices":[0],"values":[1e999]}\n'],
  ]) assert.equal(success(sampler, ['--json'], input), expected);
  assert.equal(typeof JSON.parse(success(sampler, ['--json'], '{"op":"boolean"}')).value, 'boolean');
  const invalid = run(sampler, ['--json'], '{"op":"integer","min":9007199254740993,"maxExclusive":9007199254740994}');
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_INTEGER_RANGE');
  const config = 'skills/harness-advisor/scripts/advisor-config.js';
  const initial = JSON.parse(success(config, ['resolve', '--host', 'codex', '--primary', 'sol', '--json']));
  assert.equal(initial.route_source, 'built-in');
  success(config, ['set-route', '--host', 'codex', '--primary', 'sol', '--advisor', 'terra', '--reasoning-effort', 'medium', '--json']);
  const selected = JSON.parse(success(config, ['resolve', '--host', 'codex', '--primary', 'sol', '--json']));
  assert.equal(selected.advisor_family, 'terra'); assert.equal(selected.reasoning_effort, 'medium'); assert.equal(selected.route_source, 'user-route');
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(home, 'claude-calls');
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ADVISOR_FLOOR_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === '--version') process.stdout.write('floor-fixture');
else {
  const assert = require('node:assert/strict');
  const option = name => args[args.indexOf(name) + 1];
  assert.equal(option('--tools'), '');
  assert.equal(option('--disallowedTools'), 'mcp__*');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(option('--mcp-config'), '{"mcpServers":{}}');
  assert.equal(option('--output-format'), 'json');
  assert.equal(option('--system-prompt'), fs.readFileSync(process.env.ADVISOR_FLOOR_CONTRACT, 'utf8'));
  assert.equal(fs.readFileSync(0, 'utf8'), 'Supplied evidence only\\n');
  process.stdout.write(JSON.stringify({ result: 'Floor advice.' }));
}
`, { mode: 0o755 });
  env.PATH = bin;
  env.ADVISOR_FLOOR_CALLS = calls;
  env.ADVISOR_FLOOR_CONTRACT = path.join(plugin, 'skills/harness-advisor/references/contract.md');
  const prompt = path.join(home, 'prompt'); fs.writeFileSync(prompt, 'Supplied evidence only\n');
  const adapter = 'skills/harness-advisor/scripts/claude-advisor.js';
  const removed = run(adapter, ['--workspace', home, '--help', '--json']);
  assert.equal(removed.status, 2, removed.stderr);
  assert.equal(removed.stdout, '');
  assert.equal(JSON.parse(removed.stderr).error.code, 'usage_error');
  assert.equal(JSON.parse(removed.stderr).error.condition, '--workspace is no longer supported; Harness Advisor uses executor-supplied evidence only.');
  assert.equal(fs.existsSync(calls), false);
  const args = ['--native-absent', '--model', 'opus', '--reasoning-effort', 'high', '--prompt', prompt, '--json'];
  const preflight = JSON.parse(success(adapter, [...args, '--preflight']));
  assert.equal(preflight.status, 'preflight_passed');
  assert.ok(preflight.checks.includes('advisor_contract_readable_nonempty'));
  const consulted = JSON.parse(success(adapter, args));
  assert.equal(consulted.status, 'consulted');
  assert.equal(consulted.advice, 'Floor advice.');
  assert.equal(consulted.usage, null);
  assert.equal(consulted.model_usage, null);
  for (const report of [preflight, consulted]) {
    assert.equal(report.model, 'opus');
    assert.equal(report.reasoning_effort, 'high');
    assert.equal(report.mechanism, 'claude-cli');
    assert.equal(report.context_mode, 'fresh');
    assert.equal(report.runtime_controls, 'unverified');
    assert.deepEqual(report.tools, []);
    assert.equal(Object.hasOwn(report, 'workspace'), false);
    assert.equal(Object.hasOwn(report, 'observations'), false);
  }
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 3);
  process.stdout.write(`Runtime floor passed on Node ${process.versions.node}: native ESM, preserved numeric tokens, routing mutations, bundled-contract preflight, tool-free consultation and removed-flag rejection.\n`);
  }
} finally { fs.rmSync(home, { recursive: true, force: true }); }
