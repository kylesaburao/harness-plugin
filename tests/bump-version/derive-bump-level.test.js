'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveBumpLevel,
  deriveFromLog,
  isRelevantPath,
  parseLog,
} = require('../../scripts/derive-bump-level.js');

// Most cases here are about subjects, not paths, so give them a relevant path by default and let
// the path-gate cases pass one explicitly.
function commit(subject, paths = ['plugins/harness/skills/foo/SKILL.md']) {
  return { hash: subject.slice(0, 7), subject, paths };
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

test('deriveFromLog: stops at the last bump commit, ignoring everything at or before it', () => {
  const entries = [
    commit('add foo skill'),
    commit('add bar skill [bump:minor]'),
    commit('chore: bump version to 0.1.1'),
    commit('add baz skill [bump:major]'),
  ];
  assert.equal(deriveFromLog(entries), 'minor');
});

test('deriveFromLog: a batched push spanning several commits still finds the deepest tag', () => {
  // Simulates one `git push` landing three commits at once, oldest tag buried under two others.
  const entries = [
    commit('fix typo'),
    commit('add foo [bump:major]'),
    commit('add bar skill'),
    commit('chore: bump version to 0.1.0'),
  ];
  assert.equal(deriveFromLog(entries), 'major');
});

test('deriveFromLog: nothing since the last bump is "none"', () => {
  const entries = [commit('chore: bump version to 0.1.1'), commit('add foo skill')];
  assert.equal(deriveFromLog(entries), 'none');
});

test('deriveFromLog: an empty log is "none"', () => {
  assert.equal(deriveFromLog([]), 'none');
});

test('deriveFromLog: no prior bump commit at all scans the whole history', () => {
  const entries = [
    commit('add foo skill'),
    commit('add bar skill [bump:minor]'),
    commit('initial commit'),
  ];
  assert.equal(deriveFromLog(entries), 'minor');
});

test('deriveFromLog: a human commit body containing bump-looking text is not mistaken for the anchor', () => {
  // Only the exact subject "chore: bump version to X.Y.Z" is the anchor - grep-style substring
  // matching against a full commit message would false-positive here.
  const entries = [
    commit('document the chore: bump version to X.Y.Z convention'),
    commit('chore: bump version to 0.1.0'),
  ];
  assert.equal(deriveFromLog(entries), 'patch');
});

test('deriveFromLog: a docs-only range is "none"', () => {
  const entries = [
    commit('clarify the install steps', ['README.md']),
    commit('document the preflight contract', ['AGENTS.md', 'CLAUDE.md']),
    commit('chore: bump version to 1.0.2'),
  ];
  assert.equal(deriveFromLog(entries), 'none');
});

test('deriveFromLog: a tests-only range is "none"', () => {
  const entries = [
    commit('cover the wake-desktop retry path', ['tests/wake-desktop/wake-desktop.test.js']),
    commit('chore: bump version to 1.0.2'),
  ];
  assert.equal(deriveFromLog(entries), 'none');
});

test('deriveFromLog: changes to this repo\'s own tooling are "none"', () => {
  // scripts/ and .github/ never reach an install, so touching the bump machinery itself must not
  // mint a version - the case most likely to surprise, since it self-triggers.
  const entries = [
    commit('gate bumps on plugin-relevant paths', [
      'scripts/derive-bump-level.js',
      '.github/workflows/bump-version.yml',
      '.githooks/post-commit',
    ]),
    commit('chore: bump version to 1.0.2'),
  ];
  assert.equal(deriveFromLog(entries), 'none');
});

test('deriveFromLog: one relevant commit among docs commits still bumps', () => {
  const entries = [
    commit('fix a README typo', ['README.md']),
    commit('add the agentic-loop skill', ['plugins/harness/skills/agentic-loop/SKILL.md']),
    commit('rework the test layout', ['tests/bump-version/derive-bump-level.test.js']),
    commit('chore: bump version to 1.0.2'),
  ];
  assert.equal(deriveFromLog(entries), 'patch');
});

test('deriveFromLog: a tag on an irrelevant commit is honored when the range is relevant', () => {
  // Paths decide whether to bump, subjects decide how much. The [bump:minor] here sits on a docs
  // commit, but the range contains a real plugin change, so the human signal stands.
  const entries = [
    commit('note the new skill in the readme [bump:minor]', ['README.md']),
    commit('add the agentic-loop skill', ['plugins/harness/skills/agentic-loop/SKILL.md']),
    commit('chore: bump version to 1.0.2'),
  ];
  assert.equal(deriveFromLog(entries), 'minor');
});

test('deriveFromLog: a tag cannot force a bump when nothing relevant changed', () => {
  const entries = [
    commit('rewrite the docs [bump:major]', ['README.md', 'AGENTS.md']),
    commit('chore: bump version to 1.0.2'),
  ];
  assert.equal(deriveFromLog(entries), 'none');
});

test('deriveFromLog: touching the root claude marketplace manifest bumps', () => {
  const entries = [
    commit('rename the marketplace owner', ['.claude-plugin/marketplace.json']),
    commit('chore: bump version to 1.0.2'),
  ];
  assert.equal(deriveFromLog(entries), 'patch');
});

test('deriveFromLog: touching the codex marketplace manifest bumps', () => {
  const entries = [
    commit('tighten the codex install policy', ['.agents/plugins/marketplace.json']),
    commit('chore: bump version to 1.0.2'),
  ];
  assert.equal(deriveFromLog(entries), 'patch');
});

test('deriveFromLog: a merge commit contributes no paths of its own', () => {
  // `git log --name-only` prints no file list for a merge. Alone that is "none"; the commits it
  // merges appear in the same log and carry the real paths.
  assert.equal(deriveFromLog([commit('Merge pull request #7 from foo/bar', [])]), 'none');
  const withMergedCommits = [
    commit('Merge pull request #7 from foo/bar', []),
    commit('add the agentic-loop skill', ['plugins/harness/skills/agentic-loop/SKILL.md']),
  ];
  assert.equal(deriveFromLog(withMergedCommits), 'patch');
});

test('isRelevantPath: everything shipped inside the plugin tree counts', () => {
  assert.equal(isRelevantPath('plugins/harness/skills/hello-world/SKILL.md'), true);
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

test('parseLog: reads the sentinel format git is asked to produce', () => {
  const text = [
    'commit\tabc123\tadd the agentic-loop skill',
    '',
    'plugins/harness/skills/agentic-loop/SKILL.md',
    'README.md',
    'commit\tdef456\tchore: bump version to 1.0.1',
    '',
    'plugins/harness/.claude-plugin/plugin.json',
    '',
  ].join('\n');
  assert.deepEqual(parseLog(text), [
    {
      hash: 'abc123',
      subject: 'add the agentic-loop skill',
      paths: ['plugins/harness/skills/agentic-loop/SKILL.md', 'README.md'],
    },
    {
      hash: 'def456',
      subject: 'chore: bump version to 1.0.1',
      paths: ['plugins/harness/.claude-plugin/plugin.json'],
    },
  ]);
});

test('parseLog: a commit with no files parses with an empty path list', () => {
  const text = [
    'commit\tabc123\tMerge pull request #7 from foo/bar',
    '',
    'commit\tdef456\tadd foo skill',
    '',
    'plugins/harness/skills/foo/SKILL.md',
  ].join('\n');
  const entries = parseLog(text);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].paths, []);
  assert.deepEqual(entries[1].paths, ['plugins/harness/skills/foo/SKILL.md']);
});

test('parseLog: a subject containing a tab is not truncated', () => {
  // Only the first tab after the sentinel separates hash from subject; the rest is subject.
  const entries = parseLog('commit\tabc123\tadd foo\tand bar\nplugins/harness/skills/foo/SKILL.md');
  assert.deepEqual(entries, [
    { hash: 'abc123', subject: 'add foo\tand bar', paths: ['plugins/harness/skills/foo/SKILL.md'] },
  ]);
});

test('parseLog: empty input yields no entries, which derives as "none"', () => {
  assert.deepEqual(parseLog(''), []);
  assert.equal(deriveFromLog(parseLog('')), 'none');
});
