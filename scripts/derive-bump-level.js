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

// Subjects and paths are separate streams so filenames cannot impersonate headers.
function deriveFromRange({ subjects, paths }) {
  if (!paths.some(isRelevantPath)) return 'none';
  return deriveBumpLevel(subjects);
}

function readReleaseRange(cwd) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const firstParent = git(['log', '--first-parent', '--format=%H%x09%s', 'HEAD']);
  const anchor = firstParent.split('\n').find(line => BUMP_COMMIT_PATTERN.test(line.slice(line.indexOf('\t') + 1)));
  const revision = anchor ? `${anchor.slice(0, anchor.indexOf('\t'))}..HEAD` : 'HEAD';
  const subjects = git(['log', '--format=%s', '-z', revision]).split('\0').filter(Boolean);
  const paths = git(['log', '--format=', '--name-only', '-z', '--no-renames', '--diff-merges=first-parent', revision]).split('\0').filter(Boolean);
  return { subjects, paths };
}

function main() {
  if (process.argv.length !== 2) {
    process.stderr.write('Usage: node scripts/derive-bump-level.js\n');
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${deriveFromRange(readReleaseRange(process.cwd()))}\n`);
  } catch (error) {
    process.stderr.write(error.stderr || `${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { deriveBumpLevel, deriveFromRange, isRelevantPath, readReleaseRange };
