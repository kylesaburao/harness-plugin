'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveBumpLevel,
  deriveFromRange,
  isRelevantPath,
  readReleaseRange,
} = require('../../scripts/derive-bump-level.js');

// Most cases here are about subjects, not paths, so give them a relevant path by default and let
// the path-gate cases pass one explicitly.
function commit(subject, paths = ['plugins/harness/skills/foo/SKILL.md']) {
  return { hash: subject.slice(0, 7), subject, paths };
}

function range(entries) {
  return { subjects: entries.map(entry => entry.subject), paths: entries.flatMap(entry => entry.paths) };
}

test('deriveBumpLevel: all-patch subjects default to patch', () => {
  assert.equal(deriveBumpLevel(['add foo skill', 'fix typo', 'remove dead code']), 'patch');
});

test('deriveBumpLevel: one [bump:minor] among several patch-shaped subjects wins', () => {
  assert.equal(deriveBumpLevel(['add foo skill', 'add bar skill [bump:minor]', 'fix typo']), 'minor');
});

test('deriveBumpLevel: [bump:major] beats [bump:minor] when both are present', () => {
  assert.equal(deriveBumpLevel(['add foo [bump:minor]', 'drop codex support [bump:major]']), 'major');
});

test('deriveBumpLevel: empty subject list defaults to patch', () => {
  assert.equal(deriveBumpLevel([]), 'patch');
});

test('deriveBumpLevel: the tag matches wherever it sits in the subject', () => {
  assert.equal(deriveBumpLevel(['add foo [bump:minor] skill']), 'minor');
});

test('deriveFromRange: scans the complete selected range', () => {
  const entries = [
    commit('add foo skill'),
    commit('chore: bump version to 99.0.0', []),
    commit('add bar skill [bump:minor]'),
  ];
  assert.equal(deriveFromRange(range(entries)), 'minor');
});

test('deriveFromRange: a batched push spanning several commits still finds the deepest tag', () => {
  // Simulates one `git push` landing three commits at once, oldest tag buried under two others.
  const entries = [
    commit('fix typo'),
    commit('add foo [bump:major]'),
    commit('add bar skill'),
  ];
  assert.equal(deriveFromRange(range(entries)), 'major');
});

test('deriveFromRange: nothing since the last bump is "none"', () => {
  const entries = [];
  assert.equal(deriveFromRange(range(entries)), 'none');
});

test('deriveFromRange: an empty log is "none"', () => {
  assert.equal(deriveFromRange(range([])), 'none');
});

test('deriveFromRange: no prior bump commit at all scans the whole history', () => {
  const entries = [
    commit('add foo skill'),
    commit('add bar skill [bump:minor]'),
    commit('initial commit'),
  ];
  assert.equal(deriveFromRange(range(entries)), 'minor');
});

test('deriveFromRange: bump-looking prose does not affect the selected range', () => {
  const entries = [
    commit('document the chore: bump version to X.Y.Z convention'),
  ];
  assert.equal(deriveFromRange(range(entries)), 'patch');
});

test('deriveFromRange: a docs-only range is "none"', () => {
  const entries = [
    commit('clarify the install steps', ['README.md']),
    commit('document the preflight contract', ['AGENTS.md', 'CLAUDE.md']),
  ];
  assert.equal(deriveFromRange(range(entries)), 'none');
});

test('deriveFromRange: a tests-only range is "none"', () => {
  const entries = [
    commit('cover the GIF CLI contract', ['tests/create-discord-emoji-gif/cli-contract.test.js']),
  ];
  assert.equal(deriveFromRange(range(entries)), 'none');
});

test('deriveFromRange: changes to this repo\'s own tooling are "none"', () => {
  // scripts/ and .github/ never reach an install, so touching the bump machinery itself must not
  // mint a version - the case most likely to surprise, since it self-triggers.
  const entries = [
    commit('gate bumps on plugin-relevant paths', [
      'scripts/derive-bump-level.js',
      '.github/workflows/bump-version.yml',
      '.githooks/post-commit',
    ]),
  ];
  assert.equal(deriveFromRange(range(entries)), 'none');
});

test('deriveFromRange: one relevant commit among docs commits still bumps', () => {
  const entries = [
    commit('fix a README typo', ['README.md']),
    commit('add the natural-style skill', ['plugins/harness/skills/natural-style/SKILL.md']),
    commit('rework the test layout', ['tests/bump-version/derive-bump-level.test.js']),
  ];
  assert.equal(deriveFromRange(range(entries)), 'patch');
});

test('deriveFromRange: a tag on an irrelevant commit is honored when the range is relevant', () => {
  // Paths decide whether to bump, subjects decide how much. The [bump:minor] here sits on a docs
  // commit, but the range contains a real plugin change, so the human signal stands.
  const entries = [
    commit('note the new skill in the readme [bump:minor]', ['README.md']),
    commit('add the natural-style skill', ['plugins/harness/skills/natural-style/SKILL.md']),
  ];
  assert.equal(deriveFromRange(range(entries)), 'minor');
});

test('deriveFromRange: a tag cannot force a bump when nothing relevant changed', () => {
  const entries = [
    commit('rewrite the docs [bump:major]', ['README.md', 'AGENTS.md']),
  ];
  assert.equal(deriveFromRange(range(entries)), 'none');
});

test('deriveFromRange: touching the root claude marketplace manifest bumps', () => {
  const entries = [
    commit('rename the marketplace owner', ['.claude-plugin/marketplace.json']),
  ];
  assert.equal(deriveFromRange(range(entries)), 'patch');
});

test('deriveFromRange: touching the codex marketplace manifest bumps', () => {
  const entries = [
    commit('tighten the codex install policy', ['.agents/plugins/marketplace.json']),
  ];
  assert.equal(deriveFromRange(range(entries)), 'patch');
});

test('deriveFromRange: an empty merge diff relies on the merged commits', () => {
  // A merge with an empty diff is irrelevant by itself. Merged commits still count.
  assert.equal(deriveFromRange(range([commit('Merge pull request #7 from foo/bar', [])])), 'none');
  const withMergedCommits = [
    commit('Merge pull request #7 from foo/bar', []),
    commit('add the natural-style skill', ['plugins/harness/skills/natural-style/SKILL.md']),
  ];
  assert.equal(deriveFromRange(range(withMergedCommits)), 'patch');
});

test('isRelevantPath: everything shipped inside the plugin tree counts', () => {
  assert.equal(isRelevantPath('plugins/harness/skills/natural-style/SKILL.md'), true);
  assert.equal(isRelevantPath('plugins/harness/.claude-plugin/plugin.json'), true);
  assert.equal(isRelevantPath('plugins/harness/.codex-plugin/plugin.json'), true);
  assert.equal(isRelevantPath('plugins/harness/output-styles/natural.md'), true);
});

test('isRelevantPath: both marketplace manifests count', () => {
  assert.equal(isRelevantPath('.claude-plugin/marketplace.json'), true);
  assert.equal(isRelevantPath('.agents/plugins/marketplace.json'), true);
});

test('isRelevantPath: development-only trees and root docs do not count', () => {
  for (const path of [
    'tests/bump-version/derive-bump-level.test.js',
    'scripts/bump-version.js',
    '.github/workflows/bump-version.yml',
    '.githooks/post-commit',
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    'LICENSE',
    '.gitignore',
  ]) {
    assert.equal(isRelevantPath(path), false, `${path} should not be relevant`);
  }
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.resolve(__dirname, '../../scripts/derive-bump-level.js');
function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'release-graph-'));
  t.after(() => fs.rmSync(cwd, { recursive:true, force:true }));
  const env = { ...process.env, GIT_AUTHOR_DATE:'1999-12-31T23:59:00-08:00', GIT_COMMITTER_DATE:'1999-12-31T23:59:00-08:00' };
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd, env, encoding:'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const commitFile = (file, text, subject) => {
    fs.mkdirSync(path.dirname(path.join(cwd,file)), { recursive:true });
    fs.writeFileSync(path.join(cwd,file), text);
    git('add','--all'); git('commit','-m',subject);
  };
  const level = () => {
    const r = spawnSync(process.execPath, [cli], { cwd, encoding:'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init','-b','main'); git('config','user.name','Test'); git('config','user.email','test@example.invalid'); git('config','core.hooksPath','/dev/null');
  return { cwd, git, commitFile, level };
}

test('CLI release range includes features created before the release and merged afterward', t => {
  const { git, commitFile, level } = repository(t);
  commitFile('README.md','initial','initial');
  git('checkout','-b','feature');
  commitFile('plugins/new','feature','feature [bump:minor]');
  git('commit','--allow-empty','-m','chore: bump version to 99.0.0');
  git('checkout','main');
  commitFile('README.md','release','chore: bump version to 1.0.1');
  git('merge','--no-ff','feature','-m','merge feature');
  assert.equal(level(),'minor');
});

test('CLI handles no anchor, anchor HEAD, docs, catch-up, and rename out of the plugin', t => {
  const { git, commitFile, level } = repository(t);
  commitFile('plugins/file','initial','initial');
  assert.equal(level(),'patch');
  git('commit','--allow-empty','-m','chore: bump version to 1.0.0');
  assert.equal(level(),'none');
  commitFile('README.md','docs','docs [bump:minor]');
  assert.equal(level(),'none');
  commitFile('plugins/file','changed','change');
  commitFile('README.md','more docs','docs');
  assert.equal(level(),'minor');
  git('commit','--allow-empty','-m','chore: bump version to 1.1.0');
  git('mv','plugins/file','moved'); git('commit','-m','move out');
  assert.equal(level(),'patch');
});

test('CLI includes plugin changes introduced only during merge resolution', t => {
  const { git, commitFile, level } = repository(t);
  commitFile('README.md','initial','initial');
  git('checkout','-b','feature');
  commitFile('feature.md','feature','feature');
  git('checkout','main');
  git('commit','--allow-empty','-m','chore: bump version to 1.0.0');
  git('merge','--no-ff','--no-commit','feature');
  commitFile('plugins/resolution','merge-only','merge resolution');
  assert.equal(level(),'patch');
});

test('CLI Git failures emit diagnostics and never a release level', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(),'not-git-'));
  t.after(() => fs.rmSync(cwd,{ recursive:true,force:true }));
  const result = spawnSync(process.execPath,[cli],{ cwd,encoding:'utf8' });
  assert.equal(result.status,1);
  assert.equal(result.stdout,'');
  assert.match(result.stderr,/not a git repository/);
});

for (const quotePath of ['true', 'false']) {
  for (const name of ['plain.md', 'café.md', 'tab\tname.md', 'line\nname.md', 'quote"name.md']) {
    test(`native paths survive add/delete/rename-out: ${JSON.stringify(name)}, quotePath=${quotePath}`, t => {
      const { cwd, git, commitFile, level } = repository(t);
      git('config', 'core.quotePath', quotePath);
      commitFile('README.md', 'initial', 'initial');
      git('commit', '--allow-empty', '-m', 'chore: bump version to 1.0.0');
      const shipped = `plugins/${name}`;
      commitFile(shipped, 'content', 'add [bump:minor]');
      assert.deepEqual(readReleaseRange(cwd), { subjects: ['add [bump:minor]'], paths: [shipped] });
      assert.equal(level(), 'minor');
      git('commit', '--allow-empty', '-m', 'chore: bump version to 1.1.0');
      git('rm', '--', shipped);
      git('commit', '-m', 'delete [bump:minor]');
      assert.deepEqual(readReleaseRange(cwd).paths, [shipped]);
      assert.equal(level(), 'minor');
      commitFile(shipped, 'content', 'restore');
      git('commit', '--allow-empty', '-m', 'chore: bump version to 1.2.0');
      git('mv', '--', shipped, name);
      git('commit', '-m', 'move out [bump:minor]');
      assert.deepEqual(new Set(readReleaseRange(cwd).paths), new Set([shipped, name]));
      assert.equal(level(), 'minor');
    });
  }
}

test('native paths preserve whitespace and cannot inject subjects or shipped prefixes', t => {
  const { cwd, git, commitFile, level } = repository(t);
  commitFile('README.md', 'initial', 'initial');
  git('commit', '--allow-empty', '-m', 'chore: bump version to 1.0.0');
  const unrelated = 'docs/\nplugins/fake\ncommit\tabc\t[bump:major]\n';
  commitFile(unrelated, 'content', 'docs');
  assert.deepEqual(readReleaseRange(cwd), { subjects: ['docs'], paths: [unrelated] });
  assert.equal(level(), 'none');
  const shipped = 'plugins/ spaced\t\n';
  commitFile(shipped, 'content', 'ship\t[bump:minor]');
  const selected = readReleaseRange(cwd);
  assert.ok(selected.paths.includes(shipped));
  assert.deepEqual(selected.subjects, ['ship\t[bump:minor]', 'docs']);
  assert.equal(level(), 'minor');
});

test('native mixed range derives severity from every subject independently of paths', t => {
  const { cwd, git, commitFile, level } = repository(t);
  commitFile('plugins/file', 'initial', 'initial [bump:major]');
  git('commit', '--allow-empty', '-m', 'chore: bump version to 1.0.0');
  commitFile('README.md', 'major', 'docs [bump:major]');
  commitFile('plugins/file', 'changed', 'shipping [bump:minor]');
  git('commit', '--allow-empty', '-m', 'empty subject commit');
  assert.deepEqual(readReleaseRange(cwd).subjects, ['empty subject commit', 'shipping [bump:minor]', 'docs [bump:major]']);
  assert.equal(level(), 'major');
});
