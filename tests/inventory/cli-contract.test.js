'use strict';

// Runs every script that a shipped skill tells an agent to invoke through the
// CLI contract in root AGENTS.md ("Preflight contract"): `--help` and `-h` print
// usage on stdout and exit 0; bad usage exits 2 with `ERROR [usage_error]:` and
// `Remedy:` on stderr, or one line holding `{"error":{"code","condition",
// "remedy"}}` under `--json`; a `--preflight --json` run either prints one
// flat `{"status":"ready",...}` line or fails with that error envelope. Envelope
// keys are camelCase and error codes lowercase snake_case. Run-success
// `{"result":{...}}` shapes need real work, so each skill's own tests own them.

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
const prompt = path.join(home, 'advisor-prompt.txt');
fs.writeFileSync(prompt, '[QUESTION]\nreadiness only\n');

// Arguments that let a script reach its own readiness checks without touching
// the network, the user's configuration, or anything outside the test home.
// Scripts not listed run `--preflight --json` with no further arguments.
const PREFLIGHT_ARGUMENTS = {
  'harness-advisor/scripts/advisor-config.js': ['show'],
  'harness-advisor/scripts/claude-advisor.js': ['--native-absent', '--model', 'opus', '--reasoning-effort', 'high', '--prompt', prompt],
  'wake-desktop/scripts/manage-targets.js': ['list'],
  'wake-desktop/scripts/wake-desktop.js': ['--mac', 'a1:b2:c3:d4:e5:f6', '--ip', '192.0.2.1'],
};
const CAMEL_CASE = /^[a-z][A-Za-z0-9]*$/;
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

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

// One JSON object on exactly one line, as the contract requires under --json.
function oneLineObject(text, stream, result) {
  assert.match(text, /^[^\n]+\n$/, `${stream} under --json must be exactly one line\n${describe(result)}`);
  let value;
  assert.doesNotThrow(() => { value = JSON.parse(text); }, `${stream} under --json must be JSON\n${describe(result)}`);
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value),
    `${stream} under --json must be one JSON object\n${describe(result)}`);
  return value;
}

function assertCamelCaseKeys(object, where, result) {
  for (const key of Object.keys(object)) {
    assert.match(key, CAMEL_CASE, `${where} key ${key} must be camelCase\n${describe(result)}`);
  }
}

function assertErrorEnvelope(result) {
  const report = oneLineObject(result.stderr, 'stderr', result);
  assert.deepEqual(Object.keys(report), ['error'], `stderr must hold only {"error":{...}}\n${describe(result)}`);
  for (const field of ['code', 'condition', 'remedy']) {
    assert.equal(typeof report.error?.[field], 'string', `error.${field} must be a string\n${describe(result)}`);
    assert.ok(report.error[field].length > 0, `error.${field} must not be empty\n${describe(result)}`);
  }
  assert.match(report.error.code, SNAKE_CASE, `error.code must be lowercase snake_case\n${describe(result)}`);
  assertCamelCaseKeys(report.error, 'error', result);
  return report.error;
}

test('the shipped skills reference scripts to check', () => {
  assert.ok(scripts.length > 0, 'no skill document references a scripts/*.js|*.mjs|*.py file');
  const labels = new Set(scripts.map(script => script.label));
  for (const label of Object.keys(PREFLIGHT_ARGUMENTS)) {
    assert.ok(labels.has(label), `PREFLIGHT_ARGUMENTS names ${label}, which no skill document references`);
  }
});

for (const script of scripts) {
  test(`${script.label}: follows the AGENTS.md CLI contract`, () => {
    assert.ok(fs.existsSync(script.file), `${script.source} references ${script.label}, which is not shipped`);

    for (const flag of ['--help', '-h']) {
      const help = run(script, [flag]);
      assert.equal(help.status, 0, `${flag} must exit 0\n${describe(help)}`);
      assert.ok(help.stdout.trim().length > 0, `${flag} must print usage on stdout\n${describe(help)}`);
    }

    const usage = run(script, ['--definitely-unknown']);
    assert.equal(usage.status, 2, `an unknown argument must exit 2\n${describe(usage)}`);
    assert.match(usage.stderr, /ERROR \[usage_error\]: /, `stderr must carry ERROR [usage_error]\n${describe(usage)}`);
    assert.match(usage.stderr, /Remedy:/, `stderr must carry Remedy:\n${describe(usage)}`);

    const json = run(script, ['--definitely-unknown', '--json']);
    assert.equal(json.status, 2, `an unknown argument under --json must exit 2\n${describe(json)}`);
    assert.equal(assertErrorEnvelope(json).code, 'usage_error', `bad usage must report usage_error\n${describe(json)}`);

    const preflight = run(script, [...(PREFLIGHT_ARGUMENTS[script.label] ?? []), '--preflight', '--json']);
    if (preflight.status === 0) {
      const report = oneLineObject(preflight.stdout, 'stdout', preflight);
      assert.equal(report.status, 'ready', `a passed preflight must print flat {"status":"ready",...}\n${describe(preflight)}`);
      assertCamelCaseKeys(report, 'preflight report', preflight);
    } else {
      assert.equal(preflight.status, 2, `a failed preflight must exit 2\n${describe(preflight)}`);
      assert.equal(preflight.stdout, '', `a failed preflight must print nothing on stdout\n${describe(preflight)}`);
      assertErrorEnvelope(preflight);
    }
  });
}
