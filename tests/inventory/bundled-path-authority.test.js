'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inventory } = require('../../scripts/build');
const { artifactRoot, artifactPath } = require('../helpers/plugin-paths');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SKILLS_PREFIX = 'src/harness/skills/';
const HEADING = '## Bundled path authority';
const AUTHORITY_TEXT = `Use the current host’s path for this loaded \`SKILL.md\`. Claude Code supplies this path through \`\${CLAUDE_SKILL_DIR}\`. Expand any catalog root alias using its supplied mapping. Set \`<SKILL_DIR>\` to the absolute directory containing that exact file and retain it for this invocation. Replace \`<SKILL_DIR>\` in commands with that directory, keeping paths quoted. Resolve bundled scripts and skill-root resource paths from this directory. Resolve Markdown-relative links from the file containing the link, within the same installed skill instance. Preserve the caller’s working directory and existing input/output path semantics.

If the host-provided path is unavailable or a bundled file is missing, report the supplied skill path, attempted resource path, and actual failure. Other installations may be inspected for diagnosis, but use a replacement only when the host or user explicitly selects it. Do not infer the skill directory from conventional locations or select another copy by version, timestamp, or search order.`;

function normalizeWhitespace(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function trackedResourceBearingSkills()
{
  const tracked = [...inventory(artifactRoot, { overlays: true }).keys()].filter(file => file.startsWith('skills/'));
  const skills = new Set();

  for (const file of tracked) {
    const relative = file.slice('skills/'.length);
    const [skillName, firstComponent, ...rest] = relative.split('/');
    const bundledDirectory = ['scripts', 'references', 'assets'].includes(firstComponent);
    const siblingMarkdown = rest.length === 0
      && firstComponent.endsWith('.md')
      && firstComponent !== 'SKILL.md';
    if (bundledDirectory || siblingMarkdown) skills.add(skillName);
  }

  return [...skills].sort();
}

function authorityBody(text, label) {
  const lines = text.split(/\r?\n/);
  const starts = lines.flatMap((line, index) => line === HEADING ? [index] : []);
  assert.equal(starts.length, 1, `${label} must contain exactly one ${HEADING} section`);
  let end = lines.length;
  for (let index = starts[0] + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(starts[0] + 1, end).join('\n');
}

function assertAuthority(text, label) {
  assert.equal(
    normalizeWhitespace(authorityBody(text, label)),
    normalizeWhitespace(AUTHORITY_TEXT),
    `${label} must use the shared bundled-path authority text`,
  );
}

function withoutAuthoritySection(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(HEADING);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index])) {
      end = index;
      break;
    }
  }
  lines.splice(start, end - start);
  return lines.join('\n');
}

function appendToAuthoritySection(text, addition) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(HEADING);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index])) {
      end = index;
      break;
    }
  }
  lines.splice(end, 0, '', addition);
  return lines.join('\n');
}

test('every tracked resource-bearing skill has the shared bundled-path authority', () => {
  const skills = trackedResourceBearingSkills();
  assert.ok(skills.length > 0, 'resource-bearing skill discovery returned no skills');
  for (const skill of skills) {
    const skillPath = path.join(REPO_ROOT, SKILLS_PREFIX, skill, 'SKILL.md');
    const source = fs.readFileSync(skillPath, 'utf8');
    assertAuthority(source, skillPath);
    const installedPath = artifactPath('skills', skill, 'SKILL.md');
    const installed = fs.readFileSync(installedPath, 'utf8');
    assert.equal(installed, source, installedPath);
    assertAuthority(installed, installedPath);
  }
});

test('the authority check rejects an in-memory skill copy with its section removed', () => {
  const skill = trackedResourceBearingSkills()[0];
  const skillPath = path.join(REPO_ROOT, SKILLS_PREFIX, skill, 'SKILL.md');
  const altered = withoutAuthoritySection(fs.readFileSync(skillPath, 'utf8'));
  assert.throws(() => assertAuthority(altered, `${skillPath} in-memory copy`), /must contain exactly one/);
});

test('the authority check rejects appended text in the shared section', () => {
  const skill = trackedResourceBearingSkills()[0];
  const skillPath = path.join(REPO_ROOT, SKILLS_PREFIX, skill, 'SKILL.md');
  const altered = appendToAuthoritySection(
    fs.readFileSync(skillPath, 'utf8'),
    'Infer another installation when convenient.',
  );
  assert.throws(
    () => assertAuthority(altered, `${skillPath} in-memory copy`),
    /must use the shared bundled-path authority text/,
  );
});
