'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const { EXIT, OperationContext, execute } = require('../../plugins/harness/skills/back-up-directories/scripts/backup.js');
const { directoryDetails, successfulArchiveFactory, temporaryRoot } = require('./test-helpers.js');

async function makePlan(t) {
  const root = await temporaryRoot(t);
  const sourcePath = path.join(root, 'source');
  const outputPath = path.join(root, 'output');
  const firstTargetPath = path.join(root, 'target-0');
  const secondTargetPath = path.join(root, 'target-1');
  await Promise.all([fsp.mkdir(sourcePath), fsp.mkdir(outputPath), fsp.mkdir(firstTargetPath), fsp.mkdir(secondTargetPath)]);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const targets = await Promise.all([
    directoryDetails(firstTargetPath, 'targetDirectories[0]'),
    directoryDetails(secondTargetPath, 'targetDirectories[1]'),
  ]);
  return {
    plan: {
      source,
      output,
      targets,
      archivePath: path.join(outputPath, 'backup.zip'),
      retainArchive: false,
      copyTargets: targets.map((directory) => ({ directory, destination: path.join(directory.canonicalPath, 'backup.zip') })),
    },
  };
}

test('execute installs each target before starting the next copy', async (t) => {
  const { plan } = await makePlan(t);
  const stages = [];
  let started = 0;
  let firstStartedResolve;
  let secondStartedResolve;
  let releaseFirst;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  const secondStarted = new Promise((resolve) => { secondStartedResolve = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const createReadStream = () => {
    const index = started;
    started += 1;
    if (index === 1) {
      secondStartedResolve();
      return Readable.from(['archive data']);
    }
    let began = false;
    return new Readable({
      read() {
        if (began) return;
        began = true;
        firstStartedResolve();
        firstGate.then(() => {
          this.push('archive data');
          this.push(null);
        });
      },
    });
  };

  const execution = execute(plan, new OperationContext(), {
    archive: { archiveFactory: successfulArchiveFactory('archive data') },
    copy: { createReadStream },
    onStage: (stage) => stages.push(stage),
  });
  await firstStarted;

  try {
    assert.equal(started, 1);
    assert.deepEqual(stages.filter((stage) => stage.phase === 'copy-start'), [
      { phase: 'copy-start', destination: plan.copyTargets[0].destination, index: 0, total: 2 },
    ]);
    await assert.rejects(fsp.access(plan.copyTargets[0].destination), { code: 'ENOENT' });
  } finally {
    releaseFirst();
  }

  await secondStarted;
  assert.equal(await fsp.readFile(plan.copyTargets[0].destination, 'utf8'), 'archive data');
  const copied = await execution;

  assert.deepEqual(copied, plan.copyTargets.map((target) => target.destination));
  assert.deepEqual(stages.filter((stage) => stage.phase === 'copy-start'), [
    { phase: 'copy-start', destination: plan.copyTargets[0].destination, index: 0, total: 2 },
    { phase: 'copy-start', destination: plan.copyTargets[1].destination, index: 1, total: 2 },
  ]);
  for (const destination of copied) assert.equal(await fsp.readFile(destination, 'utf8'), 'archive data');
  assert.deepEqual(await fsp.readdir(plan.output.canonicalPath), []);
});

test('a failed first copy prevents the second copy from starting', async (t) => {
  const { plan } = await makePlan(t);
  let started = 0;
  const createReadStream = () => {
    started += 1;
    return new Readable({ read() { this.destroy(new Error('first target failed')); } });
  };

  await assert.rejects(
    execute(plan, new OperationContext(), {
      archive: { archiveFactory: successfulArchiveFactory('archive data') },
      copy: { createReadStream },
    }),
    (error) => error.exitCode === EXIT.COPY && /first target failed/.test(error.message),
  );

  assert.equal(started, 1);
  await assert.rejects(fsp.access(plan.copyTargets[0].destination), { code: 'ENOENT' });
  await assert.rejects(fsp.access(plan.copyTargets[1].destination), { code: 'ENOENT' });
});

test('a failed second copy preserves the first installed destination', async (t) => {
  const { plan } = await makePlan(t);
  const context = new OperationContext();
  let started = 0;
  const createReadStream = () => {
    const index = started;
    started += 1;
    if (index === 0) return Readable.from(['archive data']);
    return new Readable({ read() { this.destroy(new Error('second target failed')); } });
  };

  await assert.rejects(
    execute(plan, context, {
      archive: { archiveFactory: successfulArchiveFactory('archive data') },
      copy: { createReadStream },
    }),
    (error) => error.exitCode === EXIT.COPY &&
      error.message.includes(plan.copyTargets[1].destination) &&
      /second target failed/.test(error.message),
  );

  assert.equal(started, 2);
  assert.equal(await fsp.readFile(plan.copyTargets[0].destination, 'utf8'), 'archive data');
  await assert.rejects(fsp.access(plan.copyTargets[1].destination), { code: 'ENOENT' });
  assert.deepEqual(await fsp.readdir(plan.output.canonicalPath), []);
  assert.equal(context.temporaryPaths.size, 1);
  assert.deepEqual(context.cleanupSync(), []);
});
