'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateReleaseRecord, findReleaseByRunId } = require('../../scripts/release-policy');
const { fixture, git, write, commit, assertPassed } = require('./publication-fixture');

test('actual assembly publishes once after a real Git race; rerun is idempotent', t =>
{
  const f = fixture(t, { races: 1 });
  assertPassed(f.run());
  const head = git(f.remote, 'rev-parse', 'main');
  const record = validateReleaseRecord(f.remote, head, {requireTrailers:true});
  const tests = f.events().filter(e => e.stage === 'test');
  assert.equal(tests.length, 2);
  assert.equal(tests[0].source, f.source);
  assert.notEqual(tests[1].source, f.source);
  assert.equal(record.parent, tests[1].source);
  assert.match(git(f.remote, 'show', `${head}:dist/harness/shared/node/transaction.js`), /snapshot = 2/);
  assert.equal(git(f.remote, 'ls-tree', head, '--', 'dist/harness/shared/node/obsolete.js'), '');
  assertPassed(f.run({GITHUB_RUN_ATTEMPT:'2'}));
  assert.equal(git(f.remote, 'rev-parse', 'main'), head);
  assert.equal(f.events().filter(e => e.stage === 'test').length, 2);
});

test('a transport error after acceptance resolves the published run without a second bump', t =>
{
  const f = fixture(t, {transportError:true});
  assertPassed(f.run());
  const release = findReleaseByRunId(f.remote, 'main', '42');
  assert.ok(release);
  assert.equal(f.events().filter(e => e.stage === 'push').length, 1);
});

test('failed post-push inspection reports uncertainty and the same run later resolves it', t =>
{
  const f = fixture(t, {failInspect:true});
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /uncertain publication/);
  const published = findReleaseByRunId(f.remote, 'main', '42');
  assert.ok(published);
  assertPassed(f.run({GITHUB_RUN_ATTEMPT:'2'}));
  assert.equal(git(f.remote, 'rev-parse', 'main'), published.commit);
  assert.equal(f.events().filter(e => e.stage === 'push').length, 1);
});

test('a raced workflow change stops before another install or gate', t =>
{
  const f = fixture(t, {races:1,workflowRace:true});
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executed workflow/);
  assert.equal(f.events().filter(e => e.stage === 'install').length, 1);
  assert.equal(findReleaseByRunId(f.remote, 'main', '42'), null);
});

test('a post-staging artifact edit cannot publish', t =>
{
  const f = fixture(t, {mutateAfterStage:true});
  assert.notEqual(f.run().status, 0);
  assert.equal(git(f.remote, 'rev-parse', 'main'), f.source);
});

test('invalid submitted version metadata is rejected before regeneration can hide it', t =>
{
  const f = fixture(t);
  const canonicalPath = 'src/harness/package.json';
  const pkg = JSON.parse(fs.readFileSync(path.join(f.actor, canonicalPath), 'utf8'));
  write(f.actor, canonicalPath, JSON.stringify({...pkg,version:'99.0.0'}));
  const invalid = commit(f.actor, 'unauthorized version edit');
  git(f.actor, 'push', '-q', 'origin', 'main');
  assert.notEqual(f.run().status, 0);
  assert.equal(git(f.remote, 'rev-parse', 'main'), invalid);
  assert.equal(f.events().length, 0);
});

test('a raced snapshot failing its gate cannot publish the prior tested artifact', t =>
{
  const f = fixture(t, {races:1, failRaced:true});
  assert.notEqual(f.run().status, 0);
  assert.equal(findReleaseByRunId(f.remote, 'main', '42'), null);
  assert.equal(f.events().filter(e => e.stage === 'test').length, 1);
});

test('each publication-stage failure leaves the remote unchanged', t =>
{
  for (const fail of ['build','setup','test','check','commit'])
  {
    const f = fixture(t, {fail});
    assert.notEqual(f.run().status, 0, fail);
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.source, fail);
  }
});

test('unexpected source edits during testing fail before staging publication', t =>
{
  const f = fixture(t, {mutateSource:true});
  assert.notEqual(f.run().status, 0);
  assert.equal(git(f.remote, 'rev-parse', 'main'), f.source);
});

test('persistent push rejection does not retry without source advancement', t =>
{
  const f = fixture(t, {reject:true});
  assert.notEqual(f.run().status, 0);
  assert.equal(f.events().filter(e => e.stage === 'push').length, 1);
  assert.equal(git(f.remote, 'rev-parse', 'main'), f.source);
});

test('three real push races exhaust the bounded retry without publishing', t =>
{
  const f = fixture(t, {races:3});
  assert.notEqual(f.run().status, 0);
  assert.equal(f.events().filter(e => e.stage === 'test').length, 3);
  assert.equal(findReleaseByRunId(f.remote, 'main', '42'), null);
});

test('manual choice governs pending tags and supports release with no pending source', t =>
{
  const f = fixture(t);
  write(f.actor, 'pending-notes.md', 'operator chooses the level\n');
  commit(f.actor, 'pending notes [bump:major]');
  git(f.actor, 'push', '-q', 'origin', 'main');
  assertPassed(f.run({GITHUB_EVENT_NAME:'workflow_dispatch',DISPATCH_LEVEL:'patch'}));
  assert.equal(validateReleaseRecord(f.remote, 'main').level, 'patch');
  for (const [level, runId] of [['minor','43'], ['major','44'], ['patch','45']])
  {
    const before = validateReleaseRecord(f.remote, 'main');
    assertPassed(f.run({GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ID:runId,DISPATCH_LEVEL:level}));
    const after = validateReleaseRecord(f.remote, 'main');
    assert.equal(after.level, level);
    assert.equal(after.previous, before.version);
  }
});

test('a new automatic run with no eligible range does not rebuild or bump', t =>
{
  const f = fixture(t);
  assertPassed(f.run());
  const before = git(f.remote, 'rev-parse', 'main');
  const tests = f.events().filter(e => e.stage === 'test').length;
  assertPassed(f.run({GITHUB_RUN_ID:'46'}));
  assert.equal(git(f.remote, 'rev-parse', 'main'), before);
  assert.equal(f.events().filter(e => e.stage === 'test').length, tests);
});

test('moving a release to second-parent ancestry fails safely instead of double publishing', t =>
{
  const f = fixture(t);
  assertPassed(f.run());
  const release = git(f.remote, 'rev-parse', 'main');
  git(f.actor, 'fetch', '-q', 'origin');
  git(f.actor, 'merge', '--no-ff', '-m', 'inherit release through second parent', release);
  const merge = git(f.actor, 'rev-parse', 'HEAD');
  git(f.actor, 'push', '-q', 'origin', 'main');
  const tests = f.events().filter(e => e.stage === 'test').length;
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release-owned subject namespace/);
  assert.equal(git(f.remote, 'rev-parse', 'main'), merge);
  assert.equal(f.events().filter(e => e.stage === 'test').length, tests);
});

test('stale executed workflow and invalid publication contexts fail before mutation', t =>
{
  const f = fixture(t);
  const workflowPath = '.github/workflows/bump-version.yml';
  fs.appendFileSync(path.join(f.actor, workflowPath), '\n# new workflow definition\n');
  const changed = commit(f.actor, 'change release workflow');
  git(f.actor, 'push', '-q', 'origin', 'main');
  const stale = f.run();
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /STALE_WORKFLOW|executed workflow/);
  assert.equal(git(f.remote, 'rev-parse', 'main'), changed);
  assert.equal(f.events().length, 0);
  for (const context of [
    {GITHUB_REF:'refs/heads/topic'},
    {GITHUB_EVENT_NAME:'pull_request'},
    {GITHUB_REPOSITORY:'another/repository'},
    {GITHUB_RUN_ID:''},
  ])
  {
    assert.notEqual(f.run(context).status, 0);
    assert.equal(git(f.remote, 'rev-parse', 'main'), changed);
  }
});
