#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateArtifact, inventory, classify, outputPath } = require('./build');

function validateTracked(root, files, records) {
  const output = records ?? execFileSync('git', ['ls-files', '--stage', '-z', '--', 'dist'], { cwd: root, encoding: 'utf8' });
  const tracked = new Map(output.split('\0').filter(Boolean).map(line => {
    const separator = line.indexOf('\t');
    const metadata = line.slice(0, separator);
    const name = line.slice(separator + 1);
    const [mode, , stage] = metadata.split(' ');
    if (stage !== '0') throw new Error(`Unmerged distribution path: ${name}`);
    return [name, mode];
  }));
  for (const [name, entry] of files) {
    const expected = entry.mode === 0o755 ? '100755' : '100644';
    if (tracked.get(`dist/harness/${name}`) !== expected) throw new Error(`Distribution file missing from index or wrong executable bit: ${name}`);
  }
  for (const name of tracked.keys()) {
    if (!name.startsWith('dist/harness/') || !files.has(name.slice('dist/harness/'.length))) throw new Error(`Forbidden/stale tracked artifact: ${name}`);
  }
}

function validate(root, tracked = false, records) {
  const files = validateArtifact(path.join(root, 'dist/harness'));
  const source = inventory(path.join(root, 'src/harness'));
  const expected = new Set();
  for (const [name, entry] of source) {
    const kind = classify(name);
    const output = kind === 'typescript' ? outputPath(name) : name;
    if (output === null) continue;
    expected.add(output);
    const installed = files.get(output);
    if (!installed || installed.mode !== entry.mode) throw new Error(`Missing artifact or wrong mode: ${output}`);
    if (kind === 'asset' && !fs.readFileSync(entry.absolute).equals(fs.readFileSync(installed.absolute))) throw new Error(`Asset differs from source: ${name}`);
  }
  for (const name of files.keys()) if (!expected.has(name)) throw new Error(`Unexpected artifact: ${name}`);
  if (tracked) validateTracked(root, files, records);
  return files.size;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const supplied = args.length === 2 && args[0] === '--tracked-records' && !args[1].startsWith('--');
  if (!supplied && !(args.length === 0 || (args.length === 1 && args[0] === '--tracked'))) { process.stderr.write('Usage: node scripts/validate-dist.js [--tracked | --tracked-records PATH]\n'); process.exitCode = 2; }
  else {
    try {
      const records = supplied ? fs.readFileSync(args[1], 'utf8') : undefined;
      process.stdout.write(`Distribution validation passed: ${validate(path.resolve(__dirname, '..'), supplied || args.includes('--tracked'), records)} files.\n`);
    }
    catch (error) { process.stderr.write(`ERROR [invalid_distribution]: ${error.message}\n`); process.exitCode = 1; }
  }
}
module.exports = { validate, validateTracked };
