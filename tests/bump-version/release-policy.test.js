'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  assertTestedInventory,
  findReleaseAnchor,
  findReleaseByRunId,
  inspectPublication,
  releaseRange,
  testedInventory,
  validateCommittedRelease,
  validateIncomingChanges,
  validateReleaseRecord,
  validateStagedRelease,
  validateWorkingRelease,
} = require('../../scripts/release-policy');
const { repositoryRoot: checkoutRoot } = require('../helpers/plugin-paths');

const FIXED_DATE = '1999-12-31T23:59:00-08:00';

function canonical(version)
{
  return `${JSON.stringify({
    name: 'harness',
    version,
    private: true,
    type: 'commonjs',
  }, null, 2)}\n`;
}

function fixture(t)
{
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-policy-'));
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
  const environment = {
    ...process.env,
    GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_DATE: FIXED_DATE,
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
  function write(repositoryPath, content, mode = 0o644)
  {
    const absolute = path.join(repositoryRoot, repositoryPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, { mode });
  }
  function remove(repositoryPath)
  {
    fs.rmSync(path.join(repositoryRoot, repositoryPath), { recursive: true, force: true });
  }
  function publish(version)
  {
    write('src/harness/package.json', canonical(version));
    remove('dist/harness');
    const sourceRoot = path.join(repositoryRoot, 'src/harness');
    function assemble(relative = '')
    {
      for (const directoryEntry of fs.readdirSync(path.join(sourceRoot, relative), {
        withFileTypes: true,
      }))
      {
        const child = relative ? `${relative}/${directoryEntry.name}` : directoryEntry.name;
        if (directoryEntry.isDirectory())
        {
          assemble(child);
          continue;
        }
        const sourcePath = path.join(sourceRoot, child);
        const sourceMode = fs.statSync(sourcePath).mode & 0o111 ? 0o755 : 0o644;
        if (child === '.claude-plugin/plugin.json' || child === '.codex-plugin/plugin.json')
        {
          const template = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
          write(
            `dist/harness/${child}`,
            `${JSON.stringify({ ...template, version }, null, 2)}\n`,
            sourceMode,
          );
        }
        else if (/\.d\.(?:ts|mts|cts)$/.test(child))
        {
          continue;
        }
        else if (/\.(?:ts|mts|cts)$/.test(child))
        {
          const output = child
            .replace(/\.mts$/, '.mjs')
            .replace(/\.cts$/, '.cjs')
            .replace(/\.ts$/, '.js');
          write(`dist/harness/${output}`, `// compiled fixture for ${child}\n`, sourceMode);
        }
        else
        {
          write(`dist/harness/${child}`, fs.readFileSync(sourcePath), sourceMode);
        }
      }
    }
    assemble();
  }
  function commit(subject, body = null)
  {
    git('add', '--all');
    const arguments_ = ['commit', '-m', subject];
    if (body !== null)
    {
      arguments_.push('-m', body);
    }
    git(...arguments_);
    return git('rev-parse', 'HEAD');
  }
  function source(repositoryPath, content, subject)
  {
    write(repositoryPath, content);
    return commit(subject);
  }
  function stageRelease(version)
  {
    publish(version);
    git('add', '-A', '--', 'src/harness/package.json', 'dist');
  }
  function commitRelease(version, sourceCommit, runId)
  {
    stageRelease(version);
    return commit(
      `chore: bump version to ${version}`,
      `Harness-Source: ${sourceCommit}\nHarness-Release-Run: ${runId}`,
    );
  }

  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  write('.github/workflows/bump-version.yml', 'name: fixture release\n');
  write('src/harness/.claude-plugin/plugin.json', `${JSON.stringify({
    name: 'harness',
  }, null, 2)}\n`);
  write('src/harness/.codex-plugin/plugin.json', `${JSON.stringify({
    name: 'harness',
    skills: './skills/',
  }, null, 2)}\n`);
  publish('1.0.0');
  commit('initial published state');
  publish('1.0.1');
  const legacyRelease = commit('chore: bump version to 1.0.1');
  return {
    commit,
    commitRelease,
    environment,
    git,
    legacyRelease,
    publish,
    remove,
    repositoryRoot,
    source,
    stageRelease,
    write,
  };
}

function policyCode(callback)
{
  try
  {
    callback();
  }
  catch (error)
  {
    return error.code;
  }
  return null;
}

test('the checked-in 3.1.9 commit remains a valid trailerless legacy anchor', () =>
{
  const result = spawnSync('git', [
    'log', '--all', '--fixed-strings', '--format=%H', '--grep=chore: bump version to 3.1.9',
  ], {
    cwd: checkoutRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const legacyCommit = result.stdout.trim().split('\n')[0];
  assert.match(legacyCommit, /^[0-9a-f]{40,64}$/);
  const record = validateReleaseRecord(checkoutRoot, legacyCommit);
  assert.equal(record.version, '3.1.9');
  assert.equal(record.requiresTrailers, false);
});

test('a structurally valid legacy record anchors the complete source range', (t) =>
{
  const f = fixture(t);
  f.source('src/harness/skills/example/SKILL.md', 'one\n', 'source [bump:minor]');
  f.source('README.md', 'docs\n', 'docs');
  const selected = releaseRange(f.repositoryRoot, { requireAnchor: true });
  assert.equal(selected.anchor.commit, f.legacyRelease);
  assert.equal(selected.level, 'minor');
  assert.equal(selected.commits.length, 2);
});

test('the nearest release-looking record cannot hide malformed contents', (t) =>
{
  const f = fixture(t);
  f.git('commit', '--allow-empty', '-m', 'chore: bump version to 1.0.2');
  assert.equal(
    policyCode(() => findReleaseAnchor(f.repositoryRoot, 'HEAD', { required: true })),
    'INVALID_RELEASE_ANCHOR',
  );
});

test('release ancestry checks reject shallow history explicitly', (t) =>
{
  const f = fixture(t);
  const cloneHome = fs.mkdtempSync(path.join(os.tmpdir(), 'release-policy-shallow-'));
  t.after(() => fs.rmSync(cloneHome, { recursive: true, force: true }));
  const shallow = path.join(cloneHome, 'checkout');
  const clone = spawnSync('git', [
    'clone',
    '-q',
    '--depth=1',
    `file://${f.repositoryRoot}`,
    shallow,
  ], { encoding: 'utf8' });
  assert.equal(clone.status, 0, clone.stderr);
  assert.equal(
    policyCode(() => findReleaseAnchor(shallow, 'HEAD', { required: true })),
    'INCOMPLETE_GIT_HISTORY',
  );
});

test('source policy accepts source-only commits and unusual filenames', (t) =>
{
  const f = fixture(t);
  const base = f.legacyRelease;
  const unusual = 'src/harness/skills/ café\tline\n/SKILL.md';
  const head = f.source(unusual, 'skill\n', 'source only');
  const result = validateIncomingChanges(f.repositoryRoot, { base, head });
  assert.equal(result.base, base);
  assert.equal(result.head, head);
  assert.deepEqual(result.commits, [head]);
  const cli = spawnSync(process.execPath, [
    path.join(checkoutRoot, 'scripts/check-source-policy.js'),
    '--base', base,
    '--head', head,
  ], {
    cwd: f.repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Source policy passed/);
});

test('source policy rejects protected edits even when a later commit restores the final pair', (t) =>
{
  const f = fixture(t);
  const base = f.legacyRelease;
  f.source('dist/harness/unauthorized.md', 'bad\n', 'forbidden output');
  f.remove('dist/harness/unauthorized.md');
  const head = f.commit('restore output');
  assert.equal(
    policyCode(() => validateIncomingChanges(f.repositoryRoot, { base, head })),
    'PROTECTED_CONTENT_CHANGED',
  );
});

test('source policy reserves release subjects even without a protected diff', (t) =>
{
  const f = fixture(t);
  const base = f.legacyRelease;
  f.git('commit', '--allow-empty', '-m', 'chore: bump version to 1.0.2');
  const head = f.git('rev-parse', 'HEAD');
  assert.equal(
    policyCode(() => validateIncomingChanges(f.repositoryRoot, { base, head })),
    'RESERVED_RELEASE_SUBJECT',
  );
});

test('release derivation includes merged subjects, mode changes, merge resolutions, and moves out of source', (t) =>
{
  const f = fixture(t);
  f.source('src/harness/shared/node/example.ts', 'export {};\n', 'source');
  f.git('checkout', '-qb', 'feature');
  const feature = f.source('notes.md', 'tag is on merged documentation\n', 'notes [bump:minor]');
  fs.chmodSync(path.join(f.repositoryRoot, 'src/harness/shared/node/example.ts'), 0o755);
  f.commit('source mode change');
  f.git('checkout', '-q', 'main');
  f.source('main.md', 'main\n', 'main branch');
  f.git('merge', '--no-ff', '--no-commit', 'feature');
  f.write('src/harness/shared/node/resolution.ts', 'export const resolution = true;\n');
  f.commit('merge source branches');
  f.git('mv', 'src/harness/shared/node/example.ts', 'moved-out.md');
  f.commit('move out of source');
  const range = releaseRange(f.repositoryRoot, { requireAnchor: true });
  assert.equal(range.level, 'minor');
  assert.ok(range.commits.includes(feature));
  assert.ok(range.paths.includes('src/harness/shared/node/example.ts'));
  assert.ok(range.paths.includes('src/harness/shared/node/resolution.ts'));
});

test('source policy rejects missing, non-commit, and non-ancestor baselines', (t) =>
{
  const f = fixture(t);
  const base = f.git('rev-parse', 'HEAD');
  assert.equal(
    policyCode(() => validateIncomingChanges(f.repositoryRoot, {
      base: 'missing-history',
      head: base,
    })),
    'INVALID_REVISION',
  );
  const blob = f.git('rev-parse', `${base}:src/harness/package.json`);
  assert.equal(
    policyCode(() => validateIncomingChanges(f.repositoryRoot, { base, head: blob })),
    'INVALID_REVISION',
  );
  f.git('checkout', '--orphan', 'unrelated');
  f.git('rm', '-rf', '.');
  const unrelated = f.source('README.md', 'new history\n', 'unrelated root');
  assert.equal(
    policyCode(() => validateIncomingChanges(f.repositoryRoot, { base, head: unrelated })),
    'NON_ANCESTOR_SOURCE_RANGE',
  );
});

test('PR integration may inherit a newer base release than the source branch', (t) =>
{
  const f = fixture(t);
  f.git('checkout', '-q', '-b', 'feature');
  const head = f.source('src/harness/shared/node/feature.ts', 'export {};\n', 'feature source');
  f.git('checkout', '-q', 'main');
  f.publish('1.0.2');
  const base = f.commit('chore: bump version to 1.0.2');
  f.git('merge', '--no-ff', 'feature', '-m', 'integration');
  const integration = f.git('rev-parse', 'HEAD');
  const result = validateIncomingChanges(f.repositoryRoot, { base, head, integration });
  assert.equal(result.integration, integration);
  assert.deepEqual(result.commits, [head]);
});

test('source policy rejects a merge that synthesizes a protected pair', (t) =>
{
  const f = fixture(t);
  const base = f.legacyRelease;
  f.git('checkout', '-q', '-b', 'left');
  f.source('left.md', 'left\n', 'left source');
  f.git('checkout', '-q', '-b', 'right', base);
  f.source('right.md', 'right\n', 'right source');
  f.git('checkout', '-q', 'left');
  f.git('merge', '--no-ff', '--no-commit', 'right');
  f.write('dist/harness/fabricated.md', 'not inherited\n');
  const head = f.commit('synthesized merge');
  assert.equal(
    policyCode(() => validateIncomingChanges(f.repositoryRoot, { base, head })),
    'PROTECTED_CONTENT_CHANGED',
  );
});

test('canonical package mode changes are not version-only publication changes', (t) =>
{
  const f = fixture(t);
  const base = f.source('src/harness/shared/node/example.ts', 'export {};\n', 'source');
  f.stageRelease('1.0.2');
  fs.chmodSync(path.join(f.repositoryRoot, 'src/harness/package.json'), 0o755);
  f.git('add', 'src/harness/package.json');
  assert.equal(
    policyCode(() => validateStagedRelease(f.repositoryRoot, {
      base,
      level: 'patch',
      next: '1.0.2',
    })),
    'CANONICAL_PACKAGE_MODE_CHANGED',
  );
  const commit = f.commit('chore: bump version to 1.0.2');
  assert.equal(
    policyCode(() => validateReleaseRecord(f.repositoryRoot, commit)),
    'CANONICAL_PACKAGE_MODE_CHANGED',
  );
});

test('staged validation binds canonical version, generated versions, bytes, modes, and full scope', (t) =>
{
  const f = fixture(t);
  f.write('scripts/check-release.js', 'migration marker\n');
  const base = f.source('src/harness/shared/node/example.ts', 'export {};\n', 'migration source');
  f.stageRelease('1.0.2');
  const report = validateStagedRelease(f.repositoryRoot, {
    base,
    level: 'patch',
    next: '1.0.2',
  });
  assert.equal(report.previous, '1.0.1');
  assert.equal(report.next, '1.0.2');
  assert.equal(report.files, 4);
  const cli = spawnSync(process.execPath, [
    path.join(checkoutRoot, 'scripts/check-release.js'),
    '--base', base,
    '--level', 'patch',
    '--next', '1.0.2',
    '--staged',
  ], {
    cwd: f.repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Staged release passed/);

  f.write('dist/harness/package.json', `${canonical('1.0.2')} `);
  assert.equal(
    policyCode(() => validateStagedRelease(f.repositoryRoot, {
      base,
      level: 'patch',
      next: '1.0.2',
    })),
    'INDEX_WORKTREE_MISMATCH',
  );
});

test('staged validation rejects stale indexed bytes even when working files are correct', (t) =>
{
  const f = fixture(t);
  f.write('scripts/check-release.js', 'migration marker\n');
  const base = f.source('src/harness/shared/node/example.ts', 'export {};\n', 'migration source');
  f.stageRelease('1.0.2');
  f.write('dist/harness/package.json', canonical('9.9.9'));
  f.git('add', 'dist/harness/package.json');
  f.write('dist/harness/package.json', canonical('1.0.2'));
  assert.equal(
    policyCode(() => validateStagedRelease(f.repositoryRoot, {
      base,
      level: 'patch',
      next: '1.0.2',
    })),
    'GENERATED_VERSION_MISMATCH',
  );
});

test('staged validation rejects indexed overlays and paths outside dist/harness', (t) =>
{
  const f = fixture(t);
  f.write('scripts/check-release.js', 'migration marker\n');
  const base = f.source('src/harness/shared/node/example.ts', 'export {};\n', 'migration source');
  f.stageRelease('1.0.2');
  f.write('dist/harness/skills/back-up-directories/node_modules/bad.js', 'bad\n');
  f.git('add', '-f', 'dist/harness/skills/back-up-directories/node_modules/bad.js');
  assert.equal(
    policyCode(() => validateStagedRelease(f.repositoryRoot, {
      base,
      level: 'patch',
      next: '1.0.2',
    })),
    'FORBIDDEN_ARTIFACT_PATH',
  );
});

test('staged validation rejects allowed-looking output without a source input', (t) =>
{
  const f = fixture(t);
  f.write('scripts/check-release.js', 'migration marker\n');
  const base = f.source('src/harness/shared/node/example.ts', 'export {};\n', 'migration source');
  f.stageRelease('1.0.2');
  f.write('dist/harness/evil.md', 'fabricated output\n');
  f.git('add', 'dist/harness/evil.md');
  assert.equal(
    policyCode(() => validateStagedRelease(f.repositoryRoot, {
      base,
      level: 'patch',
      next: '1.0.2',
    })),
    'UNEXPECTED_ARTIFACT_OUTPUT',
  );
});

test('release records require the complete structural source-derived inventory', (t) =>
{
  const f = fixture(t);
  f.write('scripts/check-release.js', 'migration marker\n');
  const base = f.source(
    'src/harness/skills/example/SKILL.md',
    '---\nname: example\ndescription: fixture\n---\n',
    'migration source',
  );
  f.stageRelease('1.0.2');
  f.remove('dist/harness/skills/example/SKILL.md');
  const release = f.commit(
    'chore: bump version to 1.0.2',
    `Harness-Source: ${base}\nHarness-Release-Run: 700`,
  );
  assert.equal(
    policyCode(() => validateReleaseRecord(f.repositoryRoot, release)),
    'ARTIFACT_OUTPUT_MISSING',
  );
});

test('release records reject unrelated paths and canonical metadata changes', (t) =>
{
  const unrelated = fixture(t);
  unrelated.write('scripts/check-release.js', 'migration marker\n');
  const unrelatedBase = unrelated.source(
    'src/harness/shared/node/example.ts',
    'export {};\n',
    'migration source',
  );
  unrelated.stageRelease('1.0.2');
  unrelated.write('README.md', 'not release-owned\n');
  const unrelatedRelease = unrelated.commit(
    'chore: bump version to 1.0.2',
    `Harness-Source: ${unrelatedBase}\nHarness-Release-Run: 701`,
  );
  assert.equal(
    policyCode(() => validateReleaseRecord(unrelated.repositoryRoot, unrelatedRelease)),
    'INVALID_RELEASE_DIFF',
  );

  const metadata = fixture(t);
  metadata.write('scripts/check-release.js', 'migration marker\n');
  const metadataBase = metadata.source(
    'src/harness/shared/node/example.ts',
    'export {};\n',
    'migration source',
  );
  metadata.stageRelease('1.0.2');
  const changed = JSON.parse(canonical('1.0.2'));
  changed.license = 'MIT';
  metadata.write('src/harness/package.json', `${JSON.stringify(changed, null, 2)}\n`);
  const metadataRelease = metadata.commit(
    'chore: bump version to 1.0.2',
    `Harness-Source: ${metadataBase}\nHarness-Release-Run: 702`,
  );
  assert.equal(
    policyCode(() => validateReleaseRecord(metadata.repositoryRoot, metadataRelease)),
    'INVALID_CANONICAL_PACKAGE',
  );
});

test('post-test inventory detects any release byte or mode change after capture', (t) =>
{
  const f = fixture(t);
  f.write('scripts/check-release.js', 'migration marker\n');
  f.source('src/harness/shared/node/example.ts', 'export {};\n', 'migration source');
  f.stageRelease('1.0.2');
  assert.doesNotThrow(() => validateWorkingRelease(f.repositoryRoot, {
    base: f.git('rev-parse', 'HEAD'),
    level: 'patch',
    next: '1.0.2',
  }));
  const inventory = testedInventory(f.repositoryRoot);
  assert.doesNotThrow(() => assertTestedInventory(f.repositoryRoot, inventory));
  f.write('dist/harness/.claude-plugin/plugin.json', '{}\n');
  assert.equal(
    policyCode(() => assertTestedInventory(f.repositoryRoot, inventory)),
    'TESTED_CONTENT_CHANGED',
  );
});

test('publication inspection validates workflow identity, source policy, eligibility, and manual override', (t) =>
{
  const f = fixture(t);
  const executedWorkflow = f.legacyRelease;
  f.write('scripts/check-release.js', 'migration marker\n');
  const source = f.source('src/harness/shared/node/example.ts', 'export {};\n', 'migration source');
  const automatic = inspectPublication(f.repositoryRoot, {
    head: source,
    runId: '321',
    workflowSha: executedWorkflow,
  });
  assert.equal(automatic.status, 'ready');
  assert.equal(automatic.source, source);
  assert.equal(automatic.level, 'patch');
  assert.equal(automatic.previous, '1.0.1');

  const manual = inspectPublication(f.repositoryRoot, {
    head: source,
    runId: '322',
    workflowSha: executedWorkflow,
    manualLevel: 'major',
  });
  assert.equal(manual.level, 'major');

  f.source('.github/workflows/bump-version.yml', 'name: changed release\n', 'workflow change');
  assert.equal(
    policyCode(() => inspectPublication(f.repositoryRoot, {
      head: 'HEAD',
      runId: '323',
      workflowSha: executedWorkflow,
    })),
    'STALE_WORKFLOW',
  );
});

test('new release commit validation requires matching trailers, increment, tree, and fixed timestamps', (t) =>
{
  const f = fixture(t);
  f.write('scripts/check-release.js', 'migration marker\n');
  const base = f.source('src/harness/shared/node/example.ts', 'export {};\n', 'migration source');
  f.stageRelease('1.0.2');
  validateStagedRelease(f.repositoryRoot, { base, level: 'patch', next: '1.0.2' });
  f.git('config', 'user.name', 'github-actions[bot]');
  f.git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  const release = f.commit(
    'chore: bump version to 1.0.2',
    `Harness-Source: ${base}\nHarness-Release-Run: 12345`,
  );
  const record = validateCommittedRelease(f.repositoryRoot, {
    base,
    level: 'patch',
    next: '1.0.2',
    commit: release,
    runId: '12345',
  });
  assert.equal(record.commit, release);
  assert.equal(record.source, base);
  assert.equal(record.runId, '12345');
  const cli = spawnSync(process.execPath, [
    path.join(checkoutRoot, 'scripts/check-release.js'),
    '--base', base,
    '--level', 'patch',
    '--next', '1.0.2',
    '--commit', release,
    '--run-id', '12345',
  ], {
    cwd: f.repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Release commit passed/);
  assert.equal(findReleaseByRunId(f.repositoryRoot, 'HEAD', '12345').commit, release);
  assert.equal(findReleaseByRunId(f.repositoryRoot, 'HEAD', '54321'), null);
  const repeated = inspectPublication(f.repositoryRoot, {
    head: release,
    runId: '12345',
    workflowSha: 'an-unneeded-ref-after-publication',
  });
  assert.equal(repeated.status, 'already published');
  assert.equal(repeated.release, release);
  assert.equal(
    policyCode(() => validateCommittedRelease(f.repositoryRoot, {
      base,
      level: 'patch',
      next: '1.0.2',
      commit: release,
      runId: '99999',
    })),
    'RELEASE_TRANSACTION_MISMATCH',
  );
});

test('a migrated release record without trailers is invalid', (t) =>
{
  const f = fixture(t);
  f.write('scripts/check-release.js', 'migration marker\n');
  const base = f.source('src/harness/shared/node/example.ts', 'export {};\n', 'migration source');
  f.stageRelease('1.0.2');
  const release = f.commit('chore: bump version to 1.0.2');
  assert.equal(policyCode(() => validateReleaseRecord(f.repositoryRoot, release)), 'INVALID_RELEASE_TRAILERS');
  assert.equal(base.length, 40);
});

test('trailer enforcement remains active after the migration marker is deleted', (t) =>
{
  const f = fixture(t);
  f.write('scripts/check-release.js', 'migration marker\n');
  f.source('src/harness/shared/node/example.ts', 'export {};\n', 'migration source');
  f.remove('scripts/check-release.js');
  f.commit('remove obsolete marker path');
  f.stageRelease('1.0.2');
  const release = f.commit('chore: bump version to 1.0.2');
  assert.equal(
    policyCode(() => validateReleaseRecord(f.repositoryRoot, release)),
    'INVALID_RELEASE_TRAILERS',
  );
});

test('a duplicate matching run trailer fails idempotency inspection closed', (t) =>
{
  const f = fixture(t);
  f.write('scripts/check-release.js', 'migration marker\n');
  const base = f.source('src/harness/shared/node/example.ts', 'export {};\n', 'migration source');
  f.stageRelease('1.0.2');
  const release = f.commit(
    'chore: bump version to 1.0.2',
    `Harness-Source: ${base}\nHarness-Release-Run: 888\nHarness-Release-Run: 888`,
  );
  assert.equal(
    policyCode(() => findReleaseByRunId(f.repositoryRoot, release, '888')),
    'INVALID_RELEASE_TRAILERS',
  );
});

test('release metadata lines in the message body do not satisfy trailer policy', (t) =>
{
  const f = fixture(t);
  f.write('scripts/check-release.js', 'migration marker\n');
  const base = f.source('src/harness/shared/node/example.ts', 'export {};\n', 'migration source');
  f.stageRelease('1.0.2');
  const release = f.commit(
    'chore: bump version to 1.0.2',
    `Harness-Source: ${base}\n\nHarness-Release-Run: 889`,
  );
  assert.equal(
    policyCode(() => validateReleaseRecord(f.repositoryRoot, release)),
    'INVALID_RELEASE_TRAILERS',
  );
});

test('final transaction validation rejects a non-publisher commit identity', (t) =>
{
  const f = fixture(t);
  f.write('scripts/check-release.js', 'migration marker\n');
  const base = f.source('src/harness/shared/node/example.ts', 'export {};\n', 'migration source');
  const release = f.commitRelease('1.0.2', base, '777');
  assert.equal(
    policyCode(() => validateCommittedRelease(f.repositoryRoot, {
      base,
      level: 'patch',
      next: '1.0.2',
      commit: release,
      runId: '777',
    })),
    'RELEASE_IDENTITY_MISMATCH',
  );
});

test('final transaction validation requires the exact fixed timestamp offset', (t) =>
{
  const f = fixture(t);
  f.write('scripts/check-release.js', 'migration marker\n');
  const base = f.source('src/harness/shared/node/example.ts', 'export {};\n', 'migration source');
  f.git('config', 'user.name', 'github-actions[bot]');
  f.git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  f.environment.GIT_AUTHOR_DATE = '2000-01-01T07:59:00+00:00';
  f.environment.GIT_COMMITTER_DATE = '2000-01-01T07:59:00+00:00';
  const release = f.commitRelease('1.0.2', base, '778');
  assert.equal(
    policyCode(() => validateCommittedRelease(f.repositoryRoot, {
      base,
      level: 'patch',
      next: '1.0.2',
      commit: release,
      runId: '778',
    })),
    'RELEASE_TIMESTAMP_MISMATCH',
  );
});

test('CLI entry points validate arguments before inspecting Git', () =>
{
  for (const [script, arguments_] of [
    ['check-source-policy.js', ['--base', 'HEAD']],
    ['check-source-policy.js', ['--base', '--not-a-value', '--head', 'HEAD']],
    ['check-release.js', ['--base', 'HEAD', '--level', 'patch', '--next', '1.0.1']],
    ['check-release.js', [
      '--base', '--not-a-value', '--level', 'patch', '--next', '1.0.1', '--staged',
    ]],
  ])
  {
    const result = spawnSync(process.execPath, [path.join(checkoutRoot, 'scripts', script), ...arguments_], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /ERROR \[/);
    assert.doesNotMatch(result.stderr, /not a git repository/);
  }
});
