#!/usr/bin/env node
'use strict';

// Derives which bump level scripts/bump-version.js should use, from a list of commit subjects.
//
// This exists so the level survives a batched push (several commits landing in one `git push`)
// and a re-run after a concurrency eviction or a lost push race: the caller always supplies every
// commit subject since the last bump, not just the newest one, so nothing gets silently dropped.
// See .github/workflows/bump-version.yml, which is the only caller and the only place git runs.
//
// deriveBumpLevel(subjects) is the pure part: given commit subjects, which of major/minor/patch.
// The CLI wrapper below (`--from-stdin`) additionally finds where to stop scanning: it reads
// "hash<TAB>subject" lines from stdin (oldest-history-first is fine, order doesn't matter for
// this), stops at the first commit whose subject is exactly a bump commit's own message, and
// prints the derived level for everything newer than that - or "none" if there is nothing newer
// than the last bump, which the caller treats as a no-op.
//
// Minimum Node: 18 (node:readline only for the CLI wrapper; deriveBumpLevel itself has no deps).

const MAJOR_TAG = '[bump:major]';
const MINOR_TAG = '[bump:minor]';
const BUMP_COMMIT_PATTERN = /^chore: bump version to \d+\.\d+\.\d+$/;

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

// subjectLines: array of "hash\tsubject" strings, newest commit first (i.e. `git log` order).
// Returns the derived level, or 'none' if the newest commit is itself the last bump commit
// (nothing to do), or if the array is empty.
function deriveFromLog(subjectLines) {
  const subjectsSinceLastBump = [];
  for (const line of subjectLines) {
    const tabIndex = line.indexOf('\t');
    const subject = tabIndex === -1 ? line : line.slice(tabIndex + 1);
    if (BUMP_COMMIT_PATTERN.test(subject)) {
      break;
    }
    subjectsSinceLastBump.push(subject);
  }
  if (subjectsSinceLastBump.length === 0) {
    return 'none';
  }
  return deriveBumpLevel(subjectsSinceLastBump);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  if (!process.argv.includes('--from-stdin')) {
    process.stderr.write('Usage: git log --format=\'%H%x09%s\' HEAD | derive-bump-level.js --from-stdin\n');
    process.exit(2);
  }
  const raw = await readStdin();
  const lines = raw.split('\n').filter((line) => line.length > 0);
  process.stdout.write(`${deriveFromLog(lines)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = { deriveBumpLevel, deriveFromLog, BUMP_COMMIT_PATTERN };
