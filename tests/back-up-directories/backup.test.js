'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  EXIT,
  InterruptedError,
  OperationContext,
  acquireRunLock,
  assertDirectoryUnchanged,
  backupFilename,
  cleanupStartupArtifacts,
  copyAtomically,
  createArchive,
  execute,
  formatBytes,
  readAndValidate,
  resolveRunLockPath,
  shortTempPath,
} = require('../../plugins/harness/skills/back-up-directories/scripts/backup.js');
const { directoryDetails, runCli, successfulArchiveFactory, temporaryRoot } = require('./test-helpers.js');

const FIXED_DATE = new Date(2026, 6, 11, 12);

async function makeDirectories(root, names) {
  const result = Object.fromEntries(names.map((name) => [name, path.join(root, name)]));
  await Promise.all(Object.values(result).map((directory) => fsp.mkdir(directory)));
  return result;
}


test('backupFilename sanitizes names and emits a stable dated filename', () => {
  assert.equal(
    backupFilename('/tmp/My: Project. ', FIXED_DATE),
    'My--Project.-_Backup_July112026.zip',
  );
  assert.equal(backupFilename('/', FIXED_DATE), 'Backup_Backup_July112026.zip');
});

test('backupFilename truncates long UTF-8 names on character boundaries with a stable hash', () => {
  const source = path.join('/tmp', '📁'.repeat(100));
  const first = backupFilename(source, FIXED_DATE);
  const second = backupFilename(source, FIXED_DATE);

  assert.equal(first, second);
  assert(Buffer.byteLength(first) <= 255);
  assert.match(first, /-[0-9a-f]{12}_Backup_July112026\.zip$/);
  assert(!first.includes('�'));
});

test('formatBytes presents byte counts with binary units', () => {
  assert.equal(formatBytes(0n), '0 B');
  assert.equal(formatBytes(1023n), '1023 B');
  assert.equal(formatBytes(1024n), '1.00 KiB');
  assert.equal(formatBytes(1536n), '1.50 KiB');
  assert.equal(formatBytes(1024n ** 3n), '1.00 GiB');
});

test('shortTempPath stays in its directory and uses the owned-artifact shape', () => {
  const first = shortTempPath('/tmp/output', 'copy');
  const second = shortTempPath('/tmp/output', 'copy');

  assert.equal(path.dirname(first), '/tmp/output');
  assert.match(path.basename(first), /^\.backup-copy-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i);
  assert.notEqual(first, second);
});

test('readAndValidate reports unreadable and malformed configurations', async (t) => {
  const root = await temporaryRoot(t);
  await assert.rejects(readAndValidate(path.join(root, 'missing.json')), /Cannot read configuration file.*ENOENT/);

  const invalid = path.join(root, 'invalid.json');
  await fsp.writeFile(invalid, '{');
  await assert.rejects(readAndValidate(invalid), /contains invalid JSON/);
});

test('CLI rejects a missing configuration before checking dependencies', async (t) => {
  const root = await temporaryRoot(t);
  const preload = path.join(root, 'missing-archiver.cjs');
  await fsp.writeFile(preload, `const Module = require('node:module');
const original = Module._load;
Module._load = function(request, ...args) {
  if (request === 'archiver') { const error = new Error('missing'); error.code = 'MODULE_NOT_FOUND'; throw error; }
  return original.call(this, request, ...args);
};
`);
  const result = await runCli(t, ['--json'], {
    environment: { NODE_OPTIONS: `--require=${preload}` },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'usage_error');
});

// archiver became ESM-only at 8.0.0 and lost its default export, so loadArchiver reaches
// for a named ZipArchive. A missing property is undefined rather than a throw, so an
// archiver that resolves but no longer carries that export would clear the preflight and
// only fail once the run is already underway. This stubs that exact shape: the module
// loads, the export is gone, and the environment check has to be what stops the run.
test('CLI rejects an archiver that resolves without ZipArchive', async (t) => {
  const root = await temporaryRoot(t, 'backup-cli-archiver-shape-');
  const { source, output } = await makeDirectories(root, ['source', 'output']);
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [output],
  }));
  const preload = path.join(root, 'hollow-archiver.cjs');
  await fsp.writeFile(preload, `const Module = require('node:module');
const original = Module._load;
Module._load = function(request, ...args) {
  if (request === 'archiver') return {};
  return original.call(this, request, ...args);
};
`);

  const result = await runCli(t, ['--json', config], {
    input: 'yes\n',
    environment: { NODE_OPTIONS: `--require=${preload}` },
  });

  assert.equal(result.exitCode, EXIT.USAGE);
  const { error } = JSON.parse(result.stderr);
  assert.equal(error.code, 'dependency_missing');
  assert.match(error.condition, /does not export ZipArchive/);
  assert.deepEqual(await fsp.readdir(output), []);
});

test('readAndValidate rejects each invalid configuration shape', async (t) => {
  const root = await temporaryRoot(t);
  const cases = [
    [null, /must be a JSON object/],
    [[], /must be a JSON object/],
    [{ targetDirectories: ['target'] }, /"sourceDirectory" is required/],
    [{ sourceDirectory: 'source' }, /"targetDirectories" is required/],
    [{ sourceDirectory: 'source', targetDirectories: [] }, /"targetDirectories" is required/],
    [{ sourceDirectory: 'source', targetDirectories: [''] }, /"targetDirectories" is required/],
    [{ sourceDirectory: 'source', targetDirectories: ['target'], outputDirectory: 42 }, /"outputDirectory"/],
  ];

  for (const [index, [value, expected]] of cases.entries()) {
    const config = path.join(root, `config-${index}.json`);
    await fsp.writeFile(config, JSON.stringify(value));
    await assert.rejects(readAndValidate(config), expected);
  }
});

test('readAndValidate resolves relative paths and plans aliases without duplicate copies', async (t) => {
  const root = await temporaryRoot(t);
  const { source, output, target } = await makeDirectories(root, ['source', 'output', 'target']);
  const targetAlias = path.join(root, 'target-alias');
  await fsp.symlink(target, targetAlias, 'dir');
  const filename = backupFilename(source, FIXED_DATE);
  await fsp.writeFile(path.join(target, filename), 'old backup');
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: './source',
    outputDirectory: './output',
    targetDirectories: ['./output', './target', './target-alias'],
  }));

  const plan = await readAndValidate(config, FIXED_DATE);

  assert.equal(plan.source.canonicalPath, await fsp.realpath(source));
  assert.equal(plan.retainArchive, true);
  assert.equal(plan.archiveExists, false);
  assert.equal(plan.copyTargets.length, 1);
  assert.equal(plan.copyTargets[0].destination, path.join(await fsp.realpath(target), filename));
  assert.match(plan.previewTargets[0].action, /shared with outputDirectory/);
  assert.equal(plan.previewTargets[1].action, 'will be overwritten');
  assert.match(plan.previewTargets[2].action, /shared with targetDirectories\[1\]/);
  assert.equal('storage' in plan.previewTargets[1], false);
});

test('readAndValidate accepts a target root with an unreadable descendant', async (t) => {
  const root = await temporaryRoot(t);
  const { source, output, target } = await makeDirectories(root, ['source', 'output', 'target']);
  const inaccessible = path.join(target, 'unrelated-private-directory');
  await fsp.mkdir(inaccessible, { mode: 0o700 });
  await fsp.chmod(inaccessible, 0o000);
  t.after(() => fsp.chmod(inaccessible, 0o700).catch(() => {}));
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [target],
  }));

  const plan = await readAndValidate(config, FIXED_DATE);

  assert.equal(plan.copyTargets.length, 1);
});

test('readAndValidate rejects an output root without read access during preflight', async (t) => {
  const root = await temporaryRoot(t);
  const { source, output, target } = await makeDirectories(root, ['source', 'output', 'target']);
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [target],
  }));
  const originalAccess = fsp.access;
  t.mock.method(fsp, 'access', async (candidate, mode) => {
    if (candidate === await fsp.realpath(output) && mode === (fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK)) {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return originalAccess(candidate, mode);
  });

  await assert.rejects(readAndValidate(config, FIXED_DATE), /outputDirectory must be readable, writable, and searchable/);
});

test('readAndValidate recursively creates and validates a missing output directory', async (t) => {
  const root = await temporaryRoot(t);
  const { source, target } = await makeDirectories(root, ['source', 'target']);
  const output = path.join(root, 'missing', 'parents', 'output');
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [target],
  }));

  const plan = await readAndValidate(config, FIXED_DATE);
  const details = await fsp.stat(output, { bigint: true });

  assert(details.isDirectory());
  assert.equal(plan.output.configuredPath, output);
  assert.equal(plan.output.canonicalPath, await fsp.realpath(output));
  assert.equal(plan.output.identity, `${details.dev}:${details.ino}`);
});

test('readAndValidate creates a missing output that is also a target', async (t) => {
  const root = await temporaryRoot(t);
  const { source } = await makeDirectories(root, ['source']);
  const output = path.join(root, 'new', 'output');
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [output],
  }));

  const plan = await readAndValidate(config, FIXED_DATE);

  assert.equal(plan.retainArchive, true);
  assert.equal(plan.archiveExists, false);
  assert.deepEqual(plan.copyTargets, []);
  assert.match(plan.previewTargets[0].action, /shared with outputDirectory/);
});

test('readAndValidate recognizes an existing retained archive', async (t) => {
  const root = await temporaryRoot(t);
  const { source, output } = await makeDirectories(root, ['source', 'output']);
  const filename = backupFilename(source, FIXED_DATE);
  await fsp.writeFile(path.join(output, filename), 'previous');
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [output],
  }));

  const plan = await readAndValidate(config, FIXED_DATE);
  assert.equal(plan.retainArchive, true);
  assert.equal(plan.archiveExists, true);
  assert.deepEqual(plan.copyTargets, []);
});

test('readAndValidate rejects non-directories and output or target paths inside the source', async (t) => {
  const root = await temporaryRoot(t);
  const { source, target } = await makeDirectories(root, ['source', 'target']);
  const nestedOutput = path.join(source, 'output');
  await fsp.mkdir(nestedOutput);
  const regularFile = path.join(root, 'file');
  await fsp.writeFile(regularFile, 'not a directory');

  const fileConfig = path.join(root, 'file-config.json');
  await fsp.writeFile(fileConfig, JSON.stringify({ sourceDirectory: regularFile, targetDirectories: [target] }));
  await assert.rejects(readAndValidate(fileConfig), /sourceDirectory must be a directory/);

  const nestedConfig = path.join(root, 'nested-config.json');
  await fsp.writeFile(nestedConfig, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: nestedOutput,
    targetDirectories: [target],
  }));
  await assert.rejects(readAndValidate(nestedConfig), /outputDirectory must not resolve to sourceDirectory/);

  const missingNestedOutput = path.join(source, 'missing', 'output');
  const missingNestedConfig = path.join(root, 'missing-nested-config.json');
  await fsp.writeFile(missingNestedConfig, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: missingNestedOutput,
    targetDirectories: [target],
  }));
  await assert.rejects(readAndValidate(missingNestedConfig), /outputDirectory must not resolve to sourceDirectory/);
  await assert.rejects(fsp.access(missingNestedOutput), { code: 'ENOENT' });

  const sourceAlias = path.join(root, 'source-alias');
  await fsp.symlink(source, sourceAlias, 'dir');
  const aliasedMissingOutput = path.join(sourceAlias, 'aliased-missing-output');
  const aliasedConfig = path.join(root, 'aliased-config.json');
  await fsp.writeFile(aliasedConfig, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: aliasedMissingOutput,
    targetDirectories: [target],
  }));
  await assert.rejects(readAndValidate(aliasedConfig), /outputDirectory must not resolve to sourceDirectory/);
  await assert.rejects(fsp.access(aliasedMissingOutput), { code: 'ENOENT' });

  for (const [index, targetDirectory] of [source, nestedOutput].entries()) {
    const nestedTargetConfig = path.join(root, `nested-target-config-${index}.json`);
    await fsp.writeFile(nestedTargetConfig, JSON.stringify({
      sourceDirectory: source,
      targetDirectories: [targetDirectory],
    }));
    await assert.rejects(readAndValidate(nestedTargetConfig), /targetDirectories\[0\] must not resolve to sourceDirectory/);
  }
});

test('readAndValidate rejects output file conflicts and reports directory creation failures', async (t) => {
  const root = await temporaryRoot(t);
  const { source, target } = await makeDirectories(root, ['source', 'target']);
  const conflictingOutput = path.join(root, 'conflicting-output');
  await fsp.writeFile(conflictingOutput, 'not a directory');
  const fileConfig = path.join(root, 'file-config.json');
  await fsp.writeFile(fileConfig, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: conflictingOutput,
    targetDirectories: [target],
  }));

  await assert.rejects(
    readAndValidate(fileConfig),
    (error) => error.message.includes(conflictingOutput) && error.message.includes('EEXIST'),
  );

  const conflictingParent = path.join(root, 'conflicting-parent');
  await fsp.writeFile(conflictingParent, 'not a directory');
  const conflictOutput = path.join(conflictingParent, 'output');
  const conflictConfig = path.join(root, 'conflict-config.json');
  await fsp.writeFile(conflictConfig, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: conflictOutput,
    targetDirectories: [target],
  }));

  await assert.rejects(
    readAndValidate(conflictConfig),
    (error) => error.message.includes(conflictOutput) && error.message.includes('ENOTDIR'),
  );

  const failedOutput = path.join(root, 'cannot-create', 'output');
  const failedConfig = path.join(root, 'failed-config.json');
  await fsp.writeFile(failedConfig, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: failedOutput,
    targetDirectories: [target],
  }));
  t.mock.method(fsp, 'mkdir', async (directory, options) => {
    assert.equal(directory, failedOutput);
    assert.deepEqual(options, { recursive: true, mode: 0o700 });
    const error = new Error('permission denied');
    error.code = 'EACCES';
    throw error;
  });

  await assert.rejects(
    readAndValidate(failedConfig),
    (error) => error.message.includes(failedOutput) && error.message.includes('EACCES'),
  );
});

test('readAndValidate rejects a directory where a destination file must go', async (t) => {
  const root = await temporaryRoot(t);
  const { source, output, target } = await makeDirectories(root, ['source', 'output', 'target']);
  await fsp.mkdir(path.join(target, backupFilename(source, FIXED_DATE)));
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [target],
  }));

  await assert.rejects(readAndValidate(config, FIXED_DATE), /Destination exists but is a directory/);
});

test('assertDirectoryUnchanged detects a replaced configured symlink', async (t) => {
  const root = await temporaryRoot(t);
  const { first, second } = await makeDirectories(root, ['first', 'second']);
  const configured = path.join(root, 'configured');
  await fsp.symlink(first, configured, 'dir');
  const directory = await directoryDetails(configured, 'targetDirectories[0]');
  await fsp.unlink(configured);
  await fsp.symlink(second, configured, 'dir');

  await assert.rejects(assertDirectoryUnchanged(directory), /no longer identifies the directory validated earlier/);
});

test('cleanupStartupArtifacts removes only current archive and copy temporary files', async (t) => {
  const root = await temporaryRoot(t);
  const output = await directoryDetails(root, 'outputDirectory');
  const ownedArchive = path.join(root, '.backup-archive-12345678-1234-4abc-8def-123456789abc.tmp');
  const ownedCopy = path.join(root, '.backup-copy-abcdefab-cdef-4abc-9def-abcdefabcdef.tmp');
  const legacyLockMetadata = path.join(root, '.backup-lock-fedcbafe-dcba-4321-abcd-fedcbafedcba.tmp');
  const broadLookalike = path.join(root, '.backup-copy-a.tmp');
  const unrelated = path.join(root, '.backup-other-abcdef.tmp');
  const lookalikeDirectory = path.join(root, '.backup-copy-directory.tmp');
  await Promise.all([
    fsp.writeFile(ownedArchive, 'stale'),
    fsp.writeFile(ownedCopy, 'stale'),
    fsp.writeFile(legacyLockMetadata, 'keep'),
    fsp.writeFile(broadLookalike, 'keep'),
    fsp.writeFile(unrelated, 'keep'),
    fsp.mkdir(lookalikeDirectory),
  ]);

  await cleanupStartupArtifacts({ output, targets: [output] });

  assert.deepEqual((await fsp.readdir(root)).sort(), [
    path.basename(broadLookalike),
    path.basename(legacyLockMetadata),
    path.basename(unrelated),
    path.basename(lookalikeDirectory),
  ].sort());
});

test('OperationContext interrupts once, notifies handlers, and exposes signal exit codes', async () => {
  const context = new OperationContext();
  let calls = 0;
  context.onAbort((error) => {
    calls += 1;
    assert(error instanceof InterruptedError);
  });

  await context.interrupt('SIGTERM');
  await context.interrupt('SIGINT');

  assert.equal(calls, 1);
  assert.equal(context.interruption.exitCode, 143);
  assert.throws(() => context.throwIfInterrupted(), /Interrupted by SIGTERM/);
});

test('OperationContext immediately notifies handlers registered after interruption', async () => {
  const context = new OperationContext();
  await context.interrupt('SIGINT');
  let delivered;

  context.onAbort((error) => { delivered = error; });

  assert.equal(delivered, context.interruption);
});

test('OperationContext cleanup removes successfully tracked artifacts', async (t) => {
  const root = await temporaryRoot(t);
  const artifact = path.join(root, 'temporary');
  await fsp.writeFile(artifact, 'data');
  const context = new OperationContext();
  context.track(artifact);

  assert.deepEqual(context.cleanupSync(), []);
  assert.equal(context.temporaryPaths.size, 0);
  await assert.rejects(fsp.access(artifact), { code: 'ENOENT' });
});

test('OperationContext cleanup reports and keeps an artifact it cannot remove', async (t) => {
  const root = await temporaryRoot(t);
  const nonDirectory = path.join(root, 'file');
  await fsp.writeFile(nonDirectory, 'content');
  const impossiblePath = path.join(nonDirectory, 'child');
  const context = new OperationContext();
  context.track(impossiblePath);

  const failures = context.cleanupSync();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].path, impossiblePath);
  assert(context.temporaryPaths.has(impossiblePath));
});

test('createArchive writes output and untracks only after the caller installs it', async (t) => {
  const root = await temporaryRoot(t);
  const destination = path.join(root, '.backup-archive-test.tmp');
  const context = new OperationContext();

  await createArchive(root, destination, context, { archiveFactory: successfulArchiveFactory('archive bytes') });

  assert.equal(await fsp.readFile(destination, 'utf8'), 'archive bytes');
  assert(context.temporaryPaths.has(destination));
});

// Every other createArchive test injects an archiveFactory double, so none of them
// exercise the real archiver package. This test omits dependencies.archiveFactory,
// which sends createArchive through loadArchiver() and the real ZipArchive, so an
// archiver upgrade that breaks the actual integration fails here.
test('createArchive with the real archiver produces a ZIP containing the source tree', async (t) => {
  const root = await temporaryRoot(t);
  const source = path.join(root, 'source');
  await fsp.mkdir(path.join(source, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(source, 'a.txt'), 'hello world');
  await fsp.writeFile(path.join(source, 'sub', 'b.txt'), 'nested');
  const destination = path.join(root, '.backup-archive-real.tmp');
  const context = new OperationContext();

  await createArchive(source, destination, context);

  const bytes = await fsp.readFile(destination);
  assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304');
  const text = bytes.toString('latin1');
  assert(text.includes('a.txt'));
  assert(text.includes('sub/b.txt'));
  assert.deepEqual(context.cleanupSync(), []);
});

test('createArchive reports initial and Archiver progress while work is in flight', async (t) => {
  const root = await temporaryRoot(t);
  const destination = path.join(root, '.backup-archive-progress.tmp');
  const context = new OperationContext();
  const reports = [];
  const archiveFactory = () => {
    const archive = successfulArchiveFactory('archive bytes')();
    archive.pointer = () => 7;
    archive.finalize = async () => {
      archive.emit('progress', {
        entries: { processed: 2, total: 3 },
        fs: { processedBytes: 11, totalBytes: 13 },
      });
      archive.output.end('archive bytes');
    };
    return archive;
  };

  await createArchive(root, destination, context, {
    archiveFactory,
    onProgress: (progress) => reports.push(progress),
  });

  assert.deepEqual(reports[0], { entries: 0, processedBytes: 0, outputBytes: 0 });
  assert.deepEqual(reports.at(-1), { entries: 2, processedBytes: 11, outputBytes: 7 });
});

test('createArchive treats warnings as failures and includes the omitted entry', async (t) => {
  const root = await temporaryRoot(t);
  const destination = path.join(root, '.backup-archive-warning.tmp');
  const context = new OperationContext();
  const archiveFactory = () => {
    const archive = new EventEmitter();
    archive.pipe = (output) => { archive.output = output; };
    archive.directory = () => {};
    archive.finalize = () => { archive.emit('warning', { path: 'secret.txt', code: 'EACCES' }); };
    archive.abort = () => archive.output.destroy();
    return archive;
  };

  await assert.rejects(
    createArchive(root, destination, context, { archiveFactory }),
    /Archiver warning for secret\.txt: EACCES/,
  );
  assert(context.temporaryPaths.has(destination));
  assert.deepEqual(context.cleanupSync(), []);
});

test('createArchive does not start an archive for an already interrupted context', async (t) => {
  const root = await temporaryRoot(t);
  const destination = path.join(root, '.backup-archive-interrupted.tmp');
  const context = new OperationContext();
  await context.interrupt('SIGTERM');
  let started = false;
  const archiveFactory = () => {
    const archive = successfulArchiveFactory()();
    archive.directory = () => { started = true; };
    return archive;
  };

  await assert.rejects(createArchive(root, destination, context, { archiveFactory }), /Interrupted by SIGTERM/);

  assert.equal(started, false);
  assert(context.temporaryPaths.has(destination));
  assert.deepEqual(context.cleanupSync(), []);
});

test('copyAtomically overwrites the destination and leaves no temporary artifact', async (t) => {
  const root = await temporaryRoot(t);
  const { target } = await makeDirectories(root, ['target']);
  const source = path.join(root, 'source.zip');
  const destination = path.join(target, 'backup.zip');
  await fsp.writeFile(source, 'new contents');
  await fsp.writeFile(destination, 'old contents');
  const directory = await directoryDetails(target, 'targetDirectories[0]');
  const context = new OperationContext();

  await copyAtomically(source, { directory, destination }, context);

  assert.equal(await fsp.readFile(destination, 'utf8'), 'new contents');
  assert.equal(context.temporaryPaths.size, 0);
  assert.deepEqual(await fsp.readdir(target), ['backup.zip']);
});

test('copyAtomically tracks partial output after a stream failure for later cleanup', async (t) => {
  const root = await temporaryRoot(t);
  const { target } = await makeDirectories(root, ['target']);
  const directory = await directoryDetails(target, 'targetDirectories[0]');
  const destination = path.join(target, 'backup.zip');
  const context = new OperationContext();
  const createReadStream = () => new Readable({
    read() { this.destroy(new Error('read failed')); },
  });

  await assert.rejects(
    copyAtomically('unused', { directory, destination }, context, { createReadStream }),
    /read failed/,
  );
  assert.equal(context.temporaryPaths.size, 1);
  await assert.rejects(fsp.access(destination), { code: 'ENOENT' });
  assert.deepEqual(context.cleanupSync(), []);
  assert.deepEqual(await fsp.readdir(target), []);
});

test('execute replicates a staging-only archive directly from its temporary path', async (t) => {
  const root = await temporaryRoot(t);
  const { source: sourcePath, output: outputPath, target: targetPath } =
    await makeDirectories(root, ['source', 'output', 'target']);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const target = await directoryDetails(targetPath, 'targetDirectories[0]');
  const destination = path.join(targetPath, 'backup.zip');
  const context = new OperationContext();
  const plan = {
    source,
    output,
    targets: [target],
    archivePath: path.join(outputPath, 'backup.zip'),
    retainArchive: false,
    copyTargets: [{ directory: target, destination }],
  };
  let replicationSource;
  const createReadStream = (sourcePath) => {
    replicationSource = sourcePath;
    return fs.createReadStream(sourcePath);
  };

  await execute(plan, context, {
    archive: { archiveFactory: successfulArchiveFactory() },
    copy: { createReadStream },
  });

  assert.equal(path.dirname(replicationSource), output.canonicalPath);
  assert.match(
    path.basename(replicationSource),
    /^\.backup-archive-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i,
  );
  assert.equal(await fsp.readFile(destination, 'utf8'), 'zip-data');
  assert.deepEqual(await fsp.readdir(outputPath), []);
  assert.equal(context.temporaryPaths.size, 0);
});

test('execute retains the archive, overwrites it atomically, and replicates from it', async (t) => {
  const root = await temporaryRoot(t);
  const { source: sourcePath, output: outputPath, target: targetPath } =
    await makeDirectories(root, ['source', 'output', 'target']);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const target = await directoryDetails(targetPath, 'targetDirectories[0]');
  const archivePath = path.join(outputPath, 'backup.zip');
  const destination = path.join(targetPath, 'backup.zip');
  await fsp.writeFile(archivePath, 'old archive');
  const context = new OperationContext();
  const plan = {
    source,
    output,
    targets: [target],
    archivePath,
    retainArchive: true,
    copyTargets: [{ directory: target, destination }],
  };

  const copied = await execute(plan, context, { archive: { archiveFactory: successfulArchiveFactory() } });

  assert.deepEqual(copied, [destination]);
  assert.equal(await fsp.readFile(archivePath, 'utf8'), 'zip-data');
  assert.equal(await fsp.readFile(destination, 'utf8'), 'zip-data');
  assert.equal(context.temporaryPaths.size, 0);
});

test('execute classifies archive creation failures and leaves cleanup to the context', async (t) => {
  const root = await temporaryRoot(t);
  const { source: sourcePath, output: outputPath } = await makeDirectories(root, ['source', 'output']);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const context = new OperationContext();
  const plan = { source, output, targets: [], archivePath: path.join(outputPath, 'backup.zip'), retainArchive: false, copyTargets: [] };

  await assert.rejects(
    execute(plan, context, { archive: { outputFactory: () => { throw new Error('disk full'); } } }),
    (error) => error.exitCode === EXIT.ARCHIVE && /Failed to create archive.*disk full/.test(error.message),
  );
  assert.equal(context.temporaryPaths.size, 1);
  assert.deepEqual(context.cleanupSync(), []);
});

test('execute classifies copy failures and always removes a staging-only archive', async (t) => {
  const root = await temporaryRoot(t);
  const { source: sourcePath, output: outputPath, target: targetPath } =
    await makeDirectories(root, ['source', 'output', 'target']);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const target = await directoryDetails(targetPath, 'targetDirectories[0]');
  const destination = path.join(targetPath, 'backup.zip');
  const context = new OperationContext();
  const plan = {
    source,
    output,
    targets: [target],
    archivePath: path.join(outputPath, 'backup.zip'),
    retainArchive: false,
    copyTargets: [{ directory: target, destination }],
  };
  const createReadStream = () => new Readable({ read() { this.destroy(new Error('copy read failed')); } });

  await assert.rejects(
    execute(plan, context, {
      archive: { archiveFactory: successfulArchiveFactory() },
      copy: { createReadStream },
    }),
    (error) => error.exitCode === EXIT.COPY && /Failed to copy archive.*copy read failed/.test(error.message),
  );
  assert.deepEqual(await fsp.readdir(outputPath), []);
  assert.equal(context.temporaryPaths.size, 1);
  assert.deepEqual(context.cleanupSync(), []);
});

test('execute preserves a copy failure when staging cleanup also fails', async (t) => {
  const root = await temporaryRoot(t);
  const { source: sourcePath, output: outputPath, target: targetPath } =
    await makeDirectories(root, ['source', 'output', 'target']);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const target = await directoryDetails(targetPath, 'targetDirectories[0]');
  const context = new OperationContext();
  const plan = {
    source,
    output,
    targets: [target],
    archivePath: path.join(outputPath, 'backup.zip'),
    retainArchive: false,
    copyTargets: [{ directory: target, destination: path.join(targetPath, 'backup.zip') }],
  };

  await assert.rejects(
    execute(plan, context, {
      archive: { archiveFactory: successfulArchiveFactory() },
      copy: { createReadStream: () => new Readable({ read() { this.destroy(new Error('copy failed')); } }) },
      removeFile: async () => { throw new Error('cleanup failed'); },
    }),
    (error) => error.exitCode === EXIT.COPY &&
      /Failed to copy archive.*copy failed.*Cleanup also failed.*cleanup failed/.test(error.message),
  );
  assert.equal(context.temporaryPaths.size, 2);
  assert.deepEqual(context.cleanupSync(), []);
});

test('run lock rejects a second active backup and releases cleanly', async (t) => {
  const root = await temporaryRoot(t);
  const lockPath = path.join(root, '.backup-tool.lock');

  const first = await acquireRunLock(lockPath);
  await assert.rejects(acquireRunLock(lockPath), /Another backup run may already be active/);
  assert.deepEqual(first.releaseSync(), []);
  await assert.rejects(fsp.access(lockPath), { code: 'ENOENT' });
});

test('run lock path uses the home directory independently of TMPDIR', () => {
  assert.equal(
    resolveRunLockPath({ TMPDIR: '/different-temporary-directory' }, '/user-owned-home'),
    path.join('/user-owned-home', '.backup-tool.lock'),
  );
});

test('run lock path honors an absolute override and rejects a relative override', () => {
  const absolute = path.resolve('/test-locks', '.backup-tool.lock');
  assert.equal(resolveRunLockPath({ BACKUP_LOCK_PATH: absolute }, '/unused-home'), absolute);
  assert.throws(
    () => resolveRunLockPath({ BACKUP_LOCK_PATH: 'relative.lock' }, '/unused-home'),
    /BACKUP_LOCK_PATH must be an absolute path/,
  );
});

test('resolved singleton lock paths conflict', async (t) => {
  const root = await temporaryRoot(t);
  const lockPath = path.join(root, '.backup-tool.lock');
  const resolved = resolveRunLockPath({ BACKUP_LOCK_PATH: lockPath }, '/unused-home');
  const first = await acquireRunLock(resolved);

  await assert.rejects(acquireRunLock(resolved), /Another backup run may already be active/);
  assert.deepEqual(first.releaseSync(), []);
});

test('run lock leaves stale ownership decisions to the local operator', async (t) => {
  const root = await temporaryRoot(t);
  const lockPath = path.join(root, '.backup-tool.lock');
  const staleOwner = JSON.stringify({
    pid: 99_999_999,
    hostname: os.hostname(),
    token: 'abandoned',
  });
  await fsp.writeFile(lockPath, staleOwner);

  await assert.rejects(acquireRunLock(lockPath), /inspect and remove this stale lock manually/);
  assert.equal(await fsp.readFile(lockPath, 'utf8'), staleOwner);
});

test('run lock release does not delete a lock whose ownership token changed', async (t) => {
  const root = await temporaryRoot(t);
  const lockPath = path.join(root, '.backup-tool.lock');
  const lock = await acquireRunLock(lockPath);
  await fsp.writeFile(lockPath, JSON.stringify({ pid: process.pid, hostname: os.hostname(), token: 'replacement' }));

  assert.deepEqual(lock.releaseSync(), []);
  assert.equal(JSON.parse(await fsp.readFile(lockPath, 'utf8')).token, 'replacement');
});

test('CLI returns usage and validation exit codes with actionable errors', async (t) => {
  const usage = await runCli(t, []);
  assert.equal(usage.exitCode, EXIT.USAGE);
  assert.match(usage.stderr, /Usage:/);
  assert.match(usage.stderr, /Provide exactly one configuration file path/);

  const root = await temporaryRoot(t);
  const invalidConfig = path.join(root, 'invalid.json');
  await fsp.writeFile(invalidConfig, '{}');
  const validation = await runCli(t, [invalidConfig]);
  assert.equal(validation.exitCode, EXIT.VALIDATION);
  assert.match(validation.stderr, /"sourceDirectory" is required/);
});

test('CLI rejects a relative BACKUP_LOCK_PATH before creating a lock', async (t) => {
  const root = await temporaryRoot(t, 'backup-cli-lock-validation-');
  const { source, output } = await makeDirectories(root, ['source', 'output']);
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [output],
  }));

  const result = await runCli(t, [config], {
    input: 'yes\n',
    environment: { BACKUP_LOCK_PATH: 'relative.lock' },
  });

  assert.equal(result.exitCode, EXIT.VALIDATION);
  assert.match(result.stderr, /BACKUP_LOCK_PATH must be an absolute path/);
  assert.deepEqual(await fsp.readdir(output), []);
});

test('CLI cancellation leaves backup directories untouched', async (t) => {
  const root = await temporaryRoot(t, 'backup-cli-cancel-');
  const { source, output, target } = await makeDirectories(root, ['source', 'output', 'target']);
  const existingTemporary = path.join(target, '.backup-copy-00000000-0000-4000-8000-000000000000.tmp');
  await fsp.writeFile(existingTemporary, 'must remain untouched');
  await fsp.writeFile(path.join(target, 'source_Backup_January012025.zip'), '1234567890');
  await fsp.writeFile(path.join(target, 'unrelated.txt'), 'abc');
  const nested = path.join(target, 'nested');
  await fsp.mkdir(nested);
  await fsp.writeFile(path.join(nested, 'contents.txt'), 'hello');
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [target],
  }));

  const result = await runCli(t, [config], { input: 'n\n' });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Targets \(1\)\n-----------\n1\. .*source_Backup_.*\.zip\n   Action             will be created/);
  assert.doesNotMatch(result.stdout, /Existing contents|Matching backups/);
  assert.match(result.stdout, /Proceed\? \[y\/N\] \nCANCELLED — No archive or replicated copy was created\./);
  assert.equal(await fsp.readFile(existingTemporary, 'utf8'), 'must remain untouched');
  assert.deepEqual(await fsp.readdir(output), []);
  assert.deepEqual((await fsp.readdir(target)).sort(), [
    path.basename(existingTemporary),
    'nested',
    'source_Backup_January012025.zip',
    'unrelated.txt',
  ].sort());
});

test('CLI creates a real ZIP, reports completion, and releases its lock', async (t) => {
  const root = await temporaryRoot(t, 'backup-cli-success-');
  const { source } = await makeDirectories(root, ['source']);
  const output = path.join(root, 'new', 'output');
  await fsp.writeFile(path.join(source, 'hello.txt'), 'hello from the backup');
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    sourceDirectory: source,
    outputDirectory: output,
    targetDirectories: [output],
  }));

  const lockPath = path.join(root, '.backup-tool.lock');
  const result = await runCli(t, [config], {
    input: 'yes\n',
    environment: { BACKUP_LOCK_PATH: lockPath },
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Backup preview\n==============/);
  assert.match(result.stdout, /Proceed\? \[y\/N\] \nPreparing backup\.\.\.\nCreating archive\.\.\./);
  assert.match(result.stdout, /0 entries, 0 B read, 0 B written/);
  assert.match(result.stdout, /Archive created\./);
  assert.match(result.stdout, /Backup complete\n===============/);
  assert.match(result.stdout, /Replicated copies \(0\)/);
  const entries = await fsp.readdir(output);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^source_Backup_[A-Z][a-z]+\d{2}\d{4}\.zip$/);
  const archivePath = path.join(output, entries[0]);
  const header = Buffer.alloc(4);
  const handle = await fsp.open(archivePath, 'r');
  await handle.read(header, 0, 4, 0);
  await handle.close();
  assert.equal(header.toString('hex'), '504b0304');
  if (process.platform !== 'win32') assert.equal((await fsp.stat(archivePath)).mode & 0o777, 0o600);
  const extraction = path.join(root, 'extracted');
  await fsp.mkdir(extraction);
  const unzip = spawn('unzip', ['-qq', archivePath, '-d', extraction], { stdio: ['ignore', 'pipe', 'pipe'] });
  let unzipError = '';
  unzip.stderr.setEncoding('utf8');
  unzip.stderr.on('data', (chunk) => { unzipError += chunk; });
  const unzipExit = await new Promise((resolve, reject) => {
    unzip.once('error', reject);
    unzip.once('close', resolve);
  });
  assert.equal(unzipExit, 0, unzipError);
  assert.equal(await fsp.readFile(path.join(extraction, 'hello.txt'), 'utf8'), 'hello from the backup');
  await assert.rejects(fsp.access(lockPath), { code: 'ENOENT' });
});
