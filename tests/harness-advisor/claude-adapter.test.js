'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = require('../helpers/plugin-paths').artifactPath('skills/harness-advisor/scripts/claude-advisor.js');
const contract = fs.readFileSync(path.resolve(path.dirname(script), '../references/contract.md'), 'utf8');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude advisor's test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'claude');
  const prompt = path.join(root, 'prompt.txt');
  const log = path.join(root, 'invocation.json');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ agent: 'ambient-agent' }));
  fs.writeFileSync(prompt, '[QUESTION]\nWhich name is clearer?\n');
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
// Independently specified host contract. Help intentionally omits a supported control.
const supported = {'-p': 0, '--system-prompt': 1, '--setting-sources': 1, '--model': 1, '--effort': 1, '--tools': 1,
 '--disallowedTools': 1, '--strict-mcp-config': 0, '--mcp-config': 1,
 '--permission-mode': 1, '--settings': 1, '--disable-slash-commands': 0,
 '--no-session-persistence': 0, '--output-format': 1};
if (process.argv[2] === '--help') { process.stdout.write(Object.keys(supported).filter(k => k !== '--no-session-persistence').join(' ')); }
else if (process.argv[2] === '--version') {
 fs.appendFileSync(process.env.ADVISOR_TEST_LOG + '.probes', 'probe\\n');
 if (process.env.ADVISOR_TEST_PROBE_FAILURE) { process.stderr.write('fixture version failure'); process.exit(3); }
 process.stdout.write(process.env.ADVISOR_TEST_VERSION || '2.1.270 (Claude Code)');
}
else {
 fs.appendFileSync(process.env.ADVISOR_TEST_LOG + '.calls', 'call\\n');
 fs.writeFileSync(process.env.ADVISOR_TEST_LOG, JSON.stringify({ args: process.argv.slice(2), input: fs.readFileSync(0,'utf8'), native: process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, parent: process.env.CLAUDECODE, cwd: process.cwd(), entries: fs.readdirSync(process.cwd()) }));
 const args = process.argv.slice(2);
 for (let i = 0; i < args.length; i++) {
   const flag = args[i];
   if (!Object.hasOwn(supported, flag) || flag === process.env.ADVISOR_TEST_REJECT) {
     process.stderr.write('unknown option ' + flag); process.exit(1);
   }
   i += supported[flag];
 }
 if (process.env.ADVISOR_TEST_AUTH_FAILURE) { process.stderr.write('Not logged in. Please run /login'); process.exit(1); }
 if (process.env.ADVISOR_TEST_FAILURE) { process.stderr.write('fixture unavailable model'); process.exitCode = 1; }
 else if (process.env.ADVISOR_TEST_NULL_RESPONSE) process.stdout.write('null');
 else if (process.env.ADVISOR_TEST_RESPONSE !== undefined) process.stdout.write(process.env.ADVISOR_TEST_RESPONSE);
 else process.stdout.write(JSON.stringify({ result: 'Use pendingFiles.', is_error: false, modelUsage: {'claude-opus-fixture': {inputTokens: 100,cacheReadInputTokens: 0}} }));
}
`, { mode: 0o755 });
  const run = (args, extra = {}, executable = script, nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, executable, ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: bin, CLAUDE_CONFIG_DIR: home, CLAUDECODE: '1', ADVISOR_TEST_LOG: log, ...extra },
  });
  const valid = ['--native-absent', '--model', 'opus', '--reasoning-effort', 'high', '--prompt', prompt];
  const invoke = (args = [], extra = {}) => run([...valid.slice(1), '--json', ...args], extra);
  return { root, bin, home, prompt, log, invoke, run, valid };
}

test('CLI requires parent native-absence attestation before dispatch', t => {
  const f = fixture(t);
  const r = f.invoke();
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).error.code, 'usage_error');
  assert.equal(fs.existsSync(f.log), false);
});

test('Claude CLI applies per-call profile, fresh input, tool restrictions, and no recursion', t => {
  const f = fixture(t);
  let r = f.invoke(['--native-absent', '--preflight']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(f.log), false);
  assert.equal(JSON.parse(r.stdout).runtime_controls, 'unverified');
  assert.deepEqual(JSON.parse(r.stdout).checks, ['prompt_readable_nonempty', 'advisor_contract_readable_nonempty', 'cli_version_command_succeeded']);
  r = f.invoke(['--native-absent']);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.advice, 'Use pendingFiles.');
  assert.deepEqual(result.tools, []);
  const observed = JSON.parse(fs.readFileSync(f.log));
  assert.equal(observed.input, fs.readFileSync(f.prompt, 'utf8'));
  const option = name => observed.args[observed.args.indexOf(name) + 1];
  assert.equal(option('--system-prompt'), contract);
  assert.equal(option('--setting-sources'), '');
  assert.ok(!observed.args.includes('--agent'));
  assert.deepEqual(observed.entries, []);
  assert.equal(option('--model'), 'opus');
  assert.equal(option('--effort'), 'high');
  assert.equal(option('--tools'), '');
  assert.equal(option('--disallowedTools'), 'mcp__*');
  assert.equal(option('--mcp-config'), '{"mcpServers":{}}');
  assert.ok(observed.args.includes('--strict-mcp-config'));
  assert.equal(option('--permission-mode'), 'dontAsk');
  assert.ok(observed.args.includes('--disable-slash-commands'));
  assert.equal(observed.native, '1');
  assert.equal(observed.parent, undefined);
  assert.equal(JSON.parse(option('--settings')).switchModelsOnFlag, false);
  assert.equal(JSON.parse(option('--settings')).disableAllHooks, true);
  assert.deepEqual(JSON.parse(option('--settings')).fallbackModel, []);
  assert.ok(observed.args.includes('--no-session-persistence'));
  assert.ok(!observed.args.includes('--resume'));
  assert.equal(fs.existsSync(observed.cwd), false);
});

for (const [variable, diagnosis] of [
  ['ADVISOR_TEST_FAILURE', /fixture unavailable model/],
  ['ADVISOR_TEST_AUTH_FAILURE', /Not logged in. Please run \/login/],
]) test(`runtime failure ${variable} reports once without consultation success`, t => {
  const f = fixture(t);
  const r = f.invoke(['--native-absent'], { [variable]: '1' });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).error.code, 'advisor_execution_failed');
  assert.match(JSON.parse(r.stderr).error.condition, diagnosis);
  assert.equal(r.stdout, '');
  assert.equal(fs.readFileSync(f.log + '.calls', 'utf8'), 'call\n');
  assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(f.log)).cwd), false);
});

test('missing and empty canonical contract fail before CLI dispatch with reinstall remedy', t => {
  const f = fixture(t);
  const copy = path.join(f.root, 'skill/scripts/claude-advisor.js');
  const missing = path.join(f.root, 'skill/references/contract.md');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(script, copy);
  for (const empty of [false, true]) {
    if (empty) {
      fs.mkdirSync(path.dirname(missing));
      fs.writeFileSync(missing, '  \n');
    }
    const r = spawnSync(process.execPath, [copy, '--native-absent', '--model', 'opus',
      '--reasoning-effort', 'high', '--prompt', f.prompt, '--preflight', '--json'],
      { encoding: 'utf8', env: { ...process.env, PATH: f.bin, ADVISOR_TEST_LOG: f.log } });
    assert.equal(r.status, 2);
    const error = JSON.parse(r.stderr).error;
    assert.equal(error.code, 'advisor_contract_unavailable');
    assert.ok(error.condition.includes(missing));
    assert.match(error.remedy, /Reinstall the Harness plugin/);
    assert.equal(r.stdout, '');
    assert.equal(fs.existsSync(f.log), false);
  }
});

test('required but unlisted flag permits dispatch, genuine rejection fails without retry', t => {
  const f = fixture(t);
  const help = spawnSync(path.join(f.bin, 'claude'), ['--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /--no-session-persistence/);
  let r = f.invoke(['--native-absent']);
  assert.equal(r.status, 0, r.stderr);
  fs.unlinkSync(f.log + '.calls');
  r = f.invoke(['--native-absent'], { ADVISOR_TEST_REJECT: '--no-session-persistence' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(JSON.parse(r.stderr).error.code, 'advisor_execution_failed');
  assert.match(JSON.parse(r.stderr).error.condition, /unknown option --no-session-persistence/);
  assert.equal(fs.readFileSync(f.log + '.calls', 'utf8'), 'call\n');
  const observed = JSON.parse(fs.readFileSync(f.log));
  assert.ok(observed.args.includes('--no-session-persistence'));
  assert.equal(fs.existsSync(observed.cwd), false);
});

test('absent CLI is unavailable without inference', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.bin, 'claude'));
  const r = f.invoke(['--native-absent', '--preflight']);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).error.code, 'claude_unavailable');
  assert.equal(fs.existsSync(f.log), false);
});

test('null response keeps the existing failure diagnosis after dispatch', t => {
  const f = fixture(t);
  const result = f.invoke(['--native-absent'], { ADVISOR_TEST_NULL_RESPONSE: '1' });
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.code, 'advisor_failed');
  assert.equal(error.condition, "Cannot read properties of null (reading 'is_error')");
});

const removed = {
  code: 'usage_error',
  condition: '--workspace is no longer supported; Harness Advisor uses executor-supplied evidence only.',
  remedy: 'Remove --workspace and its value; include the material source excerpts and results in --prompt.',
};
function noHostCalls(f) {
  assert.equal(fs.existsSync(f.log + '.probes'), false);
  assert.equal(fs.existsSync(f.log + '.calls'), false);
}
function noInspection(report) {
  assert.deepEqual(report.tools, []);
  assert.equal(report.runtime_controls, 'unverified');
  assert.equal(Object.hasOwn(report, 'workspace'), false);
  assert.equal(Object.hasOwn(report, 'observations'), false);
}
function isolatedAdapter(f) {
  const copy = path.join(f.root, "skill's files/scripts/claude-advisor.js");
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(script, copy);
  return { copy, contractFile: path.resolve(path.dirname(copy), '../references/contract.md') };
}

for (const json of [false, true]) test(`removed workspace forms win before help, I/O, or probes (json=${json})`, t => {
  const f = fixture(t);
  const { copy } = isolatedAdapter(f); // No contract exists.
  fs.unlinkSync(f.prompt);
  for (const flag of [['--workspace', '/tmp/review'], ['--workspace=/tmp/review'], ['--workspace='], ['--workspace']]) {
    for (const rest of [f.valid, [...f.valid, '--preflight'], ['--help'], []]) {
      for (const args of [[...flag, ...rest], [...rest, ...flag]]) {
        const r = f.run([...args, ...(json ? ['--json'] : [])], {}, copy);
        assert.equal(r.status, 2, r.stderr);
        assert.equal(r.stdout, '');
        if (json) assert.deepEqual(JSON.parse(r.stderr), { error: removed });
        else assert.equal(r.stderr, `ERROR [usage_error]: ${removed.condition}\nRemedy: ${removed.remedy}\n`);
        noHostCalls(f);
      }
    }
  }
  fs.unlinkSync(path.join(f.bin, 'claude'));
  const r = f.run(['--workspace', '--help', '--json'], {}, copy);
  assert.deepEqual(JSON.parse(r.stderr), { error: removed });
  noHostCalls(f);
});

test('usage errors precede host probes and similar unknown spelling remains generic', t => {
  const f = fixture(t);
  for (const args of [[], ['--workspaces'], ['--unknown'], ['--help', '--help'],
    ['--model'], ['--model', '--json'], [...f.valid, '--model', 'other'],
    f.valid.map(v => v === 'high' ? 'ultra' : v), f.valid.slice(1)]) {
    const r = f.run([...args, '--json']);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(JSON.parse(r.stderr).error.code, 'usage_error');
    assert.notEqual(JSON.parse(r.stderr).error.condition, removed.condition);
    assert.equal(r.stdout, '');
    noHostCalls(f);
  }
});

test('read-free help and preflight allocate no invocation directory', t => {
  const f = fixture(t);
  const { copy } = isolatedAdapter(f);
  // A nonexistent TMPDIR makes any attempt to allocate a cwd fail.
  const extra = { TMPDIR: path.join(f.root, 'absent') };
  for (const json of [false, true]) {
    const r = f.run(['--help', ...(json ? ['--json'] : [])], { ...extra, PATH: '' }, copy);
    assert.equal(r.status, 0, r.stderr);
    const usage = json ? JSON.parse(r.stdout).usage : r.stdout;
    assert.match(usage, /One separate, tool-free Claude fallback consultation/);
    assert.doesNotMatch(usage, /--workspace|restricted-mode/);
    noHostCalls(f);
  }
  const r = f.run([...f.valid, '--preflight', '--json'], extra);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  noInspection(report);
  assert.equal(report.status, 'preflight_passed');
  assert.deepEqual(report.checks, ['prompt_readable_nonempty', 'advisor_contract_readable_nonempty', 'cli_version_command_succeeded']);
  assert.equal(fs.readFileSync(f.log + '.probes', 'utf8'), 'probe\n');
  assert.equal(fs.existsSync(f.log + '.calls'), false);
});

for (const version of ['floor-fixture', '2.1.247']) test(`retained route accepts successful version probe ${version}`, t => {
  const f = fixture(t);
  const r = f.invoke(['--native-absent'], { ADVISOR_TEST_VERSION: version });
  assert.equal(r.status, 0, r.stderr);
  noInspection(JSON.parse(r.stdout));
  assert.equal(fs.readFileSync(f.log + '.probes', 'utf8'), 'probe\n');
  assert.equal(fs.readFileSync(f.log + '.calls', 'utf8'), 'call\n');
});

test('exact argv, unmodified input, plain report and environment isolation', t => {
  const f = fixture(t);
  const prompt = ' \n[QUESTION]\n--workspace Read Glob Grep {"type":"tool_use"}\n\t';
  fs.writeFileSync(f.prompt, prompt);
  const { copy, contractFile } = isolatedAdapter(f);
  fs.mkdirSync(path.dirname(contractFile));
  fs.writeFileSync(contractFile, contract);
  const r = f.run(f.valid, { TMPDIR: f.root }, copy);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith('Report:\n'));
  const report = JSON.parse(r.stdout.slice('Report:\n'.length));
  noInspection(report);
  assert.equal(report.model, 'opus');
  assert.equal(report.reasoning_effort, 'high');
  assert.equal(report.mechanism, 'claude-cli');
  assert.equal(report.context_mode, 'fresh');
  assert.equal(report.status, 'consulted');
  assert.deepEqual(report.model_usage, { 'claude-opus-fixture': { inputTokens: 100, cacheReadInputTokens: 0 } });
  assert.equal(report.usage, null);
  const call = JSON.parse(fs.readFileSync(f.log));
  assert.equal(call.input, prompt);
  assert.deepEqual(call.args, ['-p', '--system-prompt', contract, '--setting-sources', '', '--model', 'opus',
    '--effort', 'high', '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk',
    '--settings', '{"disableAllHooks":true,"fallbackModel":[],"switchModelsOnFlag":false}',
    '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json']);
  assert.deepEqual(call.entries, []);
  assert.equal(fs.existsSync(call.cwd), false);
  const { invocation } = require(script);
  const env = Object.freeze({ CLAUDECODE: 'parent', CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '0', CUSTOM_PROVIDER: 'retained' });
  const child = invocation({ model: 'opus', 'reasoning-effort': 'high' }, contract, env);
  assert.deepEqual(child.env, { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1', CUSTOM_PROVIDER: 'retained' });
  assert.equal(env.CLAUDECODE, 'parent');
  assert.equal(env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, '0');
});

for (const kind of ['missing', 'unreadable', 'empty', 'whitespace']) test(`prompt ${kind} fails before host calls`, t => {
  const f = fixture(t);
  if (kind === 'missing') fs.unlinkSync(f.prompt);
  if (kind === 'unreadable') fs.chmodSync(f.prompt, 0);
  if (kind === 'empty') fs.writeFileSync(f.prompt, '');
  if (kind === 'whitespace') fs.writeFileSync(f.prompt, ' \n\t');
  const r = f.invoke(['--native-absent']);
  assert.equal(r.status, 2, r.stderr);
  const error = JSON.parse(r.stderr).error;
  assert.equal(error.code, ['missing', 'unreadable'].includes(kind) ? 'input_read_failed' : 'input_invalid');
  assert.match(error.remedy, /--help$/);
  assert.equal(r.stdout, '');
  noHostCalls(f);
});

for (const kind of ['missing', 'unreadable', 'empty', 'whitespace']) test(`contract ${kind} keeps reinstall diagnosis`, t => {
  const f = fixture(t);
  const { copy, contractFile } = isolatedAdapter(f);
  fs.mkdirSync(path.dirname(contractFile));
  if (kind !== 'missing') fs.writeFileSync(contractFile, kind === 'unreadable' ? contract : kind === 'empty' ? '' : ' \n\t');
  if (kind === 'unreadable') fs.chmodSync(contractFile, 0);
  const r = f.run([...f.valid, '--json'], {}, copy);
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual(JSON.parse(r.stderr).error, {
    code: 'advisor_contract_unavailable',
    condition: `Advisor contract is missing, unreadable, or empty at ${contractFile}`,
    remedy: 'Reinstall the Harness plugin through your host plugin manager.',
  });
  assert.equal(r.stdout, '');
  noHostCalls(f);
});

test('version nonzero failure is unavailable without inference', t => {
  const f = fixture(t);
  const r = f.invoke(['--native-absent'], { ADVISOR_TEST_PROBE_FAILURE: '1' });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).error.code, 'claude_unavailable');
  assert.match(JSON.parse(r.stderr).error.condition, /fixture version failure/);
  assert.equal(JSON.parse(r.stderr).error.remedy, 'claude --version');
  assert.equal(r.stdout, '');
  assert.equal(fs.readFileSync(f.log + '.probes', 'utf8'), 'probe\n');
  assert.equal(fs.existsSync(f.log + '.calls'), false);
});

for (const response of ['{', '[]', '42', 'false', '"text"', '{}', '{"result":7}',
  '{"result":"  \\n"}', '{"result":"advice","is_error":true}', '{"result":"advice","is_error":"false"}']) {
  test(`invalid result ${response} fails once with cleanup`, t => {
    const f = fixture(t);
    const r = f.invoke(['--native-absent'], { ADVISOR_TEST_RESPONSE: response });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(JSON.parse(r.stderr).error.code, response === '{' ? 'advisor_response_invalid' : 'advisor_execution_failed');
    assert.equal(fs.readFileSync(f.log + '.calls', 'utf8'), 'call\n');
    assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(f.log)).cwd), false);
  });
}

for (const response of [{ result: ' advice ' }, { result: 'advice', is_error: 0, usage: ['opaque'], modelUsage: 'opaque' }]) {
  test(`minimal result preserves acceptance and unknown usage ${JSON.stringify(response)}`, t => {
    const f = fixture(t);
    const r = f.invoke(['--native-absent'], { ADVISOR_TEST_RESPONSE: JSON.stringify(response) });
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    noInspection(report);
    assert.equal(report.advice, response.result);
    assert.deepEqual(report.usage, response.usage ?? null);
    assert.deepEqual(report.model_usage, response.modelUsage ?? null);
  });
}

// Faults are confined to the adapter process and task-owned temporary paths.
function preload(f) {
  const file = path.join(f.root, 'boundary.cjs');
  fs.writeFileSync(file, `
const fs = require('node:fs');
const originalMake = fs.mkdtempSync;
const originalRemove = fs.rmSync;
let directory;
fs.mkdtempSync = function(prefix, ...args) {
  if (process.env.ADVISOR_FAULT === 'allocate') throw new Error('fixture allocation denied');
  directory = originalMake.call(this, prefix, ...args);
  return directory;
};
fs.rmSync = function(target, ...args) {
  if (target === directory && process.env.ADVISOR_FAULT === 'cleanup') throw new Error('fixture cleanup denied');
  return originalRemove.call(this, target, ...args);
};
const originalWrite = process.stdout.write;
process.stdout.write = function(...args) {
  if (directory && fs.existsSync(directory)) throw new Error('success emitted before cleanup');
  return originalWrite.apply(this, args);
};
`);
  return ['--require', file];
}

test('success emission happens after cwd cleanup at the process boundary', t => {
  const f = fixture(t);
  const r = f.run([...f.valid, '--json'], { TMPDIR: f.root }, script, preload(f));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'consulted');
});

for (const runtimeFailure of [false, true]) test(`cleanup denial retains path and original failure (runtime=${runtimeFailure})`, t => {
  const f = fixture(t);
  const r = f.run([...f.valid, '--json'], { TMPDIR: f.root, ADVISOR_FAULT: 'cleanup',
    ...(runtimeFailure ? { ADVISOR_TEST_FAILURE: '1' } : {}) }, script, preload(f));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  const error = JSON.parse(r.stderr).error;
  const cwd = JSON.parse(fs.readFileSync(f.log)).cwd;
  assert.equal(error.code, runtimeFailure ? 'advisor_execution_failed' : 'advisor_failed');
  assert.ok(error.condition.includes(cwd));
  assert.match(error.condition, runtimeFailure ? /fixture unavailable model/ : /fixture cleanup denied/);
  assert.equal(error.remedy, `rm -rf -- '${cwd.replace(/'/g, "'\\''")}'`);
  assert.equal(fs.existsSync(cwd), true);
  const recovery = spawnSync('/bin/sh', ['-c', error.remedy], { encoding: 'utf8' });
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.equal(fs.existsSync(cwd), false);
});

test('allocation failure counts as started without inference or unrelated cleanup', t => {
  const f = fixture(t);
  const sentinel = path.join(f.root, 'unrelated');
  fs.writeFileSync(sentinel, 'preserve');
  const r = f.run([...f.valid, '--json'], { TMPDIR: f.root, ADVISOR_FAULT: 'allocate' }, script, preload(f));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(JSON.parse(r.stderr).error.code, 'advisor_failed');
  assert.equal(JSON.parse(r.stderr).error.condition, 'fixture allocation denied');
  assert.equal(fs.readFileSync(f.log + '.probes', 'utf8'), 'probe\n');
  assert.equal(fs.existsSync(f.log + '.calls'), false);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
});

test('module import exposes only retained callable exports and performs no runtime work', t => {
  const f = fixture(t);
  const { copy } = isolatedAdapter(f); // Import needs neither prompt nor bundled contract.
  const r = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const api = require(process.argv[1]);
    assert.deepEqual(Object.keys(api).sort(), ['invocation', 'parseArguments']);
    assert.equal(api.parseArguments(['--help']).help, true);
    assert.equal(api.invocation({model: 'opus', 'reasoning-effort': 'high'}, 'contract').command, 'claude');
  `, copy], { encoding: 'utf8', env: { ...process.env, PATH: f.bin, ADVISOR_TEST_LOG: f.log } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  noHostCalls(f);
});
