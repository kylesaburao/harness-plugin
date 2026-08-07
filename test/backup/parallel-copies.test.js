'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const test = require('node:test');

const { EXIT, OperationContext, execute } = require('../../src/backup/backup');

async function temporaryRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'backup-parallel-copies-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function directoryDetails(directory, label) {
  const canonicalPath = await fsp.realpath(directory);
  const details = await fsp.stat(canonicalPath, { bigint: true });
  return { label, configuredPath: directory, canonicalPath, identity: `${details.dev}:${details.ino}` };
}

function successfulArchiveFactory(contents = 'archive data') {
  return () => {
    const archive = new EventEmitter();
    archive.pipe = (output) => { archive.output = output; };
    archive.directory = () => {};
    archive.finalize = async () => { archive.output.end(contents); };
    archive.abort = () => archive.output?.destroy();
    return archive;
  };
}

async function makePlan(t, targetCount = 2) {
  const root = await temporaryRoot(t);
  const sourcePath = path.join(root, 'source');
  const outputPath = path.join(root, 'output');
  await Promise.all([fsp.mkdir(sourcePath), fsp.mkdir(outputPath)]);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const targets = [];
  for (let index = 0; index < targetCount; index += 1) {
    const targetPath = path.join(root, `target-${index}`);
    await fsp.mkdir(targetPath);
    targets.push(await directoryDetails(targetPath, `targetDirectories[${index}]`));
  }
  return {
    root,
    plan: {
      source,
      output,
      targets,
      archivePath: path.join(outputPath, 'backup.zip'),
      retainArchive: false,
      copyTargets: targets.map((directory) => ({
        directory,
        destination: path.join(directory.canonicalPath, 'backup.zip'),
      })),
    },
  };
}

function gatedReaders(expectedStarts) {
  let active = 0;
  let peak = 0;
  let started = 0;
  let closed = 0;
  let startedResolve;
  let release;
  const allStarted = new Promise((resolve) => { startedResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const createReadStream = () => {
    let began = false;
    const input = new Readable({
      read() {
        if (began) return;
        began = true;
        active += 1;
        started += 1;
        peak = Math.max(peak, active);
        if (started === expectedStarts) startedResolve();
        gate.then(() => {
          if (!input.destroyed) {
            input.push('archive data');
            input.push(null);
          }
        });
      },
    });
    input.once('close', () => {
      active -= 1;
      closed += 1;
    });
    return input;
  };
  return { createReadStream, allStarted, release, stats: () => ({ active, peak, started, closed }) };
}

test('execute overlaps two target copies and reports only installed destinations', async (t) => {
  const { plan } = await makePlan(t);
  const readers = gatedReaders(2);
  const stages = [];
  const context = new OperationContext();
  const execution = execute(plan, context, {
    archive: { archiveFactory: successfulArchiveFactory() },
    copy: { createReadStream: readers.createReadStream },
    onStage: (stage) => stages.push(stage),
  });

  await readers.allStarted;
  assert.equal(readers.stats().peak, 2);
  readers.release();
  const copied = await execution;

  assert.deepEqual(copied, plan.copyTargets.map((target) => target.destination));
  assert.equal(stages.filter((stage) => stage.phase === 'copy-start').length, 2);
  for (const destination of copied) assert.equal(await fsp.readFile(destination, 'utf8'), 'archive data');
  assert.deepEqual(await fsp.readdir(plan.output.canonicalPath), []);
});

test('parallel copy failure aborts and drains in-flight work before staging removal', async (t) => {
  const { plan } = await makePlan(t);
  let started = 0;
  let closed = 0;
  let allStartedResolve;
  const allStarted = new Promise((resolve) => { allStartedResolve = resolve; });
  const createReadStream = () => {
    const index = started;
    started += 1;
    if (started === 2) allStartedResolve();
    const input = new Readable({
      read() {
        if (index === 0) allStarted.then(() => input.destroy(new Error('first target failed')));
      },
    });
    input.once('close', () => { closed += 1; });
    return input;
  };
  let stagingRemovedAfterDrain = false;
  const removeFile = async (...args) => {
    stagingRemovedAfterDrain = closed === 2;
    return fsp.rm(...args);
  };
  const context = new OperationContext();

  await assert.rejects(
    execute(plan, context, {
      archive: { archiveFactory: successfulArchiveFactory() },
      copy: { createReadStream },
      removeFile,
    }),
    (error) => error.exitCode === EXIT.COPY && /first target failed/.test(error.message),
  );

  assert.equal(stagingRemovedAfterDrain, true);
  assert.deepEqual(await fsp.readdir(plan.output.canonicalPath), []);
  for (const { destination } of plan.copyTargets) {
    await assert.rejects(fsp.access(destination), { code: 'ENOENT' });
  }
  assert.deepEqual(await context.cleanup(), []);
});

test('interruption aborts all parallel copies and preserves its signal exit code', async (t) => {
  const { plan } = await makePlan(t);
  const readers = gatedReaders(2);
  const context = new OperationContext();
  let stagingRemovedAfterDrain = false;
  const removeFile = async (...args) => {
    stagingRemovedAfterDrain = readers.stats().closed === 2;
    return fsp.rm(...args);
  };
  const execution = execute(plan, context, {
    archive: { archiveFactory: successfulArchiveFactory() },
    copy: { createReadStream: readers.createReadStream },
    removeFile,
  });

  await readers.allStarted;
  await context.interrupt('SIGTERM');

  await assert.rejects(execution, (error) => error.exitCode === 143);
  assert.equal(stagingRemovedAfterDrain, true);
  assert.deepEqual(await fsp.readdir(plan.output.canonicalPath), []);
  assert.deepEqual(await context.cleanup(), []);
});
