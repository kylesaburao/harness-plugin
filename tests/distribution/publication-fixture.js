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
const { repositoryRoot } = require('../helpers/plugin-paths');
const { workflowSteps } = require('../helpers/workflow-steps');
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

function fixture(t, control = {}, { eligible = true } = {})
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
  const anchor = git(actor, 'rev-parse', 'HEAD');
  if (eligible)
  {
    write(actor, 'src/harness/shared/node/transaction.ts', 'export const snapshot = 1;\n');
    git(actor, 'rm', '-q', 'src/harness/shared/node/obsolete.ts');
  }
  else
  {
    write(actor, 'notes.md', 'non-release documentation\n');
    write(actor, 'tests/probe.js', '// non-release test\n');
    write(actor, 'scripts/test-probe.js', '// non-release tooling\n');
  }
  const source = commit(actor, eligible ? 'eligible source change' : 'non-release changes');
  git(actor, 'push', '-q', 'origin', 'main');
  git(root, 'pull', '-q', '--ff-only');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/bump-version.yml'), 'utf8');
  const shell = workflowSteps(workflow, 'bump').find(step => step.name === 'Publish one validated versioned distribution').run;
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
  if (args[0] === 'run' && args[1] === 'build')
  {
    log('candidate-build');
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
    const distribution = args.includes('distribution');
    log(distribution ? stage : 'candidate-' + stage);
    if (!distribution && !process.env.FIXTURE_CANDIDATE)
    {
      throw Error('Gate tested wrong artifact target');
    }
    if (ctl.fail === stage)
    {
      process.exit(33);
    }
    const source = fs.existsSync('src/harness/shared/node/transaction.ts')
      ? fs.readFileSync('src/harness/shared/node/transaction.ts','utf8') : '';
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
    root, remote, actor, source, anchor, environment,
    candidate(overrides = {}, head = source)
    {
      // An independent event checkout, including on an old-event rerun. Only
      // these disposable fixture clones are reset/cleaned; never the real repo.
      git(root, 'fetch', '-q', 'origin');
      git(root, 'reset', '--hard', head);
      git(root, 'clean', '-ffdx');
      const output = path.join(home, 'candidate-output');
      fs.writeFileSync(output, '');
      fs.writeFileSync(environment.GITHUB_STEP_SUMMARY, '');
      const env = {
        ...environment, FIXTURE_CANDIDATE: '1',
        SOURCE_BEFORE: anchor, SOURCE_HEAD: head,
        GITHUB_OUTPUT: output, ...overrides,
      };
      let stdout = '', stderr = '';
      for (const step of workflowSteps(workflow, 'test'))
      {
        const selected = fs.readFileSync(output, 'utf8').trim().split('=')[1];
        if (step.if)
        {
          assert.equal(step.if, "steps.candidate.outputs.test_candidate == 'true'");
          if (selected !== 'true') continue;
        }
        if (step.uses)
        {
          if (step.uses.startsWith('actions/setup-python@'))
          {
            fs.appendFileSync(log, JSON.stringify({stage:'candidate-python', source:head}) + '\n');
          }
          continue;
        }
        assert.ok(step.run, step.raw);
        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
          cwd: root, env: {...env, TEST_CANDIDATE: selected}, encoding:'utf8', maxBuffer:16*1024*1024,
        });
        stdout += result.stdout;
        stderr += result.stderr;
        if (result.status !== 0) return {...result, stdout, stderr};
      }
      return {
        status: 0, stdout, stderr,
        testCandidate: fs.readFileSync(output, 'utf8').trim(),
        summary: fs.readFileSync(environment.GITHUB_STEP_SUMMARY, 'utf8'),
      };
    },
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

module.exports = { fixture, git, write, commit, assertPassed };
