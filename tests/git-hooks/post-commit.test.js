'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOKS_DIR = path.resolve(__dirname, '../../.githooks');
const TARGET_EPOCH = '946713540';

// Every commit made against a repo with core.hooksPath pointed at HOOKS_DIR should land on
// this fixed author/committer instant, per the ".githooks/post-commit" hook and the convention
// documented in AGENTS.md ("Commit timestamps"). These tests exercise the real hook end to end,
// in a throwaway repo, rather than re-implementing its logic.

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      // Deliberately not setting GIT_AUTHOR_DATE/GIT_COMMITTER_DATE here - the hook is what's
      // supposed to fix the date after an ordinary, unadorned commit.
    },
  }).trim();
}

function datesOf(cwd) {
  return git(cwd, ['log', '-1', '--format=%at %ct']);
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-commit-hook-test-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'core.hooksPath', HOOKS_DIR]);
  return dir;
}

test('a fresh commit ends up at the fixed author and committer date', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-q', '-m', 'first commit']);

  assert.equal(datesOf(dir), `${TARGET_EPOCH} ${TARGET_EPOCH}`);
});

test('the amend does not create an extra commit or change the message/tree', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-q', '-m', 'first commit']);

  assert.equal(git(dir, ['log', '--oneline']).split('\n').length, 1);
  assert.equal(git(dir, ['log', '-1', '--format=%s']), 'first commit');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello\n');
});

test('committing again on top of an already-correct HEAD stays correct and terminates', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-q', '-m', 'first commit']);
  assert.equal(datesOf(dir), `${TARGET_EPOCH} ${TARGET_EPOCH}`);

  fs.appendFileSync(path.join(dir, 'a.txt'), 'world\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-q', '-m', 'second commit']);

  assert.equal(datesOf(dir), `${TARGET_EPOCH} ${TARGET_EPOCH}`);
  assert.equal(git(dir, ['log', '--oneline']).split('\n').length, 2);
});
