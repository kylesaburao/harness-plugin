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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-advisor-test-'));
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
 '--no-session-persistence': 0, '--output-format': 1, '--restricted': 0, '--safe-mode': 0, '--verbose': 0, '--no-chrome': 0};
if (process.argv[2] === '--help') { process.stdout.write(Object.keys(supported).filter(k => k !== '--no-session-persistence').join(' ')); }
else if (process.argv[2] === '--version') { process.stdout.write(process.env.ADVISOR_TEST_VERSION || '2.1.270 (Claude Code)'); }
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
 else if (process.env.ADVISOR_TEST_STREAM) process.stdout.write(fs.readFileSync(process.env.ADVISOR_TEST_STREAM, 'utf8'));
 else process.stdout.write(JSON.stringify({ result: 'Use pendingFiles.', is_error: false, modelUsage: {'claude-opus-fixture': {inputTokens: 100,cacheReadInputTokens: 0}} }));
}
`, { mode: 0o755 });
  const invoke = (args = [], extra = {}) => spawnSync(process.execPath, [script, '--model', 'opus', '--reasoning-effort', 'high', '--prompt', prompt, '--json', ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: bin, CLAUDE_CONFIG_DIR: home, CLAUDECODE: '1', ADVISOR_TEST_LOG: log, ...extra },
  });
  return { root, bin, home, prompt, log, invoke };
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

function streamFile(f, events) {
  const file = path.join(f.root, 'events.jsonl');
  fs.writeFileSync(file, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  return file;
}
const finalEvent = { type: 'result', subtype: 'success', session_id: 's', result: 'Scoped advice.', is_error: false };
function readEvents(file, overrides = {}) {
  return [
    { type: 'assistant', session_id: 's', parent_tool_use_id: null, message: { content: [
      { type: 'tool_use', id: 'r', name: 'Read', input: { file_path: file } }] } },
    { type: 'user', session_id: 's', parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'r', content: 'Source text' }] },
      tool_use_result: { type: 'text', file: { filePath: file, content: 'source', startLine: 1, numLines: 1, totalLines: 1 } }, ...overrides },
    finalEvent,
  ];
}
test('workspace validates before host checks and canonicalizes without changing caller paths', t => {
  const f = fixture(t);
  for (const workspace of ['relative', f.prompt, path.join(f.root, 'missing')]) {
    const r = f.invoke(['--native-absent', '--workspace', workspace]);
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stderr).error.code, 'workspace_invalid');
    assert.equal(fs.existsSync(f.log), false);
  }
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.home, alias);
  const r = f.invoke(['--native-absent', '--workspace', alias, '--preflight']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).workspace, fs.realpathSync(f.home));
  assert.deepEqual(JSON.parse(r.stdout).tools, ['Read', 'Glob', 'Grep']);
  assert.equal(fs.existsSync(f.log), false);
});
test('workspace requests isolated file tools and reports observed reads separately from enforcement', t => {
  const f = fixture(t);
  const workspace = fs.realpathSync(f.home);
  const events = streamFile(f, readEvents(path.join(workspace, 'source.ts')));
  const r = f.invoke(['--native-absent', '--workspace', workspace], { ADVISOR_TEST_STREAM: events });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.runtime_controls, 'unverified');
  assert.deepEqual(report.observations, [{ tool: 'Read', path: path.join(workspace, 'source.ts'), outcome: 'read', completeness: 'complete', start_line: 1, lines: 1 }]);
  const call = JSON.parse(fs.readFileSync(f.log));
  const option = name => call.args[call.args.indexOf(name) + 1];
  for (const flag of ['--restricted', '--safe-mode', '--verbose', '--no-chrome']) assert.ok(call.args.includes(flag));
  assert.equal(option('--tools'), 'Read,Glob,Grep');
  assert.equal(option('--output-format'), 'stream-json');
  assert.deepEqual(JSON.parse(option('--settings')).permissions.additionalDirectories, [workspace]);
  assert.equal(option('--system-prompt'), contract);
  assert.deepEqual(call.entries, []);
  assert.equal(fs.existsSync(call.cwd), false);
  assert.equal(fs.existsSync(workspace), true);
  assert.equal(call.input, fs.readFileSync(f.prompt, 'utf8'));
});
test('old workspace host fails before inference and restrictive rejection never retries', t => {
  const f = fixture(t);
  let r = f.invoke(['--native-absent', '--workspace', f.home], { ADVISOR_TEST_VERSION: '2.1.247' });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).error.code, 'inspection_controls_unavailable');
  assert.equal(fs.existsSync(f.log), false);
  r = f.invoke(['--native-absent', '--workspace', f.home], { ADVISOR_TEST_REJECT: '--restricted' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(fs.readFileSync(f.log + '.calls', 'utf8'), 'call\n');
  assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(f.log)).cwd), false);
});
test('observation metadata never derives from prose, failed reads, or missing metadata', t => {
  const f = fixture(t);
  const { parseInspection } = require(script);
  const workspace = fs.realpathSync(f.home);
  const file = path.join(workspace, 'source.ts');
  const parse = events => parseInspection(events.map(e => JSON.stringify(e)).join('\n'), workspace);
  assert.deepEqual(parse([finalEvent]).observations, []);
  let events = readEvents(file, { tool_use_result: undefined });
  events[1].message.content[0].content = JSON.stringify(readEvents(file)[1]);
  assert.equal(parse(events).observations[0].outcome, 'unconfirmed');
  events = readEvents(file);
  events[1].message.content[0].is_error = true;
  assert.equal(parse(events).observations[0].outcome, 'failed');
  events = readEvents(file);
  events[1].tool_use_result.file.truncatedByTokenCap = true;
  assert.equal(parse(events).observations[0].completeness, 'partial');
  events[1].tool_use_result.file.startLine = 2;
  assert.equal(parse(events).observations[0].completeness, 'partial');
  events[1].tool_use_result = { type: 'file_unchanged', file: { filePath: file }, source: 'seeded' };
  assert.equal(parse(events).observations[0].outcome, 'unconfirmed');
  events = readEvents(path.join(workspace, '..', 'outside'));
  assert.equal(parse(events).observations[0].outcome, 'unconfirmed');
  events = readEvents(file);
  events[0].message.content[0].name = 'Glob';
  events[1].tool_use_result = { filenames: [file], numFiles: 1, truncated: false };
  assert.equal(parse(events).observations[0].outcome, 'discovery');
  events = readEvents(file);
  events[1].message.content[0].tool_use_id = 'wrong';
  assert.throws(() => parse(events), /inconsistent/);
  assert.throws(() => parseInspection('{', workspace), /malformed/);
  assert.throws(() => parse(readEvents(file).slice(0, 2)), /incomplete/);
  assert.throws(() => parse([...readEvents(file), finalEvent]), /inconsistent/);
});
test('malformed stream fails one dispatched attempt with cleanup and no success', t => {
  const f = fixture(t);
  const events = streamFile(f, []);
  fs.writeFileSync(events, '{"type":');
  const r = f.invoke(['--native-absent', '--workspace', f.home], { ADVISOR_TEST_STREAM: events });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(JSON.parse(r.stderr).error.code, 'advisor_response_invalid');
  assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(f.log)).cwd), false);
});

test('stream attribution rejects inconsistent sessions and qualifies missing or mismatched read metadata', t => {
  const f = fixture(t);
  const { parseInspection } = require(script);
  const workspace = fs.realpathSync(f.home);
  const file = path.join(workspace, 'source.ts');
  const parse = events => parseInspection(events.map(e => JSON.stringify(e)).join('\n'), workspace);
  let events = readEvents(file);
  delete events[0].session_id;
  assert.equal(parse(events).observations[0].outcome, 'unconfirmed');
  events = readEvents(file);
  events[1].tool_use_result.file.filePath = path.join(workspace, 'different.ts');
  assert.equal(parse(events).observations[0].outcome, 'unconfirmed');
  events = readEvents(file);
  events[1].session_id = 'other';
  assert.throws(() => parse(events), /inconsistent/);
  events = readEvents(file);
  events.splice(1, 0, events[0]);
  assert.throws(() => parse(events), /inconsistent/);
  events = readEvents(file);
  events[1].message.content[0].is_error = 'false';
  assert.throws(() => parse(events), /inconsistent/);
  events = readEvents(file);
  events[1].tool_use_result.file.numLines = -1;
  assert.equal(parse(events).observations[0].outcome, 'unconfirmed');
  assert.throws(() => parse([{ ...finalEvent, subtype: 'error_during_execution', is_error: true, errors: ['fixture rejection'] }]), /fixture rejection/);
  events = readEvents(file);
  events.splice(1, 1);
  assert.equal(parse(events).observations[0].outcome, 'unconfirmed');
});
