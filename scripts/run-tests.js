#!/usr/bin/env node
'use strict';

// Repository test orchestrator. This is development tooling and is not shipped with the plugin.
// Minimum Node: 22.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXIT = Object.freeze({ OK: 0, FAILED: 1, CANNOT_START: 2 });
const GIF_GROUP = 'create-discord-emoji-gif';
const GIF_SKILL = 'plugins/harness/skills/create-discord-emoji-gif/scripts/node';
const STE_SCRIPTS = 'plugins/harness/skills/write-asd-ste100/scripts';

const USAGE = `Usage: run-tests.js [--skip-gif]

Run the repository test gate.

With no arguments, run the complete local test gate, including both GIF converter
preflights and all tests under tests/create-discord-emoji-gif/.

Options:
  --skip-gif  Omit both GIF converter preflights and all tests under
              tests/create-discord-emoji-gif/
  --help      Print this message

Exit status: 0 success, 2 bad usage, or the first failed child command's status.`;

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

function buildCommandPlan(repoRoot, skipGif) {
  const python = path.join('.venv', 'bin', 'python');
  const plan = [
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

function runCommandPlan(plan, execute = spawnCommand) {
  for (const specification of plan) {
    process.stdout.write(`\n==> ${specification.label}\n`);
    const result = execute(specification);
    if (result.status !== 0) {
      if (result.error) process.stderr.write(`ERROR [COMMAND_FAILED]: ${result.error.message}\n`);
      return Number.isInteger(result.status) && result.status !== 0 ? result.status : EXIT.FAILED;
    }
  }
  return EXIT.OK;
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
  return runCommandPlan(buildCommandPlan(repoRoot, options.skipGif));
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  buildCommandPlan,
  discoverNodeTestGroups,
  main,
  parseArguments,
  runCommandPlan,
};
