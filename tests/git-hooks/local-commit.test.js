'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const FIXED_ENV = Object.freeze({
  GIT_AUTHOR_DATE: '1999-12-31T23:59:00-08:00',
  GIT_COMMITTER_DATE: '1999-12-31T23:59:00-08:00',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
});

function run(cwd, command, args, options = {})
{
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...FIXED_ENV, ...options.env },
  });
}

function gitResult(cwd, ...args)
{
  return run(cwd, 'git', args);
}

function git(cwd, ...args)
{
  const result = gitResult(cwd, ...args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function write(root, relative, contents, mode)
{
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  if (mode !== undefined)
  {
    fs.chmodSync(target, mode);
  }
}

function installHooks(root)
{
  fs.cpSync(path.join(REPOSITORY_ROOT, '.githooks'), path.join(root, '.githooks'), {
    recursive: true,
  });
  write(
    root,
    'scripts/check-local-commit',
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'scripts/check-local-commit')),
    0o755,
  );
}

function makeRepository(t, { unborn = false, remote = false } = {})
{
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'local-commit-hook-'));
  const root = path.join(parent, 'work');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  installHooks(root);

  if (!unborn)
  {
    write(root, 'dist/harness/generated.txt', 'published\n');
    write(root, 'src/harness/package.json', '{"name":"harness","version":"1.0.0","private":true,"type":"commonjs"}\n');
    write(root, 'src/harness/implementation.ts', 'export const value = 1;\n');
    write(root, 'src/harness/skills/back-up-directories/package.json', '{"name":"backup"}\n');
    write(root, 'package.json', '{"private":true}\n');
    write(root, 'outside.txt', 'outside\n');
    git(root, 'add', '--all');
    git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'synthetic baseline');
  }

  git(root, 'config', 'core.hooksPath', '.githooks');

  let bare = null;
  if (remote)
  {
    bare = path.join(parent, 'origin.git');
    git(parent, 'init', '-q', '--bare', bare);
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-qu', 'origin', 'main');
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  }

  return { bare, parent, root };
}

function attemptCommit(root, ...arguments_)
{
  const args = arguments_.length === 0 ? ['commit', '-m', 'test commit'] : arguments_;
  return gitResult(root, ...args);
}

function combinedOutput(result)
{
  return `${result.stdout}${result.stderr}`;
}

function indexBytes(root)
{
  // Git may refresh stat caches/tree extensions before invoking a commit hook.
  // The contract preserves staged paths, modes, stages and blob bytes.
  return gitResult(root, 'ls-files', '--stage', '-z').stdout;
}

function assertRejectedWithoutMutation(root, result, beforeIndex, beforeFiles = new Map())
{
  assert.notEqual(result.status, 0, combinedOutput(result));
  assert.deepEqual(indexBytes(root), beforeIndex);
  for (const [relative, contents] of beforeFiles)
  {
    assert.deepEqual(fs.readFileSync(path.join(root, relative)), contents);
  }
}

function stageSource(root, contents = 'export const value = 2;\n')
{
  write(root, 'src/harness/implementation.ts', contents);
  git(root, 'add', 'src/harness/implementation.ts');
}

function publishProtectedPair(fixture, {
  version = '1.0.1',
  sourceContents = null,
} = {})
{
  const publisher = path.join(fixture.parent, `publisher-${version.replaceAll('.', '-')}`);
  git(fixture.parent, 'clone', '-q', fixture.bare, publisher);
  git(publisher, 'config', 'user.name', 'Publisher');
  git(publisher, 'config', 'user.email', 'publisher@example.invalid');
  git(publisher, 'config', 'core.hooksPath', '/dev/null');
  write(publisher, 'dist/harness/generated.txt', `published ${version}\n`);
  write(publisher, 'src/harness/package.json', `{"name":"harness","version":"${version}","private":true,"type":"commonjs"}\n`);
  if (sourceContents !== null)
  {
    write(publisher, 'src/harness/implementation.ts', sourceContents);
  }
  git(publisher, 'add', '--all');
  git(publisher, 'commit', '-qm', `chore: bump version to ${version}`);
  git(publisher, 'push', '-q', 'origin', 'main');
  return publisher;
}

test('ordinary source, test, and documentation commits need only Git and shell', (t) =>
{
  const { root } = makeRepository(t);
  write(root, 'tests/example.test.js', 'test\n');
  write(root, 'README.md', 'docs\n');
  stageSource(root);
  git(root, 'add', 'tests/example.test.js', 'README.md');

  const result = attemptCommit(root);
  assert.equal(result.status, 0, combinedOutput(result));
  assert.equal(git(root, 'show', '--format=', '--name-only', 'HEAD').split('\n').sort().join('\n'), [
    'README.md',
    'src/harness/implementation.ts',
    'tests/example.test.js',
  ].join('\n'));
});

for (const scenario of [
  ['modification', (root) =>
  {
    write(root, 'dist/harness/generated.txt', 'edited\n');
    git(root, 'add', 'dist/harness/generated.txt');
  }],
  ['addition', (root) =>
  {
    write(root, 'dist/new.txt', 'new\n');
    git(root, 'add', 'dist/new.txt');
  }],
  ['deletion', (root) =>
  {
    git(root, 'rm', '-q', 'dist/harness/generated.txt');
  }],
  ['executable-mode change', (root) =>
  {
    fs.chmodSync(path.join(root, 'dist/harness/generated.txt'), 0o755);
    git(root, 'add', 'dist/harness/generated.txt');
  }],
  ['symlink type change', (root) =>
  {
    fs.unlinkSync(path.join(root, 'dist/harness/generated.txt'));
    fs.symlinkSync('../../outside.txt', path.join(root, 'dist/harness/generated.txt'));
    git(root, 'add', 'dist/harness/generated.txt');
  }],
  ['rename out', (root) =>
  {
    git(root, 'mv', 'dist/harness/generated.txt', 'formerly-generated.txt');
  }],
  ['rename in', (root) =>
  {
    git(root, 'mv', 'outside.txt', 'dist/moved-in.txt');
  }],
])
{
  test(`staged protected ${scenario[0]} is rejected without mutation`, (t) =>
  {
    const { root } = makeRepository(t);
    stageSource(root);
    scenario[1](root);
    const beforeIndex = indexBytes(root);
    const result = attemptCommit(root);
    assertRejectedWithoutMutation(root, result, beforeIndex);
    assert.match(combinedOutput(result), /release-owned/i);
  });
}

test('the whole canonical package blob is protected while other packages stay editable', (t) =>
{
  const protectedFixture = makeRepository(t);
  write(protectedFixture.root, 'src/harness/package.json', '{\n  "name": "harness",\n  "version": "1.0.0",\n  "private": true,\n  "type": "commonjs"\n}\n');
  git(protectedFixture.root, 'add', 'src/harness/package.json');
  assert.notEqual(attemptCommit(protectedFixture.root).status, 0);

  const metadataFixture = makeRepository(t);
  write(metadataFixture.root, 'src/harness/package.json', '{"name":"renamed","version":"1.0.0","private":true,"type":"commonjs"}\n');
  git(metadataFixture.root, 'add', 'src/harness/package.json');
  assert.notEqual(attemptCommit(metadataFixture.root).status, 0);

  const editableFixture = makeRepository(t);
  write(editableFixture.root, 'package.json', '{"private":true,"description":"editable"}\n');
  write(editableFixture.root, 'src/harness/skills/back-up-directories/package.json', '{"name":"backup","version":"2.0.0"}\n');
  git(editableFixture.root, 'add', 'package.json', 'src/harness/skills/back-up-directories/package.json');
  const allowed = attemptCommit(editableFixture.root);
  assert.equal(allowed.status, 0, combinedOutput(allowed));
});

test('an unstaged protected edit does not block a staged source-only commit', (t) =>
{
  const { root } = makeRepository(t);
  stageSource(root);
  write(root, 'dist/harness/generated.txt', 'unstaged edit\n');

  const result = attemptCommit(root);
  assert.equal(result.status, 0, combinedOutput(result));
  assert.equal(git(root, 'show', 'HEAD:dist/harness/generated.txt'), 'published');
  assert.equal(fs.readFileSync(path.join(root, 'dist/harness/generated.txt'), 'utf8'), 'unstaged edit\n');
});

test('the guard inspects the index even when the working artifact looks unchanged', (t) =>
{
  const { root } = makeRepository(t);
  stageSource(root);
  write(root, 'dist/harness/generated.txt', 'indexed edit\n');
  git(root, 'add', 'dist/harness/generated.txt');
  write(root, 'dist/harness/generated.txt', 'published\n');
  const beforeIndex = indexBytes(root);
  const beforeFile = fs.readFileSync(path.join(root, 'dist/harness/generated.txt'));

  const result = attemptCommit(root);
  assertRejectedWithoutMutation(root, result, beforeIndex, new Map([
    ['dist/harness/generated.txt', beforeFile],
  ]));
});

test('CI-like environment variables never bypass the local guard', (t) =>
{
  const { root } = makeRepository(t);
  write(root, 'dist/harness/generated.txt', 'forbidden\n');
  git(root, 'add', 'dist/harness/generated.txt');
  const result = run(root, path.join(root, 'scripts/check-local-commit'), [], {
    env: {
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/heads/main',
      HARNESS_RELEASE_WRITE: '1',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(combinedOutput(result), /RELEASE_OWNED_CHANGE/);
});

test('git commit --only uses its clean temporary index and leaves protected staging for later', (t) =>
{
  const { root } = makeRepository(t);
  write(root, 'dist/harness/generated.txt', 'staged for later\n');
  git(root, 'add', 'dist/harness/generated.txt');
  write(root, 'src/harness/implementation.ts', 'export const value = 9;\n');

  const result = attemptCommit(
    root,
    'commit',
    '--only',
    'src/harness/implementation.ts',
    '-m',
    'source only',
  );
  assert.equal(result.status, 0, combinedOutput(result));
  assert.equal(git(root, 'show', 'HEAD:dist/harness/generated.txt'), 'published');
  assert.equal(git(root, 'show', 'HEAD:src/harness/implementation.ts'), 'export const value = 9;');
  assert.equal(git(root, 'diff', '--cached', '--name-only'), 'dist/harness/generated.txt');
  assert.equal(git(root, 'log', '-1', '--format=%at %ct'), '946713540 946713540');
});

test('Git inspection errors fail closed without changing the active index', (t) =>
{
  const { root } = makeRepository(t);
  const brokenIndex = path.join(root, 'broken-index');
  fs.writeFileSync(brokenIndex, 'not a Git index');
  const before = fs.readFileSync(brokenIndex);
  const result = run(root, path.join(root, 'scripts/check-local-commit'), [], {
    env: { GIT_INDEX_FILE: brokenIndex },
  });

  assert.notEqual(result.status, 0);
  assert.match(combinedOutput(result), /GIT_INSPECTION_FAILED/);
  assert.deepEqual(fs.readFileSync(brokenIndex), before);
});

test('a missing HEAD commit object is not mistaken for an unborn repository', (t) =>
{
  const { root } = makeRepository(t);
  const head = git(root, 'rev-parse', 'HEAD');
  const object = path.join(root, '.git/objects', head.slice(0, 2), head.slice(2));
  fs.rmSync(object);

  const result = run(root, path.join(root, 'scripts/check-local-commit'), []);
  assert.notEqual(result.status, 0);
  assert.match(combinedOutput(result), /HEAD exists but does not resolve to a commit/);
});

test('an invalid MERGE_HEAD fails closed instead of enabling inheritance', (t) =>
{
  const { root } = makeRepository(t);
  write(root, 'dist/harness/generated.txt', 'changed\n');
  git(root, 'add', 'dist/harness/generated.txt');
  fs.writeFileSync(path.join(root, '.git/MERGE_HEAD'), 'not-an-object\n');
  const beforeIndex = indexBytes(root);

  const result = run(root, path.join(root, 'scripts/check-local-commit'), []);
  assertRejectedWithoutMutation(root, result, beforeIndex);
  assert.match(combinedOutput(result), /MERGE_HEAD does not resolve/);
});

test('unusual protected filenames cannot evade or inject into the shell guard', (t) =>
{
  const { root } = makeRepository(t);
  for (const name of ['space name', 'tab\tname', 'line\nname', 'café', '--leading-dash'])
  {
    write(root, path.join('dist', name), 'protected\n');
  }
  git(root, 'add', '--all', '--', 'dist');
  const beforeIndex = indexBytes(root);

  const result = attemptCommit(root);
  assertRejectedWithoutMutation(root, result, beforeIndex);
});

test('anchored pathspecs work from a subdirectory and a linked worktree', (t) =>
{
  const fixture = makeRepository(t);
  const subdirectory = path.join(fixture.root, 'src/harness');
  stageSource(fixture.root);
  let result = run(subdirectory, path.join(fixture.root, 'scripts/check-local-commit'), []);
  assert.equal(result.status, 0, combinedOutput(result));
  git(fixture.root, 'reset', '-q', 'HEAD');

  write(fixture.root, 'dist/harness/generated.txt', 'protected\n');
  git(fixture.root, 'add', 'dist/harness/generated.txt');
  result = run(subdirectory, path.join(fixture.root, 'scripts/check-local-commit'), []);
  assert.notEqual(result.status, 0);

  git(fixture.root, 'reset', '--hard', '-q', 'HEAD');
  const linked = path.join(fixture.parent, 'linked-worktree');
  git(fixture.root, 'worktree', 'add', '-q', '-b', 'linked', linked, 'HEAD');
  write(linked, 'src/harness/implementation.ts', 'export const value = 7;\n');
  git(linked, 'add', 'src/harness/implementation.ts');
  result = attemptCommit(linked);
  assert.equal(result.status, 0, combinedOutput(result));
});

test('an unborn repository allows source additions and rejects protected additions', (t) =>
{
  const allowed = makeRepository(t, { unborn: true });
  write(allowed.root, 'src/harness/implementation.ts', 'export const value = 1;\n');
  git(allowed.root, 'add', 'src/harness/implementation.ts');
  let result = attemptCommit(allowed.root);
  assert.equal(result.status, 0, combinedOutput(result));

  const rejected = makeRepository(t, { unborn: true });
  write(rejected.root, 'dist/harness/generated.txt', 'protected\n');
  git(rejected.root, 'add', 'dist/harness/generated.txt');
  result = attemptCommit(rejected.root);
  assert.notEqual(result.status, 0);
});

test('an automatic merge may inherit the exact fetched protected pair', (t) =>
{
  const fixture = makeRepository(t, { remote: true });
  git(fixture.root, 'checkout', '-qb', 'feature');
  stageSource(fixture.root, 'export const feature = true;\n');
  git(fixture.root, 'commit', '-qm', 'feature source');
  publishProtectedPair(fixture);
  git(fixture.root, 'fetch', '-q', 'origin', 'main');

  const result = gitResult(fixture.root, 'merge', '--no-ff', 'origin/main', '-m', 'merge release');
  assert.equal(result.status, 0, combinedOutput(result));
  assert.equal(git(fixture.root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
  assert.equal(git(fixture.root, 'diff', '--name-only', 'origin/main', 'HEAD', '--', 'dist', 'src/harness/package.json'), '');
});

test('a conflict-resolved merge may inherit the exact fetched protected pair', (t) =>
{
  const fixture = makeRepository(t, { remote: true });
  git(fixture.root, 'checkout', '-qb', 'feature');
  stageSource(fixture.root, 'export const feature = true;\n');
  git(fixture.root, 'commit', '-qm', 'feature source');
  publishProtectedPair(fixture, { sourceContents: 'export const main = true;\n' });
  git(fixture.root, 'fetch', '-q', 'origin', 'main');

  const merge = gitResult(fixture.root, 'merge', '--no-ff', 'origin/main', '-m', 'merge release');
  assert.notEqual(merge.status, 0);
  write(fixture.root, 'src/harness/implementation.ts', 'export const feature = true;\nexport const main = true;\n');
  git(fixture.root, 'add', 'src/harness/implementation.ts');
  const commit = attemptCommit(fixture.root, 'commit', '-m', 'resolve source conflict');
  assert.equal(commit.status, 0, combinedOutput(commit));
  assert.equal(git(fixture.root, 'diff', '--name-only', 'origin/main', 'HEAD', '--', 'dist', 'src/harness/package.json'), '');
});

test('merge inheritance rejects missing, mixed, and edited remote protected pairs', async (t) =>
{
  await t.test('missing remote-tracking branch', () =>
  {
    const { root } = makeRepository(t);
    write(root, 'dist/harness/generated.txt', 'changed\n');
    git(root, 'add', 'dist/harness/generated.txt');
    const result = run(root, path.join(root, 'scripts/check-local-commit'), ['--merge']);
    assert.notEqual(result.status, 0);
    assert.match(combinedOutput(result), /origin\/main is unavailable/);
  });

  await t.test('mixed pair', () =>
  {
    const fixture = makeRepository(t, { remote: true });
    publishProtectedPair(fixture);
    git(fixture.root, 'fetch', '-q', 'origin', 'main');
    git(fixture.root, 'checkout', 'origin/main', '--', 'src/harness/package.json');
    const result = run(fixture.root, path.join(fixture.root, 'scripts/check-local-commit'), ['--merge']);
    assert.notEqual(result.status, 0);
    assert.match(combinedOutput(result), /PUBLISHED_PAIR_MISMATCH/);
  });

  await t.test('edited generated output', () =>
  {
    const fixture = makeRepository(t, { remote: true });
    publishProtectedPair(fixture);
    git(fixture.root, 'fetch', '-q', 'origin', 'main');
    git(fixture.root, 'checkout', 'origin/main', '--', 'dist', 'src/harness/package.json');
    write(fixture.root, 'dist/harness/generated.txt', 'hand edited\n');
    git(fixture.root, 'add', 'dist/harness/generated.txt');
    const result = run(fixture.root, path.join(fixture.root, 'scripts/check-local-commit'), ['--merge']);
    assert.notEqual(result.status, 0);
    assert.match(combinedOutput(result), /PUBLISHED_PAIR_MISMATCH/);
  });

  await t.test('stale remote-tracking pair', () =>
  {
    const fixture = makeRepository(t, { remote: true });
    const publisher = publishProtectedPair(fixture);
    fs.cpSync(path.join(publisher, 'dist'), path.join(fixture.root, 'dist'), {
      force: true,
      recursive: true,
    });
    fs.copyFileSync(
      path.join(publisher, 'src/harness/package.json'),
      path.join(fixture.root, 'src/harness/package.json'),
    );
    git(fixture.root, 'add', '--all', '--', 'dist', 'src/harness/package.json');
    const result = run(fixture.root, path.join(fixture.root, 'scripts/check-local-commit'), ['--merge']);
    assert.notEqual(result.status, 0);
    assert.match(combinedOutput(result), /PUBLISHED_PAIR_MISMATCH/);
  });
});

test('an ordinary commit cannot copy even the exact fetched published pair', (t) =>
{
  const fixture = makeRepository(t, { remote: true });
  publishProtectedPair(fixture);
  git(fixture.root, 'fetch', '-q', 'origin', 'main');
  git(fixture.root, 'checkout', 'origin/main', '--', 'dist', 'src/harness/package.json');

  const result = attemptCommit(fixture.root);
  assert.notEqual(result.status, 0);
  assert.match(combinedOutput(result), /RELEASE_OWNED_CHANGE/);
});

test('an operational failure in the remote-pair comparison fails closed', (t) =>
{
  const fixture = makeRepository(t, { remote: true });
  publishProtectedPair(fixture);
  git(fixture.root, 'fetch', '-q', 'origin', 'main');
  git(fixture.root, 'checkout', 'origin/main', '--', 'dist', 'src/harness/package.json');
  const remote = git(fixture.root, 'rev-parse', 'origin/main');
  const realGit = process.env.PATH.split(path.delimiter)
    .map(directory => path.join(directory, 'git'))
    .find(candidate => fs.existsSync(candidate));
  assert.ok(realGit, 'Git executable was not found on PATH');
  const fakeBin = path.join(fixture.parent, 'fake-bin');
  write(fixture.parent, 'fake-bin/git', '#!/bin/sh\nif [ "$1" = diff ]; then\n  for argument in "$@"; do\n    if [ "$argument" = "$FAIL_REV" ]; then\n      exit 73\n    fi\n  done\nfi\nexec "$REAL_GIT" "$@"\n', 0o755);
  const beforeIndex = indexBytes(fixture.root);

  const result = run(
    fixture.root,
    path.join(fixture.root, 'scripts/check-local-commit'),
    ['--merge'],
    {
      env: {
        FAIL_REV: remote,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        REAL_GIT: realGit,
      },
    },
  );
  assert.equal(result.status, 73, combinedOutput(result));
  assert.match(combinedOutput(result), /GIT_INSPECTION_FAILED/);
  assert.deepEqual(indexBytes(fixture.root), beforeIndex);
});

test('fast-forward and source-only rebase inherit releases without recreating them', async (t) =>
{
  await t.test('fast-forward', () =>
  {
    const fixture = makeRepository(t, { remote: true });
    publishProtectedPair(fixture);
    git(fixture.root, 'fetch', '-q', 'origin', 'main');
    git(fixture.root, 'merge', '--ff-only', '-q', 'origin/main');
    assert.equal(git(fixture.root, 'rev-parse', 'HEAD'), git(fixture.root, 'rev-parse', 'origin/main'));
  });

  await t.test('source-only rebase', () =>
  {
    const fixture = makeRepository(t, { remote: true });
    git(fixture.root, 'checkout', '-qb', 'feature');
    stageSource(fixture.root, 'export const feature = true;\n');
    git(fixture.root, 'commit', '-qm', 'feature source');
    publishProtectedPair(fixture);
    git(fixture.root, 'fetch', '-q', 'origin', 'main');
    git(fixture.root, 'rebase', 'origin/main');
    assert.equal(git(fixture.root, 'diff', '--name-only', 'origin/main', 'HEAD', '--', 'dist', 'src/harness/package.json'), '');
    assert.equal(git(fixture.root, 'show', 'HEAD:src/harness/implementation.ts'), 'export const feature = true;');
  });
});

test('updated hooks no longer run a build-time pre-push check', (t) =>
{
  const fixture = makeRepository(t, { remote: true });
  assert.equal(fs.existsSync(path.join(fixture.root, '.githooks/pre-push')), false);
  stageSource(fixture.root);
  git(fixture.root, 'commit', '-qm', 'source only');
  const result = gitResult(fixture.root, 'push', '-q', 'origin', 'main');
  assert.equal(result.status, 0, combinedOutput(result));
});
