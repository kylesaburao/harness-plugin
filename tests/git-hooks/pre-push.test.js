'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { build } = require('../../scripts/build');
const repoRoot = path.resolve(__dirname, '../..');
const hook = path.join(repoRoot, '.githooks/pre-push');
const zero = '0'.repeat(40);
const dates = { GIT_AUTHOR_DATE: '1999-12-31T23:59:00-08:00', GIT_COMMITTER_DATE: '1999-12-31T23:59:00-08:00' };
function write(root, name, text, mode = 0o644) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}
function command(cwd, executable, args, options = {}) {
  return spawnSync(executable, args, { cwd, encoding: 'utf8', env: { ...process.env, ...dates }, ...options });
}
function git(root, ...args) {
  const result = command(root, 'git', args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}
function fixture(t, real = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'checkout with spaces'); fs.mkdirSync(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'core.hooksPath', path.dirname(hook));
  git(root, 'init', '-q', '--bare', path.join(base, 'remote.git'));
  git(root, 'remote', 'add', 'local', path.join(base, 'remote.git'));
  write(root, '.gitignore', '.build/\nnode_modules\n');
  write(root, 'source.txt', 'valid\n'); write(root, 'dist/result.txt', 'valid\n');
  const bin = path.join(base, 'bin'); fs.mkdirSync(bin);
  write(bin, 'uname', '#!/bin/sh\necho Darwin\n', 0o755);
  const env = { ...process.env, ...dates, PATH: `${bin}:${process.env.PATH}`, CHECK_LOG: path.join(base, 'checks') };
  if (real) {
    fs.rmSync(path.join(root, 'dist'), { recursive: true });
    for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'scripts/build.js', 'scripts/validate-dist.js']) {
      write(root, name, fs.readFileSync(path.join(repoRoot, name)));
    }
    for (const name of ['package.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
      write(root, `src/harness/${name}`, fs.readFileSync(path.join(repoRoot, 'src/harness', name)));
    }
    write(root, 'src/harness/shared/node/example.ts', 'export const answer: number = 42;\n');
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'));
    build(root);
  } else {
    write(bin, 'npm', `#!/bin/sh
cat >/dev/null
printf '%s %s\\n' "$PWD" "$*" >> "$CHECK_LOG"
[ -d .git ] && [ ! -f .git/objects/info/alternates ] || exit 31
[ "$(git rev-parse --absolute-git-dir)" = "$PWD/.git" ] || exit 32
[ -z "$(git status --porcelain)" ] || exit 33
case "$*" in
  'ci --include=dev') exit "\${INSTALL_STATUS:-0}" ;;
  'run build:check') cmp source.txt dist/result.txt ;;
  *) exit 34 ;;
esac
`, 0o755);
    write(bin, 'node', `#!/bin/sh
printf '%s %s\\n' "$PWD" "$*" >> "$CHECK_LOG"
[ "$*" = 'scripts/validate-dist.js --tracked' ] || exit 35
exit "\${VALIDATE_STATUS:-0}"
`, 0o755);
  }
  function commit() { git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture'); return git(root, 'rev-parse', 'HEAD'); }
  const valid = commit();
  function invoke(records, overrides = {}) {
    return command(root, hook, [], { input: records, env: { ...env, ...overrides } });
  }
  function push(...refs) { return command(root, 'git', ['push', 'local', ...refs], { env }); }
  function clean() {
    assert.deepEqual(fs.readdirSync(path.join(root, '.build')).filter(name => name.startsWith('pre-push-')), []);
  }
  return { root, base, bin, env, valid, commit, invoke, push, clean };
}
const record = (oid, ref = 'refs/heads/test') => `${ref} ${oid} ${ref} ${zero}\n`;
const output = result => result.stdout + result.stderr;

test('real pushes accept a fresh TypeScript build and reject a stale commit despite an uncommitted rebuild', t => {
  const f = fixture(t, true);
  let result = f.push('HEAD:refs/heads/check');
  assert.equal(result.status, 0, output(result)); f.clean();
  write(f.root, 'src/harness/shared/node/example.ts', 'export const answer: number = 43;\n');
  const stale = f.commit();
  build(f.root);
  const state = git(f.root, 'status', '--porcelain');
  const index = fs.readFileSync(path.join(f.root, '.git/index'));
  const before = fs.readFileSync(path.join(f.root, 'dist/harness/shared/node/example.js'));
  result = f.push('HEAD:refs/heads/check');
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /Distribution is stale/);
  assert.match(output(result), new RegExp(stale));
  assert.equal(git(f.root, 'ls-remote', 'local', 'refs/heads/check').split(/\s/)[0], f.valid);
  assert.equal(git(f.root, 'status', '--porcelain'), state);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), index);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'dist/harness/shared/node/example.js')), before);
  f.clean();
});

test('non-HEAD refs, annotated tags and duplicate tips select the supplied commit only once', t => {
  const f = fixture(t);
  git(f.root, 'branch', 'good', f.valid);
  git(f.root, 'tag', '-a', 'good-tag', '-m', 'tag', f.valid);
  write(f.root, 'source.txt', 'stale\n'); f.commit();
  const result = f.push('good:refs/heads/good', 'refs/tags/good-tag');
  assert.equal(result.status, 0, output(result));
  assert.equal((output(result).match(/pre-push: checking/g) || []).length, 1);
  f.clean();
});

test('multiple distinct tips all run and a bad non-HEAD tip blocks the whole push', t => {
  const f = fixture(t);
  write(f.root, 'source.txt', 'stale\n'); const stale = f.commit();
  git(f.root, 'branch', 'bad', stale);
  write(f.root, 'dist/result.txt', 'stale\n'); f.commit();
  const result = f.push('HEAD:refs/heads/a-good', 'bad:refs/heads/z-bad');
  assert.notEqual(result.status, 0, output(result));
  assert.equal((output(result).match(/pre-push: checking/g) || []).length, 2);
  assert.equal(git(f.root, 'ls-remote', 'local'), '');
  f.clean();
});

test('deletion-only pushes skip tools, and non-commit objects fail clearly', t => {
  const f = fixture(t);
  assert.equal(f.push('HEAD:refs/heads/remove').status, 0);
  fs.unlinkSync(f.env.CHECK_LOG);
  const result = f.push(':refs/heads/remove');
  assert.equal(result.status, 0, output(result));
  assert.equal(fs.existsSync(f.env.CHECK_LOG), false);
  const blob = git(f.root, 'rev-parse', 'HEAD:source.txt');
  const bad = f.invoke(record(blob, 'refs/tags/blob'));
  assert.notEqual(bad.status, 0); assert.match(output(bad), /resolve outgoing commit/);
  f.clean();
});

test('failed prerequisites and tracked validation propagate, preserving caller Git environment and owned cleanup', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.build/unrelated'), { recursive: true }); write(f.root, '.build/unrelated/keep', 'keep');
  for (const [overrides, status] of [[{ INSTALL_STATUS: '17' }, 17], [{ VALIDATE_STATUS: '19' }, 19], [{}, 0]]) {
    const result = f.invoke(record(f.valid), { ...overrides, GIT_DIR: path.join(f.root, '.git'), GIT_INDEX_FILE: path.join(f.root, '.git/index') });
    assert.equal(result.status, status, output(result)); f.clean();
  }
  assert.equal(fs.readFileSync(path.join(f.root, '.build/unrelated/keep'), 'utf8'), 'keep');
  write(f.bin, 'npm', '#!/bin/sh\necho missing npm prerequisite >&2\nexit 127\n', 0o755);
  const result = f.invoke(record(f.valid));
  assert.equal(result.status, 127); assert.match(output(result), /missing npm prerequisite/); f.clean();
});

test('Linux dispatch uses the original launcher and host index export without host Node or npm', t => {
  const f = fixture(t);
  write(f.bin, 'uname', '#!/bin/sh\necho Linux\n', 0o755);
  write(f.bin, 'node', '#!/bin/sh\necho unexpected-host-node >&2\nexit 99\n', 0o755);
  write(f.bin, 'npm', '#!/bin/sh\necho unexpected-host-npm >&2\nexit 99\n', 0o755);
  // A launcher fixture validates argument boundaries and the mapped files. It does
  // not claim that Docker ran. The real validator's supplied-index path is tested separately.
  write(f.root, 'scripts/dev', `#!/bin/sh
[ "$1" = exec ] && [ "$2" = sh ] && [ "$3" = -ec ] && [ "$5" = pre-push ] || exit 41
case "$4" in *'npm ci --include=dev'*'npm run build:check'*'node scripts/validate-dist.js --tracked-records'*) ;; *) exit 42 ;; esac
root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
snapshot="$root/\${6#/workspace/harness-plugin/}"
records="$root/\${7#/workspace/harness-plugin/}"
[ -d "$snapshot/.git" ] && [ -s "$records" ] || exit 43
[ ! -f "$snapshot/.git/objects/info/alternates" ] || exit 44
git -C "$snapshot" ls-files --stage -z -- dist | cmp - "$records" || exit 45
printf '%s\\n' "$6" "$7" >> "$CHECK_LOG"
exit "\${LAUNCH_STATUS:-0}"
`, 0o755);
  for (const status of [0, 23]) {
    const result = f.invoke(record(f.valid), { LAUNCH_STATUS: String(status) });
    assert.equal(result.status, status, output(result)); f.clean();
  }
  assert.match(fs.readFileSync(f.env.CHECK_LOG, 'utf8'), /\/workspace\/harness-plugin\/\.build\/pre-push-/);
});

test('committed dependency symlinks cannot redirect npm outside the snapshot', t => {
  const f = fixture(t);
  const dependencies = path.join(f.base, 'external-dependencies');
  fs.mkdirSync(dependencies); write(dependencies, 'keep', 'keep');
  fs.symlinkSync(dependencies, path.join(f.root, 'node_modules'));
  git(f.root, 'add', '-f', 'node_modules');
  git(f.root, 'commit', '-qm', 'bad dependencies');
  const result = f.push('HEAD:refs/heads/check');
  assert.notEqual(result.status, 0);
  assert.match(output(result), /committed root node_modules is not permitted/);
  assert.equal(fs.existsSync(f.env.CHECK_LOG), false);
  assert.equal(fs.readFileSync(path.join(dependencies, 'keep'), 'utf8'), 'keep');
  f.clean();
});

test('interruption fails and cleanup waits for the active snapshot command', async t => {
  const f = fixture(t);
  write(f.bin, 'npm', `#!/bin/sh
echo ready > "$CHECK_LOG"
sleep 1
[ -d "$PWD" ] || exit 51
echo finished >> "$CHECK_LOG"
`, 0o755);
  const child = spawn(hook, [], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', data => { diagnostic += data; });
  child.stdout.resume();
  const ended = once(child, 'close');
  child.stdin.end(record(f.valid));
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(f.env.CHECK_LOG) && child.exitCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  child.kill('SIGTERM');
  const [status] = await ended;
  assert.equal(status, 143, diagnostic);
  assert.match(fs.readFileSync(f.env.CHECK_LOG, 'utf8'), /finished/);
  f.clean();
});
