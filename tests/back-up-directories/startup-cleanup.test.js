'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { cleanupStartupArtifacts } = require('../../plugins/harness/skills/back-up-directories/scripts/backup.js');

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
