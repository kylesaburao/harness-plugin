'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const script = path.resolve(__dirname, '../../dist/harness/skills/harness-advisor/scripts/advisor-config.js');
const { emptyConfig, resolve, validateConfig } = require(script);
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-config-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Isolate only os.homedir for this child, preserving all actual CLI parsing/I/O.
  const invoke = (...args) => spawnSync(process.execPath, ['-e',
    "require('node:os').homedir = () => process.argv[1]; process.exitCode = require(process.argv[2]).main(process.argv.slice(3));",
    home, script, ...args, '--json'], { encoding: 'utf8' });
  return { home, invoke, file: path.join(home, '.harness-plugin/harness-advisor/config.json') };
}

test('built-ins and derived same-family modes', () => {
  for (const [host, primary, advisor] of [
    ['codex', 'luna', 'astra'], ['codex', 'terra', 'astra'], ['codex', 'sol', 'astra'], ['codex', 'astra', 'astra'],
    ['claude', 'haiku', 'opus'], ['claude', 'sonnet', 'opus'], ['claude', 'opus', 'opus'], ['claude', 'fable', 'fable'],
  ]) {
    assert.deepEqual(resolve(emptyConfig(), host, primary), { host, primary_family: primary,
      advisor_family: advisor, reasoning_effort: 'high', route_source: 'built-in',
      consultation_mode: primary === advisor ? 'fresh-review' : 'escalation' });
  }
});

test('explicit family > exact route > host default > built-in, including deliberate downgrade', () => {
  const config = { schema_version: 1,
    defaults: [{ host: 'codex', advisor: 'sol', reasoning_effort: 'medium' }, { host: 'claude', advisor: 'sonnet' }],
    routes: [{ host: 'codex', primary: 'sol', advisor: 'astra', reasoning_effort: 'max' }] };
  assert.equal(resolve(config, 'codex', 'luna').route_source, 'user-default');
  assert.equal(resolve(config, 'codex', 'luna').advisor_family, 'sol');
  assert.equal(resolve(config, 'codex', 'sol').route_source, 'user-route');
  assert.equal(resolve(config, 'codex', 'sol').reasoning_effort, 'max');
  assert.equal(resolve(config, 'codex', 'sol', 'sol').route_source, 'explicit-user');
  assert.equal(resolve(config, 'codex', 'sol', 'sol').consultation_mode, 'fresh-review');
  assert.equal(resolve(config, 'codex', 'sol', 'sol').reasoning_effort, 'high');
  assert.equal(resolve(config, 'claude', 'fable').advisor_family, 'sonnet');
  assert.throws(() => resolve(emptyConfig(), 'claude', 'sol'), { code: 'route_unresolved' });
});

test('CLI missing config reads and no-op removals never create a file', t => {
  const f = fixture(t);
  for (const args of [['show'], ['resolve', '--host', 'codex', '--primary', 'sol'],
    ['clear-default', '--host', 'codex'], ['remove-route', '--host', 'claude', '--primary', 'sonnet']]) {
    const result = f.invoke(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(f.file), false);
  }
});

test('CLI mutations preserve unrelated routes, serialize sparsely, and avoid no-op writes', t => {
  const f = fixture(t);
  const run = (...args) => {
    const result = f.invoke(...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  run('set-default', '--host', 'codex', '--advisor', 'sol', '--reasoning-effort', 'high', '--preflight');
  assert.equal(fs.existsSync(path.dirname(f.file)), false);
  run('set-default', '--host', 'codex', '--advisor', 'sol', '--reasoning-effort', 'high');
  run('set-route', '--host', 'claude', '--primary', 'sonnet', '--advisor', 'opus');
  const before = fs.readFileSync(f.file, 'utf8');
  const mtime = fs.statSync(f.file).mtimeMs;
  assert.equal(run('set-default', '--host', 'codex', '--advisor', 'sol').changed, false);
  assert.equal(fs.statSync(f.file).mtimeMs, mtime);
  run('resolve', '--host', 'codex', '--primary', 'sol', '--advisor', 'astra');
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.ok(before.endsWith('\n'));
  assert.equal(JSON.parse(before).routes.length, 1);
  run('clear-default', '--host', 'codex');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).routes, [{ host: 'claude', primary: 'sonnet', advisor: 'opus' }]);
  run('remove-route', '--host', 'claude', '--primary', 'sonnet');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), emptyConfig());
});

test('invalid schema and exact model IDs fail before writing, bad args precede config reads', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.file), { recursive: true });
  for (const contents of ['{"schema_version":2}', '{broken']) {
    fs.writeFileSync(f.file, contents);
    assert.equal(f.invoke('set-default', '--host', 'codex', '--advisor', 'sol').status, 2);
    assert.equal(fs.readFileSync(f.file, 'utf8'), contents);
    assert.equal(fs.existsSync(f.file + '.lock'), false);
    assert.equal(JSON.parse(f.invoke('resolve', '--host', 'codex', '--primary', 'sol', '--typo').stderr).error.code, 'usage_error');
  }
  assert.equal(f.invoke('set-default', '--host', 'codex', '--advisor', 'gpt-6-astra').status, 2);
  assert.throws(() => validateConfig({ schema_version: 1, defaults: [
    { host: 'codex', advisor: 'sol' }, { host: 'codex', advisor: 'astra' }], routes: [] }), { code: 'config_invalid' });
});

// Pause after the actual read while retaining real CLI parsing and publication.
function pausedWriter(t, f) {
  const child = spawn(process.execPath, ['-e', `
    require('node:os').homedir = () => process.argv[1];
    const fs = require('node:fs');
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      const result = read.call(this, file, ...args);
      if (file === process.argv[3]) {
        process.stdout.write('READY\\n');
        fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      }
      return result;
    };
    process.exitCode = require(process.argv[2]).main(['set-route', '--host', 'codex', '--primary', 'sol', '--advisor', 'sol', '--json']);
  `, f.home, script, f.file], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', data => { stdout += data; if (stdout.includes('READY\n')) resolve(); });
    child.on('error', reject);
    child.on('exit', () => { if (!stdout.includes('READY\n')) reject(new Error(stderr || 'Writer exited before read')); });
  });
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise(resolve => child.on('close', status => resolve({ status, stdout: stdout.replace('READY\n', ''), stderr })));
  return { child, ready, done };
}

test('separate CLI writers fail explicitly on contention and preserve routes after retry', { timeout: 10000 }, async t => {
  const f = fixture(t);
  assert.equal(f.invoke('set-default', '--host', 'codex', '--advisor', 'astra').status, 0);
  const first = pausedWriter(t, f);
  await first.ready;
  const args = ['set-route', '--host', 'claude', '--primary', 'sonnet', '--advisor', 'opus'];
  const second = f.invoke(...args);
  assert.equal(second.status, 2, second.stderr);
  assert.equal(second.stdout, '');
  assert.equal(JSON.parse(second.stderr).error.code, 'config_busy');
  // Readers and a no-write preview do not acquire the writer lock.
  assert.equal(f.invoke('show').status, 0);
  assert.equal(f.invoke('resolve', '--host', 'codex', '--primary', 'sol').status, 0);
  assert.equal(f.invoke(...args, '--preflight').status, 0);
  first.child.stdin.end('x');
  const saved = await first.done;
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(JSON.parse(saved.stdout).changed, true);
  assert.equal(fs.existsSync(f.file + '.lock'), false);
  assert.equal(f.invoke(...args).status, 0);
  const config = JSON.parse(fs.readFileSync(f.file));
  assert.deepEqual(config.routes, [
    { host: 'claude', primary: 'sonnet', advisor: 'opus' },
    { host: 'codex', primary: 'sol', advisor: 'sol' },
  ]);
  assert.equal(JSON.parse(f.invoke('resolve', '--host', 'codex', '--primary', 'sol').stdout).advisor_family, 'sol');
});

test('interrupted writer leaves an actionable lock and never permits silent stealing', { timeout: 10000 }, async t => {
  const f = fixture(t);
  assert.equal(f.invoke('set-default', '--host', 'codex', '--advisor', 'astra').status, 0);
  const before = fs.readFileSync(f.file, 'utf8');
  const first = pausedWriter(t, f);
  await first.ready;
  first.child.kill('SIGKILL');
  await first.done;
  const result = f.invoke('set-route', '--host', 'claude', '--primary', 'sonnet', '--advisor', 'opus');
  assert.equal(result.status, 2);
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.code, 'config_busy');
  assert.ok(error.remedy.includes('confirming no advisor-config mutation is running'));
  assert.ok(error.remedy.includes(f.file + '.lock'));
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  fs.rmdirSync(f.file + '.lock'); // The scheduled writer is known to have exited.
  assert.equal(f.invoke('set-route', '--host', 'claude', '--primary', 'sonnet', '--advisor', 'opus').status, 0);
});

test('publication failure preserves configuration and cleans staging and lock', t => {
  const f = fixture(t);
  assert.equal(f.invoke('set-default', '--host', 'codex', '--advisor', 'astra').status, 0);
  const before = fs.readFileSync(f.file, 'utf8');
  const result = spawnSync(process.execPath, ['-e', `
    require('node:os').homedir = () => process.argv[1];
    require('node:fs').renameSync = () => { throw new Error('injected publication failure'); };
    process.exitCode = require(process.argv[2]).main(['set-default', '--host', 'codex', '--advisor', 'sol', '--json']);
  `, f.home, script], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'config_write_failed');
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['config.json']);
});

test('lock cleanup failure reports possible publication and manual recovery', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, ['-e', `
    require('node:os').homedir = () => process.argv[1];
    require('node:fs').rmdirSync = () => { throw new Error('injected cleanup failure'); };
    process.exitCode = require(process.argv[2]).main(['set-default', '--host', 'codex', '--advisor', 'sol', '--json']);
  `, f.home, script], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.code, 'config_lock_cleanup_failed');
  assert.match(error.condition, /may already be published/);
  assert.ok(error.remedy.includes(f.file + '.lock'));
  assert.equal(JSON.parse(fs.readFileSync(f.file)).defaults[0].advisor, 'sol');
});
