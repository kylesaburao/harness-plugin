#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { backupDependencyRoot, buildSetupPlan, runCommandPlan } = require('./run-tests');
const { DEFAULT_TARGET, artifactRoot, parseCommandLine, validateTarget } = require('./artifact-paths');

// archiver must resolve from the user-level backup dependency directory, as
// the skill resolves it, and that install must come from the selected
// artifact's lockfile so the gate tests the dependencies that artifact ships.
// Returns null when that holds, otherwise the reason it does not.
function backupInstallProblem(selected, home = undefined)
{
  const backupSkill = path.join(selected, 'skills/back-up-directories');
  const backupRoot = backupDependencyRoot(home);
  const backupModules = path.join(backupRoot, 'node_modules');
  const missing = `archiver must be installed in the backup dependency directory: ${backupRoot}`;
  if (!fs.existsSync(backupModules)) return missing;
  const backupRequire = createRequire(path.join(backupRoot, 'package.json'));
  let dependency;
  try
  {
    dependency = backupRequire.resolve('archiver');
  }
  catch (error)
  {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  if (!dependency || !dependency.startsWith(fs.realpathSync(backupModules) + path.sep)) return missing;
  const installedLock = path.join(backupRoot, 'package-lock.json');
  const selectedLock = path.join(backupSkill, 'package-lock.json');
  if (!fs.existsSync(installedLock) || !fs.existsSync(selectedLock)
    || !fs.readFileSync(installedLock).equals(fs.readFileSync(selectedLock)))
  {
    return `backup dependencies in ${backupRoot} were not installed from the selected artifact's lockfile: ${backupSkill}`;
  }
  try
  {
    backupRequire('archiver');
  }
  catch (error)
  {
    return `archiver in ${backupRoot} cannot be loaded: ${error.message}`;
  }
  return null;
}

// The selected artifact's own comment helper decides parser readiness, so setup
// and the skill cannot disagree: Node.js floor, user-level location, lockfile
// match with the selected artifact, exact version, and a loadable parse export.
// Returns null when it is ready, otherwise the reason it is not.
function steParserProblem(selected, home = undefined)
{
  const helper = path.join(selected, 'skills/write-asd-ste100/scripts/extract-js-comments.js');
  if (!fs.existsSync(helper)) return `ASD-STE100 comment helper is missing from the selected artifact: ${helper}`;
  const env = home === undefined ? process.env : { ...process.env, HOME: home };
  const probe = spawnSync(process.execPath, [helper, '--preflight', '--json'], { env, encoding: 'utf8' });
  if (probe.status === 0) return null;
  let condition = (probe.stderr || '').trim() || `exit status ${probe.status}`;
  try
  {
    condition = JSON.parse(probe.stderr).error.condition;
  }
  catch
  {
    // Keep the raw stderr when the probe did not print the JSON envelope.
  }
  return `ASD-STE100 comment parser is not ready: ${condition}`;
}

function checkPrerequisites(root, target = 'development', home = undefined)
{
  const selected = artifactRoot(root, target);
  if (!fs.existsSync(selected))
  {
    throw new Error(`Selected artifact is missing: ${selected}`);
  }
  if (!fs.existsSync(path.join(root, 'node_modules/.bin/tsc')))
  {
    throw new Error('Local TypeScript compiler is missing; run npm ci --include=dev');
  }
  const python = path.join(root, '.venv/bin/python');
  if (!fs.existsSync(python))
  {
    throw new Error(`Python environment is missing: ${python}`);
  }
  const backupProblem = backupInstallProblem(selected, home);
  if (backupProblem) throw new Error(backupProblem);
  const probe = spawnSync(python, ['-c', 'import pypdfium2'], { encoding: 'utf8' });
  if (probe.status !== 0)
  {
    throw new Error('pypdfium2 is missing from the Python environment');
  }
  const steProblem = steParserProblem(selected, home);
  if (steProblem) throw new Error(steProblem);
}

function main(argv)
{
  let parsed;
  try
  {
    const values = parseCommandLine(argv, {
      target: { type: 'string' },
      check: { type: 'boolean' },
      help: { type: 'boolean' },
    }, (code, condition) => new Error(condition));
    if (values.check && values.help)
    {
      throw new Error('expected --target development|distribution, --check, or --help');
    }
    parsed = { target: validateTarget(values.target ?? DEFAULT_TARGET), check: values.check, help: values.help };
  }
  catch (error)
  {
    process.stderr.write(`ERROR [usage_error]: ${error.message}\nRemedy: npm run test:setup -- --help\n`);
    return 2;
  }
  if (parsed.help)
  {
    process.stdout.write(`Usage: npm run test:setup [-- [--target development|distribution] [--check | --help]]
Prepare runtime dependencies for an already-built artifact (default: development).
Pass setup options after npm's -- separator. --check only validates installed dependencies.

Examples:
  npm run test:setup
  npm run test:setup -- --check
  npm run test:setup -- --help
  npm run test:setup -- --target development
  npm run test:setup -- --target distribution
`);
    return 0;
  }
  const root = path.resolve(__dirname, '..');
  if (!parsed.check)
  {
    const selected = artifactRoot(root, parsed.target);
    const backupReady = backupInstallProblem(selected) === null;
    if (backupReady)
    {
      process.stdout.write(`Backup dependency already installed for ${parsed.target}; skipping npm ci\n`);
    }
    const steParserReady = steParserProblem(selected) === null;
    if (steParserReady)
    {
      process.stdout.write(`ASD-STE100 comment parser already installed for ${parsed.target}; skipping npm ci\n`);
    }
    return runCommandPlan(buildSetupPlan(root, parsed.target, undefined, { backupReady, steParserReady }), undefined, { summaryLabel: 'Test setup' });
  }
  try
  {
    checkPrerequisites(root, parsed.target);
    return 0;
  }
  catch (error)
  {
    process.stderr.write(`ERROR [test_prerequisite_missing]: ${error.message}\nRemedy: build the selected artifact, then npm run test:setup -- --target ${parsed.target}\n`);
    return 2;
  }
}
if (require.main === module)
{
  process.exitCode = main(process.argv.slice(2));
}
module.exports = { backupInstallProblem, checkPrerequisites, main, steParserProblem };
