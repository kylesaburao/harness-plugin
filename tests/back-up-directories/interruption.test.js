'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { OperationContext, copyAtomically, execute } = require('../../plugins/harness/skills/back-up-directories/scripts/backup.js');
const SCRIPT = path.resolve(__dirname, '../../plugins/harness/skills/back-up-directories/scripts/backup.js');
const { directoryDetails, successfulArchiveFactory, temporaryRoot } = require('./test-helpers.js');

function delayedValidation(t, canonicalPath, occurrence) {
  const originalStat = fsp.stat;
  let matchingCalls = 0;
  let release;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  t.mock.method(fsp, 'stat', async (...args) => {
    if (args[0] === canonicalPath && args[1]?.bigint) {
      matchingCalls += 1;
      if (matchingCalls === occurrence) {
        enteredResolve();
        await gate;
      }
    }
    return originalStat(...args);
  });
  return { entered, release };
}

test('interruption during final copy validation prevents destination replacement', async (t) => {
  const root = await temporaryRoot(t);
  const targetPath = path.join(root, 'target');
  await fsp.mkdir(targetPath);
  const source = path.join(root, 'source.zip');
  const destination = path.join(targetPath, 'backup.zip');
  await Promise.all([fsp.writeFile(source, 'new'), fsp.writeFile(destination, 'old')]);
  const directory = await directoryDetails(targetPath, 'targetDirectories[0]');
  const context = new OperationContext();
  const delay = delayedValidation(t, directory.canonicalPath, 2);

  const copying = copyAtomically(source, { directory, destination }, context);
  await delay.entered;
  await context.interrupt('SIGINT');
  delay.release();

  await assert.rejects(copying, (error) => error.exitCode === 130);
  assert.equal(await fsp.readFile(destination, 'utf8'), 'old');
  assert.equal(context.temporaryPaths.size, 1);
  assert.deepEqual(await context.cleanup(), []);
});

test('interruption during retained archive validation prevents archive replacement', async (t) => {
  const root = await temporaryRoot(t);
  const sourcePath = path.join(root, 'source');
  const outputPath = path.join(root, 'output');
  await Promise.all([fsp.mkdir(sourcePath), fsp.mkdir(outputPath)]);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const archivePath = path.join(outputPath, 'backup.zip');
  await fsp.writeFile(archivePath, 'old archive');
  const plan = { source, output, targets: [output], archivePath, retainArchive: true, copyTargets: [] };
  const context = new OperationContext();
  const delay = delayedValidation(t, output.canonicalPath, 2);

  const execution = execute(plan, context, { archive: { archiveFactory: successfulArchiveFactory('new archive') } });
  await delay.entered;
  await context.interrupt('SIGTERM');
  delay.release();

  await assert.rejects(execution, (error) => error.exitCode === 143);
  assert.equal(await fsp.readFile(archivePath, 'utf8'), 'old archive');
  assert.equal(context.temporaryPaths.size, 1);
  assert.deepEqual(await context.cleanup(), []);
});

test('interruption during final staging cleanup remains authoritative', async (t) => {
  const root = await temporaryRoot(t);
  const sourcePath = path.join(root, 'source');
  const outputPath = path.join(root, 'output');
  await Promise.all([fsp.mkdir(sourcePath), fsp.mkdir(outputPath)]);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const plan = { source, output, targets: [], archivePath: path.join(outputPath, 'backup.zip'), retainArchive: false, copyTargets: [] };
  const context = new OperationContext();
  let release;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const removeFile = async (...args) => {
    enteredResolve();
    await gate;
    return fsp.rm(...args);
  };

  const execution = execute(plan, context, {
    archive: { archiveFactory: successfulArchiveFactory('new archive') },
    removeFile,
  });
  await entered;
  await context.interrupt('SIGINT');
  release();

  await assert.rejects(execution, (error) => error.exitCode === 130);
  assert.deepEqual(await fsp.readdir(outputPath), []);
  assert.equal(context.temporaryPaths.size, 0);
});

for (const [signal, expectedExitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`CLI ${signal} interruption uses exit code ${expectedExitCode} and cleans up`, async (t) => {
    const root = await temporaryRoot(t);
    const source = path.join(root, 'source');
    const output = path.join(root, 'output');
    await Promise.all([fsp.mkdir(source), fsp.mkdir(output)]);
    await fsp.writeFile(path.join(source, 'payload.bin'), Buffer.alloc(8 * 1024 * 1024, 0x61));
    const config = path.join(root, 'config.json');
    const lockPath = path.join(root, '.backup-tool.lock');
    await fsp.writeFile(config, JSON.stringify({ sourceDirectory: source, outputDirectory: output, targetDirectories: [output] }));

    const child = spawn(process.execPath, [SCRIPT, config], {
      env: { ...process.env, BACKUP_LOCK_PATH: lockPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let stdout = '';
    let stderr = '';
    let signalled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!signalled && stdout.includes('Creating archive...')) {
        signalled = true;
        child.kill(signal);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end('yes\n');
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    assert.equal(signalled, true);
    assert.equal(exitCode, expectedExitCode, stderr);
    assert.match(stderr, new RegExp(`Interrupted by ${signal}`));
    assert.doesNotMatch(stdout, /Backup complete/);
    await assert.rejects(fsp.access(lockPath), { code: 'ENOENT' });
    assert.deepEqual((await fsp.readdir(output)).filter((name) => /^\.backup-.*\.tmp$/.test(name)), []);
  });
}
