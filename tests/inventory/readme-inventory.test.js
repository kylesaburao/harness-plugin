'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SKILLS_DIR = path.join(REPO_ROOT, 'plugins/harness/skills');
const STYLES_DIR = path.join(REPO_ROOT, 'plugins/harness/output-styles');
const README_PATH = path.join(REPO_ROOT, 'README.md');

// README.md's "Plugin contents" section is meant to be the discoverable catalog of everything
// the plugin ships - see AGENTS.md. This test fails whenever that catalog and the actual tree
// disagree, so an added/removed/renamed skill or output style can't drift out of the README
// silently. It does not check that a listed entry's one-line description is still accurate.

function parseFrontmatterName(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, `${filePath} has no frontmatter block`);
  const nameLine = match[1].match(/^name:\s*(.+?)\s*$/m);
  assert.ok(nameLine, `${filePath} frontmatter has no "name" field`);
  return nameLine[1].trim();
}

function skillNamesOnDisk() {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(SKILLS_DIR, entry.name, 'SKILL.md'))
    .filter((skillMd) => fs.existsSync(skillMd))
    .map(parseFrontmatterName)
    .sort();
}

function outputStyleNamesOnDisk() {
  return fs
    .readdirSync(STYLES_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(STYLES_DIR, name))
    .map(parseFrontmatterName)
    .sort();
}

// Pulls out the text between a "### <heading>" line and the next heading of the same or
// higher level, so parsing stays scoped to one section instead of scanning the whole README.
function sectionBody(readme, heading) {
  const lines = readme.split('\n');
  const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
  assert.ok(start !== -1, `README.md has no "### ${heading}" section`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,3}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

// Table rows look like "| `name` | purpose | setup |". Taking only the first cell, and only
// keeping it when that cell is exactly one backticked token, skips the header/separator rows
// and never picks up a backticked command or path from the Setup column.
function skillNamesInReadme(readme) {
  const body = sectionBody(readme, 'Skills');
  const names = [];
  for (const line of body.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const firstCell = line.split('|')[1].trim();
    const match = firstCell.match(/^`([^`]+)`$/);
    if (match) names.push(match[1]);
  }
  return names.sort();
}

// List items look like "- `Name` (`path`) - description". Only the first backticked token is
// taken, so the backticked path that follows is never collected as a second entry.
function outputStyleNamesInReadme(readme) {
  const body = sectionBody(readme, 'Output styles');
  const names = [];
  for (const line of body.split('\n')) {
    const match = line.match(/^-\s+`([^`]+)`/);
    if (match) names.push(match[1]);
  }
  return names.sort();
}

test('README lists exactly the skills present under plugins/harness/skills/', () => {
  const onDisk = skillNamesOnDisk();
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const inReadme = skillNamesInReadme(readme);

  const missingFromReadme = onDisk.filter((name) => !inReadme.includes(name));
  const extraInReadme = inReadme.filter((name) => !onDisk.includes(name));

  assert.deepEqual(
    { missingFromReadme, extraInReadme },
    { missingFromReadme: [], extraInReadme: [] },
  );
});

test('README lists exactly the output styles present under plugins/harness/output-styles/', () => {
  const onDisk = outputStyleNamesOnDisk();
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const inReadme = outputStyleNamesInReadme(readme);

  const missingFromReadme = onDisk.filter((name) => !inReadme.includes(name));
  const extraInReadme = inReadme.filter((name) => !onDisk.includes(name));

  assert.deepEqual(
    { missingFromReadme, extraInReadme },
    { missingFromReadme: [], extraInReadme: [] },
  );
});
