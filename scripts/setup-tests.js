#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { buildSetupPlan, runCommandPlan } = require('./run-tests');

function checkPrerequisites(root) {
  const python = path.join(root, '.venv/bin/python');
  if (!fs.existsSync(python)) throw new Error(`Python environment is missing: ${python}`);
  createRequire(path.join(root, 'plugins/harness/skills/back-up-directories/package.json'))('archiver');
  const probe = spawnSync(python, ['-c', 'import pypdfium2'], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error('pypdfium2 is missing from the Python environment');
}

function main(argv) {
  if (argv.length > 1 || argv.some(value => !['--help', '--check'].includes(value))) {
    process.stderr.write('ERROR [usage_error]: expected --check, --help, or no arguments\nRemedy: node scripts/setup-tests.js --help\n');
    return 2;
  }
  if (argv.includes('--help')) {
    process.stdout.write('Usage: node scripts/setup-tests.js [--check]\nInstall development dependencies and initialize references. --check only validates installed dependencies.\n');
    return 0;
  }
  const root = path.resolve(__dirname, '..');
  if (!argv.includes('--check')) return runCommandPlan(buildSetupPlan(root));
  try { checkPrerequisites(root); return 0; }
  catch (error) {
    process.stderr.write(`ERROR [test_prerequisite_missing]: ${error.message}\nRemedy: node scripts/setup-tests.js\n`);
    return 2;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { checkPrerequisites, main };
