'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { backupFilenamePattern, measureDirectoryStorage } = require('../../src/backup/backup');

test('storage measurement overlaps metadata operations at its internal cap', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'backup-measure-concurrency-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 12 }, (_, index) =>
    fsp.writeFile(path.join(root, `file-${index}.txt`), '12345')));
  const details = await fsp.stat(root, { bigint: true });
  const directory = {
    label: 'targetDirectories[0]',
    configuredPath: root,
    canonicalPath: await fsp.realpath(root),
    identity: `${details.dev}:${details.ino}`,
  };
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const originalStat = fsp.stat;
  t.mock.method(fsp, 'stat', async (...args) => {
    active += 1;
    peak = Math.max(peak, active);
    if (peak === 8) release();
    await gate;
    try {
      return await originalStat(...args);
    } finally {
      active -= 1;
    }
  });

  const storage = await measureDirectoryStorage(directory, backupFilenamePattern());

  assert.deepEqual(storage, { totalBytes: 60n, backupBytes: 0n, backupCount: 0 });
  assert.equal(peak, 8);
});
