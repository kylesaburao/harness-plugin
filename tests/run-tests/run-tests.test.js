'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/run-tests.js');

function loadRunner() {
  delete require.cache[scriptPath];
  return require(scriptPath);
}

function makeTestTree(groups) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-discovery.'));
  for (const [group, files] of Object.entries(groups)) {
    const directory = path.join(root, 'tests', group);
    fs.mkdirSync(directory, { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(directory, file), '');
  }
  return root;
}

test('CLI accepts only the complete gate, --skip-gif, and --help', () => {
  let result = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /run-tests\.js \[--skip-gif\]/);
  assert.match(result.stdout, /complete local test gate/i);
  assert.match(result.stdout, /omit[\s\S]*create-discord-emoji-gif/i);

  result = spawnSync(process.execPath, [scriptPath, '--unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR \[UNKNOWN_ARGUMENT\]: unrecognized argument: --unknown/);

  result = spawnSync(process.execPath, [scriptPath, '--skip-gif', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR \[INVALID_ARGUMENTS\]/);
});

test('Node test groups are discovered deterministically and ignore non-test files', () => {
  const root = makeTestTree({
    zebra: ['z.test.js'],
    alpha: ['notes.md', 'b.test.js', 'a.test.js'],
    empty: ['helper.js'],
    'create-discord-emoji-gif': ['gif.test.js'],
  });
  const { discoverNodeTestGroups } = loadRunner();

  assert.deepEqual(discoverNodeTestGroups(root, false), [
    'alpha',
    'create-discord-emoji-gif',
    'zebra',
  ]);
  assert.deepEqual(discoverNodeTestGroups(root, true), ['alpha', 'zebra']);
});

test('command plan has stable setup, preflight, Node group, and Python suite order', () => {
  const root = makeTestTree({
    wake: ['wake.test.js'],
    'create-discord-emoji-gif': ['gif.test.js'],
    backup: ['backup.test.js'],
  });
  const { buildCommandPlan } = loadRunner();
  const labels = buildCommandPlan(root, false).map(({ label }) => label);

  assert.deepEqual(labels, [
    'install backup dependencies',
    'create or reuse Python virtual environment',
    'install pypdfium2',
    'initialize ASD-STE100 references',
    'validate ASD-STE100 references',
    'preflight GIF converter (gifski)',
    'preflight GIF converter (gifsicle)',
    'Node tests: backup',
    'Node tests: create-discord-emoji-gif',
    'Node tests: wake',
    'ASD-STE100 Python tests',
  ]);

  const hostedLabels = buildCommandPlan(root, true).map(({ label }) => label);
  assert.equal(hostedLabels.includes('preflight GIF converter (gifski)'), false);
  assert.equal(hostedLabels.includes('preflight GIF converter (gifsicle)'), false);
  assert.equal(hostedLabels.includes('Node tests: create-discord-emoji-gif'), false);
});

test('every orchestration-stage failure stops later commands and returns its status', () => {
  const { runCommandPlan } = loadRunner();
  const plan = Array.from({ length: 8 }, (_, index) => ({
    label: `stage ${index}`,
    command: 'fake',
    args: [String(index)],
  }));

  for (let failureIndex = 0; failureIndex < plan.length; failureIndex += 1) {
    const calls = [];
    const status = runCommandPlan(plan, ({ args }) => {
      calls.push(Number(args[0]));
      return Number(args[0]) === failureIndex ? { status: 17 } : { status: 0 };
    });
    assert.equal(status, 17, `failure at stage ${failureIndex}`);
    assert.deepEqual(calls, Array.from({ length: failureIndex + 1 }, (_, index) => index));
  }
});

test('workflow tests the push SHA or manual main before bump becomes eligible', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/bump-version.yml'), 'utf8');
  assert.match(workflow, /test:\n\s+runs-on: ubuntu-24\.04/);
  assert.match(workflow, /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && 'main' \|\| github\.sha \}\}/);
  assert.match(workflow, /node-version: '22'/);
  assert.match(workflow, /python-version: '3\.12'/);
  assert.match(workflow, /node scripts\/run-tests\.js --skip-gif/);
  assert.match(workflow, /bump:\n\s+needs: test/);
});
