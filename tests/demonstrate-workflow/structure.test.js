'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const repo = path.resolve(__dirname, '../..');
const plugin = path.join(repo, 'dist/harness');
const skill = path.join(plugin, 'skills/demonstrate-workflow');
const expected = [
  'SKILL.md',
  'agents/openai.yaml',
  'references/author-and-validate.md',
  'references/live-demonstration.md',
  'references/retrospective.md',
  'references/scope-and-synthesis.md',
];

function files(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const name = path.posix.join(prefix, entry.name);
    assert.ok(!entry.isSymbolicLink(), `unexpected symlink: ${name}`);
    return entry.isDirectory() ? files(root, name) : [name];
  }).sort();
}

test('A01: the shipped skill contains exactly six instruction and metadata files', () => {
  assert.deepEqual(files(skill), expected);
});

test('A02/A03: exact candidate extension and Codex manual-only metadata', () => {
  const text = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8');
  const frontmatter = text.match(/^---\n([\s\S]+?)\n---\n/);
  assert.ok(frontmatter);
  // This draft deliberately uses only plain keys and JSON-compatible YAML scalars.
  const fields = Object.fromEntries(frontmatter[1].trim().split('\n').map(line => {
    const separator = line.indexOf(':');
    assert.ok(separator > 0);
    return [line.slice(0, separator), line.slice(separator + 1).trim()];
  }));
  assert.deepEqual(Object.keys(fields).sort(), ['description', 'disable-model-invocation', 'name']);
  assert.equal(fields.name, path.basename(skill));
  assert.equal(fields['disable-model-invocation'], 'true');
  assert.ok(JSON.parse(fields.description).length > 0);
  const metadata = fs.readFileSync(path.join(skill, 'agents/openai.yaml'), 'utf8');
  assert.match(metadata, /^policy:\n  allow_implicit_invocation: false\n$/m);
  for (const field of ['display_name', 'short_description', 'default_prompt']) {
    const match = metadata.match(new RegExp(`^  ${field}: (.+)$`, 'm'));
    assert.ok(match, field);
    const value = JSON.parse(match[1]);
    assert.equal(typeof value, 'string');
    if (field === 'short_description') assert.ok(value.length >= 25 && value.length <= 64);
    if (field === 'default_prompt') assert.ok(value.includes('$harness:demonstrate-workflow'));
  }
  assert.doesNotMatch(metadata, /^(dependencies|tools):/m);
});

test('A03/A04: the approved exception is scoped and distribution uses the canonical directory', () => {
  assert.match(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), /Exception limited to `demonstrate-workflow`/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin/plugin.json'), 'utf8')).skills, './skills/');
});

test('A05: all instruction references resolve after relocating the skill', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-references-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const moved = path.join(temporary, 'installed/skills/demonstrate-workflow');
  fs.cpSync(skill, moved, { recursive: true });
  const reached = new Set();
  for (const name of expected.filter(name => name.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(moved, name), 'utf8');
    for (const match of text.matchAll(/`((?:references\/)?[a-z-]+\.md)`/g)) {
      const target = path.resolve(path.dirname(path.join(moved, name)), match[1]);
      assert.ok(target.startsWith(moved + path.sep));
      assert.ok(fs.statSync(target).isFile(), `${name}: ${match[1]}`);
      reached.add(path.relative(moved, target));
    }
  }
  assert.deepEqual([...reached].sort(), expected.filter(name => name.startsWith('references/')));
});
