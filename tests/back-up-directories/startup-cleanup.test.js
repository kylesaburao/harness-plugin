'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { cleanupStartupArtifacts, cleanupLegacyStaging } = require(require('../helpers/plugin-paths').artifactPath('skills/back-up-directories/scripts/backup.js'));

function unknownDirent(name) {
  return {
    name,
    isFile: () => false,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

test('startup cleanup classifies unknown Dirents and removes only owned regular files', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'backup-cleanup-unknown-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const details = await fsp.stat(root, { bigint: true });
  const directory = {
    label: 'outputDirectory',
    configuredPath: root,
    canonicalPath: await fsp.realpath(root),
    identity: `${details.dev}:${details.ino}`,
  };
  const regularName = '.backup-copy-12345678-1234-4abc-8def-123456789abc.tmp';
  const symlinkName = '.backup-copy-abcdefab-cdef-4abc-9def-abcdefabcdef.tmp';
  const directoryName = '.backup-archive-fedcbafe-dcba-4321-abcd-fedcbafedcba.tmp';
  const outside = path.join(root, 'outside');
  await Promise.all([
    fsp.writeFile(path.join(root, regularName), 'remove'),
    fsp.writeFile(outside, 'keep'),
    fsp.mkdir(path.join(root, directoryName)),
  ]);
  await fsp.symlink(outside, path.join(root, symlinkName));

  const originalReaddir = fsp.readdir;
  t.mock.method(fsp, 'readdir', async (...args) => {
    const entries = await originalReaddir(...args);
    return args[1]?.withFileTypes ? entries.map((entry) => unknownDirent(entry.name)) : entries;
  });

  await cleanupStartupArtifacts({ output: directory, targets: [] });

  await assert.rejects(fsp.access(path.join(root, regularName)), { code: 'ENOENT' });
  assert.equal(await fsp.readFile(path.join(root, symlinkName), 'utf8'), 'keep');
  assert((await fsp.stat(path.join(root, directoryName))).isDirectory());
});

async function cleanupFixture(t, names) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'backup-cleanup-retain-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const details = await fsp.stat(root, { bigint: true });
  const canonicalPath = await fsp.realpath(root);
  await Promise.all(names.map((name) => fsp.writeFile(path.join(root, name), 'stale')));
  return {
    canonicalPath,
    directory: { label: 'outputDirectory', configuredPath: root, canonicalPath, identity: `${details.dev}:${details.ino}` },
  };
}

const deniedName = '.backup-archive-11111111-1111-4111-8111-111111111111.tmp';
const ownedName = '.backup-copy-22222222-2222-4222-9222-222222222222.tmp';

test('startup cleanup retains a file whose removal is denied and continues', async (t) => {
  const { canonicalPath, directory } = await cleanupFixture(t, [deniedName, ownedName]);
  const deniedPath = path.join(canonicalPath, deniedName);
  const removeFile = async (file, options) => {
    if (file === deniedPath) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    return fsp.rm(file, options);
  };

  const retained = await cleanupStartupArtifacts({ output: directory, targets: [] }, { removeFile });

  assert.deepEqual(retained.map((item) => [item.path, item.error.code]), [[deniedPath, 'EPERM']]);
  assert.equal(await fsp.readFile(deniedPath, 'utf8'), 'stale');
  await assert.rejects(fsp.access(path.join(canonicalPath, ownedName)), { code: 'ENOENT' });
});

test('startup cleanup skips files owned by another user without reporting them', async (t) => {
  const { canonicalPath, directory } = await cleanupFixture(t, [deniedName, ownedName]);
  const foreignPath = path.join(canonicalPath, deniedName);
  const removed = [];
  const lstat = async (file) => ({ isFile: () => true, uid: file === foreignPath ? 4242 : 1000 });
  const removeFile = async (file, options) => { removed.push(file); return fsp.rm(file, options); };

  const retained = await cleanupStartupArtifacts({ output: directory, targets: [] }, { lstat, removeFile, uid: 1000 });

  assert.deepEqual(retained, []);
  assert.deepEqual(removed, [path.join(canonicalPath, ownedName)]);
  assert.equal(await fsp.readFile(foreignPath, 'utf8'), 'stale');
});

test('startup cleanup raises unexpected removal failures', async (t) => {
  const { directory } = await cleanupFixture(t, [ownedName]);
  const removeFile = async () => { throw Object.assign(new Error('i/o error'), { code: 'EIO' }); };

  await assert.rejects(
    cleanupStartupArtifacts({ output: directory, targets: [] }, { removeFile }),
    { code: 'EIO' },
  );
});

const DAY_MS = 24 * 60 * 60 * 1000;
const oldArchive = '.backup-archive-33333333-3333-4333-8333-333333333333.tmp';
const freshArchive = '.backup-archive-44444444-4444-4444-9444-444444444444.tmp';
const foreignArchive = '.backup-archive-55555555-5555-4555-a555-555555555555.tmp';
const legacyCopy = '.backup-copy-66666666-6666-4666-b666-666666666666.tmp';

async function legacyFixture(t) {
  const { canonicalPath, directory } = await cleanupFixture(t, [oldArchive, freshArchive, foreignArchive, legacyCopy, 'unrelated.tmp']);
  const plan = { output: { ...directory, canonicalPath: `${canonicalPath}-elsewhere` }, targets: [] };
  const now = Date.now();
  const lstat = async (file) => ({
    isFile: () => true,
    uid: path.basename(file) === foreignArchive ? 4242 : 1000,
    mtimeMs: path.basename(file) === freshArchive ? now - 60 * 1000 : now - 2 * DAY_MS,
  });
  return { tmpdir: canonicalPath, plan, now, lstat };
}

test('legacy staging cleanup removes only owned archive staging files untouched for a day', async (t) => {
  const { tmpdir, plan, now, lstat } = await legacyFixture(t);

  const retained = await cleanupLegacyStaging(plan, { tmpdir, now, lstat, uid: 1000 });

  assert.deepEqual(retained, []);
  assert.deepEqual((await fsp.readdir(tmpdir)).sort(), [foreignArchive, freshArchive, legacyCopy, 'unrelated.tmp'].sort());
});

test('legacy staging cleanup skips a temporary directory the plan already scans', async (t) => {
  const { tmpdir, plan, now, lstat } = await legacyFixture(t);
  plan.targets.push({ canonicalPath: tmpdir });

  assert.deepEqual(await cleanupLegacyStaging(plan, { tmpdir, now, lstat, uid: 1000 }), []);
  assert.ok((await fsp.readdir(tmpdir)).includes(oldArchive));
});

test('legacy staging cleanup ignores an unreadable temporary directory', async () => {
  const plan = { output: { canonicalPath: '/nonexistent-output' }, targets: [] };
  assert.deepEqual(await cleanupLegacyStaging(plan, { tmpdir: path.join(os.tmpdir(), 'backup-legacy-missing-directory') }), []);
});

test('legacy staging cleanup retains files it cannot remove instead of failing', async (t) => {
  const { tmpdir, plan, now, lstat } = await legacyFixture(t);
  const removeFile = async () => { throw Object.assign(new Error('i/o error'), { code: 'EIO' }); };

  const retained = await cleanupLegacyStaging(plan, { tmpdir, now, lstat, uid: 1000, removeFile });

  assert.deepEqual(retained.map((item) => [path.basename(item.path), item.error.code]), [[oldArchive, 'EIO']]);
});
