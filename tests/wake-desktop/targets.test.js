'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scripts = path.resolve(__dirname, '../../plugins/harness/skills/wake-desktop/scripts');
const fixture = path.join(__dirname, 'simulated-network.cjs');
const mac = '34:5a:60:37:3e:21';
const ip = '192.168.1.91';
function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-targets-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, '.harness-plugin/wake-desktop/config.json');
  const tracePath = path.join(home, 'trace.json');
  function run(args, { wake = false, scenario = 'ok', json = true, env = {} } = {}) {
    const result = spawnSync(process.execPath, ['--require', fixture,
      path.join(scripts, wake ? 'wake-desktop.js' : 'manage-targets.js'), ...args, ...(json ? ['--json'] : [])], {
      env: { ...process.env, HOME: home, USERPROFILE: home, MAC_ADDRESS: 'bad-env', IP_ADDRESS: 'bad env', TIMEOUT: '23',
        WAKE_TRACE: tracePath, WAKE_SCENARIO: scenario, ...env }, encoding: 'utf8', timeout: 6000,
    });
    assert.ifError(result.error);
    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    if (!wake) assert.deepEqual(trace, [], 'management must not use networking');
    return { ...result, trace, body: json ? JSON.parse(result.status === 0 ? result.stdout : result.stderr) : undefined };
  }
  function write(config) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, typeof config === 'string' ? config : JSON.stringify(config));
  }
  const read = () => fs.readFileSync(configPath, 'utf8');
  const register = (name = 'desktop', extra = [], opts) => run(['register', '--name', name, '--ip', ip, '--mac', mac, ...extra], opts);
  return { home, configPath, run, write, read, register };
}
function ok(result, status) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.body.status, status);
  return result.body;
}
function fail(result, code, exit = 2) {
  assert.equal(result.status, exit, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(Object.keys(result.body.error).sort(), ['code', 'condition', 'remedy']);
  assert.equal(result.body.error.code, code);
  return result.body.error;
}

test('absent list, registration, direct-name sorting and exact own-property lookup', t => {
  const s = sandbox(t);
  assert.deepEqual(ok(s.run(['list']), 'listed'), { status: 'listed', configPath: s.configPath, targets: [] });
  assert.equal(fs.existsSync(path.dirname(s.configPath)), false);
  for (const name of ['desktop', 'office desktop', '桌面', '__proto__', 'constructor', 'A']) {
    assert.equal(ok(s.register(name), 'registered').changed, true);
  }
  assert.deepEqual(ok(s.run(['list']), 'listed').targets.map(x => x.name), ['A', '__proto__', 'constructor', 'desktop', 'office desktop', '桌面']);
  assert.match(s.read(), /^\{\n  "schema_version": 1,/);
  assert.ok(s.read().endsWith('\n'));
  fail(s.run(['remove', '--name', 'Desktop']), 'target_unknown');
  fail(s.run(['remove', '--name', 'toString']), 'target_unknown');
});

test('conflicts, replacement, partial update, rename and removal preserve unknown properties', t => {
  const s = sandbox(t);
  s.write({ schema_version: 1, extra: { a: 1 }, targets: { desktop: { ip, mac, note: 'keep' }, other: { ip: 'other.local', mac } } });
  const original = s.read();
  for (const result of [s.register(), s.register('desktop', ['--replace']), s.run(['update', '--name', 'desktop', '--ip', ip]), s.run(['rename', '--name', 'desktop', '--new-name', 'desktop'])]) {
    assert.equal(result.body.changed, false);
    assert.equal(s.read(), original);
  }
  const conflict = fail(s.run(['register', '--name', 'desktop', '--ip', 'new.local', '--mac', mac]), 'target_exists');
  assert.match(conflict.remedy, /--replace/);
  assert.equal(s.read(), original);
  ok(s.run(['register', '--name=desktop', '--ip=new.local', '--mac=A1-B2-C3-D4-E5-F6', '--replace']), 'registered');
  ok(s.run(['update', '--name', 'desktop', '--ip', ip]), 'updated');
  const beforeRename = s.read();
  fail(s.run(['rename', '--name', 'desktop', '--new-name', 'other']), 'target_exists');
  assert.equal(s.read(), beforeRename);
  ok(s.run(['rename', '--name', 'desktop', '--new-name', '__proto__']), 'renamed');
  const config = JSON.parse(s.read());
  assert.deepEqual(config.extra, { a: 1 });
  assert.deepEqual(config.targets.__proto__, { ip, mac: 'A1-B2-C3-D4-E5-F6', note: 'keep' });
  assert.deepEqual(config.targets.other, { ip: 'other.local', mac });
  for (const name of ['other', '__proto__']) ok(s.run(['remove', '--name', name]), 'removed');
  assert.deepEqual(JSON.parse(s.read()).targets, {});
  fail(s.run(['remove', '--name', '__proto__']), 'target_unknown');
});

test('missing sources, invalid names and command usage', t => {
  const s = sandbox(t);
  for (const args of [['update', '--name=x', '--ip', ip], ['rename', '--name=x', '--new-name=y'], ['remove', '--name=x']]) fail(s.run(args), 'target_unknown');
  for (const name of ['', ' desk', 'desk ', '\n']) fail(s.register(name), 'target_config_invalid');
  for (const args of [[], ['unknown'], ['list', '--name=x'], ['list', '--replace'], ['update', '--name=x'], ['register', '--name=x'], ['list', 'x'], ['remove', '--name'], ['remove', '--name', '--json'], ['remove', '--name=x', '--name=y'], ['list', '--bogus'], ['rename', '--name=x', '--new-name=y', '--replace'], ['list', '--json=true'], ['register', '--name=x', '--ip', ip, '--ip', ip, '--mac', mac]]) {
    fail(s.run(args, { scenario: 'old-node' }), 'usage_error');
  }
  assert.equal(fs.existsSync(path.dirname(s.configPath)), false);
});

test('invalid configuration and supplied addresses have structured diagnostics', t => {
  const s = sandbox(t);
  for (const config of ['{', 'null', '[]', { schema_version: 1, targets: [] }, { schema_version: 1, targets: null }, { schema_version: 1, targets: { ' bad': { ip, mac } } }, { schema_version: 1, targets: { desktop: { ip, mac: 123 } } }]) {
    s.write(config);
    const error = fail(s.run(['list']), 'target_config_invalid');
    assert.ok(error.condition.includes(s.configPath));
  }
  for (const version of [undefined, '1', 2, null]) {
    s.write({ schema_version: version, targets: {} });
    fail(s.run(['list']), 'target_config_version_unsupported');
  }
  s.write({ schema_version: 1, targets: {} });
  for (const [key, value] of [['ip', '192.168.01.1'], ['ip', '1.2.3.256'], ['ip', 'bad host'], ['ip', ''], ['mac', 'a1-b2:c3:d4:e5:f6'], ['mac', '']]) {
    const args = ['register', '--name=x', `--ip=${key === 'ip' ? value : ip}`, `--mac=${key === 'mac' ? value : mac}`];
    fail(s.run(args, { scenario: 'old-node' }), 'target_config_invalid');
  }
  fs.unlinkSync(s.configPath);
  fs.mkdirSync(s.configPath);
  fail(s.run(['list']), 'target_config_unreadable');
});

test('management help and preflight do not write or network and need no wake platform', t => {
  const s = sandbox(t);
  assert.equal(s.register('desktop', ['--preflight']).body.operation, 'register');
  assert.equal(fs.existsSync(path.dirname(s.configPath)), false);
  fail(s.register('desktop', [], { scenario: 'old-node' }), 'node_version_unsupported');
  ok(s.register('desktop', [], { scenario: 'platform' }), 'registered');
  const before = s.read();
  for (const args of [['register', '--name=second', '--ip', ip, '--mac', mac], ['update', '--name=desktop', '--ip=new.local'], ['rename', '--name=desktop', '--new-name=new'], ['remove', '--name=desktop'], ['list']]) {
    assert.equal(ok(s.run([...args, '--preflight']), 'ready').operation, args[0]);
    assert.equal(s.read(), before);
  }
  fail(s.register('desktop', ['--preflight', '--ip=new.local']), 'usage_error');
  fail(s.run(['rename', '--name=absent', '--new-name=new', '--preflight']), 'target_unknown');
  s.write('{');
  for (const command of ['register', 'update', 'rename', 'remove', 'list']) {
    const result = s.run([command, '--help'], { json: false, scenario: 'old-node' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
  }
  const result = s.run(['list'], { json: false });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^ERROR \[target_config_invalid\]: .+\nRemedy: .+\n$/);
});

test('persistence failure preserves the original and cleans staging files', t => {
  const s = sandbox(t);
  s.register();
  const original = s.read();
  for (const scenario of ['write-fail', 'rename-fail', 'mkdir-fail']) {
    fail(s.run(['update', '--name=desktop', '--ip=new.local'], { scenario }), 'target_config_write_failed', 1);
    assert.equal(s.read(), original);
    assert.deepEqual(fs.readdirSync(path.dirname(s.configPath)), ['config.json']);
  }
  const text = s.run(['update', '--name=desktop', '--ip=new.local'], { scenario: 'rename-fail', json: false });
  assert.equal(text.status, 1);
  assert.match(text.stderr, /^ERROR \[target_config_write_failed\]:/);
});

test('registration followed by simulated named wake, precedence and read-only results', t => {
  const s = sandbox(t);
  s.register();
  const original = s.read();
  const wake = s.run(['--target=desktop'], { wake: true });
  const { waitedSeconds, ...stableFields } = ok(wake, 'online');
  assert.deepEqual(stableFields, { status: 'online', mac, ip, target: 'desktop' });
  assert.ok(Number.isFinite(waitedSeconds) && waitedSeconds >= 0);
  assert.equal(wake.trace.filter(x => x.event === 'send').length, 2);
  assert.equal(wake.trace.filter(x => x.event === 'ping').at(-1).host, ip);
  const ready = s.run(['--target', 'desktop', '--preflight', '--no-wait'], { wake: true });
  assert.equal(ok(ready, 'ready').timeoutSeconds, 23);
  assert.equal(ready.trace.some(x => x.event === 'send' || x.event === 'ping'), false);
  const override = s.run(['--target=desktop', '--mac=A1-B2-C3-D4-E5-F6', '--ip=override.local', '--timeout=7', '--preflight', '--no-wait'], { wake: true });
  assert.deepEqual(ok(override, 'ready'), { status: 'ready', mac: 'A1-B2-C3-D4-E5-F6', ip: 'override.local', timeoutSeconds: 7, target: 'desktop' });
  for (const flag of ['--mac=', '--ip=', '--timeout=']) {
    const result = s.run(['--target=desktop', flag], { wake: true });
    assert.equal(result.status, 2);
    assert.deepEqual(result.trace, []);
  }
  assert.equal(s.read(), original);
});

test('named validation precedes overrides and networking, unrelated bad entries do not block waking', t => {
  const s = sandbox(t);
  const explicit = ['--mac', mac, '--ip', ip, '--no-wait'];
  fail(s.run(['--target=desktop', ...explicit], { wake: true }), 'target_config_missing');
  s.register();
  for (const name of ['Desktop', 'toString', 'missing']) {
    const result = s.run([`--target=${name}`, ...explicit], { wake: true });
    fail(result, 'target_unknown');
    assert.deepEqual(result.trace, []);
  }
  s.write({ schema_version: 1, targets: { desktop: { ip, mac }, broken: null } });
  ok(s.run(['--target=desktop', '--no-wait'], { wake: true }), 'packet-sent');
  fail(s.run(['list']), 'target_config_invalid');
  for (const config of ['{', { schema_version: 2, targets: {} }, { schema_version: 1, targets: { desktop: { ip, mac: 'bad' } } }]) {
    s.write(config);
    const result = s.run(['--target=desktop', ...explicit], { wake: true, scenario: 'old-node' });
    assert.equal(result.status, 2);
    assert.match(result.body.error.code, /^target_config_/);
    assert.deepEqual(result.trace, []);
    ok(s.run(explicit, { wake: true }), 'packet-sent');
  }
  fs.unlinkSync(s.configPath);
  ok(s.run(explicit, { wake: true }), 'packet-sent');
});

test('named configuration failures identify the requested name and configuration path', t => {
  const s = sandbox(t);
  const name = "office desktop's $desk";
  function check(code, json = true) {
    const result = s.run(['--target', name, '--no-wait'], { wake: true, json });
    assert.deepEqual(result.trace, []);
    if (!json) {
      assert.equal(result.status, 2);
      assert.ok(result.stderr.includes(s.configPath));
      assert.ok(result.stderr.includes(JSON.stringify(name)));
      return;
    }
    const error = fail(result, code);
    assert.ok(error.condition.includes(s.configPath));
    assert.ok(error.condition.includes(JSON.stringify(name)));
    return error;
  }
  const missing = check('target_config_missing');
  assert.ok(missing.remedy.includes("--name='office desktop'\\''s $desk'"));
  assert.equal(fs.existsSync(path.dirname(s.configPath)), false);
  check('target_config_missing', false);
  for (const [config, code] of [
    ['{', 'target_config_invalid'],
    ['null', 'target_config_invalid'],
    [{ schema_version: 2, targets: {} }, 'target_config_version_unsupported'],
    [{ schema_version: 1, targets: [] }, 'target_config_invalid'],
  ]) {
    s.write(config);
    check(code);
  }
  fs.unlinkSync(s.configPath);
  fs.mkdirSync(s.configPath);
  check('target_config_unreadable');
});

test('missing configuration remedy supports names beginning with a hyphen', t => {
  const s = sandbox(t);
  const result = s.run(['--target=-desktop', '--no-wait'], { wake: true });
  const error = fail(result, 'target_config_missing');
  assert.deepEqual(result.trace, []);
  assert.ok(error.remedy.includes("--name='-desktop'"));
  const registered = ok(s.run(['register', '--name=-desktop', '--ip', ip, '--mac', mac]), 'registered');
  assert.equal(registered.name, '-desktop');
  assert.deepEqual(ok(s.run(['list']), 'listed').targets, [{ name: '-desktop', ip, mac }]);
});

test('text management output contains the same result facts', t => {
  const s = sandbox(t);
  const result = s.register('office desktop', [], { json: false });
  assert.equal(result.status, 0, result.stderr);
  for (const value of ['REGISTERED', s.configPath, 'changed: true', 'office desktop', ip, mac]) assert.ok(result.stdout.includes(value));
  const listed = s.run(['list'], { json: false });
  assert.equal(listed.status, 0);
  assert.ok(listed.stdout.includes('office desktop'));
});
