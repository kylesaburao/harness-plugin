'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { runGate, childStatus } = require('../../scripts/test-gate');
const pythonAdapter = path.resolve(__dirname, '../../scripts/python-test-reporter.py');
const python = path.resolve(__dirname, '../../.venv/bin/python');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fixture.'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, contents) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), contents); return file; };
  let output = '';
  const signals = new EventEmitter();
  return { root, write, signals, output: () => output, options: { stdout: { write: text => { output += text; } }, stderr: { write: text => { output += text; } }, signals } };
}

function pythonSpec(f) {
  f.write('python/test_sample.py', `import unittest\nclass Sample(unittest.TestCase):\n def test_ok(self): pass\n`);
  return { command: python, args: [pythonAdapter, 'python'] };
}

test('prerequisites remain sequential, preserve statuses, and report all unrun and excluded groups', async t => {
  for (const command of [{ command: process.execPath, args: ['-e', 'process.exit(17)'] }, { command: '/missing-gate-command', args: [] }]) {
    const f = fixture(t);
    const status = await runGate({ root: f.root, prerequisites: [{ label: 'first', ...command }, { label: 'never', command: '/must-not-launch', args: [] }], groups: { alpha: ['unused.test.js'] }, python: pythonSpec(f), excluded: ['create-discord-emoji-gif'], concurrency: 2 }, f.options);
    assert.equal(status, command.command === process.execPath ? 17 : 1);
    assert.match(f.output(), /Unrun \| never/);
    assert.match(f.output(), /Unrun \| alpha/);
    assert.match(f.output(), /Unrun \| write-asd-ste100/);
    assert.match(f.output(), /Excluded \| create-discord-emoji-gif/);
    assert.equal((f.output().match(/TEST GATE:/g) || []).length, 1);
  }
  assert.equal(childStatus({ signal: 'SIGTERM' }), 143);
});

test('Python overlaps full search, pool waits for full search, and failures do not stop later files', async t => {
  const f = fixture(t);
  f.write('python/test_sample.py', `import pathlib, time, unittest\nclass Sample(unittest.TestCase):\n def test_overlap(self):\n  pathlib.Path('python-started').touch()\n  limit=time.monotonic()+10\n  while not pathlib.Path('full-done').exists() and time.monotonic()<limit: time.sleep(.01)\n  self.assertTrue(pathlib.Path('full-done').exists())\n def test_failure(self): self.fail('python evidence')\n @unittest.skip('fixture skip')\n def test_skip(self): pass\n`);
  const full = f.write('tests/gif/full.test.js', `const {test}=require('node:test'); const fs=require('node:fs'); const assert=require('node:assert/strict'); test('full overlap',async()=>{const limit=Date.now()+10000;while(!fs.existsSync('python-started')&&Date.now()<limit) await new Promise(r=>setTimeout(r,10));assert.ok(fs.existsSync('python-started'));fs.writeFileSync('full-done','');});`);
  const pool = ['alpha', 'beta'].map(group => f.write(`tests/${group}/pool.test.js`, `const {test,describe}=require('node:test');const fs=require('node:fs');const assert=require('node:assert/strict'); describe('suite',()=>{test('pool ${group}',async()=>{assert.ok(fs.existsSync('full-done'));fs.writeFileSync('${group}-started','');const limit=Date.now()+10000;while(!fs.existsSync('${group === 'alpha' ? 'beta' : 'alpha'}-started')&&Date.now()<limit)await new Promise(r=>setTimeout(r,10));assert.ok(fs.existsSync('${group === 'alpha' ? 'beta' : 'alpha'}-started'));${group === 'alpha' ? "assert.fail('node evidence');" : ''}});test.skip('skipped',()=>{});test.todo('todo');});`));
  const status = await runGate({ root: f.root, prerequisites: [], groups: { gif: [full], alpha: [pool[0]], beta: [pool[1]] }, fullSearch: full, python: { command: python, args: [pythonAdapter, 'python'] }, concurrency: 2 }, f.options);
  assert.equal(status, 1, f.output());
  assert.match(f.output(), /Failed \| alpha \| 0 passed, 1 failed, 1 skipped, 0 cancelled, 1 todo/);
  assert.match(f.output(), /Passed \| beta \| 1 passed, 0 failed, 1 skipped, 0 cancelled, 1 todo/);
  assert.match(f.output(), /Failed \| write-asd-ste100 \| 1 passed, 1 failed, 1 skipped/);
  assert.match(f.output(), /Aggregate: 3 passed, 2 failed, 3 skipped, 0 cancelled, 2 todo/);
  assert.match(f.output(), /node evidence/);
  assert.match(f.output(), /python evidence/);
  assert.match(f.output(), /test_sample.py:\d+/);
});

test('Python launch errors and Node file crashes still yield a complete final report', async t => {
  const f = fixture(t);
  const crash = f.write('tests/alpha/crash.test.js', "throw new Error('crash evidence');");
  const good = f.write('tests/beta/good.test.js', "require('node:test')('survives',()=>{});");
  assert.equal(await runGate({ root: f.root, prerequisites: [], groups: { alpha: [crash], beta: [good] }, python: { command: '/missing-python', args: [] }, concurrency: 2 }, f.options), 1);
  assert.match(f.output(), /Failed \| alpha/);
  assert.match(f.output(), /Passed \| beta \| 1 passed/);
  assert.match(f.output(), /Failed \| write-asd-ste100/);
  assert.match(f.output(), /crash evidence/);
  assert.match(f.output(), /ENOENT/);
});

test('interruption preserves the first signal, stops scheduling, and terminates active children', async t => {
  const f = fixture(t);
  const pidFile = path.join(f.root, 'pid');
  const descendantPidFile = path.join(f.root, 'descendant-pid');
  const descendantReadyFile = path.join(f.root, 'descendant-ready');
  const original = f.options.stderr.write;
  f.options.stderr.write = text => {
    original(text);
    if (String(text).includes('child ready')) {
      f.signals.emit('SIGTERM');
      f.signals.emit('SIGINT');
    }
  };
  const descendant = `const fs=require('fs');process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),250));fs.writeFileSync(${JSON.stringify(descendantReadyFile)},'');setInterval(()=>{},1000);`;
  const leader = `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));fs.writeFileSync(${JSON.stringify(descendantPidFile)},String(child.pid));const ready=()=>{if(fs.existsSync(${JSON.stringify(descendantReadyFile)}))console.error('child ready');else setTimeout(ready,5)};ready();setInterval(()=>{},1000);`;
  const status = await runGate({ root: f.root, prerequisites: [{ label: 'waiting prerequisite', command: process.execPath, args: ['-e', leader] }], groups: { alpha: ['unused.test.js'] }, python: pythonSpec(f), concurrency: 2 }, f.options);
  assert.equal(status, 143);
  assert.throws(() => process.kill(Number(fs.readFileSync(pidFile)), 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(Number(fs.readFileSync(descendantPidFile)), 0), { code: 'ESRCH' });
  assert.match(f.output(), /Unrun \| alpha/);
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
});

test('interruption during full search cancels active work and leaves the pool unrun', async t => {
  const f = fixture(t);
  const full = f.write('tests/gif/full.test.js', `require('node:test')('waiting',async()=>{require('fs').writeFileSync('test-pid',String(process.pid));console.error('search ready');await new Promise(()=>{});});`);
  const original = f.options.stderr.write;
  f.options.stderr.write = text => {
    original(text);
    if (String(text).includes('search ready')) f.signals.emit('SIGINT');
  };
  const status = await runGate({ root: f.root, prerequisites: [], groups: { gif: [full], alpha: ['unused.test.js'] }, fullSearch: full, python: pythonSpec(f), concurrency: 2 }, f.options);
  assert.equal(status, 130, f.output());
  assert.match(f.output(), /Unrun \| alpha/);
  assert.throws(() => process.kill(Number(fs.readFileSync(path.join(f.root, 'test-pid'))), 0), { code: 'ESRCH' });
});

test('Python subtests and expected failures count each test once', async t => {
  const f = fixture(t);
  f.write('python/test_sample.py', `import unittest\nclass Sample(unittest.TestCase):\n def test_subtests(self):\n  for n in range(2):\n   with self.subTest(n=n): self.fail('subtest failure')\n @unittest.expectedFailure\n def test_expected(self): self.fail('expected')\n @unittest.expectedFailure\n def test_unexpected(self): pass\n`);
  const status = await runGate({ root: f.root, prerequisites: [], groups: {}, python: { command: python, args: [pythonAdapter, 'python'] }, concurrency: 2 }, f.options);
  assert.equal(status, 1);
  assert.match(f.output(), /Aggregate: 0 passed, 2 failed, 0 skipped, 0 cancelled, 1 todo/);
});
