'use strict';

// Runs every script that a shipped skill tells an agent to invoke through the
// CLI contract in root AGENTS.md ("Preflight contract"): `--help` prints usage
// on stdout and exits 0; bad usage exits 2 with `ERROR [code]: condition` and
// `Remedy:` on stderr, or one `{"error":{"code","condition","remedy"}}` object
// under `--json`. Error code names stay skill-specific, so only their presence
// is asserted here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { repositoryRoot, artifactPath } = require('../helpers/plugin-paths');

const skillsRoot = artifactPath('skills');
const python = path.join(repositoryRoot, '.venv/bin/python');
const SCRIPT_REFERENCE = /scripts\/[A-Za-z0-9_./-]+\.(?:js|mjs|py)\b/g;

// The documents an agent follows to dispatch a skill's scripts: SKILL.md plus
// the INSTALL.md and references/*.md files it routes to.
function instructionDocuments(skillDirectory) {
  const documents = ['SKILL.md', 'INSTALL.md']
    .map(name => path.join(skillDirectory, name))
    .filter(file => fs.existsSync(file));
  const references = path.join(skillDirectory, 'references');
  if (fs.existsSync(references)) {
    for (const name of fs.readdirSync(references).sort()) {
      if (name.endsWith('.md')) documents.push(path.join(references, name));
    }
  }
  return documents;
}

function discoverScripts() {
  const scripts = new Map();
  const skills = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  for (const skill of skills) {
    const skillDirectory = path.join(skillsRoot, skill);
    for (const document of instructionDocuments(skillDirectory)) {
      for (const [reference] of fs.readFileSync(document, 'utf8').matchAll(SCRIPT_REFERENCE)) {
        const file = path.join(skillDirectory, reference);
        const label = `${skill}/${reference}`;
        if (!scripts.has(label)) {
          scripts.set(label, { label, file, source: path.relative(skillsRoot, document) });
        }
      }
    }
  }
  return [...scripts.values()].sort((left, right) => left.label.localeCompare(right.label));
}

const scripts = discoverScripts();
const home = fs.mkdtempSync(path.join(repositoryRoot, '.build', 'cli-contract-home-'));

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function run(script, args) {
  const command = script.file.endsWith('.py') ? python : process.execPath;
  const result = spawnSync(command, [script.file, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, HOME: home },
    input: '',
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, `${script.label} ${args.join(' ')}: ${result.error}`);
  return result;
}

function describe(result) {
  return `status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

test('the shipped skills reference scripts to check', () => {
  assert.ok(scripts.length > 0, 'no skill document references a scripts/*.js|*.mjs|*.py file');
});

for (const script of scripts) {
  test(`${script.label}: follows the AGENTS.md CLI contract`, () => {
    assert.ok(fs.existsSync(script.file), `${script.source} references ${script.label}, which is not shipped`);

    const help = run(script, ['--help']);
    assert.equal(help.status, 0, `--help must exit 0\n${describe(help)}`);
    assert.ok(help.stdout.trim().length > 0, `--help must print usage on stdout\n${describe(help)}`);

    const usage = run(script, ['--definitely-unknown']);
    assert.equal(usage.status, 2, `an unknown argument must exit 2\n${describe(usage)}`);
    assert.match(usage.stderr, /ERROR \[/, `stderr must carry ERROR [code]\n${describe(usage)}`);
    assert.match(usage.stderr, /Remedy:/, `stderr must carry Remedy:\n${describe(usage)}`);

    const json = run(script, ['--definitely-unknown', '--json']);
    assert.equal(json.status, 2, `an unknown argument under --json must exit 2\n${describe(json)}`);
    let report;
    assert.doesNotThrow(() => { report = JSON.parse(json.stderr.trim()); },
      `stderr under --json must be one JSON object\n${describe(json)}`);
    assert.equal(typeof report, 'object', `stderr under --json must be one JSON object\n${describe(json)}`);
    for (const field of ['code', 'condition', 'remedy']) {
      assert.equal(typeof report?.error?.[field], 'string', `error.${field} must be a string\n${describe(json)}`);
      assert.ok(report.error[field].length > 0, `error.${field} must not be empty\n${describe(json)}`);
    }
  });
}
