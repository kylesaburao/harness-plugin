'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build, inventory } = require('../../scripts/build');
const { repositoryRoot, mapPublishedPath, publishedRoot } = require('../helpers/plugin-paths');

function write(root, name, contents)
{
  const destination = path.join(root, name);
  fs.mkdirSync(path.dirname(destination), {recursive:true});
  fs.writeFileSync(destination, contents);
}

function run(root, args, target)
{
  return spawnSync(process.execPath, args, {cwd:root, env:{...process.env,HARNESS_TEST_TARGET:target,NODE_TEST_CONTEXT:undefined}, encoding:'utf8'});
}

test('new source resources and headings are tested from the candidate while publication stays unchanged', t =>
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-paths-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  for (const name of ['src','scripts','tests/helpers','tests/inventory'])
  {
    fs.cpSync(path.join(repositoryRoot,name),path.join(root,name),{recursive:true});
  }
  for (const name of ['package.json','tsconfig.json','README.md'])
  {
    fs.copyFileSync(path.join(repositoryRoot,name),path.join(root,name));
  }
  // The real repository README has guide links; give this isolated link checker
  // only the existing component inventory and the new canonical public link.
  const readme = fs.readFileSync(path.join(root,'README.md'),'utf8');
  const {links} = require('../inventory/markdown');
  write(root,'README.md',links(readme).filter(link => /^dist\/harness\/(skills|output-styles)\//.test(link.target)).map(link => `[${link.label}](${link.target})`).join('\n'));
  fs.mkdirSync(path.join(root,'docs'));
  fs.symlinkSync(path.join(repositoryRoot,'node_modules'),path.join(root,'node_modules'));
  build(root,{target:'distribution'});
  const before = [...inventory(path.join(root,'dist/harness'))].map(([name,entry]) => [name,entry.mode,fs.readFileSync(entry.absolute).toString('base64')]);
  write(root,'src/harness/shared/node/pending.ts','export const value = 73;\n');
  write(root,'src/harness/skills/candidate-only/SKILL.md','---\nname: candidate-only\ndescription: A candidate inventory fixture.\n---\n\n## Pending heading\n\nPending content.\n');
  fs.appendFileSync(path.join(root,'README.md'),'\n[candidate-only](dist/harness/skills/candidate-only/SKILL.md#pending-heading)\n');
  build(root);
  const result = run(root,['-e', 'const {artifactPath}=require("./tests/helpers/plugin-paths");console.log(require(artifactPath("shared/node/pending.js")).value)']);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),'73');
  assert.notEqual(run(root,['-e','require("./tests/helpers/plugin-paths")'],'invalid').status,0);
  assert.notEqual(run(root,['-e','const {artifactPath}=require("./tests/helpers/plugin-paths");require(artifactPath("shared/node/pending.js"))'],'distribution').status,0);
  const checks = ['--test','tests/inventory/readme-inventory.test.js','tests/inventory/documentation-links.test.js','tests/inventory/bundled-path-authority.test.js'];
  const valid = run(root,checks);
  assert.equal(valid.status,0,valid.stdout+valid.stderr);
  write(root,'.build/harness/skills/candidate-only/SKILL.md','---\nname: candidate-only\n---\n## Wrong heading\n');
  const broken = run(root,['--test','tests/inventory/documentation-links.test.js']);
  assert.notEqual(broken.status,0);
  assert.match(broken.stdout+broken.stderr,/Missing heading/);
  const after = [...inventory(path.join(root,'dist/harness'))].map(([name,entry]) => [name,entry.mode,fs.readFileSync(entry.absolute).toString('base64')]);
  assert.deepEqual(after,before);
});

test('published-link mapping applies only to the exact installation subtree', () =>
{
  for (const other of [path.join(publishedRoot,'../unrelated/file.md'),publishedRoot+'-other/file.md',path.join(repositoryRoot,'README.md')])
  {
    assert.equal(mapPublishedPath(other),other);
  }
});
