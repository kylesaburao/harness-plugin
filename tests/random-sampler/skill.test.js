'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const skill = path.join(root, 'plugins/harness/skills/random-sampler');
test('portable automatic routing and complete instructions', () => {
  const text = fs.readFileSync(path.join(skill,'SKILL.md'),'utf8');
  const metadata = text.split('---')[1];
  assert.deepEqual(metadata.trim().split('\n').map(line => line.split(':')[0]), ['name','description']);
  assert.match(metadata,/name: random-sampler/);
  for (const fragment of ['random integers','samples','shuffle','dice','coins','recommendations','rankings','optimization','without requested randomness']) assert.ok(metadata.includes(fragment),fragment);
  for (const fragment of ['complete sampling space before execution','original array position','Preserve duplicates','2/3',"host's currently loaded absolute skill directory",'scripts/sample.mjs','quoted heredoc','delimiter is absent','Never generate sampling code','Accept the returned values and original indices exactly','preference-reroll','Relay diagnostics verbatim','actual command','22.0.0','[1,101)','[1,21)','separate invocations']) assert.ok(text.includes(fragment),fragment);
  assert.deepEqual(fs.readdirSync(skill).sort(),['SKILL.md','scripts']);
});
test('entropy boundary stays in built-in crypto with no fallback or randomized sorting', () => {
  const source = fs.readFileSync(path.join(skill,'scripts/sample.mjs'),'utf8');
  assert.match(source,/import\('node:crypto'\)/);
  assert.match(source,/crypto\.randomInt\(/);
  assert.doesNotMatch(source,/Math\.random|\.sort\s*\(|process\.env|node:(?:fs|https?|net)|\beval\s*\(/);
  assert.match(source,/22\.0\.0/);
  const dependencies = fs.readFileSync(path.join(root,'DEPENDENCIES.md'),'utf8').split('\n').find(line => line.startsWith('| `random-sampler`'));
  assert.match(dependencies,/22\.0\.0/);
  assert.match(dependencies,/crypto/);
});
