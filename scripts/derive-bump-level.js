#!/usr/bin/env node
'use strict';

// Derives which bump level scripts/bump-version.js should use, from a `git log` of the commits
// since the last version bump - their subjects and the files each one touched.
//
// This exists so the level survives a batched push (several commits landing in one `git push`)
// and a re-run after a concurrency eviction or a lost push race: the caller always supplies every
// commit since the last bump, not just the newest one, so nothing gets silently dropped.
// See .github/workflows/bump-version.yml, which is the only caller and the only place git runs.
//
// Two independent questions get answered here, and keeping them separate is the whole design:
//
//   whether to bump - decided by paths. A commit only counts if it touched something a user of
//     the plugin can observe (see RELEVANT_PATH_PREFIXES). A push that only edits docs, tests, or
//     this repo's own tooling changes nothing that ships, so it must not mint a new version.
//   how much to bump - decided by subjects, via deriveBumpLevel below, unchanged and still the
//     pure part of this module.
//
// Because those are separate, a `[bump:minor]` tag is honored wherever it sits in the range, even
// on a docs commit, as long as *some* commit in the range was relevant. The tag is a deliberate
// human signal about the size of a release; the path check decides only whether there is a
// release at all, and should never silently downgrade an explicit tag on a technicality.
//
// The CLI wrapper below (`--from-stdin`) additionally finds where to stop scanning: it parses
// `git log --format='commit%x09%H%x09%s' --name-only` output from stdin, stops at the first
// commit whose subject is exactly a bump commit's own message, and prints the derived level for
// everything newer than that - or "none" if there is nothing newer than the last bump or nothing
// relevant in it, which the caller treats as a no-op.
//
// Minimum Node: 18 (no dependencies, standard library or otherwise).

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

// entries: [{ subject, paths }], newest commit first, as returned by parseLog.
// Returns the derived level, or 'none' when there is nothing to bump: an empty log, a newest
// commit that is itself the last bump commit, or a range in which no commit touched a path a
// plugin user can observe.
function deriveFromLog(entries) {
  const sinceLastBump = [];
  for (const entry of entries) {
    if (BUMP_COMMIT_PATTERN.test(entry.subject)) {
      break;
    }
    sinceLastBump.push(entry);
  }
  if (sinceLastBump.length === 0) {
    return 'none';
  }
  // A merge commit arrives with no paths at all, since `git log --name-only` shows no diff for
  // one by default. That reads as irrelevant here, which is correct rather than a gap: the
  // commits being merged are in this same log and carry the real paths.
  if (!sinceLastBump.some((entry) => entry.paths.some(isRelevantPath))) {
    return 'none';
  }
  return deriveBumpLevel(sinceLastBump.map((entry) => entry.subject));
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
    process.stderr.write(
      'Usage: git log --format=\'commit%x09%H%x09%s\' --name-only --no-renames HEAD'
        + ' | derive-bump-level.js --from-stdin\n',
    );
    process.exit(2);
  }
  const raw = await readStdin();
  process.stdout.write(`${deriveFromLog(parseLog(raw))}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  deriveBumpLevel,
  deriveFromLog,
  isRelevantPath,
  parseLog,
  BUMP_COMMIT_PATTERN,
  RELEVANT_PATH_PREFIXES,
};
