'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const launcher = path.resolve(__dirname, '../../scripts/dev');
function probe(t, args, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dev-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, 'calls.jsonl');
  fs.writeFileSync(path.join(directory, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DEV_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'ps' && process.env.DEV_TEST_BUSY) console.log('active-container');
if (args[0] === 'image' && process.env.DEV_TEST_NO_IMAGE) process.exit(1);
if (args[0] === 'run' && !args.includes('0:0')) process.exit(Number(process.env.DEV_TEST_EXIT || 0));
`, { mode: 0o755 });
  const result = spawnSync(launcher, args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, DEV_TEST_LOG: log, ...extra },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { ...result, calls };
}

test('exec preserves argv and failure status with isolated dependencies', t => {
  const args = ['printf', '%s', 'space here', '"quoted"', '$literal', ''];
  const result = probe(t, ['exec', ...args], { DEV_TEST_EXIT: '37' });
  assert.equal(result.status, 37);
  const run = result.calls.find(call => call[0] === 'run');
  assert.deepEqual(run.slice(-args.length), args);
  for (const flag of ['--rm', '--init', '--sig-proxy=true', '-i']) assert.ok(run.includes(flag));
  assert.ok(!run.includes('-it'));
  assert.equal(run.filter(arg => arg.includes('volume-nocopy')).length, 3);
  assert.equal(run[run.indexOf('--user') + 1], `${process.getuid()}:${process.getgid()}`);
  assert.ok(!result.calls.some(call => ['build', 'create'].includes(call[0])));
});

test('setup initializes only volume ownership and propagates installer failure', t => {
  const result = probe(t, ['setup'], { DEV_TEST_EXIT: '19' });
  assert.equal(result.status, 19);
  const runs = result.calls.filter(call => call[0] === 'run');
  assert.equal(runs.length, 2);
  assert.ok(runs[0].includes('0:0'));
  assert.ok(!runs[0].some(arg => arg.includes('type=bind')));
  assert.deepEqual(runs[1].slice(-2), ['node', 'scripts/setup-tests.js']);
});

test('setup and reset refuse busy volumes before any mutation', t => {
  for (const command of ['setup', 'reset']) {
    const result = probe(t, [command], { DEV_TEST_BUSY: '1' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /in use/);
    assert.ok(!result.calls.some(call => call[0] === 'run' || call.includes('rm') || call.includes('create')));
  }
});

test('reset removes exactly the three dependency volumes and retains image', t => {
  const result = probe(t, ['reset']);
  assert.equal(result.status, 0);
  const removals = result.calls.filter(call => call.includes('rm'));
  assert.equal(removals.length, 3);
  assert.ok(removals.every(call => call[0] === 'volume'));
  assert.equal(new Set(removals.map(call => call[2])).size, 3);
});

test('missing image reports explicit build remedy without building', t => {
  const result = probe(t, ['exec', 'true'], { DEV_TEST_NO_IMAGE: '1' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Remedy: \.\/scripts\/dev build/);
  assert.ok(!result.calls.some(call => ['run', 'build'].includes(call[0])));
});
