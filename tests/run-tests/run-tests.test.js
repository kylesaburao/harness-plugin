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

function captureOutput() {
  const output = { stdout: '', stderr: '' };
  return {
    output,
    stdout: { write: text => { output.stdout += text; } },
    stderr: { write: text => { output.stderr += text; } },
  };
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

test('target selection reaches every setup and prerequisite command without ambient fallback', t =>
{
  const { buildPrerequisitePlan, buildSetupPlan, parseArguments } = loadRunner();
  const root = makeTestTree({ example: ['example.test.js'] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.HARNESS_TEST_TARGET;
  process.env.HARNESS_TEST_TARGET = 'invalid-ambient-target';
  try
  {
    for (const target of ['development', 'distribution'])
    {
      assert.equal(parseArguments(['--target', target, '--skip-gif']).target, target);
      for (const plan of [buildPrerequisitePlan(root, false, target), buildSetupPlan(root, target)])
      {
        for (const command of plan)
        {
          assert.equal(command.env.HARNESS_TEST_TARGET, target);
        }
      }
      const plan = buildSetupPlan(root, target);
      assert.equal(plan.some(spec => spec.label === 'install build dependencies'), false);
      const expectedRoot = path.join(root, target === 'development' ? '.build/harness' : 'dist/harness');
      const expectedSkill = path.join(expectedRoot, 'skills/back-up-directories');
      const home = path.join(root, 'home');
      const dependencyRoot = path.join(home, '.harness-plugin/back-up-directories');
      const homePlan = buildSetupPlan(root, target, home);
      assert.deepEqual(homePlan.find(spec => spec.label === 'copy backup dependency manifest and lockfile').args,
        [path.join(expectedSkill, 'package.json'), path.join(expectedSkill, 'package-lock.json'), dependencyRoot]);
      assert.deepEqual(homePlan.find(spec => spec.label === 'install backup dependencies').args,
        ['ci', '--omit=dev', '--prefix', dependencyRoot]);
    }
    assert.equal(process.env.HARNESS_TEST_TARGET, 'invalid-ambient-target');
    assert.throws(() => parseArguments(['--target', 'elsewhere']));
  }
  finally
  {
    if (previous === undefined)
    {
      delete process.env.HARNESS_TEST_TARGET;
    }
    else
    {
      process.env.HARNESS_TEST_TARGET = previous;
    }
  }
});

test('CLI accepts only the complete gate, --skip-gif, and --help', () => {
  let result = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: npm test .*\[--skip-gif \| --help\]/);
  assert.match(result.stdout, /complete local test gate/i);
  assert.match(result.stdout, /omit[\s\S]*create-discord-emoji-gif/i);

  result = spawnSync(process.execPath, [scriptPath, '--unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR \[UNKNOWN_ARGUMENT\]: unrecognized argument: --unknown/);

  result = spawnSync(process.execPath, [scriptPath, '--skip-gif', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR \[INVALID_ARGUMENTS\]/);
});

test('npm forwards help, target selection, and invalid usage to the real runner', () => {
  for (const args of [['--help'], ['--target', 'distribution', '--help'], ['--unknown']]) {
    const result = spawnSync('npm', ['test', '--', ...args], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(result.status, args.includes('--unknown') ? 2 : 0, result.stdout + result.stderr);
    if (args.includes('--unknown')) {
      assert.match(result.stderr, /ERROR \[UNKNOWN_ARGUMENT\]/);
      assert.match(result.stderr, /Remedy: npm test -- --help/);
    } else {
      assert.match(result.stdout, /Usage: npm test/);
      assert.match(result.stdout, /complete local test gate/i);
    }
  }
});

test('successful, failed, and interrupted gates remove the test virtual environment', async t => {
  const { runWithVenvCleanup } = loadRunner();
  for (const status of [0, 1, 17, 130, 143]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-cleanup.'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.venv'));
    fs.writeFileSync(path.join(root, '.venv', 'sentinel'), 'test-owned');

    assert.equal(await runWithVenvCleanup(root, async () => status), status);
    assert.equal(fs.existsSync(path.join(root, '.venv')), false);
  }
});

test('an unexpected gate error still removes the test virtual environment', async t => {
  const { runWithVenvCleanup } = loadRunner();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-cleanup.'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.venv'));

  await assert.rejects(runWithVenvCleanup(root, async () => {
    throw new Error('unexpected gate error');
  }), /unexpected gate error/);
  assert.equal(fs.existsSync(path.join(root, '.venv')), false);
});

test('help and invalid arguments do not remove the test virtual environment', async t => {
  const { main } = loadRunner();
  for (const argv of [['--help'], ['--unknown']]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-no-cleanup.'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.venv'));
    const capture = captureOutput();

    assert.equal(await main(argv, { repoRoot: root, ...capture }), argv[0] === '--help' ? 0 : 2);
    assert.equal(fs.existsSync(path.join(root, '.venv')), true);
  }
});

test('cleanup failure reports its code and only overrides a successful gate', async () => {
  const { runWithVenvCleanup } = loadRunner();
  for (const [gateStatus, expectedStatus] of [[0, 1], [17, 17], [143, 143]]) {
    const capture = captureOutput();
    const removed = [];
    const status = await runWithVenvCleanup('/resolved/repository', async () => gateStatus, {
      remove: async (target, options) => {
        removed.push([target, options]);
        throw new Error('permission denied');
      },
      stderr: capture.stderr,
    });

    assert.equal(status, expectedStatus);
    assert.deepEqual(removed, [[path.join('/resolved/repository', '.venv'), { recursive: true, force: true }]]);
    assert.equal(capture.output.stderr, `ERROR [VENV_CLEANUP_FAILED]: Could not remove ${path.join('/resolved/repository', '.venv')}: permission denied\n`);
  }
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

test('setup is separate from the prerequisite plan, and test groups are discovered separately', () => {
  const root = makeTestTree({
    wake: ['wake.test.js'],
    'create-discord-emoji-gif': ['gif.test.js'],
    backup: ['backup.test.js', 'archive.test.js'],
  });
  const { buildNodeTestGroups, buildPrerequisitePlan, buildSetupPlan } = loadRunner();
  assert.deepEqual(buildSetupPlan(root).find(stage => stage.label === 'initialize ASD-STE100 references').args, [path.join(root, '.build/harness/skills/write-asd-ste100/scripts/initialize_references.py')]);
  const labels = buildPrerequisitePlan(root, false).map(({ label }) => label);

  // The prerequisite plan holds only prerequisite stages; test groups and the Python
  // suite are passed to runGate separately, so nothing here is built and then filtered out.
  assert.deepEqual(labels, [
    'validate test prerequisites',
    'verify selected artifact',
    'validate ASD-STE100 references',
    'preflight GIF converter (gifski)',
    'preflight GIF converter (gifsicle)',
  ]);
  assert.deepEqual(buildNodeTestGroups(root, false), {
    backup: [path.join('tests', 'backup', 'archive.test.js'), path.join('tests', 'backup', 'backup.test.js')],
    'create-discord-emoji-gif': [path.join('tests', 'create-discord-emoji-gif', 'gif.test.js')],
    wake: [path.join('tests', 'wake', 'wake.test.js')],
  });

  // build.js --check already runs validateArtifact on the selected tree, so the gate
  // compiles and validates once instead of repeating validate-dist.js.
  const plan = buildPrerequisitePlan(root, false);
  assert.equal(plan.some(stage => stage.args.includes('scripts/validate-dist.js')), false);
  assert.equal(plan.filter(stage => stage.args.includes('scripts/build.js')).length, 1);

  assert.deepEqual(buildPrerequisitePlan(root, true).map(({ label }) => label), [
    'validate test prerequisites',
    'verify selected artifact',
    'validate ASD-STE100 references',
  ]);
  assert.deepEqual(Object.keys(buildNodeTestGroups(root, true)), ['backup', 'wake']);
});

test('setup freshness failure stops before runtime dependency installation or initialization', () => {
  const { buildSetupPlan, runCommandPlan } = loadRunner();
  const calls = [];
  const capture = captureOutput();
  const status = runCommandPlan(buildSetupPlan(repoRoot), spec => {
    calls.push([spec.command, ...spec.args]);
    return { status: spec.args.includes('--check') ? 17 : 0 };
  }, { ...capture, summaryLabel: 'Test setup' });
  assert.equal(status, 17);
  assert.deepEqual(calls, [
    ['node', 'scripts/build.js', '--target', 'development', '--check'],
  ]);
  assert.match(capture.output.stdout, /Test setup: Failed/);
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
    const capture = captureOutput();
    const status = runCommandPlan(plan, ({ args }) => {
      calls.push(Number(args[0]));
      return Number(args[0]) === failureIndex ? { status: 17 } : { status: 0 };
    }, capture);
    assert.equal(status, 17, `failure at stage ${failureIndex}`);
    assert.deepEqual(calls, Array.from({ length: failureIndex + 1 }, (_, index) => index));
  }
});

test('stage timers measure invocations and the total includes gaps', () => {
  const { runCommandPlan } = loadRunner();
  const capture = captureOutput();
  const times = [100, 200, 1434, 1600, 3600, 4000];
  assert.equal(runCommandPlan([{ label: 'first' }, { label: 'second' }], () => ({ status: 0 }), {
    ...capture, now: () => times.shift(),
  }), 0);
  assert.equal(capture.output.stdout, '\n==> first\nfirst: Passed | wall-clock elapsed: 1.234s\n\n==> second\nsecond: Passed | wall-clock elapsed: 2.000s\nTest gate: Passed | wall-clock elapsed: 3.900s\n');
  assert.equal(times.length, 0);
});

test('failed exits and launch failures report timing and exactly one final summary', () => {
  const { runCommandPlan } = loadRunner();
  for (const result of [{ status: 17 }, { status: null, error: new Error('spawn missing ENOENT') }]) {
    const capture = captureOutput();
    const times = [0, 100, 350, 500];
    let calls = 0;
    assert.equal(runCommandPlan([{ label: 'failure' }, { label: 'never' }], () => {
      calls += 1;
      return result;
    }, { ...capture, now: () => times.shift() }), result.status ?? 1);
    assert.equal(calls, 1);
    assert.equal(capture.output.stdout, '\n==> failure\nfailure: Failed | wall-clock elapsed: 0.250s\nTest gate: Failed | wall-clock elapsed: 0.500s\n');
    assert.equal(capture.output.stderr, result.error ? 'ERROR [COMMAND_FAILED]: spawn missing ENOENT\n' : '');
  }
});

test('a complete child invocation includes waiting time', () => {
  const { runCommandPlan } = loadRunner();
  const capture = captureOutput();
  const status = runCommandPlan([{
    label: 'waiting child', command: process.execPath,
    args: ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)'],
    cwd: repoRoot,
  }], undefined, capture);
  assert.equal(status, 0);
  const durations = [...capture.output.stdout.matchAll(/wall-clock elapsed: ([\d.]+)s/g)].map(match => Number(match[1]));
  assert.equal(durations.length, 2);
  assert.ok(durations[0] >= 0.150, capture.output.stdout);
  assert.ok(durations[1] >= durations[0], capture.output.stdout);
  assert.equal((capture.output.stdout.match(/Test gate: Passed/g) || []).length, 1);
});

test('setup installs Python packages only from the exact pins in requirements-dev.txt', () =>
{
  const { buildSetupPlan } = loadRunner();
  const python = path.join('.venv', 'bin', 'python');
  const venv = buildSetupPlan(repoRoot).findIndex(stage => stage.label === 'create or reuse Python virtual environment');
  const install = buildSetupPlan(repoRoot).findIndex(stage => stage.label === 'install pinned Python dependencies');
  const initialize = buildSetupPlan(repoRoot).findIndex(stage => stage.label === 'initialize ASD-STE100 references');
  assert.ok(venv >= 0 && venv < install && install < initialize);
  for (const target of ['development', 'distribution'])
  {
    const stage = buildSetupPlan(repoRoot, target)[install];
    assert.equal(stage.command, python);
    assert.deepEqual(stage.args, ['-m', 'pip', 'install', '-r', 'requirements-dev.txt']);
    assert.equal(stage.cwd, repoRoot);
  }
  const requirements = fs.readFileSync(path.join(repoRoot, 'requirements-dev.txt'), 'utf8')
    .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.ok(requirements.length > 0);
  for (const requirement of requirements) assert.match(requirement, /^[A-Za-z0-9._-]+==\d+(\.\d+)*$/);
  const pin = requirements.find(requirement => requirement.startsWith('pypdfium2=='));
  assert.ok(pin, 'pypdfium2 must be pinned');
  const inventory = fs.readFileSync(path.join(repoRoot, 'docs/development/dependencies.md'), 'utf8');
  assert.ok(inventory.includes(`\`${pin}\``), 'dependencies.md must record the pypdfium2 pin');
});

test('workflow limits credentials and validates each versioned distribution before committing it', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/bump-version.yml'), 'utf8');
  assert.match(workflow, /test:\n\s+permissions:\n\s+contents: read\n\s+runs-on: ubuntu-24\.04/);
  assert.match(workflow, /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && 'main' \|\| github\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /bump:\n\s+needs: test\n\s+permissions:\n\s+contents: write/);
  const { workflowSteps } = require('../helpers/workflow-steps');
  for (const job of ['test', 'bump']) {
    const node = workflowSteps(workflow, job).filter(step => step.uses === 'actions/setup-node@v4');
    assert.equal(node.length, 1);
    assert.match(node[0].raw, /node-version-file: '\.nvmrc'/);
    assert.doesNotMatch(node[0].raw, /node-version:/);
  }
  assert.equal((workflow.match(/python-version: '3\.12'/g) || []).length, 2);
  const publish = workflowSteps(workflow, 'bump').at(-1);
  assert.equal(publish.name, 'Publish one validated versioned distribution');
  assert.equal(publish.run, 'node scripts/publish-release.js');
  assert.match(publish.raw, /DISPATCH_LEVEL: \$\{\{ inputs.level \}\}/);
  // The release transaction lives in the publication script.
  const script = fs.readFileSync(path.join(repoRoot, 'scripts/publish-release.js'), 'utf8');
  const reset = script.indexOf("['reset', '--hard', 'origin/main']");
  const bump = script.indexOf("'scripts/bump-version.js', `--bump-${level}`, '--json'", reset);
  const build = script.indexOf("['run', 'build:dist'], { environment: writerEnv }", bump);
  const setup = script.indexOf("['scripts/setup-tests.js', '--target', 'distribution']", build);
  const gate = script.indexOf("['scripts/run-tests.js', '--target', 'distribution', '--skip-gif']", setup);
  const freshness = script.indexOf("['run', 'build:dist:check']", gate);
  const stage = script.indexOf("['add', '-A', '--', 'src/harness/package.json', 'dist/']", freshness);
  const indexed = script.indexOf("'scripts/check-release.js'", stage);
  const commit = script.indexOf("['commit', '-F', messageFile]", indexed);
  assert.ok(reset >= 0 && reset < bump && bump < build && build < setup && setup < gate && gate < freshness && freshness < stage && stage < indexed && indexed < commit);
  assert.match(workflow, /queue: max/);
  assert.ok(!workflow.includes('startsWith(github.event.head_commit.message'));
  assert.ok(!workflow.includes('jq '));
});


test('missing test prerequisites give a setup remedy without installing', () => {
  const root = makeTestTree({ empty: [] });
  try {
    const { checkPrerequisites } = require('../../scripts/setup-tests');
    assert.throws(() => checkPrerequisites(root), /Selected artifact is missing/);
    const { buildPrerequisitePlan } = loadRunner();
    assert.equal(buildPrerequisitePlan(root, false).some(item => item.command === 'npm' || item.args.includes('pip') || item.args.some(arg => arg.includes('initialize_references'))), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('backup dependencies must come from the user-level directory and the selected artifact lockfile', t =>
{
  const root = makeTestTree({empty:[]});
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const write = (name, text) =>
  {
    const file = path.join(root,name);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,text);
  };
  const archiver = directory =>
  {
    write(`${directory}/package.json`,'{"name":"archiver","main":"index.js"}');
    write(`${directory}/index.js`,'module.exports = {};');
  };
  write('node_modules/.bin/tsc','compiler placeholder');
  write('.venv/bin/python','python placeholder');
  write('.build/harness/skills/back-up-directories/package.json','{}');
  write('.build/harness/skills/back-up-directories/package-lock.json','{"lockfileVersion":3}');
  // Root, in-skill, published, and parent-of-dependency-root packages must not satisfy the check.
  for (const directory of ['node_modules/archiver', '.build/harness/skills/back-up-directories/node_modules/archiver',
    'dist/harness/skills/back-up-directories/node_modules/archiver', 'homes/node_modules/archiver']) archiver(directory);
  const {checkPrerequisites} = require('../../scripts/setup-tests');
  // Node caches module resolution per process, so each scenario uses its own home.
  const check = (name, prepare) =>
  {
    const dependencyRoot = `homes/${name}/.harness-plugin/back-up-directories`;
    prepare(dependencyRoot);
    return () => checkPrerequisites(root, 'development', path.join(root, 'homes', name));
  };
  assert.throws(check('absent', () => {}), /archiver must be installed in the backup dependency directory/);
  assert.throws(check('empty', directory => fs.mkdirSync(path.join(root, directory, 'node_modules'), {recursive:true})),
    /archiver must be installed in the backup dependency directory/);
  assert.throws(check('unlocked', directory => archiver(`${directory}/node_modules/archiver`)),
    /not installed from the selected artifact's lockfile/);
  assert.throws(check('stale', directory =>
  {
    archiver(`${directory}/node_modules/archiver`);
    write(`${directory}/package-lock.json`,'{"lockfileVersion":3,"stale":true}');
  }), /not installed from the selected artifact's lockfile/);
  // Every backup check passes; the placeholder interpreter fails the next prerequisite.
  assert.throws(check('installed', directory =>
  {
    archiver(`${directory}/node_modules/archiver`);
    write(`${directory}/package-lock.json`,'{"lockfileVersion":3}');
  }), /pypdfium2 is missing/);
});

test('setup skips the backup install only when the user-level install is ready', t =>
{
  const root = makeTestTree({empty:[]});
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const write = (name, text) =>
  {
    const file = path.join(root,name);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,text);
  };
  const selected = path.join(root, '.build/harness');
  write('.build/harness/skills/back-up-directories/package-lock.json','{"lockfileVersion":3}');
  const {backupInstallProblem} = require('../../scripts/setup-tests');
  const install = (name, lock, withArchiver = true) =>
  {
    const dependencyRoot = `homes/${name}/.harness-plugin/back-up-directories`;
    fs.mkdirSync(path.join(root, dependencyRoot, 'node_modules'), {recursive:true});
    if (withArchiver)
    {
      write(`${dependencyRoot}/node_modules/archiver/package.json`,'{"name":"archiver","main":"index.js"}');
      write(`${dependencyRoot}/node_modules/archiver/index.js`,'module.exports = {};');
    }
    if (lock !== null) write(`${dependencyRoot}/package-lock.json`, lock);
    return path.join(root, 'homes', name);
  };
  assert.equal(backupInstallProblem(selected, install('ready', '{"lockfileVersion":3}')), null);
  assert.match(backupInstallProblem(selected, install('mismatched', '{"lockfileVersion":3,"stale":true}')), /not installed from the selected artifact's lockfile/);
  assert.match(backupInstallProblem(selected, install('damaged', '{"lockfileVersion":3}', false)), /archiver must be installed/);

  const { buildSetupPlan } = loadRunner();
  const labels = plan => plan.map(stage => stage.label);
  const skipped = ['create backup dependency directory', 'copy backup dependency manifest and lockfile', 'install backup dependencies'];
  const full = labels(buildSetupPlan(root, 'development', path.join(root, 'home')));
  assert.deepEqual(labels(buildSetupPlan(root, 'development', path.join(root, 'home'), { backupReady: true })),
    full.filter(label => !skipped.includes(label)));
  assert.ok(skipped.every(label => full.includes(label)));
});

test('cleanup empties a busy venv mount and reports child cleanup failure', async t => {
  const { runWithVenvCleanup } = loadRunner();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-mount.'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const venv = path.join(root, '.venv'); fs.mkdirSync(venv);
  let failChild = false;
  const busy = async (target, options) => {
    if (target === venv) throw Object.assign(new Error('mounted'), { code: 'EBUSY', syscall: 'rmdir', path: venv });
    if (failChild) throw new Error('child cleanup failed');
    await fs.promises.rm(target, options);
  };
  fs.writeFileSync(path.join(venv, 'remove-me'), 'data');
  const capture = captureOutput();
  assert.equal(await runWithVenvCleanup(root, async () => 0, { remove: busy, ...capture }), 0);
  assert.equal(capture.output.stderr, '');
  assert.deepEqual(fs.readdirSync(venv), []);
  failChild = true;
  fs.writeFileSync(path.join(venv, 'unremoved'), 'data');
  assert.equal(await runWithVenvCleanup(root, async () => 0, { remove: busy, ...capture }), 1);
  assert.match(capture.output.stderr, /VENV_CLEANUP_FAILED/);
});
