'use strict';

// Execute the actual workflow shell against disposable clones and a bare remote.
// Runtime gates are controlled probes here; assembly and all Git/policy checks are real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { build } = require('../../scripts/build');
const { mutateVersion } = require('../../scripts/bump-version');
const { validateReleaseRecord, findReleaseByRunId } = require('../../scripts/release-policy');
const { repositoryRoot } = require('../helpers/plugin-paths');
const fixed = '1999-12-31T23:59:00-08:00';
const gitBinary = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const npmBinary = execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
const baseEnv = { ...process.env, GIT_AUTHOR_DATE: fixed, GIT_COMMITTER_DATE: fixed };

function git(root, ...args)
{
  const result = spawnSync(gitBinary, args, { cwd: root, env: baseEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, name, text)
{
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function commit(root, subject)
{
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', subject);
  return git(root, 'rev-parse', 'HEAD');
}

let seed;
test.before(() =>
{
  seed = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-publication-seed-'));
  for (const name of ['src', 'scripts', '.github'])
  {
    fs.cpSync(path.join(repositoryRoot, name), path.join(seed, name), { recursive: true });
  }
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', '.gitignore'])
  {
    fs.copyFileSync(path.join(repositoryRoot, name), path.join(seed, name));
  }
  fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(seed, 'node_modules'));
  fs.appendFileSync(path.join(seed, '.gitignore'), '\n/node_modules\n');
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.name', 'Publication Fixture');
  git(seed, 'config', 'user.email', 'fixture@example.invalid');
  git(seed, 'config', 'core.hooksPath', '/dev/null');
  write(seed, 'src/harness/shared/node/obsolete.ts', 'export const obsolete = true;\n');
  build(seed, { target: 'distribution' });
  const parent = commit(seed, 'synthetic source bootstrap');
  const result = mutateVersion(seed, 'patch');
  build(seed, { target: 'distribution' });
  commit(seed, `chore: bump version to ${result.next}\n\nHarness-Source: ${parent}\nHarness-Release-Run: 1`);
});
test.after(() => fs.rmSync(seed, { recursive: true, force: true }));

function fixture(t, control = {})
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-publication-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const remote = path.join(home, 'remote.git');
  git(home, 'clone', '-q', '--bare', seed, remote);
  const root = path.join(home, 'runner');
  const actor = path.join(home, 'actor');
  for (const clone of [root, actor])
  {
    git(home, 'clone', '-q', remote, clone);
    git(clone, 'config', 'user.name', 'Publication Fixture');
    git(clone, 'config', 'user.email', 'fixture@example.invalid');
  }
  write(actor, 'src/harness/shared/node/transaction.ts', 'export const snapshot = 1;\n');
  git(actor, 'rm', '-q', 'src/harness/shared/node/obsolete.ts');
  const source = commit(actor, 'eligible source change');
  git(actor, 'push', '-q', 'origin', 'main');
  git(root, 'pull', '-q', '--ff-only');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/bump-version.yml'), 'utf8');
  const marker = workflow.indexOf('      - name: Publish one validated versioned distribution');
  assert.ok(marker >= 0);
  const run = workflow.indexOf('        run: |\n', marker);
  const shell = workflow.slice(run + '        run: |\n'.length).split('\n').map(line => line.slice(10)).join('\n');
  const shellFile = path.join(home, 'publish.sh');
  fs.writeFileSync(shellFile, shell);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const controlFile = path.join(home, 'control.json');
  fs.writeFileSync(controlFile, JSON.stringify(control));
  const log = path.join(home, 'events.jsonl');
  const wrapper = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const ctl = JSON.parse(fs.readFileSync(process.env.FIXTURE_CONTROL, 'utf8'));
const realGit = ${JSON.stringify(gitBinary)};
const realNode = ${JSON.stringify(process.execPath)};
const realNpm = ${JSON.stringify(npmBinary)};
function git(cwd, args)
{
  const r = cp.spawnSync(realGit, args, {cwd, encoding:'utf8'});
  if (r.status)
  {
    throw Error(r.stderr);
  }
  return r.stdout.trim();
}
function log(stage)
{
  fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({stage, source:git(process.cwd(),['rev-parse','HEAD'])})+'\\n');
}
function exec(binary)
{
  const r = cp.spawnSync(binary,args,{stdio:'inherit'});
  process.exit(r.status === null ? 1 : r.status);
}
if (tool === 'npm')
{
  if (args[0] === 'ci')
  {
    log('install');
    fs.symlinkSync(${JSON.stringify(path.join(repositoryRoot, 'node_modules'))},path.join(process.cwd(),'node_modules'));
    process.exit(0);
  }
  if (args[0] === 'run' && args[1] === 'build:dist')
  {
    log('build');
    if (ctl.fail === 'build')
    {
      process.exit(31);
    }
  }
  if (args[0] === 'run' && args[1] === 'build:dist:check' && ctl.fail === 'check')
  {
    process.exit(32);
  }
  exec(realNpm);
}
if (tool === 'node')
{
  if (args[0] === 'scripts/check-release.js' && args.includes('--staged') && ctl.mutateAfterStage)
  {
    fs.appendFileSync('dist/harness/shared/node/transaction.js','// changed after staging\\n');
  }
  if (args[0] === 'scripts/setup-tests.js' || args[0] === 'scripts/run-tests.js')
  {
    const stage = args[0].includes('setup') ? 'setup' : 'test';
    log(stage);
    if (!args.includes('distribution'))
    {
      throw Error('Gate tested wrong artifact target');
    }
    if (ctl.fail === stage)
    {
      process.exit(33);
    }
    const source = fs.readFileSync('src/harness/shared/node/transaction.ts','utf8');
    if (ctl.failRaced && source.includes('snapshot = 2'))
    {
      process.exit(34);
    }
    if (stage === 'test' && ctl.mutateSource)
    {
      fs.appendFileSync('src/harness/shared/node/transaction.ts','// unexpected edit\\n');
    }
    process.exit(0);
  }
  exec(realNode);
}
if (tool === 'git')
{
  if (args[0] === 'fetch' && ctl.failInspect && ctl.pushes && !ctl.inspectFailureUsed)
  {
    ctl.inspectFailureUsed = true;
    fs.writeFileSync(process.env.FIXTURE_CONTROL,JSON.stringify(ctl));
    process.exit(38);
  }
  if (args[0] === 'commit' && ctl.fail === 'commit')
  {
    process.exit(35);
  }
  if (args[0] === 'push' && args.includes('HEAD:refs/heads/main'))
  {
    log('push');
    ctl.pushes = (ctl.pushes || 0) + 1;
    fs.writeFileSync(process.env.FIXTURE_CONTROL,JSON.stringify(ctl));
    if (ctl.reject)
    {
      process.exit(36);
    }
    if (ctl.races && ctl.pushes <= ctl.races)
    {
      const actor = process.env.FIXTURE_ACTOR;
      git(actor,['pull','-q','--ff-only']);
      fs.writeFileSync(path.join(actor,'src/harness/shared/node/transaction.ts'),'export const snapshot = '+(ctl.pushes+1)+';\\n');
      git(actor,['add','src/harness/shared/node/transaction.ts']);
      if (ctl.workflowRace)
      {
        fs.appendFileSync(path.join(actor,'.github/workflows/bump-version.yml'),'\\n# changed workflow\\n');
        git(actor,['add','.github/workflows/bump-version.yml']);
      }
      git(actor,['commit','-qm','raced source change']);
      git(actor,['push','-q','origin','main']);
    }
    if (ctl.transportError)
    {
      const r = cp.spawnSync(realGit,args,{stdio:'inherit'});
      if (r.status)
      {
        process.exit(r.status);
      }
      process.exit(37);
    }
  }
  exec(realGit);
}
`;
  for (const name of ['git', 'node', 'npm'])
  {
    fs.writeFileSync(path.join(bin, name), wrapper, { mode: 0o755 });
  }
  const environment = {
    ...baseEnv,
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'kylesaburao/harness-plugin',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push',
    GITHUB_WORKSPACE: root, GITHUB_WORKFLOW_SHA: source, GITHUB_RUN_ID: '42',
    RUNNER_TEMP: home, GITHUB_STEP_SUMMARY: path.join(home, 'summary'),
    FIXTURE_CONTROL: controlFile, FIXTURE_EVENTS: log, FIXTURE_ACTOR: actor,
    DISPATCH_LEVEL: '',
  };
  return {
    root, remote, actor, source, environment,
    run(overrides = {})
    {
      return spawnSync('bash', [shellFile], {cwd: root, env: {...environment,...overrides}, encoding:'utf8', maxBuffer:16*1024*1024});
    },
    events()
    {
      return fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    },
  };
}

function assertPassed(result)
{
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('actual assembly publishes once after a real Git race; rerun is idempotent', t =>
{
  const f = fixture(t, { races: 1 });
  assertPassed(f.run());
  const head = git(f.remote, 'rev-parse', 'main');
  const record = validateReleaseRecord(f.remote, head, {requireTrailers:true});
  const tests = f.events().filter(e => e.stage === 'test');
  assert.equal(tests.length, 2);
  assert.equal(tests[0].source, f.source);
  assert.notEqual(tests[1].source, f.source);
  assert.equal(record.parent, tests[1].source);
  assert.match(git(f.remote, 'show', `${head}:dist/harness/shared/node/transaction.js`), /snapshot = 2/);
  assert.equal(git(f.remote, 'ls-tree', head, '--', 'dist/harness/shared/node/obsolete.js'), '');
  assertPassed(f.run({GITHUB_RUN_ATTEMPT:'2'}));
  assert.equal(git(f.remote, 'rev-parse', 'main'), head);
  assert.equal(f.events().filter(e => e.stage === 'test').length, 2);
});

test('a transport error after acceptance resolves the published run without a second bump', t =>
{
  const f = fixture(t, {transportError:true});
  assertPassed(f.run());
  const release = findReleaseByRunId(f.remote, 'main', '42');
  assert.ok(release);
  assert.equal(f.events().filter(e => e.stage === 'push').length, 1);
});

test('failed post-push inspection reports uncertainty and the same run later resolves it', t =>
{
  const f = fixture(t, {failInspect:true});
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /uncertain publication/);
  const published = findReleaseByRunId(f.remote, 'main', '42');
  assert.ok(published);
  assertPassed(f.run({GITHUB_RUN_ATTEMPT:'2'}));
  assert.equal(git(f.remote, 'rev-parse', 'main'), published.commit);
  assert.equal(f.events().filter(e => e.stage === 'push').length, 1);
});

test('a raced workflow change stops before another install or gate', t =>
{
  const f = fixture(t, {races:1,workflowRace:true});
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executed workflow/);
  assert.equal(f.events().filter(e => e.stage === 'install').length, 1);
  assert.equal(findReleaseByRunId(f.remote, 'main', '42'), null);
});

test('a post-staging artifact edit cannot publish', t =>
{
  const f = fixture(t, {mutateAfterStage:true});
  assert.notEqual(f.run().status, 0);
  assert.equal(git(f.remote, 'rev-parse', 'main'), f.source);
});

test('invalid submitted version metadata is rejected before regeneration can hide it', t =>
{
  const f = fixture(t);
  const canonicalPath = 'src/harness/package.json';
  const pkg = JSON.parse(fs.readFileSync(path.join(f.actor, canonicalPath), 'utf8'));
  write(f.actor, canonicalPath, JSON.stringify({...pkg,version:'99.0.0'}));
  const invalid = commit(f.actor, 'unauthorized version edit');
  git(f.actor, 'push', '-q', 'origin', 'main');
  assert.notEqual(f.run().status, 0);
  assert.equal(git(f.remote, 'rev-parse', 'main'), invalid);
  assert.equal(f.events().length, 0);
});

test('a raced snapshot failing its gate cannot publish the prior tested artifact', t =>
{
  const f = fixture(t, {races:1, failRaced:true});
  assert.notEqual(f.run().status, 0);
  assert.equal(findReleaseByRunId(f.remote, 'main', '42'), null);
  assert.equal(f.events().filter(e => e.stage === 'test').length, 1);
});

test('each publication-stage failure leaves the remote unchanged', t =>
{
  for (const fail of ['build','setup','test','check','commit'])
  {
    const f = fixture(t, {fail});
    assert.notEqual(f.run().status, 0, fail);
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.source, fail);
  }
});

test('unexpected source edits during testing fail before staging publication', t =>
{
  const f = fixture(t, {mutateSource:true});
  assert.notEqual(f.run().status, 0);
  assert.equal(git(f.remote, 'rev-parse', 'main'), f.source);
});

test('persistent push rejection does not retry without source advancement', t =>
{
  const f = fixture(t, {reject:true});
  assert.notEqual(f.run().status, 0);
  assert.equal(f.events().filter(e => e.stage === 'push').length, 1);
  assert.equal(git(f.remote, 'rev-parse', 'main'), f.source);
});

test('three real push races exhaust the bounded retry without publishing', t =>
{
  const f = fixture(t, {races:3});
  assert.notEqual(f.run().status, 0);
  assert.equal(f.events().filter(e => e.stage === 'test').length, 3);
  assert.equal(findReleaseByRunId(f.remote, 'main', '42'), null);
});

test('manual choice governs pending tags and supports release with no pending source', t =>
{
  const f = fixture(t);
  write(f.actor, 'pending-notes.md', 'operator chooses the level\n');
  commit(f.actor, 'pending notes [bump:major]');
  git(f.actor, 'push', '-q', 'origin', 'main');
  assertPassed(f.run({GITHUB_EVENT_NAME:'workflow_dispatch',DISPATCH_LEVEL:'patch'}));
  assert.equal(validateReleaseRecord(f.remote, 'main').level, 'patch');
  for (const [level, runId] of [['minor','43'], ['major','44'], ['patch','45']])
  {
    const before = validateReleaseRecord(f.remote, 'main');
    assertPassed(f.run({GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ID:runId,DISPATCH_LEVEL:level}));
    const after = validateReleaseRecord(f.remote, 'main');
    assert.equal(after.level, level);
    assert.equal(after.previous, before.version);
  }
});

test('a new automatic run with no eligible range does not rebuild or bump', t =>
{
  const f = fixture(t);
  assertPassed(f.run());
  const before = git(f.remote, 'rev-parse', 'main');
  const tests = f.events().filter(e => e.stage === 'test').length;
  assertPassed(f.run({GITHUB_RUN_ID:'46'}));
  assert.equal(git(f.remote, 'rev-parse', 'main'), before);
  assert.equal(f.events().filter(e => e.stage === 'test').length, tests);
});

test('moving a release to second-parent ancestry fails safely instead of double publishing', t =>
{
  const f = fixture(t);
  assertPassed(f.run());
  const release = git(f.remote, 'rev-parse', 'main');
  git(f.actor, 'fetch', '-q', 'origin');
  git(f.actor, 'merge', '--no-ff', '-m', 'inherit release through second parent', release);
  const merge = git(f.actor, 'rev-parse', 'HEAD');
  git(f.actor, 'push', '-q', 'origin', 'main');
  const tests = f.events().filter(e => e.stage === 'test').length;
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release-owned subject namespace/);
  assert.equal(git(f.remote, 'rev-parse', 'main'), merge);
  assert.equal(f.events().filter(e => e.stage === 'test').length, tests);
});

test('stale executed workflow and invalid publication contexts fail before mutation', t =>
{
  const f = fixture(t);
  const workflowPath = '.github/workflows/bump-version.yml';
  fs.appendFileSync(path.join(f.actor, workflowPath), '\n# new workflow definition\n');
  const changed = commit(f.actor, 'change release workflow');
  git(f.actor, 'push', '-q', 'origin', 'main');
  const stale = f.run();
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /STALE_WORKFLOW|executed workflow/);
  assert.equal(git(f.remote, 'rev-parse', 'main'), changed);
  assert.equal(f.events().length, 0);
  for (const context of [
    {GITHUB_REF:'refs/heads/topic'},
    {GITHUB_EVENT_NAME:'pull_request'},
    {GITHUB_REPOSITORY:'another/repository'},
    {GITHUB_RUN_ID:''},
  ])
  {
    assert.notEqual(f.run(context).status, 0);
    assert.equal(git(f.remote, 'rev-parse', 'main'), changed);
  }
});
