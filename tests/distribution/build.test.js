'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { build, inventory } = require('../../scripts/build');
const { validate, validateTracked } = require('../../scripts/validate-dist');
const {
  TARGETS,
  artifactRoot,
  artifactPath,
  parseArtifactTarget,
  assertReleaseWriteIntent,
} = require('../../scripts/artifact-paths');
const { repositoryRoot } = require('../helpers/plugin-paths');

function fixture(t)
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(repositoryRoot, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['package.json', 'tsconfig.json'])
  {
    fs.copyFileSync(path.join(repositoryRoot, name), path.join(root, name));
  }
  for (const name of ['artifact-paths.js', 'build.js', 'validate-dist.js'])
  {
    fs.copyFileSync(path.join(repositoryRoot, 'scripts', name), path.join(root, 'scripts', name));
  }
  fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'));
  return root;
}

function write(root, name, value, mode = 0o644)
{
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { mode });
}

function snapshot(root, target)
{
  return [...inventory(artifactRoot(root, target), { overlays: true, missing: true })]
    .map(([name, entry]) => [name, entry.mode, fs.readFileSync(entry.absolute).toString('base64')]);
}

function runBuildCli(root, args, env = {})
{
  return spawnSync(process.execPath, [path.join(root, 'scripts/build.js'), ...args], {
    cwd: path.join(root, 'src'),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function initializeGit(root)
{
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Artifact Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'artifact@example.invalid'], { cwd: root });
}

test('fixed artifact targets reject arbitrary names and escaping paths', () =>
{
  assert.deepEqual(TARGETS, {
    development: '.build/harness',
    distribution: 'dist/harness',
  });
  assert.equal(artifactRoot('/repository', 'development'), path.resolve('/repository/.build/harness'));
  assert.equal(artifactPath('/repository', 'distribution', 'skills/example'), path.resolve('/repository/dist/harness/skills/example'));
  assert.throws(() => artifactRoot('/repository', 'elsewhere'), /unknown artifact target/);
  assert.throws(() => artifactPath('/repository', 'development', '..', '..', 'dist'), /escapes/);
  assert.deepEqual(parseArtifactTarget(['--check']), {
    target: 'development', explicitTarget: false, remaining: ['--check'],
  });
  assert.deepEqual(parseArtifactTarget(['--check', '--target', 'distribution']), {
    target: 'distribution', explicitTarget: true, remaining: ['--check'],
  });
  for (const args of [
    ['--target'],
    ['--target', '--check'],
    ['--target', 'elsewhere'],
    ['--target', 'development', '--target', 'development'],
  ])
  {
    assert.throws(() => parseArtifactTarget(args));
  }
});

test('default build creates a deterministic development artifact without changing publication', t =>
{
  const root = fixture(t);
  build(root, { target: 'distribution' });
  const published = snapshot(root, 'distribution');
  const canonical = fs.readFileSync(path.join(root, 'src/harness/package.json'));
  write(root, 'src/harness/shared/node/unreleased.ts', 'export const unreleased: number = 1;\n');

  build(root);
  const first = snapshot(root, 'development');
  assert.ok(fs.existsSync(artifactPath(root, 'development', 'shared/node/unreleased.js')));
  for (const name of [
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    'skills/harness-advisor/references/contract.md',
    'skills/extract-video-frames/scripts/tiff-to-heic.swift',
    'skills/write-asd-ste100/scripts/ste_check.py',
    'skills/back-up-directories/package-lock.json',
    'skills/back-up-directories/agents/openai.yaml',
  ])
  {
    assert.ok(fs.existsSync(artifactPath(root, 'development', name)), name);
  }
  assert.ok(first.some(([name]) => name.endsWith('.jsonl')));
  for (const [name, source] of inventory(path.join(root, 'src/harness')))
  {
    if (!fs.readFileSync(source.absolute).subarray(0, 2).equals(Buffer.from('#!')))
    {
      continue;
    }
    const output = name.replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs').replace(/\.ts$/, '.js');
    const installed = artifactPath(root, 'development', output);
    assert.equal(fs.readFileSync(installed).subarray(0, 2).toString(), '#!');
    assert.equal(fs.statSync(installed).mode & 0o111 ? 0o755 : 0o644, source.mode);
  }
  assert.deepEqual(snapshot(root, 'distribution'), published);
  assert.deepEqual(fs.readFileSync(path.join(root, 'src/harness/package.json')), canonical);
  assert.ok(validate(root) > 0);

  build(root);
  assert.deepEqual(snapshot(root, 'development'), first);
  build(root, { check: true });
});

test('development checks detect content, missing, extra, and mode drift without repair', t =>
{
  const root = fixture(t);
  build(root);
  const file = artifactPath(root, 'development', 'shared/node/media-result.js');
  for (const alter of [
    () => fs.appendFileSync(file, '\n// drift\n'),
    () => fs.unlinkSync(file),
    () => write(root, '.build/harness/extra.md', 'stale'),
    () => fs.chmodSync(file, 0o755),
  ])
  {
    alter();
    const before = snapshot(root, 'development');
    assert.throws(() => build(root, { check: true }), /Development artifact is stale/);
    assert.deepEqual(snapshot(root, 'development'), before);
    build(root);
  }
});

test('a distribution check can report expected publication drift without writing tracked output', t =>
{
  const root = fixture(t);
  build(root, { target: 'distribution' });
  write(root, 'src/harness/shared/node/unreleased.ts', 'export const unreleased: number = 1;\n');
  const before = snapshot(root, 'distribution');
  assert.throws(
    () => build(root, { target: 'distribution', check: true }),
    /Published distribution is stale[\s\S]*main-branch release workflow/,
  );
  assert.deepEqual(snapshot(root, 'distribution'), before);
});

test('renames, deletions, and mode changes reconcile while opaque overlays survive in either target', t =>
{
  for (const target of ['development', 'distribution'])
  {
    const root = fixture(t);
    write(root, 'src/harness/shared/node/temporary.ts', '#!/usr/bin/env node\nexport const value = 1;\n', 0o755);
    build(root, { target });
    const selected = artifactRoot(root, target);
    const overlay = path.join(selected, 'skills/back-up-directories/node_modules');
    write(overlay, 'keep', 'dependency');
    fs.symlinkSync('/absent/opaque-dependency', path.join(overlay, 'link'));
    write(selected, 'skills/write-asd-ste100/scripts/__pycache__/keep.pyc', 'cache');

    fs.renameSync(
      path.join(root, 'src/harness/shared/node/temporary.ts'),
      path.join(root, 'src/harness/shared/node/renamed.ts'),
    );
    fs.chmodSync(path.join(root, 'src/harness/shared/node/renamed.ts'), 0o644);
    build(root, { target });
    assert.equal(fs.existsSync(path.join(selected, 'shared/node/temporary.js')), false);
    assert.equal(fs.statSync(path.join(selected, 'shared/node/renamed.js')).mode & 0o111, 0);
    assert.equal(fs.readFileSync(path.join(overlay, 'keep'), 'utf8'), 'dependency');
    assert.equal(fs.lstatSync(path.join(overlay, 'link')).isSymbolicLink(), true);

    fs.unlinkSync(path.join(root, 'src/harness/shared/node/renamed.ts'));
    build(root, { target });
    assert.equal(fs.existsSync(path.join(selected, 'shared/node/renamed.js')), false);
    build(root, { target, check: true });
  }
});

test('assembly failures and unsafe ancestors retain the prior selected artifact', t =>
{
  const root = fixture(t);
  build(root);
  const before = snapshot(root, 'development');
  const bad = path.join(root, 'src/harness/shared/node/bad.ts');
  fs.writeFileSync(bad, 'export const value: number = "bad";');
  assert.throws(() => build(root), /Compilation failed/);
  assert.deepEqual(snapshot(root, 'development'), before);
  fs.unlinkSync(bad);

  write(root, 'src/harness/unsupported.bin', 'bad');
  assert.throws(() => build(root), /Unclassified/);
  assert.deepEqual(snapshot(root, 'development'), before);
  fs.unlinkSync(path.join(root, 'src/harness/unsupported.bin'));

  const collision = path.join(root, 'src/harness/shared/node/resolve-command.js');
  fs.mkdirSync(collision);
  fs.writeFileSync(path.join(collision, 'nested.md'), 'a directory cannot replace emitted JavaScript');
  assert.throws(() => build(root), /EEXIST|EISDIR|ENOTDIR/);
  assert.deepEqual(snapshot(root, 'development'), before);
  fs.rmSync(collision, { recursive: true });

  write(root, 'src/harness/shared/node/MEDIA-RESULT.ts', 'export const duplicate = true;\n');
  assert.throws(() => build(root), /Case-colliding paths/);
  assert.deepEqual(snapshot(root, 'development'), before);
  fs.unlinkSync(path.join(root, 'src/harness/shared/node/MEDIA-RESULT.ts'));

  fs.symlinkSync('/etc/passwd', bad);
  assert.throws(() => build(root), /Symlink/);
  assert.deepEqual(snapshot(root, 'development'), before);
  fs.unlinkSync(bad);

  fs.rmSync(path.join(root, '.build'), { recursive: true });
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-build-external-'));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  fs.symlinkSync(external, path.join(root, '.build'));
  assert.throws(() => build(root), /Expected a real directory/);
  assert.deepEqual(fs.readdirSync(external), []);
});

test('writers use independent locks and clean only invocation-owned staging', t =>
{
  const root = fixture(t);
  fs.mkdirSync(path.join(root, '.build/development.lock'), { recursive: true });
  write(root, '.build/unrelated/keep', 'keep');
  assert.throws(() => build(root), /development\.lock/);
  assert.equal(fs.readFileSync(path.join(root, '.build/unrelated/keep'), 'utf8'), 'keep');

  build(root, { target: 'distribution' });
  assert.ok(snapshot(root, 'distribution').length > 0);
  assert.equal(fs.existsSync(path.join(root, '.build/distribution.lock')), false);
  assert.deepEqual(
    fs.readdirSync(path.join(root, '.build')).filter(name => name.startsWith('stage-')),
    [],
  );
});

test('source versions are rejected and the canonical version is injected into both hosts', t =>
{
  const root = fixture(t);
  build(root);
  const template = path.join(root, 'src/harness/.claude-plugin/plugin.json');
  const original = fs.readFileSync(template, 'utf8');
  fs.writeFileSync(template, JSON.stringify({ ...JSON.parse(original), version: '9.0.0' }));
  assert.throws(() => build(root), /must not own a version/);
  fs.writeFileSync(template, original);

  const pkg = path.join(root, 'src/harness/package.json');
  fs.writeFileSync(pkg, JSON.stringify({ ...JSON.parse(fs.readFileSync(pkg)), version: '4.2.3' }));
  build(root);
  for (const host of ['.claude-plugin', '.codex-plugin'])
  {
    assert.equal(JSON.parse(fs.readFileSync(artifactPath(root, 'development', host, 'plugin.json'))).version, '4.2.3');
  }
  write(root, '.build/harness/tests/forbidden.js', 'bad');
  assert.throws(() => validate(root), /Unexpected JavaScript|Forbidden/);
  assert.throws(() => build(root), /Unexpected JavaScript|Forbidden/);
});

test('distribution-writing CLI requires every explicit release-intent condition before writing', t =>
{
  const root = fixture(t);
  const before = fs.readFileSync(path.join(root, 'src/harness/package.json'));
  for (const env of [{}, { CI: 'true' }, { GITHUB_ACTIONS: 'true', HARNESS_RELEASE_WRITE: '1' }])
  {
    const result = runBuildCli(root, ['--target', 'distribution'], env);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /RELEASE_WRITE_REQUIRED/);
    assert.equal(fs.existsSync(path.join(root, 'dist')), false);
    assert.deepEqual(fs.readFileSync(path.join(root, 'src/harness/package.json')), before);
  }

  const releaseEnvironment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'kylesaburao/harness-plugin',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'push',
    HARNESS_RELEASE_WRITE: '1',
  };
  assert.doesNotThrow(() => assertReleaseWriteIntent(releaseEnvironment));
  const result = runBuildCli(root, ['--target', 'distribution'], releaseEnvironment);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(snapshot(root, 'distribution').length > 0);
});

test('build CLI rejects malformed targets and arguments before changing either artifact', t =>
{
  const root = fixture(t);
  const cases = [
    ['--target'],
    ['--target', 'unknown'],
    ['--target', 'development', '--target', 'distribution'],
    ['--out-dir', 'elsewhere'],
    ['unexpected'],
    ['--check', '--check'],
  ];
  for (const args of cases)
  {
    const result = runBuildCli(root, args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(fs.existsSync(path.join(root, '.build')), false);
    assert.equal(fs.existsSync(path.join(root, 'dist')), false);
  }
  const help = runBuildCli(root, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(fs.existsSync(path.join(root, '.build')), false);
});

test('tracked validation compares index paths, modes, and raw blob bytes with tested files', t =>
{
  const root = fixture(t);
  build(root, { target: 'distribution' });
  initializeGit(root);
  execFileSync('git', ['add', 'dist'], { cwd: root });
  const files = inventory(artifactRoot(root, 'distribution'));
  validateTracked(root, files);
  assert.ok(validate(root, { target: 'distribution', tracked: true }) > 0);

  const relative = 'shared/node/media-result.js';
  const absolute = artifactPath(root, 'distribution', relative);
  const correct = fs.readFileSync(absolute);
  fs.appendFileSync(absolute, '\n// wrong indexed bytes\n');
  execFileSync('git', ['add', `dist/harness/${relative}`], { cwd: root });
  fs.writeFileSync(absolute, correct);
  assert.throws(() => validateTracked(root, files), /Indexed distribution blob differs/);
  execFileSync('git', ['add', `dist/harness/${relative}`], { cwd: root });
  validateTracked(root, files);

  execFileSync('git', ['update-index', '--chmod=+x', `dist/harness/${relative}`], { cwd: root });
  assert.throws(() => validateTracked(root, files), /wrong indexed executable mode/);
  execFileSync('git', ['update-index', '--chmod=-x', `dist/harness/${relative}`], { cwd: root });

  write(root, 'dist/outside.txt', 'forbidden');
  execFileSync('git', ['add', 'dist/outside.txt'], { cwd: root });
  assert.throws(() => validateTracked(root, files), /Forbidden\/stale tracked artifact/);
  execFileSync('git', ['rm', '--cached', '-q', 'dist/outside.txt'], { cwd: root });

  write(root, 'dist/harness/skills/back-up-directories/node_modules/tracked.js', 'forbidden');
  execFileSync('git', ['add', '-f', 'dist/harness/skills/back-up-directories/node_modules/tracked.js'], { cwd: root });
  assert.throws(() => validateTracked(root, files), /Forbidden\/stale tracked artifact/);
});

test('tracked validation handles NUL-delimited unusual names and rejects missing entries', t =>
{
  const root = fixture(t);
  write(root, 'src/harness/skills/unusual/references/line\nname.md', 'resource\n');
  build(root, { target: 'distribution' });
  initializeGit(root);
  execFileSync('git', ['add', 'dist'], { cwd: root });
  const files = inventory(artifactRoot(root, 'distribution'));
  validateTracked(root, files);

  execFileSync('git', ['rm', '--cached', '-q', 'dist/harness/package.json'], { cwd: root });
  assert.throws(() => validateTracked(root, files), /missing from index/);
});

test('validator CLI reserves tracked inspection for an explicit distribution target', t =>
{
  const root = fixture(t);
  const script = path.join(root, 'scripts/validate-dist.js');
  for (const args of [
    ['--tracked'],
    ['--target', 'development', '--tracked'],
    ['--tracked-records', 'records'],
    ['--target'],
  ])
  {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
  }
  const help = spawnSync(process.execPath, [script, '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(fs.existsSync(path.join(root, '.build')), false);
});
