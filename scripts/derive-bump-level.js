#!/usr/bin/env node
'use strict';

// Select the release range by first-parent ancestry, then derive the level from
// all subjects and changed paths in that range, including merged branches.
// Minimum Node: 18. Uses only the standard library.
const { execFileSync } = require('node:child_process');

const MAJOR_TAG = '[bump:major]';
const MINOR_TAG = '[bump:minor]';
const BUMP_COMMIT_PATTERN = /^chore: bump version to \d+\.\d+\.\d+$/;

// Repo-relative path prefixes whose contents a plugin user can observe, and so the only changes
// worth a version bump. Prefixes rather than exact filenames, so a file added to one of these
// directories later is covered without editing this list.
//
//   plugins/          installing a plugin copies the whole directory into the harness's plugin
//                     cache, so everything under here ships to every install (see AGENTS.md).
//   .claude-plugin/   root marketplace manifest, read when someone adds the marketplace.
//   .agents/plugins/  the Codex-side equivalent of the same.
//
// Everything else - tests/, scripts/, .github/, .githooks/, AGENTS.md, README.md, LICENSE - only
// exists to develop this repository and never reaches an install.
const RELEVANT_PATH_PREFIXES = Object.freeze([
  'plugins/',
  '.claude-plugin/',
  '.agents/plugins/',
]);

function isRelevantPath(path) {
  return RELEVANT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function deriveBumpLevel(subjects) {
  let sawMinor = false;
  for (const subject of subjects) {
    if (subject.includes(MAJOR_TAG)) {
      return 'major';
    }
    if (subject.includes(MINOR_TAG)) {
      sawMinor = true;
    }
  }
  return sawMinor ? 'minor' : 'patch';
}

const COMMIT_SENTINEL = 'commit\t';

// Parses `git log --format='commit%x09%H%x09%s' --name-only` into
// [{ hash, subject, paths }], newest commit first (i.e. `git log` order).
//
// The sentinel is what makes this unambiguous: --name-only prints a commit's files as bare lines
// after a blank line, with nothing marking the header line apart from them, so the format string
// prefixes every header with a literal "commit<TAB>". Path lines cannot collide with that - git
// quotes a path containing a tab (core.quotePath) rather than emitting it raw.
function parseLog(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith(COMMIT_SENTINEL)) {
      const rest = line.slice(COMMIT_SENTINEL.length);
      const tabIndex = rest.indexOf('\t');
      // Split on the *first* tab only: a commit subject may itself contain one.
      const hash = tabIndex === -1 ? rest : rest.slice(0, tabIndex);
      const subject = tabIndex === -1 ? '' : rest.slice(tabIndex + 1);
      entries.push({ hash, subject, paths: [] });
      continue;
    }
    if (entries.length > 0) {
      entries[entries.length - 1].paths.push(line);
    }
  }
  return entries;
}

// Entries are an already selected release range, including merge diffs.
function deriveFromLog(entries) {
  if (!entries.some(entry => entry.paths.some(isRelevantPath))) return 'none';
  return deriveBumpLevel(entries.map(entry => entry.subject));
}

function readReleaseLog(cwd) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const firstParent = parseLog(git(['log', '--first-parent', '--format=commit%x09%H%x09%s', 'HEAD']));
  const anchor = firstParent.find(entry => BUMP_COMMIT_PATTERN.test(entry.subject));
  return parseLog(git(['log', '--format=commit%x09%H%x09%s', '--name-only', '--no-renames', '--diff-merges=first-parent', anchor ? `${anchor.hash}..HEAD` : 'HEAD']));
}

function main() {
  if (process.argv.length !== 2) {
    process.stderr.write('Usage: node scripts/derive-bump-level.js\n');
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${deriveFromLog(readReleaseLog(process.cwd()))}\n`);
  } catch (error) {
    process.stderr.write(error.stderr || `${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { deriveBumpLevel, deriveFromLog, isRelevantPath, parseLog, readReleaseLog };
