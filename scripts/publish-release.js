#!/usr/bin/env node
'use strict';

// The release transaction run by the write-enabled job of
// .github/workflows/bump-version.yml. It selects fresh main, bumps, builds,
// sets up, tests, validates, commits and pushes one versioned distribution,
// retrying at most three genuine push races, and appends the run's result to the
// step summary. Destructive retry operations (reset, clean) are confined to the
// owned runner checkout that the context checks below establish.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseCommandLine } = require('./artifact-paths');

// The transaction that runs must be the one in the selected source, as the
// workflow file must be (STALE_WORKFLOW). Capture this file's executed bytes.
const EXECUTED_SCRIPT = fs.readFileSync(__filename);
const SCRIPT_PATH = 'scripts/publish-release.js';
const RELEASE_DATE = '1999-12-31T23:59:00-08:00';
const MAX_OUTPUT = 64 * 1024 * 1024;

const USAGE = `Usage: node scripts/publish-release.js

Release-workflow command: publish one validated versioned distribution from fresh
main. It runs only in the canonical GitHub Actions publication context and reads
its inputs from the environment: GITHUB_EVENT_NAME, GITHUB_RUN_ID,
GITHUB_WORKFLOW_SHA, DISPATCH_LEVEL (manual dispatch only), GITHUB_WORKSPACE,
RUNNER_TEMP and GITHUB_STEP_SUMMARY. It resets and cleans the runner checkout.

Exit status: 0 published, already published, or no eligible changes; 2 bad usage;
otherwise the failing step's status (1 for policy failures).`;

class TransactionError extends Error
{
  constructor(code, condition, remedy, exitCode = 1)
  {
    super(condition);
    this.code = code;
    this.condition = condition;
    this.remedy = remedy;
    this.exitCode = exitCode;
  }
}

// A child command failed; it has already reported its own error.
class StepFailure extends Error
{
  constructor(label, status)
  {
    super(`${label} exited ${status}`);
    this.label = label;
    this.status = status;
  }
}

// Each policy call loads release-policy (and its build and artifact-path
// helpers) from the checkout as it is at that moment, as the inline workflow
// scripts did, so a selected source is inspected by its own policy.
function loadPolicy(scriptsDirectory)
{
  for (const key of Object.keys(require.cache))
  {
    if (key !== __filename && key.startsWith(scriptsDirectory + path.sep))
    {
      delete require.cache[key];
    }
  }
  return require(path.join(scriptsDirectory, 'release-policy.js'));
}

function contextFailure(condition)
{
  return new TransactionError('INVALID_PUBLICATION_CONTEXT', condition,
    'run this command only from the main release workflow checkout');
}

function realDirectory(directory)
{
  try
  {
    return fs.realpathSync(directory);
  }
  catch
  {
    return null;
  }
}

// Mirrors the guards that confine destructive operations to the owned runner.
function validateContext(env, cwd)
{
  if (env.GITHUB_ACTIONS !== 'true')
  {
    throw contextFailure('GITHUB_ACTIONS is not true');
  }
  if (env.GITHUB_REPOSITORY !== 'kylesaburao/harness-plugin')
  {
    throw contextFailure('repository is not kylesaburao/harness-plugin');
  }
  if (env.GITHUB_REF !== 'refs/heads/main')
  {
    throw contextFailure('workflow ref is not refs/heads/main');
  }
  const root = realDirectory(cwd);
  if (!env.GITHUB_WORKSPACE || root === null || root !== realDirectory(env.GITHUB_WORKSPACE))
  {
    throw contextFailure('working directory is not GITHUB_WORKSPACE');
  }
  if (realDirectory(__dirname) !== path.join(root, 'scripts'))
  {
    throw contextFailure('this script is not the workspace checkout\'s scripts/publish-release.js');
  }
  if (!['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME))
  {
    throw contextFailure('event is neither push nor workflow_dispatch');
  }
  if (!/^[0-9]+$/.test(env.GITHUB_RUN_ID ?? ''))
  {
    throw new TransactionError('INVALID_RUN_ID', 'Invalid workflow run ID.', 'pass the decimal GITHUB_RUN_ID');
  }
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && !['patch', 'minor', 'major'].includes(env.DISPATCH_LEVEL))
  {
    throw new TransactionError('INVALID_MANUAL_LEVEL', 'Invalid manual level.', 'dispatch with patch, minor, or major');
  }
  if (!env.RUNNER_TEMP || !env.GITHUB_STEP_SUMMARY || !env.GITHUB_WORKFLOW_SHA)
  {
    throw contextFailure('RUNNER_TEMP, GITHUB_STEP_SUMMARY, and GITHUB_WORKFLOW_SHA are required');
  }
  return root;
}

function requireFields(record, fields)
{
  for (const field of fields)
  {
    if (typeof record[field] !== 'string')
    {
      throw new TransactionError('MISSING_TRANSACTION_FIELD', `Missing transaction field: ${field}`,
        'inspect the publication selection and preserve the failure evidence');
    }
  }
  return record;
}

function publish(root, env, state, stdout, stderr)
{
  const scriptsDirectory = path.join(root, 'scripts');
  const runId = env.GITHUB_RUN_ID;
  const manualLevel = env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? env.DISPATCH_LEVEL : null;
  const childEnv = { ...env, GIT_AUTHOR_DATE: RELEASE_DATE, GIT_COMMITTER_DATE: RELEASE_DATE };
  const writerEnv = { ...childEnv, HARNESS_RELEASE_WRITE: '1' };

  // Commands resolve through PATH, as in the workflow shell.
  function spawn(command, args, { capture = false, environment = childEnv } = {})
  {
    const result = spawnSync(command, args, {
      cwd: root,
      env: environment,
      stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
      maxBuffer: MAX_OUTPUT,
    });
    if (result.error)
    {
      throw new TransactionError('COMMAND_START_FAILED', `${command} could not run: ${result.error.message}`,
        `install ${command} on the runner`);
    }
    return { status: result.status === null ? 1 : result.status, stdout: capture ? result.stdout : null };
  }
  function run(label, command, args, options = {})
  {
    state.step = label;
    const result = spawn(command, args, options);
    if (result.status !== 0)
    {
      throw new StepFailure(label, result.status);
    }
    return options.capture ? result.stdout.toString('utf8').trim() : '';
  }
  function step(label, action)
  {
    state.step = label;
    return action();
  }
  function fetchMain()
  {
    return spawn('git', ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']).status;
  }
  // Resolve a prior successful push of this run on fetched main.
  function findExisting()
  {
    return step('find existing release', () =>
    {
      const policy = loadPolicy(scriptsDirectory);
      const record = policy.findReleaseByRunId(root, 'origin/main', runId);
      if (!record)
      {
        return null;
      }
      const anchor = policy.findReleaseAnchor(root, record.parent, { required: true }).commit;
      return requireFields({ ...record, anchor }, ['commit', 'version', 'previous', 'level', 'parent', 'anchor']);
    });
  }
  function adoptExisting(existing)
  {
    state.releaseSha = existing.commit;
    state.next = existing.version;
    state.previous = existing.previous;
    state.level = existing.level;
    state.sourceSha = existing.parent;
    state.anchor = existing.anchor;
  }
  function fail(outcome)
  {
    state.outcome = outcome;
    stderr.write(`::error::${outcome}\n`);
    return 1;
  }
  function assertExecutedScriptCurrent(source)
  {
    step('verify executed publication script', () =>
    {
      const blob = spawn('git', ['cat-file', 'blob', `${source}:${SCRIPT_PATH}`], { capture: true });
      if (blob.status !== 0 || !blob.stdout.equals(EXECUTED_SCRIPT))
      {
        throw new TransactionError('STALE_WORKFLOW',
          `executed workflow script ${SCRIPT_PATH} differs from selected source ${source}`,
          'run the current-main workflow');
      }
    });
  }

  for (let attempt = 1; attempt <= 3; attempt++)
  {
    state.attempt = attempt;
    run('fetch main', 'git', ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    // Resolve a prior successful push before discarding attempt residue.
    const prior = findExisting();
    if (prior)
    {
      adoptExisting(prior);
      state.outcome = 'already published';
      return 0;
    }
    run('reset to fetched main', 'git', ['reset', '--hard', 'origin/main']);
    run('clean checkout', 'git', ['clean', '-ffdx']);
    const selected = step('select publication', () => requireFields(
      loadPolicy(scriptsDirectory).inspectPublication(root, {
        head: 'HEAD', runId, workflowSha: env.GITHUB_WORKFLOW_SHA, manualLevel,
      }),
      ['source', 'anchor', 'previous', 'level'],
    ));
    state.sourceSha = selected.source;
    state.anchor = selected.anchor;
    state.previous = selected.previous;
    state.level = selected.level;
    assertExecutedScriptCurrent(state.sourceSha);
    if (state.level === 'none')
    {
      state.outcome = 'no eligible changes';
      state.next = state.previous;
      return 0;
    }
    const level = state.level;
    const source = state.sourceSha;
    step('check dependency path', () =>
    {
      // A dependency path must not redirect installation outside this runner.
      let present = true;
      try
      {
        fs.lstatSync(path.join(root, 'node_modules'));
      }
      catch (error)
      {
        if (error.code !== 'ENOENT')
        {
          throw error;
        }
        present = false;
      }
      if (present || run('list tracked dependency paths', 'git', ['ls-files', '--', 'node_modules'], { capture: true }) !== '')
      {
        throw new TransactionError('UNEXPECTED_DEPENDENCY_PATH', 'node_modules exists before installation',
          'discard the attempt and preserve the failure evidence');
      }
    });
    run('install dependencies', 'npm', ['ci', '--include=dev']);
    const bumped = run('bump canonical version', 'node', ['scripts/bump-version.js', `--bump-${level}`, '--json'],
      { capture: true, environment: writerEnv });
    state.next = step('verify bump output', () =>
    {
      const result = JSON.parse(bumped);
      if (result.previous !== state.previous || result.level !== level
        || result.next !== loadPolicy(scriptsDirectory).bumpVersion(state.previous, level))
      {
        throw new TransactionError('BUMP_DISAGREES', 'Bump output disagrees with the selected transaction',
          'discard the attempt and preserve the failure evidence');
      }
      return result.next;
    });
    const next = state.next;
    run('build distribution', 'npm', ['run', 'build:dist'], { environment: writerEnv });
    run('set up distribution tests', 'node', ['scripts/setup-tests.js', '--target', 'distribution']);
    run('test distribution', 'node', ['scripts/run-tests.js', '--target', 'distribution', '--skip-gif']);
    state.gatesCompleted += 1;
    run('check distribution freshness', 'npm', ['run', 'build:dist:check']);
    run('validate distribution', 'node', ['scripts/validate-dist.js', '--target', 'distribution']);
    step('validate working release', () => loadPolicy(scriptsDirectory).validateWorkingRelease(root, { base: source, level, next }));
    const tested = step('capture tested inventory', () => loadPolicy(scriptsDirectory).testedInventory(root));
    run('stage release', 'git', ['add', '-A', '--', 'src/harness/package.json', 'dist/']);
    run('validate tracked distribution', 'node', ['scripts/validate-dist.js', '--target', 'distribution', '--tracked']);
    run('check staged release', 'node', ['scripts/check-release.js', '--base', source, '--level', level, '--next', next, '--staged']);
    step('compare tested inventory', () => loadPolicy(scriptsDirectory).assertTestedInventory(root, tested));
    const testedTree = run('write tested tree', 'git', ['write-tree'], { capture: true });
    const messageFile = path.join(state.transactionDirectory, 'message.txt');
    fs.writeFileSync(messageFile, `chore: bump version to ${next}\n\nHarness-Source: ${source}\nHarness-Release-Run: ${runId}\n`);
    run('commit release', 'git', ['commit', '-F', messageFile]);
    state.releaseSha = run('resolve release commit', 'git', ['rev-parse', 'HEAD'], { capture: true });
    if (run('resolve release tree', 'git', ['rev-parse', 'HEAD^{tree}'], { capture: true }) !== testedTree)
    {
      throw new TransactionError('COMMITTED_TREE_CHANGED', 'release commit tree differs from the tested index tree',
        'discard the attempt and preserve the failure evidence');
    }
    run('check release commit', 'node', ['scripts/check-release.js', '--base', source, '--level', level, '--next', next,
      '--commit', state.releaseSha, '--run-id', runId]);
    state.step = 'push release';
    const pushStatus = spawn('git', ['push', 'origin', 'HEAD:refs/heads/main']).status;
    state.step = 'inspect remote';
    if (fetchMain() !== 0)
    {
      return fail(`uncertain publication: remote inspection failed after push status ${pushStatus}; attempted ${state.releaseSha}, run ${runId}`);
    }
    const published = findExisting();
    if (published)
    {
      state.releaseSha = published.commit;
      state.outcome = 'published';
      return 0;
    }
    const remoteSha = run('resolve remote main', 'git', ['rev-parse', 'origin/main'], { capture: true });
    if (remoteSha === source)
    {
      return fail(`push rejected without source advancement (status ${pushStatus})`);
    }
    if (spawn('git', ['merge-base', '--is-ancestor', source, remoteSha]).status !== 0)
    {
      return fail('remote history changed non-fast-forward; explicit recovery required');
    }
    stdout.write(`Source advanced to ${remoteSha}; attempt ${attempt} will be rebuilt and retested.\n`);
  }
  return fail('failed after three source races');
}

function report(env, state)
{
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, [
    `Result: ${state.outcome}`,
    `Selected source: ${state.sourceSha}`,
    `Previous release: ${state.anchor} (${state.previous}); next version: ${state.next}`,
    `Level: ${state.level} (${env.GITHUB_EVENT_NAME})`,
    'Hosted gate: --skip-gif; no GIF or native macOS execution coverage.',
    `Distribution gates completed: ${state.gatesCompleted}`,
    `Release SHA: ${state.releaseSha}; attempt count: ${state.attempt}; run ID: ${env.GITHUB_RUN_ID}`,
    '',
  ].join('\n'));
}

function reportError(error, stderr)
{
  if (error instanceof StepFailure)
  {
    stderr.write(`ERROR [PUBLICATION_STEP_FAILED]: ${error.message}\n`);
    return;
  }
  if (error && error.code && error.condition && error.remedy)
  {
    stderr.write(`ERROR [${error.code}]: ${error.condition}\nRemedy: ${error.remedy}\n`);
    return;
  }
  stderr.write(`ERROR [UNEXPECTED]: ${error && (error.stack || error.message)}\n`);
}

function main(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {})
{
  let root;
  const state = {
    outcome: 'failed before publication',
    sourceSha: 'unknown',
    previous: 'unknown',
    next: 'unknown',
    level: 'unknown',
    anchor: 'unknown',
    releaseSha: 'none',
    attempt: 0,
    gatesCompleted: 0,
    step: 'start',
    transactionDirectory: null,
  };
  try
  {
    const options = parseCommandLine(argv, { help: { type: 'boolean', short: 'h' } },
      (code, condition) => new TransactionError(code, condition, 'node scripts/publish-release.js --help', 2));
    if (options.help)
    {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    root = validateContext(env, cwd);
    for (const [key, value] of [
      ['core.hooksPath', '/dev/null'],
      ['user.name', 'github-actions[bot]'],
      ['user.email', '41898282+github-actions[bot]@users.noreply.github.com'],
    ])
    {
      const result = spawnSync('git', ['config', key, value], { cwd: root, env, stdio: 'inherit' });
      if (result.status !== 0)
      {
        throw new StepFailure(`git config ${key}`, result.status === null ? 1 : result.status);
      }
    }
    state.transactionDirectory = fs.mkdtempSync(path.join(env.RUNNER_TEMP, 'harness-release.'));
  }
  catch (error)
  {
    // Context failures leave no summary, as before the summary was armed.
    reportError(error, stderr);
    return error instanceof StepFailure ? error.status : (error.exitCode ?? 1);
  }
  try
  {
    return publish(root, env, state, stdout, stderr);
  }
  catch (error)
  {
    const status = error instanceof StepFailure ? error.status : 1;
    state.outcome = `failed at publication step ${state.step} (status ${status})`;
    reportError(error, stderr);
    return status;
  }
  finally
  {
    report(env, state);
  }
}

if (require.main === module)
{
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
