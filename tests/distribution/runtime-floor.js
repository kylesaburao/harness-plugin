'use strict';
// Run directly with the qualified Node binary. This deliberately avoids modern
// test-runner/preload helpers that are outside installed CLI runtime contracts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const plugin = require('../helpers/plugin-paths').artifactPath('');
// The declared floor is the repository runtime major in .nvmrc.
const FLOOR = Number.parseInt(fs.readFileSync(path.join(__dirname, '../../.nvmrc'), 'utf8'), 10);
assert.ok(Number.isInteger(FLOOR), '.nvmrc must start with the Node.js major version');
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
// One-line JSON error envelope with empty stdout: the unified CLI contract.
function failure(result, status, code) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.endsWith('\n'), true);
  assert.equal(result.stderr.trimEnd().includes('\n'), false, result.stderr);
  const { error } = JSON.parse(result.stderr);
  assert.equal(error.code, code, result.stderr);
  for (const field of ['condition', 'remedy']) assert.equal(typeof error[field], 'string');
  return error;
}
// An isolated PATH that holds no media tools, so every runner reports the same failures.
function withoutTools() {
  const bin = path.join(home, 'empty-bin');
  fs.mkdirSync(bin, { recursive: true });
  return { ...env, PATH: bin };
}
function runWith(environment, relative, args) {
  const result = spawnSync(process.execPath, [path.join(plugin, relative), ...args], { cwd: home, env: environment, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  return result;
}
function qualifyGif() {
  // Reaching preflight means the Node floor check passed; no conversion starts.
  for (const [script, backend] of [['mov-to-gif-gifski.js', 'gifski'], ['mov-to-gif.js', 'gifsicle']]) {
    const relative = `skills/create-discord-emoji-gif/scripts/node/${script}`;
    assert.match(success(relative, ['--help']), /^Usage: /);
    failure(run(relative, ['--bogus', '--json']), 2, 'usage_error');
    const missing = failure(runWith(withoutTools(), relative, ['--preflight', '--json']), 2, 'preflight_failed');
    for (const entry of missing.failures) {
      assert.equal(entry.code, 'command_missing');
      for (const field of ['condition', 'remedy']) assert.equal(typeof entry[field], 'string');
    }
    assert.deepEqual(missing.failures.map(entry => entry.condition),
      ['ffmpeg', 'ffprobe', backend].map(name => `required command not found: ${name}`));
  }
  process.stdout.write(`GIF runtime floor passed on Node ${process.versions.node}: help, usage error and missing-tool preflight for both converters.\n`);
}
function qualifySteComments() {
  // Only the JavaScript-family comment helper: no ASD reference bundle is needed.
  fs.writeFileSync(path.join(home, 'package.json'), '{"type":"module"}\n');
  const skill = path.join(home, 'writer installé');
  fs.cpSync(path.join(plugin, 'skills/write-asd-ste100'), skill, {
    recursive: true,
    filter: source => !['node_modules', '__pycache__'].includes(path.basename(source)),
  });
  const helper = path.join(skill, 'scripts/extract-js-comments.js');
  const execute = (args, input = '') => {
    const result = spawnSync(process.execPath, [helper, ...args], { cwd: home, env, input, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    return result;
  };
  assert.match(execute(['--help']).stdout, /^Usage: /);
  failure(execute(['--bogus', '--json']), 2, 'usage_error');
  const missing = failure(execute(['--preflight', '--json']), 2, 'dependency_missing');
  assert.ok(missing.remedy.includes(path.join(skill, 'package-lock.json')), missing.remedy);
  const npmEnv = { ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    npm_config_cache: path.join(home, 'npm-cache') };
  // The remedy installs from the copied skill's lockfile into ~/.harness-plugin/write-asd-ste100.
  const installed = spawnSync('sh', ['-c', missing.remedy], { cwd: home, env: npmEnv, encoding: 'utf8', timeout: 120000 });
  assert.ifError(installed.error);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(fs.existsSync(path.join(skill, 'node_modules')), false);
  const ready = JSON.parse(execute(['--preflight', '--json']).stdout);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.dependencyRoot, path.join(home, '.harness-plugin/write-asd-ste100'));
  const profile = overrides => ({ typescript: false, jsx: false, sourceType: 'unambiguous', declaration: false,
    disallowAmbiguousJsxLike: false, ...overrides });
  const files = [
    { profile: profile(), text: "const s = '// no 😀'; /* yes */ x / 2; // yes\n" },
    { profile: profile({ typescript: true }), text: 'const x = <number>y; // yes\nlet t = `${/* yes */ 1} // no`;\n' },
    { profile: profile({ typescript: true, jsx: true }), text: 'const e = <a>// no {/* yes */}</a>;\n' },
    { profile: profile({ typescript: true, sourceType: 'module', disallowAmbiguousJsxLike: true }), text: 'const x = <number>y;\n' },
  ].map((file, id) => ({ id, path: `input-${id}`, ...file }));
  const extracted = execute(['--json'], JSON.stringify({ protocolVersion: 1, files }));
  assert.equal(extracted.status, 0, extracted.stderr);
  const { result } = JSON.parse(extracted.stdout);
  assert.equal(result.offsetEncoding, 'utf16');
  assert.deepEqual(result.files.slice(0, 3).map((file, index) =>
    file.comments.map(comment => files[index].text.slice(comment.start, comment.end))),
    [['/* yes */', '// yes'], ['// yes', '/* yes */'], ['/* yes */']]);
  assert.equal(result.files[3].error.reason, 'ReservedTypeAssertion');
  process.stdout.write(`ASD-STE100 comment helper runtime floor passed on Node ${process.versions.node}: isolated ESM parent, missing dependency, user-level lockfile install, JavaScript, TypeScript and TSX extraction, and a structured parse error.\n`);
}
const MODES = new Set(['--gif', '--ste-comments']);
const selected = process.argv.slice(2);
if (selected.length > 1 || (selected.length === 1 && !MODES.has(selected[0]))) {
  process.stderr.write(`Usage: runtime-floor.js [${[...MODES].join('|')}]\n`);
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(2);
}
const mode = selected[0];
try {
  assert.ok(Number(process.versions.node.split('.')[0]) >= FLOOR, `Runtime floor qualification requires Node >=${FLOOR}.0.0`);
  if (mode === '--gif') qualifyGif();
  else if (mode === '--ste-comments') qualifySteComments();
  else {
  const sampler = 'skills/random-sampler/scripts/sample.mjs';
  success(sampler, ['--help']);
  assert.equal(JSON.parse(success(sampler, ['--preflight', '--json'])).status, 'ready');
  for (const [input, expected] of [
    ['{"op":"integer","min":-2,"maxExclusive":-1}', '{"result":{"op":"integer","value":-2}}\n'],
    ['{"op":"choice","values":[9007199254740993]}', '{"result":{"op":"choice","index":0,"value":9007199254740993}}\n'],
    ['{"op":"sample","values":[1e999],"count":0}', '{"result":{"op":"sample","indices":[],"values":[]}}\n'],
    ['{"op":"shuffle","values":[1e999]}', '{"result":{"op":"shuffle","indices":[0],"values":[1e999]}}\n'],
  ]) assert.equal(success(sampler, ['--json'], input), expected);
  assert.equal(typeof JSON.parse(success(sampler, ['--json'], '{"op":"boolean"}')).result.value, 'boolean');
  const invalid = run(sampler, ['--json'], '{"op":"integer","min":9007199254740993,"maxExclusive":9007199254740994}');
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'invalid_integer_range');
  const config = 'skills/harness-advisor/scripts/advisor-config.js';
  const initial = JSON.parse(success(config, ['resolve', '--host', 'codex', '--primary', 'sol', '--json'])).result;
  assert.equal(initial.routeSource, 'built-in');
  success(config, ['set-route', '--host', 'codex', '--primary', 'sol', '--advisor', 'terra', '--reasoning-effort', 'medium', '--json']);
  const selected = JSON.parse(success(config, ['resolve', '--host', 'codex', '--primary', 'sol', '--json'])).result;
  assert.equal(selected.advisorFamily, 'terra'); assert.equal(selected.reasoningEffort, 'medium'); assert.equal(selected.routeSource, 'user-route');
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
  assert.equal(preflight.status, 'ready');
  assert.ok(preflight.checks.includes('advisor_contract_readable_nonempty'));
  const consulted = JSON.parse(success(adapter, args)).result;
  assert.equal(consulted.status, 'consulted');
  assert.equal(consulted.advice, 'Floor advice.');
  assert.equal(consulted.usage, null);
  assert.equal(consulted.modelUsage, null);
  for (const report of [preflight, consulted]) {
    assert.equal(report.model, 'opus');
    assert.equal(report.reasoningEffort, 'high');
    assert.equal(report.mechanism, 'claude-cli');
    assert.equal(report.contextMode, 'fresh');
    assert.equal(report.runtimeControls, 'unverified');
    assert.deepEqual(report.tools, []);
    assert.equal(Object.hasOwn(report, 'workspace'), false);
    assert.equal(Object.hasOwn(report, 'observations'), false);
  }
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 3);
  process.stdout.write(`Runtime floor passed on Node ${process.versions.node}: native ESM, preserved numeric tokens, routing mutations, bundled-contract preflight, tool-free consultation and removed-flag rejection.\n`);
  }
} finally { fs.rmSync(home, { recursive: true, force: true }); }
