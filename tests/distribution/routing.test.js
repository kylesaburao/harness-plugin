'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateReleaseRecord } = require('../../scripts/release-policy');
const { fixture, git, write, commit, assertPassed } = require('./publication-fixture');

function select(f, expected, overrides = {}, head = f.source)
{
  const result = f.candidate(overrides, head);
  assertPassed(result);
  assert.equal(result.testCandidate, `test_candidate=${expected}`);
  assert.match(result.summary, /Source policy: passed/);
  assert.match(result.summary, expected ? /Development gate: completed/ : /Development gate: skipped/);
}

function advance(f, name, contents, subject)
{
  git(f.actor, 'pull', '-q', '--ff-only');
  write(f.actor, name, contents);
  const head = commit(f.actor, subject);
  git(f.actor, 'push', '-q', 'origin', 'main');
  return head;
}

function gates(f)
{
  return f.events().filter(e => ['candidate-test', 'test'].includes(e.stage));
}

test('eligible events, original reruns, and already-published queued events require only one distribution gate', t =>
{
  const f = fixture(t);
  select(f, false);
  assert.deepEqual(f.events(), []);
  assertPassed(f.run());
  const release = validateReleaseRecord(f.remote, 'main');
  assert.deepEqual(gates(f), [{stage:'test', source:f.source}]);
  assert.match(fs.readFileSync(f.environment.GITHUB_STEP_SUMMARY, 'utf8'), /Distribution gates completed: 1/);

  // The old event still looks eligible; the publisher deduplicates on current main.
  select(f, false);
  assertPassed(f.run({GITHUB_RUN_ATTEMPT:'2'}));
  assert.match(fs.readFileSync(f.environment.GITHUB_STEP_SUMMARY, 'utf8'), /Distribution gates completed: 0/);
  select(f, false, {GITHUB_RUN_ID:'43'});
  assertPassed(f.run({GITHUB_RUN_ID:'43'}));
  // A manual rerun checks out main and can see its validated release directly.
  select(f, false, {GITHUB_EVENT_NAME:'workflow_dispatch', DISPATCH_LEVEL:'patch'}, release.commit);
  assertPassed(f.run({GITHUB_EVENT_NAME:'workflow_dispatch', DISPATCH_LEVEL:'patch'}));
  assert.equal(git(f.remote, 'rev-parse', 'main'), release.commit);
  assert.equal(gates(f).length, 1);
});

test('documentation, tests, and test-only tooling run one development gate and no publication gate', t =>
{
  const f = fixture(t, {}, {eligible:false});
  select(f, true);
  assert.deepEqual(f.events().map(e => e.stage), [
    'candidate-python', 'install', 'candidate-build', 'candidate-setup', 'candidate-test',
  ]);
  assertPassed(f.run());
  assert.deepEqual(gates(f), [{stage:'candidate-test', source:f.source}]);
  assert.equal(git(f.remote, 'rev-parse', 'main'), f.source);
});

test('a documentation event catches up an earlier unpublished source change', t =>
{
  const f = fixture(t);
  const docs = advance(f, 'notes.md', 'catch up source\n', 'documentation only');
  select(f, false, {SOURCE_BEFORE:f.source}, docs);
  assertPassed(f.run());
  assert.deepEqual(gates(f), [{stage:'test', source:docs}]);
  assert.equal(validateReleaseRecord(f.remote, 'main').parent, docs);
});

test('manual patch, minor, and major requests without automatic changes skip candidate testing', t =>
{
  const f = fixture(t, {}, {eligible:false});
  for (const [index, level] of ['patch', 'minor', 'major'].entries())
  {
    const context = {GITHUB_EVENT_NAME:'workflow_dispatch', DISPATCH_LEVEL:level, GITHUB_RUN_ID:String(50 + index)};
    const head = git(f.remote, 'rev-parse', 'main');
    select(f, false, context, head);
    assertPassed(f.run(context));
    const release = validateReleaseRecord(f.remote, 'main');
    assert.equal(release.level, level);
    assert.equal(release.parent, head);
  }
  assert.equal(gates(f).length, 3);
  assert.ok(gates(f).every(e => e.stage === 'test'));
});

test('invalid event history and earlier invalid source fail before dependency installation', t =>
{
  const f = fixture(t);
  const pkg = JSON.parse(fs.readFileSync(path.join(f.actor, 'src/harness/package.json'), 'utf8'));
  const invalid = advance(f, 'src/harness/package.json', JSON.stringify({...pkg, version:'99.0.0'}), 'invalid version');
  assert.notEqual(f.candidate({}, invalid).status, 0);
  const docs = advance(f, 'notes.md', 'later docs\n', 'valid event over invalid history');
  const result = f.candidate({SOURCE_BEFORE:invalid}, docs);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Source policy passed/); // Event passes; full-range selection rejects.
  assert.deepEqual(f.events(), []);
});

test('publication selects fresh main after classification, including after a non-release gate', t =>
{
  for (const eligible of [true, false])
  {
    const f = fixture(t, {}, {eligible});
    select(f, !eligible);
    const newer = advance(f, 'src/harness/shared/node/transaction.ts', 'export const snapshot = 2;\n', 'new unpublished source');
    assertPassed(f.run());
    assert.deepEqual(gates(f), [
      ...(!eligible ? [{stage:'candidate-test', source:f.source}] : []),
      {stage:'test', source:newer},
    ]);
    assert.equal(validateReleaseRecord(f.remote, 'main').parent, newer);
  }
});
