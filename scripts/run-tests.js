#!/usr/bin/env node
'use strict';

// Repository test orchestrator. This is development tooling and is not shipped with the plugin.
// Repository Node runtime: see .nvmrc.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { DEFAULT_TARGET, artifactRoot, parseCommandLine, validateTarget } = require('./artifact-paths');

const EXIT = Object.freeze({ OK: 0, FAILED: 1, CANNOT_START: 2 });
const GIF_GROUP = 'create-discord-emoji-gif';

const USAGE = `Usage: npm test [-- [--target development|distribution] [--skip-gif | --help]]

Run the repository test gate using existing dependencies.
Prepare an already-built checkout first with: npm run test:setup
Pass runner options after npm's -- separator.

With no arguments, run the complete local test gate, including both GIF converter
preflights and all tests under tests/create-discord-emoji-gif/.

Options:
  --target development|distribution  Select the artifact (default: development)
  --skip-gif  Omit both GIF converter preflights and all tests under
              tests/create-discord-emoji-gif/
  --help      Print this message

Examples:
  npm test
  npm test -- --skip-gif
  npm test -- --target development --skip-gif
  npm test -- --target distribution
  npm test -- --help
  npm test -- --target distribution --help

Exit status: 0 success, 2 bad usage, prerequisite child status, 1 test failure, or 128 + interruption signal.`;

function parseArguments(argv)
{
  const values = parseCommandLine(argv, {
    target: { type: 'string' },
    'skip-gif': { type: 'boolean' },
    help: { type: 'boolean' },
  }, (code, condition) => Object.assign(new Error(condition), { code }));
  const target = validateTarget(values.target ?? DEFAULT_TARGET);
  if (values['skip-gif'] && values.help)
  {
    throw Object.assign(new Error('use at most one of --skip-gif or --help'), { code: 'INVALID_ARGUMENTS' });
  }
  return { target, help: values.help, skipGif: values['skip-gif'] };
}

function nodeTestFiles(repoRoot, group) {
  const directory = path.join(repoRoot, 'tests', group);
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => path.join('tests', group, entry.name))
    .sort();
}

function discoverNodeTestGroups(repoRoot, skipGif) {
  const testsRoot = path.join(repoRoot, 'tests');
  return fs.readdirSync(testsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((group) => !(skipGif && group === GIF_GROUP))
    .filter((group) => nodeTestFiles(repoRoot, group).length > 0)
    .sort();
}

function command(label, executable, args, repoRoot) {
  return { label, command: executable, args, cwd: repoRoot };
}

// The backup skill resolves archiver only from its user-level state directory,
// never from the installed skill, so setup installs it there from the selected
// artifact's manifest and lockfile. These stages mirror the skill's own
// dependency_missing remedy.
function backupDependencyRoot(home = os.homedir())
{
  return path.join(home, '.harness-plugin', 'back-up-directories');
}

function buildSetupPlan(repoRoot, target = 'development', home = os.homedir())
{
  const selected = artifactRoot(repoRoot, target);
  const backupSkill = path.join(selected, 'skills/back-up-directories');
  const backupRoot = backupDependencyRoot(home);
  const python = path.join('.venv', 'bin', 'python');
  return [
    command('verify selected artifact', 'node', ['scripts/build.js', '--target', target, '--check'], repoRoot),
    command('create backup dependency directory', 'mkdir', ['-p', backupRoot], repoRoot),
    command('copy backup dependency manifest and lockfile', 'cp', [
      path.join(backupSkill, 'package.json'), path.join(backupSkill, 'package-lock.json'), backupRoot,
    ], repoRoot),
    command('install backup dependencies', 'npm', ['ci', '--omit=dev', '--prefix', backupRoot], repoRoot),
    command('create or reuse Python virtual environment', 'python3', [
      '-m', 'venv', '.venv',
    ], repoRoot),
    command('install pinned Python dependencies', python, [
      '-m', 'pip', 'install', '-r', 'requirements-dev.txt',
    ], repoRoot),
    command('initialize ASD-STE100 references', python, [
      path.join(selected, 'skills/write-asd-ste100/scripts/initialize_references.py'),
    ], repoRoot),
  ].map(spec => ({ ...spec, env: { ...process.env, HARNESS_TEST_TARGET: target } }));
}

function buildNodeTestGroups(repoRoot, skipGif)
{
  return Object.fromEntries(discoverNodeTestGroups(repoRoot, skipGif).map(group => [group, nodeTestFiles(repoRoot, group)]));
}

function buildPrerequisitePlan(repoRoot, skipGif, target = 'development')
{
  const selected = artifactRoot(repoRoot, target);
  const steScripts = path.join(selected, 'skills/write-asd-ste100/scripts');
  const gifSkill = path.join(selected, 'skills/create-discord-emoji-gif/scripts/node');
  const python = path.join('.venv', 'bin', 'python');
  const plan = [
    command('validate test prerequisites', 'node', ['scripts/setup-tests.js', '--target', target, '--check'], repoRoot),
    command('verify selected artifact', 'node', ['scripts/build.js', '--target', target, '--check'], repoRoot),
    command('validate ASD-STE100 references', python, [
      path.join(steScripts, 'validate_references.py'), '--json',
    ], repoRoot),
  ];

  if (!skipGif) {
    plan.push(
      command('preflight GIF converter (gifski)', 'node', [
        path.join(gifSkill, 'mov-to-gif-gifski.js'), '--preflight', '--json',
      ], repoRoot),
      command('preflight GIF converter (gifsicle)', 'node', [
        path.join(gifSkill, 'mov-to-gif.js'), '--preflight', '--json',
      ], repoRoot),
    );
  }

  return plan.map(spec => ({ ...spec, env: { ...process.env, HARNESS_TEST_TARGET: target } }));
}

function spawnCommand(specification) {
  return spawnSync(specification.command, specification.args, {
    cwd: specification.cwd,
    env: specification.env,
    stdio: 'inherit',
  });
}

function runCommandPlan(plan, execute = spawnCommand, {
  now = () => performance.now(),
  stdout = process.stdout,
  stderr = process.stderr,
  summaryLabel = 'Test gate',
} = {}) {
  const started = now();
  let status = EXIT.OK;
  for (const specification of plan) {
    stdout.write(`\n==> ${specification.label}\n`);
    const stageStarted = now();
    const result = execute(specification);
    const elapsed = now() - stageStarted;
    stdout.write(`${specification.label}: ${result.status === 0 ? 'Passed' : 'Failed'} | wall-clock elapsed: ${(elapsed / 1000).toFixed(3)}s\n`);
    if (result.status !== 0) {
      if (result.error) stderr.write(`ERROR [COMMAND_FAILED]: ${result.error.message}\n`);
      status = Number.isInteger(result.status) && result.status !== 0 ? result.status : EXIT.FAILED;
      break;
    }
  }
  stdout.write(`${summaryLabel}: ${status === EXIT.OK ? 'Passed' : 'Failed'} | wall-clock elapsed: ${((now() - started) / 1000).toFixed(3)}s\n`);
  return status;
}

// The gate never installs dependencies, and its prerequisite check only proves
// that pypdfium2 imports, not which version or what else the environment holds.
// Removing .venv after every gate means each gate runs against an environment
// that setup has just built from requirements-dev.txt, not one left over from
// an earlier pin or hand-installed packages. In the container this empties the
// .venv volume, which only carries the environment from one setup to one gate.
async function runWithVenvCleanup(repoRoot, runGate, {
  remove = fs.promises.rm,
  stderr = process.stderr,
} = {}) {
  let status;
  let gateError;
  try {
    status = await runGate();
  } catch (error) {
    gateError = error;
  }

  const venv = path.join(path.resolve(repoRoot), '.venv');
  try {
    try {
      await remove(venv, { recursive: true, force: true });
    } catch (error) {
      // Node can reject the mount-point rmdir before visiting its children.
      // Clean those explicitly, retaining only the empty mounted directory.
      if (error.code !== 'EBUSY' || error.syscall !== 'rmdir' || error.path !== venv) throw error;
      for (const name of await fs.promises.readdir(venv)) await remove(path.join(venv, name), { recursive: true, force: true });
      if ((await fs.promises.readdir(venv)).length !== 0) throw error;
    }
  } catch (error) {
    stderr.write(`ERROR [VENV_CLEANUP_FAILED]: Could not remove ${venv}: ${error.message}\n`);
    if (!gateError && status === EXIT.OK) status = EXIT.FAILED;
  }

  if (gateError) throw gateError;
  return status;
}

async function main(argv, {
  repoRoot = path.resolve(__dirname, '..'),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`ERROR [${error.code}]: ${error.message}\nRemedy: npm test -- --help\n`);
    return EXIT.CANNOT_START;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }
  const { runGate } = require('./test-gate');
  return runWithVenvCleanup(repoRoot, () => runGate({
    root: repoRoot,
    env: { ...process.env, HARNESS_TEST_TARGET: validateTarget(options.target) },
    prerequisites: buildPrerequisitePlan(repoRoot, options.skipGif, options.target),
    groups: buildNodeTestGroups(repoRoot, options.skipGif),
    fullSearch: options.skipGif ? undefined : 'tests/create-discord-emoji-gif/full-search.test.js',
    python: command('ASD-STE100 Python tests', path.join('.venv', 'bin', 'python'), ['scripts/python-test-reporter.py'], repoRoot),
    excluded: options.skipGif ? [GIF_GROUP] : [],
  }), { stderr });
}

if (require.main === module) Promise.resolve(main(process.argv.slice(2))).then(status => { process.exitCode = status; }).catch(error => { console.error(error); process.exitCode = 1; });

module.exports = {
  backupDependencyRoot,
  buildSetupPlan,
  buildPrerequisitePlan,
  buildNodeTestGroups,
  discoverNodeTestGroups,
  main,
  parseArguments,
  runCommandPlan,
  runWithVenvCleanup,
};
