'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { artifactPath } = require('../helpers/plugin-paths');

// Mirrors the shared-frontmatter rule and its exception in root AGENTS.md.
const PORTABLE_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
const DISABLE_MODEL_INVOCATION_ALLOWED = ['demonstrate-workflow', 'write-asd-ste100'];

const skillsRoot = artifactPath('skills');
const skills = fs.readdirSync(skillsRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();

// Shared frontmatter uses only plain single-line keys, the same approach as
// tests/demonstrate-workflow/structure.test.js.
function frontmatter(skill) {
  const text = fs.readFileSync(path.join(skillsRoot, skill, 'SKILL.md'), 'utf8');
  const block = text.match(/^---\n([\s\S]+?)\n---\n/);
  assert.ok(block, `${skill}: SKILL.md has no frontmatter block`);
  return Object.fromEntries(block[1].trim().split('\n').map(line => {
    const separator = line.indexOf(':');
    assert.ok(separator > 0, `${skill}: frontmatter line is not a plain key: ${line}`);
    return [line.slice(0, separator), line.slice(separator + 1).trim()];
  }));
}

test('the artifact ships skills to check', () => {
  assert.ok(skills.length > 0);
  for (const skill of DISABLE_MODEL_INVOCATION_ALLOWED) {
    assert.ok(skills.includes(skill), `allowlisted skill ${skill} is not shipped`);
  }
});

for (const skill of skills) {
  test(`${skill}: SKILL.md frontmatter uses only portable keys and names its directory`, () => {
    const fields = frontmatter(skill);
    const allowed = DISABLE_MODEL_INVOCATION_ALLOWED.includes(skill)
      ? [...PORTABLE_KEYS, 'disable-model-invocation']
      : PORTABLE_KEYS;
    for (const key of Object.keys(fields)) {
      assert.ok(allowed.includes(key), `${skill}: frontmatter key ${key} is outside the AGENTS.md allowlist`);
    }
    assert.equal(fields.name, skill);
    assert.ok(fields.description, `${skill}: description is empty`);
    if ('disable-model-invocation' in fields) assert.equal(fields['disable-model-invocation'], 'true');
  });
}

const withOpenAiMetadata = skills.filter(skill => fs.existsSync(path.join(skillsRoot, skill, 'agents/openai.yaml')));

test('every agents/openai.yaml default prompt names the registered $harness:<skill>', () => {
  assert.ok(withOpenAiMetadata.length > 0);
  const wrong = [];
  for (const skill of withOpenAiMetadata) {
    const metadata = fs.readFileSync(path.join(skillsRoot, skill, 'agents/openai.yaml'), 'utf8');
    const match = metadata.match(/^ {2}default_prompt: (.+)$/m);
    assert.ok(match, `${skill}: agents/openai.yaml has no interface.default_prompt`);
    const prompt = JSON.parse(match[1]);
    if (!new RegExp(`\\$harness:${skill}(?![\\w-])`).test(prompt)) wrong.push(skill);
  }
  assert.deepEqual(wrong, []);
});
