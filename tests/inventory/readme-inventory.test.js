'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { links } = require('./markdown');

const ROOT = path.resolve(__dirname, '../..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

// Compare public component links with the shipped tree. Headings, tables, lists,
// ordering, and additional guide links are presentation choices.
for (const kind of ['skills', 'output-styles']) {
  test(`README links to exactly the shipped ${kind}, using their public names`, () => {
    const directory = `plugins/harness/${kind}`;
    const expected = fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true })
      .filter(entry => kind === 'skills' ? entry.isDirectory() : entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => `${directory}/${entry.name}${kind === 'skills' ? '/SKILL.md' : ''}`)
      .filter(file => fs.existsSync(path.join(ROOT, file)))
      .sort();
    const entries = links(readme)
      .map(link => ({ ...link, target: path.posix.normalize(link.target.split('#')[0]) }))
      .filter(link => link.target.startsWith(`${directory}/`) &&
        (kind === 'skills' ? link.target.endsWith('/SKILL.md') : link.target.endsWith('.md')));
    assert.deepEqual([...new Set(entries.map(link => link.target))].sort(), expected);
    for (const entry of entries) {
      const text = fs.readFileSync(path.join(ROOT, entry.target), 'utf8');
      const name = text.match(/^---\r?\n[\s\S]*?^name:\s*(.+?)\s*$/m)?.[1];
      assert.ok(name, `Missing public name: ${entry.target}`);
      assert.equal(entry.label.replace(/[`*_]/g, ''), name, entry.target);
    }
  });
}
