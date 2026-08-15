'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  OperationContext,
  copyAtomically,
  createArchive,
  execute,
  readAndValidate,
} = require('../../plugins/harness/skills/back-up-directories/scripts/backup.js');

const POSIX_PERMISSIONS = process.platform !== 'win32';
const SCRIPT = path.resolve(__dirname, '../../plugins/harness/skills/back-up-directories/scripts/backup.js');

async function temporaryRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'backup-artifact-policy-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function directoryDetails(directory, label) {
  const canonicalPath = await fsp.realpath(directory);
  const details = await fsp.stat(canonicalPath, { bigint: true });
  return { label, configuredPath: directory, canonicalPath, identity: `${details.dev}:${details.ino}` };
}

function successfulArchiveFactory(contents = 'zip-data') {
  return () => {
    const archive = new EventEmitter();
    archive.pipe = (output) => { archive.output = output; };
    archive.directory = () => {};
    archive.finalize = async () => { archive.output.end(contents); };
    archive.abort = () => archive.output?.destroy();
    return archive;
  };
}

async function runCli(t, config, input, environment = {}) {
  const child = spawn(process.execPath, [SCRIPT, config], {
    env: { ...process.env, ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { exitCode, stdout, stderr };
}

test('new and replacement archives and copies are private on POSIX', { skip: !POSIX_PERMISSIONS }, async (t) => {
  const root = await temporaryRoot(t);
  const sourceDirectory = path.join(root, 'source');
  const targetDirectory = path.join(root, 'target');
  await Promise.all([fsp.mkdir(sourceDirectory), fsp.mkdir(targetDirectory)]);
  const archivePath = path.join(root, 'archive.zip');
  const sourceArchive = path.join(root, 'source.zip');
  const destination = path.join(targetDirectory, 'copy.zip');
  await fsp.writeFile(sourceArchive, 'new copy');
  await fsp.writeFile(destination, 'old copy', { mode: 0o644 });

  const archiveContext = new OperationContext();
  await createArchive(sourceDirectory, archivePath, archiveContext, {
    archiveFactory: successfulArchiveFactory(),
  });
  assert.equal((await fsp.stat(archivePath)).mode & 0o777, 0o600);

  const copyContext = new OperationContext();
  const directory = await directoryDetails(targetDirectory, 'targetDirectories[0]');
  await copyAtomically(sourceArchive, { directory, destination }, copyContext);
  assert.equal((await fsp.stat(destination)).mode & 0o777, 0o600);
});

test('replacing a retained archive installs mode 0600 on POSIX', { skip: !POSIX_PERMISSIONS }, async (t) => {
  const root = await temporaryRoot(t);
  const sourcePath = path.join(root, 'source');
  const outputPath = path.join(root, 'output');
  await Promise.all([fsp.mkdir(sourcePath), fsp.mkdir(outputPath)]);
  const source = await directoryDetails(sourcePath, 'sourceDirectory');
  const output = await directoryDetails(outputPath, 'outputDirectory');
  const archivePath = path.join(outputPath, 'backup.zip');
  await fsp.writeFile(archivePath, 'old archive', { mode: 0o644 });

  await execute({ source, output, targets: [output], archivePath, retainArchive: true, copyTargets: [] }, new OperationContext(), {
    archive: { archiveFactory: successfulArchiveFactory('replacement') },
  });

  assert.equal((await fsp.stat(archivePath)).mode & 0o777, 0o600);
});

test('missing output directories are private and existing output modes are unchanged on POSIX', { skip: !POSIX_PERMISSIONS }, async (t) => {
  const root = await temporaryRoot(t);
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const existing = path.join(root, 'existing');
  const missing = path.join(root, 'missing', 'output');
  await Promise.all([fsp.mkdir(source), fsp.mkdir(target), fsp.mkdir(existing, { mode: 0o755 })]);

  for (const [name, outputDirectory] of [['missing', missing], ['existing', existing]]) {
    const config = path.join(root, `${name}.json`);
    await fsp.writeFile(config, JSON.stringify({ sourceDirectory: source, outputDirectory, targetDirectories: [target] }));
    const plan = await readAndValidate(config);
    assert.equal(plan.output.createdDuringPreflight, name === 'missing');
  }

  assert.equal((await fsp.stat(missing)).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(existing)).mode & 0o777, 0o755);
});

test('archive construction requests DEFLATE level 6', async (t) => {
  const root = await temporaryRoot(t);
  const archivePath = path.join(root, 'archive.zip');
  const context = new OperationContext();
  let options;
  const archiveFactory = (format, suppliedOptions) => {
    assert.equal(format, 'zip');
    options = suppliedOptions;
    return successfulArchiveFactory()();
  };

  await createArchive(root, archivePath, context, { archiveFactory });

  assert.deepEqual(options, { zlib: { level: 6 } });
});

test('cancellation identifies an output directory created during preflight', async (t) => {
  const root = await temporaryRoot(t);
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const output = path.join(root, 'new', 'output');
  await Promise.all([fsp.mkdir(source), fsp.mkdir(target)]);
  const config = path.join(root, 'config.json');
  await fsp.writeFile(config, JSON.stringify({ sourceDirectory: source, outputDirectory: output, targetDirectories: [target] }));

  const result = await runCli(t, config, 'n\n', { BACKUP_LOCK_PATH: path.join(root, '.backup-tool.lock') });
  const canonicalOutput = await fsp.realpath(output);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /CANCELLED — No archive or replicated copy was created\./);
  assert(result.stdout.includes(`Preflight created the output directory: ${canonicalOutput}`));
  assert((await fsp.stat(output)).isDirectory());
  assert.deepEqual(await fsp.readdir(output), []);
});
