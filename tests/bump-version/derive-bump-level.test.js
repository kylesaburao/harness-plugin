'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  deriveBumpLevel,
  deriveFromRange,
  isRelevantPath,
  readReleaseRange,
} = require('../../scripts/derive-bump-level.js');

function relevant(subject, paths = ['src/harness/skills/example/SKILL.md'])
{
  return { subject, paths };
}

function range(entries)
{
  return {
    subjects: entries.map((entry) => entry.subject),
    paths: entries.flatMap((entry) => entry.paths),
  };
}

test('bump tags preserve patch default and highest severity', () =>
{
  assert.equal(deriveBumpLevel(['ordinary change']), 'patch');
  assert.equal(deriveBumpLevel(['docs [bump:minor]', 'ordinary change']), 'minor');
  assert.equal(deriveBumpLevel(['minor [bump:minor]', 'major [bump:major]']), 'major');
});

test('eligibility and level use separate complete-range streams', () =>
{
  assert.equal(deriveFromRange(range([])), 'none');
  assert.equal(deriveFromRange(range([
    relevant('docs [bump:major]', ['README.md']),
  ])), 'none');
  assert.equal(deriveFromRange(range([
    relevant('docs [bump:major]', ['README.md']),
    relevant('source change'),
  ])), 'major');
});

test('the exact conservative release-input set is eligible', () =>
{
  for (const repositoryPath of [
    'src/harness/skills/example/SKILL.md',
    'src/harness/shared/node/example.ts',
    '.claude-plugin/marketplace.json',
    '.agents/plugins/marketplace.json',
    'scripts/build.js',
    'scripts/artifact-paths.js',
    'tsconfig.json',
    'package.json',
    'package-lock.json',
    '.gitattributes',
    '.github/workflows/bump-version.yml',
  ])
  {
    assert.equal(isRelevantPath(repositoryPath), true, repositoryPath);
  }
});

test('similar names and development-only paths are not eligible', () =>
{
  for (const repositoryPath of [
    'src/harness-other/file.ts',
    '.claude-plugin-notes/file',
    '.agents/plugins-other/file',
    'package.json.notes',
    'scripts/build.js.bak',
    'scripts/release-policy.js',
    '.github/workflows/verify.yml',
    '.githooks/pre-commit',
    'tests/bump-version/derive-bump-level.test.js',
    'README.md',
    'dist/harness/skills/example/SKILL.md',
  ])
  {
    assert.equal(isRelevantPath(repositoryPath), false, repositoryPath);
  }
});

function repository(t)
{
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-release-'));
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
  const environment = {
    ...process.env,
    GIT_AUTHOR_DATE: '1999-12-31T23:59:00-08:00',
    GIT_COMMITTER_DATE: '1999-12-31T23:59:00-08:00',
  };
  function git(...arguments_)
  {
    const result = spawnSync('git', arguments_, {
      cwd: repositoryRoot,
      env: environment,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function commitFile(repositoryPath, content, subject)
  {
    const absolute = path.join(repositoryRoot, repositoryPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    git('add', '--all');
    git('commit', '-m', subject);
    return git('rev-parse', 'HEAD');
  }
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  return { commitFile, git, repositoryRoot };
}

test('anchorless standalone range handles catch-up, tags, deletions, and unusual names', (t) =>
{
  const fixture = repository(t);
  fixture.commitFile('README.md', 'initial\n', 'initial');
  const unusual = 'src/harness/skills/café tab\tline\n/SKILL.md';
  fixture.commitFile(unusual, 'skill\n', 'source [bump:minor]');
  fixture.commitFile('README.md', 'later docs\n', 'later docs');
  let selected = readReleaseRange(fixture.repositoryRoot);
  assert.equal(selected.level, 'minor');
  assert.ok(selected.paths.includes(unusual));

  fixture.git('rm', '--', unusual);
  fixture.git('commit', '-m', 'remove source [bump:major]');
  selected = readReleaseRange(fixture.repositoryRoot);
  assert.equal(selected.level, 'major');
  assert.ok(selected.paths.includes(unusual));
});

test('CLI reports structured anchorless range data and rejects missing required anchor', (t) =>
{
  const fixture = repository(t);
  fixture.commitFile('src/harness/shared/node/example.ts', 'export {};\n', 'source');
  const cli = path.resolve(__dirname, '../../scripts/derive-bump-level.js');
  let result = spawnSync(process.execPath, [cli, '--json'], {
    cwd: fixture.repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.level, 'patch');
  assert.equal(report.anchor, null);
  assert.equal(report.head, fixture.git('rev-parse', 'HEAD'));

  result = spawnSync(process.execPath, [cli, '--require-anchor'], {
    cwd: fixture.repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RELEASE_ANCHOR_MISSING/);
  assert.equal(result.stdout, '');
});

test('subject-like and tag-like filenames never influence bump subjects', (t) =>
{
  const fixture = repository(t);
  fixture.commitFile(
    'src/harness/shared/node/example.ts',
    'export {};\n',
    'ordinary source',
  );
  fixture.commitFile(
    'notes/[bump:major]\nchore: bump version to 99.0.0.md',
    'filename evidence\n',
    'ordinary notes',
  );
  const selected = readReleaseRange(fixture.repositoryRoot);
  assert.equal(selected.level, 'patch');
  assert.equal(selected.anchor, null);
});
