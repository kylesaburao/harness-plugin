'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../../plugins/harness/skills/install-harness-plugin-capabilities/scripts/install.js');
const { START, END, BLOCK, blockFor, managedText } = require(script);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-capabilities-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex-home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const invoke = (...args) => spawnSync(process.execPath, [script, ...args, '--json'], {
    encoding: 'utf8', env: { ...process.env, CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'claude-home'), PATH: bin },
  });
  return { root, home, invoke, agents: path.join(home, 'AGENTS.md'), agent: path.join(home, 'agents/harness_advisor.toml') };
}

test('three CLI installs preserve user bytes and converge without touching config', t => {
  const f = fixture(t);
  fs.mkdirSync(f.home);
  const original = '# My instructions\r\n\r\nUse precise language. Ω';
  fs.writeFileSync(f.agents, original);
  fs.chmodSync(f.agents, 0o640);
  const config = 'model = "gpt-5.6-luna"\n';
  fs.writeFileSync(path.join(f.home, 'config.toml'), config);
  const first = f.invoke('--host', 'codex');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).published.length, 1);
  const expected = fs.readFileSync(f.agents, 'utf8');
  assert.ok(expected.startsWith(original));
  assert.equal(expected.split(START).length - 1, 1);
  const mtime = fs.statSync(f.agents).mtimeMs;
  for (let i = 0; i < 2; i += 1) {
    const result = f.invoke('--host', 'codex');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'unchanged');
    assert.deepEqual(JSON.parse(result.stdout).published, []);
  }
  assert.equal(fs.readFileSync(f.agents, 'utf8'), expected);
  assert.equal(fs.statSync(f.agents).mtimeMs, mtime);
  assert.equal(fs.statSync(f.agents).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(path.join(f.home, 'config.toml'), 'utf8'), config);
  assert.equal(fs.existsSync(f.agent), false);
});

test('managed block update preserves prefix and suffix exactly', () => {
  const before = `user prefix\r\n${START}\nold activation\n${END}\r\nuser suffix`;
  assert.equal(managedText(before), `user prefix\r\n${BLOCK}\r\nuser suffix`);
  assert.equal(managedText(managedText(before)), managedText(before));
});

test('CLI updates activation while preserving a legacy role', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.agent), { recursive: true });
  const legacy = '# Managed by harness-plugin:capabilities, advisor\nmodel = "old"\n';
  fs.writeFileSync(f.agent, legacy);
  fs.chmodSync(f.agent, 0o640);
  const mtime = fs.statSync(f.agent).mtimeMs;
  fs.writeFileSync(f.agents, `before\n${START}\nold activation\n${END}\nafter`);
  const result = f.invoke('--host', 'codex');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).published.length, 1);
  assert.equal(fs.readFileSync(f.agent, 'utf8'), legacy);
  assert.equal(fs.statSync(f.agent).mtimeMs, mtime);
  assert.equal(fs.statSync(f.agent).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(f.agents, 'utf8'), `before\n${BLOCK}\nafter`);
});

test('malformed and duplicate blocks fail without any file publication', t => {
  const f = fixture(t);
  fs.mkdirSync(f.home);
  for (const text of [START, END, `${END}\n${START}`, `${START}${END}${START}${END}`]) {
    fs.writeFileSync(f.agents, text);
    const result = f.invoke('--host', 'codex');
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).error.code, 'managed_block_conflict');
    assert.equal(fs.readFileSync(f.agents, 'utf8'), text);
    assert.equal(fs.existsSync(f.agent), false);
  }
});

test('preflight without a CLI reports one instruction file and creates no home or files', t => {
  const f = fixture(t);
  const result = f.invoke('--host', 'codex', '--preflight');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'preflight_passed');
  assert.equal(JSON.parse(result.stdout).files.length, 1);
  assert.equal(fs.existsSync(f.home), false);
});

test('unowned legacy role is preserved and overriding instructions fail before writes', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.agent), { recursive: true });
  fs.writeFileSync(f.agent, 'user agent');
  let result = f.invoke('--host', 'codex');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).published, [f.agents]);
  fs.writeFileSync(path.join(f.home, 'AGENTS.override.md'), 'active override');
  result = f.invoke('--host', 'codex');
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'instructions_shadowed');
  assert.equal(fs.readFileSync(f.agent, 'utf8'), 'user agent');
});

test('Claude installs only the gate without a CLI and preserves legacy roles and settings', t => {
  const f = fixture(t);
  const home = path.join(f.root, 'claude-home');
  fs.mkdirSync(home);
  const file = path.join(home, 'CLAUDE.md');
  const legacy = path.join(home, 'agents/harness-advisor.md');
  fs.mkdirSync(path.dirname(legacy));
  fs.writeFileSync(legacy, 'legacy user role');
  const mtime = fs.statSync(legacy).mtimeMs;
  fs.writeFileSync(file, '# User instructions\r\nΩ');
  const settings = '{"advisorModel":"opus"}';
  fs.writeFileSync(path.join(home, 'settings.json'), settings);
  const first = f.invoke('--host', 'claude');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).published.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '# User instructions\r\nΩ\n\n' + blockFor('claude') + '\n');
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'legacy user role');
  assert.equal(fs.statSync(legacy).mtimeMs, mtime);
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'), settings);
  const second = f.invoke('--host', 'claude');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'unchanged');
  assert.equal(fs.existsSync(f.home), false);
});

test('obsolete installation-time native argument is rejected before writing', t => {
  const f = fixture(t);
  const result = f.invoke('--host', 'claude', '--native-evidence', 'native.json');
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'usage_error');
  assert.equal(fs.existsSync(path.join(f.root, 'claude-home')), false);
});

test('usage errors precede environment probes', t => {
  const f = fixture(t);
  const result = f.invoke('--host', 'codex', '--typo');
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'usage_error');
});

test('instruction file conflict fails before publication and rerun repairs', t => {
  const f = fixture(t);
  fs.mkdirSync(f.agents, { recursive: true });
  const result = f.invoke('--host', 'codex');
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'file_conflict');
  fs.rmdirSync(f.agents);
  const repaired = f.invoke('--host', 'codex');
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.deepEqual(JSON.parse(repaired.stdout).published, [f.agents]);
});
