#!/usr/bin/env node
'use strict';

// Repository test orchestrator. This is development tooling and is not shipped with the plugin.
// Minimum Node: 22.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const EXIT = Object.freeze({ OK: 0, FAILED: 1, CANNOT_START: 2 });
const GIF_GROUP = 'create-discord-emoji-gif';
const GIF_SKILL = 'plugins/harness/skills/create-discord-emoji-gif/scripts/node';
const STE_SCRIPTS = 'plugins/harness/skills/write-asd-ste100/scripts';

const USAGE = `Usage: run-tests.js [--skip-gif]

Run the repository test gate using existing dependencies.
Prepare a checkout first with: node scripts/setup-tests.js

With no arguments, run the complete local test gate, including both GIF converter
preflights and all tests under tests/create-discord-emoji-gif/.

Options:
  --skip-gif  Omit both GIF converter preflights and all tests under
              tests/create-discord-emoji-gif/
  --help      Print this message

Exit status: 0 success, 2 bad usage, prerequisite child status, 1 test failure, or 128 + interruption signal.`;

function parseArguments(argv) {
  const unknown = argv.find(argument => argument !== '--skip-gif' && argument !== '--help');
  if (unknown) throw Object.assign(new Error(`unrecognized argument: ${unknown}`), { code: 'UNKNOWN_ARGUMENT' });
  if (argv.length > 1 || new Set(argv).size !== argv.length) throw Object.assign(new Error('use at most one of --skip-gif or --help'), { code: 'INVALID_ARGUMENTS' });
  return { help: argv[0] === '--help', skipGif: argv[0] === '--skip-gif' };
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

function buildSetupPlan(repoRoot) {
  const python = path.join('.venv', 'bin', 'python');
  return [
    command('install backup dependencies', 'npm', [
      'ci', '--omit=dev', '--prefix', 'plugins/harness/skills/back-up-directories',
    ], repoRoot),
    command('create or reuse Python virtual environment', 'python3', [
      '-m', 'venv', '.venv',
    ], repoRoot),
    command('install pypdfium2', python, ['-m', 'pip', 'install', 'pypdfium2'], repoRoot),
    command('initialize ASD-STE100 references', python, [
      path.join(STE_SCRIPTS, 'initialize_references.py'),
    ], repoRoot),
  ];
}

function buildCommandPlan(repoRoot, skipGif) {
  const python = path.join('.venv', 'bin', 'python');
  const plan = [
    command('validate test prerequisites', 'node', ['scripts/setup-tests.js', '--check'], repoRoot),
    command('validate ASD-STE100 references', python, [
      path.join(STE_SCRIPTS, 'validate_references.py'), '--json',
    ], repoRoot),
  ];

  if (!skipGif) {
    plan.push(
      command('preflight GIF converter (gifski)', 'node', [
        path.join(GIF_SKILL, 'mov-to-gif-gifski.js'), '--preflight', '--json',
      ], repoRoot),
      command('preflight GIF converter (gifsicle)', 'node', [
        path.join(GIF_SKILL, 'mov-to-gif.js'), '--preflight', '--json',
      ], repoRoot),
    );
  }

  for (const group of discoverNodeTestGroups(repoRoot, skipGif)) {
    plan.push(command(`Node tests: ${group}`, 'node', [
      '--test', ...nodeTestFiles(repoRoot, group),
    ], repoRoot));
  }

  plan.push(command('ASD-STE100 Python tests', python, [
    '-m', 'unittest', 'discover', '-s', 'tests/write-asd-ste100', '-v',
  ], repoRoot));
  return plan;
}

function spawnCommand(specification) {
  return spawnSync(specification.command, specification.args, {
    cwd: specification.cwd,
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

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`ERROR [${error.code}]: ${error.message}\nRemedy: node scripts/run-tests.js --help\n`);
    return EXIT.CANNOT_START;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }
  const repoRoot = path.resolve(__dirname, '..');
  const { runGate } = require('./test-gate');
  const plan = buildCommandPlan(repoRoot, options.skipGif);
  const groups = Object.fromEntries(discoverNodeTestGroups(repoRoot, options.skipGif).map(group => [group, nodeTestFiles(repoRoot, group)]));
  return runGate({
    root: repoRoot,
    prerequisites: plan.filter(stage => !stage.label.startsWith('Node tests:') && stage.label !== 'ASD-STE100 Python tests'),
    groups,
    fullSearch: options.skipGif ? undefined : 'tests/create-discord-emoji-gif/full-search.test.js',
    python: command('ASD-STE100 Python tests', path.join('.venv', 'bin', 'python'), ['scripts/python-test-reporter.py'], repoRoot),
    excluded: options.skipGif ? [GIF_GROUP] : [],
  });
}

if (require.main === module) Promise.resolve(main(process.argv.slice(2))).then(status => { process.exitCode = status; }).catch(error => { console.error(error); process.exitCode = 1; });

module.exports = {
  buildSetupPlan,
  buildCommandPlan,
  discoverNodeTestGroups,
  main,
  parseArguments,
  runCommandPlan,
};
