'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { links, anchors } = require('./markdown');
const ROOT = path.resolve(__dirname, '../..');

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(file) : entry.name.endsWith('.md') ? [file] : [];
  });
}

test('repository entry points and human guides have valid local links and heading anchors', () => {
  const files = fs.readdirSync(ROOT).filter(name => name.endsWith('.md')).map(name => path.join(ROOT, name));
  files.push(...markdownFiles(path.join(ROOT, 'docs')));
  const failures = [];
  for (const file of files) {
    for (const { target } of links(fs.readFileSync(file, 'utf8'))) {
      if (/^(?:https?:|mailto:)/i.test(target)) continue;
      const [relative, fragment] = decodeURIComponent(target).split('#');
      const destination = relative ? path.resolve(path.dirname(file), relative) : file;
      const context = `${path.relative(ROOT, file)} -> ${target}`;
      if (!fs.existsSync(destination)) failures.push(`Missing file: ${context}`);
      else if (fragment && destination.endsWith('.md') && !anchors(fs.readFileSync(destination, 'utf8')).has(fragment)) {
        failures.push(`Missing heading: ${context}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});
