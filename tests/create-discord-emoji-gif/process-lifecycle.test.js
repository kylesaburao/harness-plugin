'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ProcessManager } = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/process-manager');
const { temporaryDirectory, makeExecutable } = require('./test-helpers');

test('runOldestBounded launches in order and honors its bound', async () => {
  const manager = new ProcessManager();
  let active = 0;
  let maximum = 0;
  const launched = [];
  const results = await manager.runOldestBounded([1, 2, 3, 4], 2, async item => {
    launched.push(item);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, item === 1 ? 20 : 2));
    active -= 1;
    return item * 2;
  });
  assert.deepEqual(launched, [1, 2, 3, 4]);
  assert.equal(maximum, 2);
  assert.deepEqual(results, [2, 4, 6, 8]);
});

test('an oldest worker failure stops queued work and preserves the original error', async () => {
  const manager = new ProcessManager();
  const launched = [];
  const original = Object.assign(new Error('original conversion failure'), { code: 'original_failure' });
  await assert.rejects(manager.runOldestBounded([1, 2, 3], 2, async item => {
    launched.push(item);
    if (item === 1) throw original;
    await new Promise(resolve => setTimeout(resolve, 10));
  }), error => error === original);
  assert.deepEqual(launched, [1, 2]);
  assert.equal(manager.cancelling, true);
});

test('a cancel() failure while cancelling siblings does not mask the original error or skip awaiting pending work', { skip: process.platform === 'win32' }, async () => {
  const directory = temporaryDirectory('runOldestBounded-cancel-failure.');
  const fixture = path.join(directory, 'self-exit.js');
  makeExecutable(fixture, `#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 100);\n`);
  const manager = new ProcessManager();
  const original = Object.assign(new Error('original failure'), { code: 'original_failure' });
  const realSignalChild = manager.signalChild.bind(manager);
  let signalChildCalled = false;
  manager.signalChild = () => {
    signalChildCalled = true;
    throw Object.assign(new Error('simulated EPERM'), { code: 'EPERM' });
  };
  let survivorSettled = false;
  try {
    await assert.rejects(manager.runOldestBounded([1, 2], 2, async item => {
      if (item === 1) {
        await manager.runOwned('survivor', fixture, []);
        survivorSettled = true;
        return;
      }
      throw original;
    }), error => error === original);
  } finally {
    manager.signalChild = realSignalChild;
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(signalChildCalled, true);
  assert.equal(survivorSettled, true);
});

test('a younger worker failure is prompt and leaves the next queued worker unstarted', async () => {
  const directory = temporaryDirectory('younger-worker-failure.');
  const fixture = path.join(directory, 'delayed.js');
  makeExecutable(fixture, `#!/usr/bin/env node
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => process.exit(0), 2000);
`);
  const manager = new ProcessManager();
  const launched = [];
  const original = Object.assign(new Error('younger worker failure'), { code: 'younger_failure' });
  const started = Date.now();
  try {
    await assert.rejects(manager.runOldestBounded([1, 2, 3], 2, async item => {
      launched.push(item);
      if (item === 1) await manager.runOwned('delayed-first', fixture, []);
      if (item === 2) throw original;
    }), error => error === original);
    assert.deepEqual(launched, [1, 2]);
    assert.ok(Date.now() - started < 1000);
    assert.equal(manager.active.size, 0);
  } finally {
    if (manager.active.size) await manager.cancel('SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('owned commands receive direct arguments without shell expansion', async () => {
  const directory = temporaryDirectory('process-manager-args.');
  const executable = path.join(directory, 'record.js');
  const output = path.join(directory, 'args.json');
  makeExecutable(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n`);
  try {
    const manager = new ProcessManager();
    const result = await manager.runOwned('arguments', executable, [output, 'literal *', '$(touch nope)', 'a b']);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), ['literal *', '$(touch nope)', 'a b']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('cancellation prevents later spawns', async () => {
  const manager = new ProcessManager();
  await manager.cancel('SIGTERM');
  assert.throws(() => manager.spawnOwned('late', process.execPath, ['-e', '0']), { code: 'cancelled' });
});

for (const signal of ['SIGTERM']) {
  test(`${signal} reaches an owned child and grandchild process group`, { skip: process.platform === 'win32' }, async () => {
    const directory = temporaryDirectory(`process-manager-${signal}.`);
    const fixture = path.join(directory, 'fixture.js');
    const log = path.join(directory, 'signals.log');
    const ready = path.join(directory, 'ready');
    makeExecutable(fixture, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const signal = process.env.TEST_SIGNAL;
const grandchildCode = "const fs=require('node:fs'); const signal=process.env.TEST_SIGNAL; process.on(signal,()=>{fs.appendFileSync(process.env.TEST_LOG,'grandchild\\\\n'); process.exit(0)}); fs.writeFileSync(process.env.TEST_READY,'ready'); setInterval(()=>{},1000)";
spawn(process.execPath, ['-e', grandchildCode], { stdio: 'ignore', env: process.env });
process.on(signal, () => { fs.appendFileSync(process.env.TEST_LOG, 'child\\n'); setTimeout(() => process.exit(0), 20); });
setInterval(() => {}, 1000);
`);
    let manager;
    try {
      manager = new ProcessManager({ killTimeout: 250 });
      manager.spawnOwned('tree', process.execPath, [fixture], { stdio: 'ignore', env: { ...process.env, TEST_SIGNAL: signal, TEST_LOG: log, TEST_READY: ready } });
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(fs.existsSync(ready), true);
      await manager.cancel(signal);
      const received = fs.readFileSync(log, 'utf8').trim().split('\n').sort();
      assert.deepEqual(received, ['child', 'grandchild']);
    } finally {
      if (manager?.active.size) await manager.cancel('SIGKILL');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('a signal-ignoring group is escalated after the configured timeout', { skip: process.platform === 'win32' }, async () => {
  const directory = temporaryDirectory('process-manager-escalation.');
  const ready = path.join(directory, 'ready');
  const fixture = path.join(directory, 'ignore.js');
  makeExecutable(fixture, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.TEST_READY, 'ready'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`);
  try {
    const manager = new ProcessManager({ killTimeout: 75 });
    manager.spawnOwned('ignoring', fixture, [], { stdio: 'ignore', env: { ...process.env, TEST_READY: ready } });
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const started = Date.now();
    await manager.cancel('SIGTERM');
    assert.ok(Date.now() - started >= 50);
    assert.equal(manager.active.size, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('leader exit leaves its same-group descendant tracked until cancellation', { skip: process.platform === 'win32' }, async () => {
  const directory = temporaryDirectory('process-manager-leader-descendant.');
  const fixture = path.join(directory, 'leader.js');
  const ready = path.join(directory, 'ready');
  const pidFile = path.join(directory, 'descendant.pid');
  makeExecutable(fixture, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const code = "const fs=require('node:fs'); fs.writeFileSync(process.env.TEST_PID,String(process.pid)); fs.writeFileSync(process.env.TEST_READY,'ready'); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000)";
spawn(process.execPath, ['-e', code], { stdio: 'ignore', env: process.env }).unref();
`);
  const manager = new ProcessManager({ killTimeout: 250 });
  try {
    const leader = manager.spawnOwned('leader', fixture, [], { stdio: 'ignore', env: { ...process.env, TEST_READY: ready, TEST_PID: pidFile } });
    await leader.ownedRecord.closed;
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(ready), true);
    assert.equal(manager.active.size, 1);
    assert.equal(manager.groupExists(leader), true);
    await manager.cancel('SIGTERM');
    assert.equal(manager.active.size, 0);
    assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
  } finally {
    if (manager.active.size) await manager.cancel('SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('runOwned waits for a same-group descendant after its leader exits', { skip: process.platform === 'win32' }, async () => {
  const directory = temporaryDirectory('process-manager-run-owned-group.');
  const fixture = path.join(directory, 'leader.js');
  makeExecutable(fixture, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 150)'], { stdio: 'ignore' }).unref();
`);
  try {
    const manager = new ProcessManager();
    const started = Date.now();
    const result = await manager.runOwned('leader', fixture, []);
    assert.equal(result.code, 0);
    assert.ok(Date.now() - started >= 100);
    assert.equal(manager.active.size, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('an escaped descendant is outside the original process group ownership', { skip: process.platform === 'win32' }, async () => {
  const directory = temporaryDirectory('process-manager-escaped-descendant.');
  const fixture = path.join(directory, 'leader.js');
  const pidFile = path.join(directory, 'escaped.pid');
  makeExecutable(fixture, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
require('node:fs').writeFileSync(process.env.TEST_PID, String(child.pid));
child.unref();
`);
  let escapedPid;
  try {
    const manager = new ProcessManager();
    const result = await manager.runOwned('leader', fixture, [], { env: { ...process.env, TEST_PID: pidFile } });
    assert.equal(result.code, 0);
    assert.equal(manager.active.size, 0);
    escapedPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.doesNotThrow(() => process.kill(escapedPid, 0));
  } finally {
    if (escapedPid) { try { process.kill(escapedPid, 'SIGKILL'); } catch {} }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
