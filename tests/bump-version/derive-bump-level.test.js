'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveBumpLevel, deriveFromLog } = require('../../scripts/derive-bump-level.js');

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
  const lines = [
    'h4\tadd foo skill',
    'h3\tadd bar skill [bump:minor]',
    'h2\tchore: bump version to 0.1.1',
    'h1\tadd baz skill [bump:major]',
  ];
  assert.equal(deriveFromLog(lines), 'minor');
});

test('deriveFromLog: a batched push spanning several commits still finds the deepest tag', () => {
  // Simulates one `git push` landing three commits at once, oldest tag buried under two others.
  const lines = [
    'h3\tfix typo',
    'h2\tadd foo [bump:major]',
    'h1\tadd bar skill',
    'h0\tchore: bump version to 0.1.0',
  ];
  assert.equal(deriveFromLog(lines), 'major');
});

test('deriveFromLog: nothing since the last bump is "none"', () => {
  const lines = ['h1\tchore: bump version to 0.1.1', 'h0\tadd foo skill'];
  assert.equal(deriveFromLog(lines), 'none');
});

test('deriveFromLog: an empty log is "none"', () => {
  assert.equal(deriveFromLog([]), 'none');
});

test('deriveFromLog: no prior bump commit at all scans the whole history', () => {
  const lines = ['h2\tadd foo skill', 'h1\tadd bar skill [bump:minor]', 'h0\tinitial commit'];
  assert.equal(deriveFromLog(lines), 'minor');
});

test('deriveFromLog: a human commit body containing bump-looking text is not mistaken for the anchor', () => {
  // Only the exact subject "chore: bump version to X.Y.Z" is the anchor - grep-style substring
  // matching against a full commit message would false-positive here.
  const lines = [
    'h1\tdocument the chore: bump version to X.Y.Z convention',
    'h0\tchore: bump version to 0.1.0',
  ];
  assert.equal(deriveFromLog(lines), 'patch');
});
