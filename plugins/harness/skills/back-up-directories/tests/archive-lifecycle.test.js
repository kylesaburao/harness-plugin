'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const test = require('node:test');

const { OperationContext, createArchive } = require('../scripts/backup.js');

async function temporaryRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'backup-archive-lifecycle-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

function archiveDouble(configure = () => {}) {
  const archive = new EventEmitter();
  archive.pipe = (output) => { archive.output = output; };
  archive.directory = () => {};
  archive.abort = () => archive.output?.destroy();
  archive.finalize = async () => { archive.output.end('archive'); };
  configure(archive);
  return archive;
}

test('createArchive rejects an output stream failure', async (t) => {
  const root = await temporaryRoot(t);
  const destination = path.join(root, 'archive.zip');
  const outputFactory = () => new Writable({
    write(_chunk, _encoding, callback) { callback(new Error('output failed')); },
  });
  const archiveFactory = () => archiveDouble((archive) => {
    archive.finalize = async () => { archive.output.end('archive'); };
  });

  await assert.rejects(
    createArchive(root, destination, new OperationContext(), { archiveFactory, outputFactory }),
    /output failed/,
  );
});

test('createArchive rejects an archive error and preserves the first failure through close', async (t) => {
  const root = await temporaryRoot(t);
  const destination = path.join(root, 'archive.zip');
  const archiveFactory = () => archiveDouble((archive) => {
    archive.finalize = async () => {
      archive.emit('error', new Error('archive failed first'));
      archive.output.emit('error', new Error('output failed later'));
    };
  });

  await assert.rejects(
    createArchive(root, destination, new OperationContext(), { archiveFactory }),
    /archive failed first/,
  );
});

test('createArchive interruption stops active progress reporting and rejects with the signal', async (t) => {
  const root = await temporaryRoot(t);
  const destination = path.join(root, 'archive.zip');
  const context = new OperationContext();
  const reports = [];
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const archiveFactory = () => archiveDouble((archive) => {
    archive.finalize = () => {
      startedResolve();
      return new Promise(() => {});
    };
  });

  const creation = createArchive(root, destination, context, {
    archiveFactory,
    progressIntervalMs: 5,
    onProgress: (progress) => reports.push(progress),
  });
  await started;
  await context.interrupt('SIGTERM');
  await assert.rejects(creation, (error) => error.exitCode === 143);
  const countAfterInterruption = reports.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reports.length, countAfterInterruption);
});

test('createArchive handles warning followed by close exactly once', async (t) => {
  const root = await temporaryRoot(t);
  const destination = path.join(root, 'archive.zip');
  const archiveFactory = () => archiveDouble((archive) => {
    archive.finalize = async () => {
      archive.emit('warning', { path: 'omitted.txt', code: 'EACCES' });
      archive.output.destroy();
    };
  });

  await assert.rejects(
    createArchive(root, destination, new OperationContext(), { archiveFactory }),
    /Archiver warning for omitted\.txt: EACCES/,
  );
});

test('createArchive rejects a premature output close and keeps its temporary path tracked', async (t) => {
  const root = await temporaryRoot(t);
  const destination = path.join(root, 'archive.zip');
  const archiveFactory = () => archiveDouble((archive) => {
    archive.finalize = async () => { archive.output.destroy(); };
  });
  const context = new OperationContext();

  await assert.rejects(
    createArchive(root, destination, context, { archiveFactory }),
    /closed before finishing/,
  );
  assert(context.temporaryPaths.has(destination));
});

test('createArchive rejects a finalization failure that arrives after output close', async (t) => {
  const root = await temporaryRoot(t);
  const destination = path.join(root, 'archive.zip');
  const archiveFactory = () => archiveDouble((archive) => {
    archive.finalize = async () => {
      archive.output.end('archive');
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error('finalization failed late');
    };
  });

  await assert.rejects(
    createArchive(root, destination, new OperationContext(), { archiveFactory }),
    /finalization failed late/,
  );
});

for (const stage of ['outputFactory', 'archiveFactory', 'pipe', 'finalize']) {
  test(`createArchive handles a synchronous ${stage} failure`, async (t) => {
    const root = await temporaryRoot(t);
    const destination = path.join(root, 'archive.zip');
    const failure = new Error(`${stage} failed`);
    const dependencies = {};
    if (stage === 'outputFactory') dependencies.outputFactory = () => { throw failure; };
    if (stage === 'archiveFactory') dependencies.archiveFactory = () => { throw failure; };
    if (stage === 'pipe') dependencies.archiveFactory = () => archiveDouble((archive) => {
      archive.pipe = () => { throw failure; };
    });
    if (stage === 'finalize') dependencies.archiveFactory = () => archiveDouble((archive) => {
      archive.finalize = () => { throw failure; };
    });

    await assert.rejects(createArchive(root, destination, new OperationContext(), dependencies), failure);
  });
}
