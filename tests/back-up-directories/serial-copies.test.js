'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const { EXIT, OperationContext, execute } = require(require('../helpers/plugin-paths').artifactPath('skills/back-up-directories/scripts/backup.js'));
const { directoryDetails, successfulArchiveFactory, temporaryRoot } = require('./test-helpers.js');

const COPY_TEMPORARY = /^\.backup-copy-[0-9a-f-]+\.tmp$/i;

// retainArchive selects the sequential copy path; a staging-only plan fans out.
async function makePlan(t, { retainArchive = false } = {}) {
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
      retainArchive,
      stagingTarget: null,
      copyTargets: targets.map((directory) => ({ directory, destination: path.join(directory.canonicalPath, 'backup.zip') })),
    },
  };
}

test('a retained archive installs each target before starting the next copy', async (t) => {
  const { plan } = await makePlan(t, { retainArchive: true });
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
  assert.deepEqual(await fsp.readdir(plan.output.canonicalPath), ['backup.zip']);
});

test('a failed first copy of a retained archive prevents the second copy from starting', async (t) => {
  const { plan } = await makePlan(t, { retainArchive: true });
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

test('a failed second copy of a retained archive preserves the first installed destination', async (t) => {
  const { plan } = await makePlan(t, { retainArchive: true });
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
  assert.deepEqual(await fsp.readdir(plan.output.canonicalPath), ['backup.zip']);
  assert.equal(context.temporaryPaths.size, 1);
  assert.deepEqual(context.cleanupSync(), []);
});

test('a staging-only archive is read once and written to every target in parallel', async (t) => {
  const { plan } = await makePlan(t);
  const context = new OperationContext();
  const stages = [];
  const reads = [];
  let releaseRest;
  let firstWrites = 0;
  let firstChunkWrittenResolve;
  const firstChunkWritten = new Promise((resolve) => { firstChunkWrittenResolve = resolve; });
  // Counts each target's completed first write, so both temporary files exist
  // while the rest of the archive is still unread.
  const createWriteStream = (file, options) => {
    const output = fs.createWriteStream(file, options);
    const write = output.write.bind(output);
    let first = true;
    output.write = (chunk, callback) => write(chunk, (error) => {
      if (first) {
        first = false;
        firstWrites += 1;
        if (firstWrites === plan.copyTargets.length) firstChunkWrittenResolve();
      }
      callback?.(error);
    });
    return output;
  };
  const rest = new Promise((resolve) => { releaseRest = resolve; });
  const createReadStream = (sourcePath) => {
    reads.push(sourcePath);
    let step = 0;
    return new Readable({
      read() {
        step += 1;
        if (step === 1) {
          this.push('archive ');
        } else if (step === 2) {
          rest.then(() => {
            this.push('data');
            this.push(null);
          });
        }
      },
    });
  };

  const execution = execute(plan, context, {
    archive: { archiveFactory: successfulArchiveFactory('archive data') },
    copy: { createReadStream, createWriteStream },
    onStage: (stage) => stages.push(stage),
  });
  await firstChunkWritten;

  try {
    assert.deepEqual(stages.filter((stage) => stage.phase.startsWith('copy-')), [{ phase: 'copy-parallel-start', total: 2 }]);
    for (const target of plan.copyTargets) {
      assert.equal((await fsp.readdir(target.directory.canonicalPath)).filter((name) => COPY_TEMPORARY.test(name)).length, 1);
      await assert.rejects(fsp.access(target.destination), { code: 'ENOENT' });
    }
  } finally {
    releaseRest();
  }

  const copied = await execution;
  assert.equal(reads.length, 1);
  assert.equal(path.dirname(reads[0]), plan.output.canonicalPath);
  assert.deepEqual(copied, plan.copyTargets.map((target) => target.destination));
  for (const target of plan.copyTargets) {
    assert.deepEqual(await fsp.readdir(target.directory.canonicalPath), ['backup.zip']);
    assert.equal(await fsp.readFile(target.destination, 'utf8'), 'archive data');
  }
  assert.deepEqual(await fsp.readdir(plan.output.canonicalPath), []);
  assert.equal(context.temporaryPaths.size, 0);
  assert.deepEqual(
    stages.filter((stage) => stage.phase === 'copy-complete').sort((left, right) => left.index - right.index),
    plan.copyTargets.map((target, index) => ({ phase: 'copy-complete', destination: target.destination, index, total: 2, failed: false })),
  );
});

test('a failed parallel target reports EXIT.COPY with the other outcomes and leaves its temporary file to cleanup', async (t) => {
  const { plan } = await makePlan(t);
  const context = new OperationContext();
  const failedDirectory = plan.copyTargets[1].directory.canonicalPath;
  const createWriteStream = (file, options) => {
    if (path.dirname(file) !== failedDirectory) return fs.createWriteStream(file, options);
    const partial = fs.createWriteStream(file, options);
    return new Writable({
      write(_chunk, _encoding, callback) { callback(new Error('second target write failed')); },
      destroy(error, callback) { partial.destroy(); partial.once('close', () => callback(error)); },
    });
  };

  await assert.rejects(
    execute(plan, context, {
      archive: { archiveFactory: successfulArchiveFactory('archive data') },
      copy: { createWriteStream },
    }),
    (error) => error.exitCode === EXIT.COPY &&
      error.message.startsWith(`Failed to copy archive to ${plan.copyTargets[1].destination}: second target write failed.`) &&
      error.message.endsWith(`Installed copies: ${plan.copyTargets[0].destination}.`),
  );

  assert.equal(await fsp.readFile(plan.copyTargets[0].destination, 'utf8'), 'archive data');
  await assert.rejects(fsp.access(plan.copyTargets[1].destination), { code: 'ENOENT' });
  assert.equal((await fsp.readdir(failedDirectory)).filter((name) => COPY_TEMPORARY.test(name)).length, 1);
  assert.equal(context.temporaryPaths.size, 1);
  assert.deepEqual(context.cleanupSync(), []);
  assert.deepEqual(await fsp.readdir(failedDirectory), []);
  assert.deepEqual(await fsp.readdir(plan.output.canonicalPath), []);
});

test('a read failure fails every parallel target once with one message per target', async (t) => {
  const { plan } = await makePlan(t);
  const context = new OperationContext();
  let reads = 0;
  const createReadStream = () => {
    reads += 1;
    return new Readable({ read() { this.destroy(new Error('archive read failed')); } });
  };

  await assert.rejects(
    execute(plan, context, {
      archive: { archiveFactory: successfulArchiveFactory('archive data') },
      copy: { createReadStream },
    }),
    (error) => error.exitCode === EXIT.COPY && error.message === [
      `Failed to copy archive to ${plan.copyTargets[0].destination}: archive read failed.`,
      `Failed to copy archive to ${plan.copyTargets[1].destination}: archive read failed.`,
      'No copy was installed.',
    ].join(' '),
  );
  assert.equal(reads, 1);
  for (const target of plan.copyTargets) await assert.rejects(fsp.access(target.destination), { code: 'ENOENT' });
  assert.equal(context.temporaryPaths.size, 2);
  assert.deepEqual(context.cleanupSync(), []);
  for (const target of plan.copyTargets) assert.deepEqual(await fsp.readdir(target.directory.canonicalPath), []);
});

async function makeStagingTargetPlan(t, targetCount) {
  const { plan } = await makePlan(t);
  const copyTargets = plan.copyTargets.slice(0, targetCount);
  return {
    ...plan,
    output: plan.targets[0],
    targets: plan.targets.slice(0, targetCount),
    archivePath: copyTargets[0].destination,
    stagingTarget: copyTargets[0],
    copyTargets,
  };
}

test('without an output directory the first target is published by renaming the staging archive', async (t) => {
  const plan = await makeStagingTargetPlan(t, 2);
  const context = new OperationContext();
  const reads = [];
  const createReadStream = (sourcePath) => {
    reads.push(sourcePath);
    return fs.createReadStream(sourcePath);
  };

  const copied = await execute(plan, context, {
    archive: { archiveFactory: successfulArchiveFactory('archive data') },
    copy: { createReadStream },
  });

  assert.deepEqual(copied, plan.copyTargets.map((target) => target.destination));
  assert.equal(reads.length, 1);
  assert.equal(path.dirname(reads[0]), plan.copyTargets[0].directory.canonicalPath);
  assert.match(path.basename(reads[0]), /^\.backup-archive-[0-9a-f-]+\.tmp$/i);
  for (const target of plan.copyTargets) {
    assert.deepEqual(await fsp.readdir(target.directory.canonicalPath), ['backup.zip']);
    assert.equal(await fsp.readFile(target.destination, 'utf8'), 'archive data');
  }
  assert.equal(context.temporaryPaths.size, 0);
});

test('a single staging target is published by rename alone', async (t) => {
  const plan = await makeStagingTargetPlan(t, 1);
  const context = new OperationContext();
  let reads = 0;

  const copied = await execute(plan, context, {
    archive: { archiveFactory: successfulArchiveFactory('archive data') },
    copy: { createReadStream: () => { reads += 1; return Readable.from([]); } },
  });

  assert.deepEqual(copied, [plan.copyTargets[0].destination]);
  assert.equal(reads, 0);
  assert.deepEqual(await fsp.readdir(plan.copyTargets[0].directory.canonicalPath), ['backup.zip']);
  assert.equal(await fsp.readFile(plan.copyTargets[0].destination, 'utf8'), 'archive data');
  assert.equal(context.temporaryPaths.size, 0);
});

test('a failed parallel copy does not prevent publishing the staging target', async (t) => {
  const plan = await makeStagingTargetPlan(t, 2);
  const context = new OperationContext();
  const failedDirectory = plan.copyTargets[1].directory.canonicalPath;
  const createWriteStream = (file, options) => {
    if (path.dirname(file) !== failedDirectory) return fs.createWriteStream(file, options);
    return new Writable({ write(_chunk, _encoding, callback) { callback(new Error('second target write failed')); } });
  };

  await assert.rejects(
    execute(plan, context, {
      archive: { archiveFactory: successfulArchiveFactory('archive data') },
      copy: { createWriteStream },
    }),
    (error) => error.exitCode === EXIT.COPY &&
      error.message === `Failed to copy archive to ${plan.copyTargets[1].destination}: second target write failed. ` +
        `Installed copies: ${plan.copyTargets[0].destination}.`,
  );
  assert.deepEqual(await fsp.readdir(plan.copyTargets[0].directory.canonicalPath), ['backup.zip']);
  assert.equal(await fsp.readFile(plan.copyTargets[0].destination, 'utf8'), 'archive data');
  assert.deepEqual(context.cleanupSync(), []);
  assert.deepEqual(await fsp.readdir(failedDirectory), []);
});
