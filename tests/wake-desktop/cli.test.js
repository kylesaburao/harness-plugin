'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const script = path.resolve(__dirname, '../../plugins/harness/skills/wake-desktop/scripts/wake-desktop.js');
const fixture = path.join(__dirname, 'simulated-network.cjs');
const base = ['--mac', '02:00:00:00:00:01', '--ip', 'desktop.invalid'];
function cli(scenario, args = [], target = base) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wake-test-'));
  try {
    const result = spawnSync(process.execPath, ['--require', fixture, script, ...target, ...args], {
      env: { ...process.env, HOME: dir, USERPROFILE: dir, MAC_ADDRESS: '', IP_ADDRESS: '', TIMEOUT: '120',
        WAKE_SCENARIO: scenario, WAKE_TRACE: path.join(dir, 'trace.json') },
      encoding: 'utf8', timeout: 6000,
    });
    assert.ifError(result.error);
    return { ...result, trace: JSON.parse(readFileSync(path.join(dir, 'trace.json'), 'utf8')) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function failure(result, status, code) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, '');
  const body = JSON.parse(result.stderr);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'condition', 'remedy']);
  assert.equal(body.error.code, code);
  assert.ok(body.error.condition && body.error.remedy);
}

test('no-wait skips ping and sends exact packets once per port using one prepared socket', () => {
  const result = cli('missing', ['--no-wait', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'packet-sent', mac: base[1], ip: base[3], waitedSeconds: 0 });
  assert.deepEqual(result.trace.map(x => x.event), ['socket', 'broadcast', 'send', 'send', 'close']);
  const sends = result.trace.filter(x => x.event === 'send');
  assert.deepEqual(sends.map(x => x.port), [9, 7]);
  for (const send of sends) {
    assert.equal(send.hex, 'ff'.repeat(6) + '020000000001'.repeat(16));
    assert.equal(send.address, '255.255.255.255');
    assert.equal(send.offset, 0);
    assert.equal(send.length, 102);
  }
});
test('preflight prepares and closes without sending, preserving ready fields', () => {
  const result = cli('missing', ['--preflight', '--no-wait', '--json']);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'ready', mac: base[1], ip: base[3], timeoutSeconds: 120 });
  assert.deepEqual(result.trace.map(x => x.event), ['socket', 'broadcast', 'close']);
});
test('sending precedes the first target probe, including an already reachable host', () => {
  const result = cli('ok', ['--json']);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, 'online');
  assert.deepEqual(result.trace.map(x => x.event), ['ping', 'socket', 'broadcast', 'send', 'send', 'close', 'ping']);
  assert.equal(result.trace[0].host, '127.0.0.1');
});
for (const scenario of ['fail-9', 'fail-7', 'duplicate', 'late-socket-error']) {
  test(`${scenario}: at least one successful send is sufficient`, () => {
    const result = cli(scenario, ['--no-wait', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'packet-sent');
    assert.equal(result.trace.filter(x => x.event === 'close').length, 1);
  });
}
for (const scenario of ['create', 'bind', 'broadcast', 'socket-error', 'both-fail', 'send-throw']) {
  test(`${scenario}: structured startup socket failure`, () => {
    failure(cli(scenario, ['--no-wait', '--json']), 2, 'broadcast_unavailable');
  });
}
test('cleanup failure after sending exits 1', () => {
  failure(cli('close', ['--no-wait', '--json']), 1, 'broadcast_unavailable');
  failure(cli('close', ['--preflight', '--no-wait', '--json']), 2, 'broadcast_unavailable');
});
test('configuration errors precede runtime and platform checks', () => {
  for (const scenario of ['old-node', 'platform']) {
    failure(cli(scenario, ['--json'], []), 2, 'config_missing');
  }
  failure(cli('old-node', ['--json']), 2, 'node_version_unsupported');
  failure(cli('platform', ['--json']), 2, 'platform_unsupported');
});
test('waiting checks ping before sending and preserves target subprocess errors', () => {
  failure(cli('missing', ['--json']), 2, 'command_missing');
  failure(cli('spawn-error', ['--json']), 2, 'probe_unusable');
  failure(cli('loopback-fail', ['--json']), 2, 'probe_unusable');
  failure(cli('target-error', ['--json']), 1, 'command_missing');
});
test('expired real subprocess is killed and reaped without retrying', () => {
  const result = cli('hang', ['--timeout=1', '--json']);
  failure(result, 1, 'host_unreachable');
  assert.equal(result.trace.filter(x => x.event === 'ping').length, 2);
  assert.equal(result.trace.filter(x => x.event === 'send').length, 2);
  assert.equal(result.trace.filter(x => x.event === 'kill').length, 1);
  assert.equal(result.trace.at(-1).event, 'reaped');
});
test('a response after the deadline is not accepted', () => {
  failure(cli('late', ['--timeout=1', '--json']), 1, 'host_unreachable');
});
test('CLI help, text diagnostics and JSON usage errors', () => {
  assert.match(cli('ok', ['--help'], []).stdout, /Usage:/);
  const text = cli('ok', [], []);
  assert.equal(text.status, 2);
  assert.match(text.stderr, /^ERROR \[config_missing\]: .+\nRemedy: .+\n$/);
  failure(cli('ok', ['--bogus', '--json'], []), 2, 'usage_error');
});
