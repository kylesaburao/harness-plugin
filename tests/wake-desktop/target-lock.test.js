const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const cli = path.resolve(__dirname, '../../dist/harness/skills/wake-desktop/scripts/manage-targets.js');
const preload = path.join(__dirname, 'target-lock-preload.cjs');
const mac = '00:11:22:33:44:55';
const register = name => ['register', '--name', name, '--ip', 'desktop.local', '--mac', mac];
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wake-lock's-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, '.harness-plugin/wake-desktop/config.json');
  const lock = `${config}.lock`;
  const ready = path.join(home, 'ready'), release = path.join(home, 'release');
  const env = mode => ({ ...process.env, HOME: home, USERPROFILE: home, LOCK_TEST_MODE: mode, LOCK_TEST_READY: ready, LOCK_TEST_RELEASE: release });
  const args = (command, json) => ['--require', preload, cli, ...command, ...(json ? ['--json'] : [])];
  function run(command, mode = '', json = true) {
    const result = spawnSync(process.execPath, args(command, json), { env: env(mode), encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error); return result;
  }
  async function hold(command) {
    const child = spawn(process.execPath, args(command, true), { env: env('hold'), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => stderr += data);
    const done = once(child, 'close');
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(ready)) {
      assert.ok(Date.now() < deadline && child.exitCode === null, stderr || 'writer did not reach barrier');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return { child, done, finish: async () => { fs.writeFileSync(release, 'go'); assert.deepEqual(await done, [0, null], stderr); } };
  }
  return { home, config, lock, run, hold, read: () => JSON.parse(fs.readFileSync(config, 'utf8')) };
}
function failure(result, code, status = 2) {
  assert.equal(result.status, status, result.stderr); assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr).error; assert.equal(error.code, code); return error;
}
for (const pair of ['register', 'remove-update']) test(`real CLI writer contention preserves ${pair} changes after explicit retry`, async t => {
  const s = fixture(t);
  assert.equal(s.run(register('existing')).status, 0);
  const config = s.read(); config.unknown = { keep: true }; config.targets.existing.note = 'keep';
  fs.writeFileSync(s.config, JSON.stringify(config));
  const first = pair === 'register' ? register('alpha') : ['remove', '--name', 'existing'];
  if (pair !== 'register') assert.equal(s.run(register('alpha')).status, 0);
  const second = pair === 'register' ? register('beta') : ['update', '--name', 'alpha', '--ip', 'new.local'];
  const writer = await s.hold(first);
  const original = fs.readFileSync(s.config, 'utf8');
  failure(s.run(second), 'target_config_busy');
  assert.equal(fs.readFileSync(s.config, 'utf8'), original);
  assert.equal(s.run(['list']).status, 0);
  assert.equal(s.run([...second, '--preflight']).status, 0);
  assert.equal(s.run(['--help']).status, 0);
  await writer.finish();
  assert.equal(s.run(second).status, 0);
  assert.deepEqual(s.read().unknown, { keep: true });
  if (pair === 'register') { assert.deepEqual(Object.keys(s.read().targets).sort(), ['alpha', 'beta', 'existing']); assert.equal(s.read().targets.existing.note, 'keep'); }
  else { assert.equal(s.read().targets.existing, undefined); assert.equal(s.read().targets.alpha.ip, 'new.local'); }
  assert.equal(fs.existsSync(s.lock), false);
});
test('no-op mutations lock without rewriting and operation exceptions release', async t => {
  const s = fixture(t); assert.equal(s.run(register('alpha')).status, 0);
  const before = fs.statSync(s.config); const bytes = fs.readFileSync(s.config);
  const writer = await s.hold(register('alpha'));
  failure(s.run(register('beta')), 'target_config_busy');
  await writer.finish();
  assert.deepEqual(fs.readFileSync(s.config), bytes);
  assert.equal(fs.statSync(s.config).ino, before.ino); assert.equal(fs.statSync(s.config).mtimeMs, before.mtimeMs);
  failure(s.run(['remove', '--name', 'absent']), 'target_unknown');
  assert.equal(fs.existsSync(s.lock), false);
});
test('killed writer leaves a recoverable lock and cannot silently lose changes', async t => {
  const s = fixture(t); const writer = await s.hold(register('alpha'));
  writer.child.kill('SIGKILL'); assert.deepEqual(await writer.done, [null, 'SIGKILL']);
  const error = failure(s.run(register('beta')), 'target_config_busy');
  assert.ok(error.condition.includes(s.lock)); assert.match(error.remedy, /confirm no .* mutation is running, then run rmdir -- '/);
  assert.ok(error.remedy.includes("'\\''"));
  assert.equal(fs.existsSync(s.config), false);
  fs.rmdirSync(s.lock); assert.equal(s.run(register('beta')).status, 0);
});
for (const mode of ['ownership', 'release-fail']) test(`${mode} after publication reports saved configuration and retains the lock`, t => {
  const s = fixture(t);
  const error = failure(s.run(register('alpha'), mode), 'target_config_lock_cleanup_failed', 1);
  assert.match(error.condition, /configuration was saved/); assert.ok(error.condition.includes(s.lock));
  assert.ok(s.read().targets.alpha); assert.ok(fs.existsSync(s.lock));
  if (mode === 'ownership') assert.ok(fs.existsSync(`${s.lock}.original`));
});
test('acquisition errors and combined operation/release errors retain complete diagnostics', t => {
  const s = fixture(t);
  failure(s.run(register('alpha'), 'acquire-fail'), 'target_config_lock_failed');
  assert.equal(fs.existsSync(s.config), false);
  const result = s.run(['remove', '--name', 'absent'], 'release-fail', false);
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, /ERROR \[target_config_lock_cleanup_failed\]/);
  assert.match(result.stderr, /operation also failed: target_unknown/);
  assert.match(result.stderr, /injected release failure/);
});

test('an obstructed configuration parent is an acquisition failure, not contention', t => {
  const s = fixture(t);
  fs.writeFileSync(path.join(s.home, '.harness-plugin'), 'unrelated existing file');
  const error = failure(s.run(register('alpha')), 'target_config_lock_failed');
  assert.match(error.condition, /cannot prepare configuration directory/);
  assert.equal(fs.readFileSync(path.join(s.home, '.harness-plugin'), 'utf8'), 'unrelated existing file');
});
