#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { pipeline } = require('node:stream/promises');
const archiver = require('archiver');

const EXIT = Object.freeze({
  USAGE: 2,
  VALIDATION: 3,
  ARCHIVE: 4,
  COPY: 5,
  INTERRUPTED: 130,
});
const MAX_FILENAME_BYTES = 255;
const UUID_V4_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const TEMPORARY_FILE_PATTERN = new RegExp(`^\\.backup-(?:archive|copy)-${UUID_V4_PATTERN}\\.tmp$`, 'i');
const RUN_LOCK_FILENAME = '.backup-tool.lock';
const INDENT_PREFIX = '  ';
const LIST_DETAIL_PREFIX = '   ';

class InterruptedError extends Error {
  constructor(signal = 'SIGINT') {
    super(`Interrupted by ${signal}; temporary-file cleanup was requested.`);
    this.name = 'InterruptedError';
    this.signal = signal;
    this.exitCode = signal === 'SIGTERM' ? 143 : EXIT.INTERRUPTED;
  }
}

function fail(message, exitCode) {
  console.error(`Error: ${message}`);
  process.exitCode = exitCode;
}

function usage() {
  console.error('Usage: node src/backup/backup.js <backup-config.local.json>');
}

function resolveConfigPath(value, configDirectory) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(configDirectory, value);
}

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(parent, child) {
  const relative = path.relative(comparablePath(parent), comparablePath(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function identityOf(details) {
  return `${details.dev}:${details.ino}`;
}

async function validateDirectory(configuredPath, label, accessMode) {
  let canonicalPath;
  let details;
  try {
    canonicalPath = await fsp.realpath(configuredPath);
    details = await fsp.stat(canonicalPath, { bigint: true });
  } catch (error) {
    throw new Error(`${label} does not exist or cannot be accessed: ${configuredPath} (${error.code || error.message})`);
  }
  if (!details.isDirectory()) {
    throw new Error(`${label} must be a directory: ${configuredPath}`);
  }
  try {
    await fsp.access(canonicalPath, accessMode);
  } catch (error) {
    const requirement = accessMode & fs.constants.W_OK && accessMode & fs.constants.R_OK
      ? 'readable, writable, and searchable so stale temporary files can be removed and files can be created and renamed'
      : accessMode & fs.constants.W_OK
        ? 'writable and searchable so files can be created and renamed'
      : 'readable and searchable so its contents can be enumerated';
    throw new Error(`${label} must be ${requirement}: ${configuredPath} (${error.code || error.message})`);
  }
  return {
    label,
    configuredPath,
    canonicalPath,
    identity: identityOf(details),
  };
}

async function inspectProspectiveDirectory(configuredPath, label) {
  try {
    return { exists: true, canonicalPath: await fsp.realpath(configuredPath) };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`${label} cannot be created or accessed: ${configuredPath} (${error.code || error.message})`);
    }
  }

  const missingComponents = [];
  let ancestor = configuredPath;
  while (true) {
    missingComponents.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
    try {
      const canonicalAncestor = await fsp.realpath(ancestor);
      return {
        exists: false,
        canonicalPath: path.join(canonicalAncestor, ...missingComponents),
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`${label} cannot be created or accessed: ${configuredPath} (${error.code || error.message})`);
      }
    }
  }
}

function assertOutputOutsideSource(source, outputPath, configuredPath) {
  if (isWithin(source.canonicalPath, outputPath)) {
    throw new Error(`outputDirectory must not resolve to sourceDirectory or one of its subdirectories: ${configuredPath} -> ${outputPath}`);
  }
}

async function validateOutputDirectory(configuredPath, source) {
  const prospective = await inspectProspectiveDirectory(configuredPath, 'outputDirectory');
  assertOutputOutsideSource(source, prospective.canonicalPath, configuredPath);

  if (prospective.exists) {
    let details;
    try {
      details = await fsp.stat(prospective.canonicalPath);
    } catch (error) {
      throw new Error(`outputDirectory cannot be accessed: ${configuredPath} (${error.code || error.message})`);
    }
    if (!details.isDirectory()) {
      throw new Error(`outputDirectory conflicts with an existing non-directory: ${configuredPath} (EEXIST)`);
    }
  } else {
    try {
      await fsp.mkdir(configuredPath, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new Error(`Cannot create outputDirectory: ${configuredPath} (${error.code || error.message})`);
    }
  }

  const output = await validateDirectory(
    configuredPath,
    'outputDirectory',
    fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
  );
  assertOutputOutsideSource(source, output.canonicalPath, configuredPath);
  return { ...output, createdDuringPreflight: !prospective.exists };
}

async function assertDirectoryUnchanged(directory) {
  let canonicalPath;
  let details;
  try {
    canonicalPath = await fsp.realpath(directory.configuredPath);
    details = await fsp.stat(canonicalPath, { bigint: true });
  } catch (error) {
    throw new Error(`${directory.label} changed or became inaccessible after validation: ${directory.configuredPath} (${error.code || error.message})`);
  }
  if (!details.isDirectory() || comparablePath(canonicalPath) !== comparablePath(directory.canonicalPath) ||
      identityOf(details) !== directory.identity) {
    throw new Error(`${directory.label} no longer identifies the directory validated earlier: ${directory.configuredPath}`);
  }
}

function safeFolderName(folderName) {
  const safe = folderName.replaceAll(' ', '-').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/[. ]+$/g, '');
  return safe || 'Backup';
}

function truncateUtf8(value, maximumBytes) {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function backupFilename(sourceDirectory, now = new Date()) {
  const month = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(now);
  const day = String(now.getDate()).padStart(2, '0');
  const year = String(now.getFullYear());
  const name = safeFolderName(path.basename(sourceDirectory));
  const suffix = `_Backup_${month}${day}${year}.zip`;
  const candidate = `${name}${suffix}`;
  if (Buffer.byteLength(candidate) <= MAX_FILENAME_BYTES) return candidate;

  const digest = crypto.createHash('sha256').update(name).digest('hex').slice(0, 12);
  const marker = `-${digest}`;
  const prefixBudget = MAX_FILENAME_BYTES - Buffer.byteLength(marker) - Buffer.byteLength(suffix);
  return `${truncateUtf8(name, prefixBudget)}${marker}${suffix}`;
}

function direntTypeIsUnknown(entry) {
  return !entry.isFile() &&
    !entry.isDirectory() &&
    !entry.isSymbolicLink() &&
    !entry.isBlockDevice() &&
    !entry.isCharacterDevice() &&
    !entry.isFIFO() &&
    !entry.isSocket();
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let divisor = 1n;
  let unitIndex = 0;
  while (unitIndex < units.length - 1 && bytes >= divisor * 1024n) {
    divisor *= 1024n;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${bytes} B`;
  const hundredths = (bytes * 100n + divisor / 2n) / divisor;
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')} ${units[unitIndex]}`;
}

async function pathKind(destination, label) {
  try {
    const details = await fsp.stat(destination);
    if (details.isDirectory()) throw new Error(`${label} exists but is a directory: ${destination}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readAndValidate(configPath, now = new Date()) {
  let contents;
  try {
    contents = await fsp.readFile(configPath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read configuration file ${configPath}: ${error.code || error.message}`);
  }

  let config;
  try {
    config = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Configuration file contains invalid JSON: ${error.message}`);
  }
  if (!config || Array.isArray(config) || typeof config !== 'object') {
    throw new Error('Configuration must be a JSON object.');
  }
  if (typeof config.sourceDirectory !== 'string' || !config.sourceDirectory.trim()) {
    throw new Error('"sourceDirectory" is required and must be a non-empty string.');
  }
  if (!Array.isArray(config.targetDirectories) || config.targetDirectories.length === 0 ||
      config.targetDirectories.some((directory) => typeof directory !== 'string' || !directory.trim())) {
    throw new Error('"targetDirectories" is required and must be a non-empty array of non-empty strings.');
  }
  if (config.outputDirectory !== undefined && (typeof config.outputDirectory !== 'string' || !config.outputDirectory.trim())) {
    throw new Error('"outputDirectory", when provided, must be a non-empty string.');
  }

  const configDirectory = path.dirname(configPath);
  const sourceConfigured = resolveConfigPath(config.sourceDirectory, configDirectory);
  const outputConfigured = config.outputDirectory
    ? resolveConfigPath(config.outputDirectory, configDirectory)
    : os.tmpdir();
  const targetConfigured = config.targetDirectories.map((directory) => resolveConfigPath(directory, configDirectory));
  const source = await validateDirectory(sourceConfigured, 'sourceDirectory', fs.constants.R_OK | fs.constants.X_OK);
  const output = await validateOutputDirectory(outputConfigured, source);
  const targets = await Promise.all(targetConfigured.map((directory, index) =>
    validateDirectory(directory, `targetDirectories[${index}]`, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK)));

  for (const target of targets) {
    if (isWithin(source.canonicalPath, target.canonicalPath)) {
      throw new Error(`${target.label} must not resolve to sourceDirectory or one of its subdirectories: ${target.configuredPath} -> ${target.canonicalPath}`);
    }
  }

  const filename = backupFilename(source.canonicalPath, now);
  const archivePath = path.join(output.canonicalPath, filename);
  const retainArchive = targets.some((target) => target.identity === output.identity);
  const archiveExists = retainArchive ? await pathKind(archivePath, 'Archive output path') : false;
  const seen = new Map([[output.identity, 'outputDirectory']]);
  const previewTargets = [];
  const copyTargets = [];
  for (const target of targets) {
    const destination = path.join(target.canonicalPath, filename);
    const sharedWith = seen.get(target.identity);
    if (sharedWith) {
      previewTargets.push({ directory: target, destination, action: `shared with ${sharedWith}; no additional copy` });
      continue;
    }
    seen.set(target.identity, target.label);
    const exists = await pathKind(destination, 'Destination');
    const item = { directory: target, destination, action: exists ? 'will be overwritten' : 'will be created' };
    previewTargets.push(item);
    copyTargets.push(item);
  }

  return { source, output, targets, filename, archivePath, archiveExists, retainArchive, previewTargets, copyTargets };
}

function shortTempPath(directory, kind = 'work') {
  return path.join(directory, `.backup-${kind}-${crypto.randomUUID()}.tmp`);
}

function printPreview(plan) {
  console.log('Backup preview');
  console.log('==============');
  console.log('');
  console.log('Source');
  console.log(`${INDENT_PREFIX}${plan.source.canonicalPath}`);
  console.log('');
  console.log('Archive');
  console.log(`${INDENT_PREFIX}Filename    ${plan.filename}`);
  if (plan.retainArchive) {
    console.log(`${INDENT_PREFIX}Destination ${plan.archivePath}`);
    console.log(`${INDENT_PREFIX}Action      ${plan.archiveExists ? 'Overwrite existing file' : 'Create new file'}`);
  } else {
    console.log(`${INDENT_PREFIX}Staging     ${plan.output.canonicalPath}`);
    console.log(`${INDENT_PREFIX}After run   Remove staging archive after replication`);
  }
  console.log('');
  const targetsHeading = `Targets (${plan.previewTargets.length})`;
  console.log(targetsHeading);
  console.log('-'.repeat(targetsHeading.length));
  plan.previewTargets.forEach((target, index) => {
    console.log(`${index + 1}. ${target.destination}`);
    console.log(`${LIST_DETAIL_PREFIX}Action             ${target.action}`);
    if (index < plan.previewTargets.length - 1) console.log('');
  });
}

async function confirmExecution(context) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const unregister = context.onAbort(() => prompt.close());
  try {
    process.stdout.write('\nProceed? [y/N] ');
    for await (const answer of prompt) {
      const response = answer.trim();
      context.throwIfInterrupted();
      return response === 'Y' || response === 'y' || response === 'yes';
    }
    context.throwIfInterrupted();
    return false;
  } finally {
    unregister();
    prompt.close();
  }
}

class OperationContext {
  constructor() {
    this.temporaryPaths = new Set();
    this.abortHandlers = new Set();
    this.interruption = null;
  }

  track(temporaryPath) {
    this.temporaryPaths.add(temporaryPath);
  }

  untrack(temporaryPath) {
    this.temporaryPaths.delete(temporaryPath);
  }

  onAbort(handler) {
    if (this.interruption) {
      try {
        Promise.resolve(handler(this.interruption)).catch(() => {});
      } catch {}
      return () => {};
    }
    this.abortHandlers.add(handler);
    return () => this.abortHandlers.delete(handler);
  }

  throwIfInterrupted() {
    if (this.interruption) throw this.interruption;
  }

  async interrupt(signal) {
    if (this.interruption) return;
    this.interruption = new InterruptedError(signal);
    const handlers = [...this.abortHandlers].map(async (handler) => handler(this.interruption));
    await Promise.allSettled(handlers);
  }

  async cleanup() {
    const paths = [...this.temporaryPaths];
    const results = await Promise.allSettled(paths.map((temporaryPath) => fsp.rm(temporaryPath, { force: true })));
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') this.temporaryPaths.delete(paths[index]);
    });
    return results
      .map((result, index) => result.status === 'rejected' ? { path: paths[index], error: result.reason } : null)
      .filter(Boolean);
  }

  cleanupSync() {
    const failures = [];
    for (const temporaryPath of this.temporaryPaths) {
      try {
        fs.rmSync(temporaryPath, { force: true });
        this.temporaryPaths.delete(temporaryPath);
      } catch (error) {
        failures.push({ path: temporaryPath, error });
      }
    }
    return failures;
  }
}

class RunLock {
  constructor(lockPath, token) {
    this.lockPath = lockPath;
    this.token = token;
    this.held = true;
  }

  async release() {
    if (!this.held) return [];
    try {
      const owner = JSON.parse(await fsp.readFile(this.lockPath, 'utf8'));
      if (owner.token === this.token) await fsp.unlink(this.lockPath);
      this.held = false;
      return [];
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.held = false;
        return [];
      }
      return [{ path: this.lockPath, error }];
    }
  }

  releaseSync() {
    if (!this.held) return [];
    try {
      const owner = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (owner.token === this.token) fs.unlinkSync(this.lockPath);
      this.held = false;
      return [];
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.held = false;
        return [];
      }
      return [{ path: this.lockPath, error }];
    }
  }
}

function resolveRunLockPath(environment = process.env, homeDirectory = os.homedir()) {
  if (environment.BACKUP_LOCK_PATH !== undefined) {
    if (!path.isAbsolute(environment.BACKUP_LOCK_PATH)) {
      throw new Error('BACKUP_LOCK_PATH must be an absolute path.');
    }
    return path.normalize(environment.BACKUP_LOCK_PATH);
  }
  return path.join(homeDirectory, RUN_LOCK_FILENAME);
}

async function acquireRunLock(lockPath = resolveRunLockPath()) {
  const token = crypto.randomUUID();
  const owner = { pid: process.pid, hostname: os.hostname(), token };
  try {
    await fsp.writeFile(lockPath, JSON.stringify(owner), { flag: 'wx' });
    return new RunLock(lockPath, token);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(
      `Another backup run may already be active (lock: ${lockPath}). ` +
      'If no backup is running, inspect and remove this stale lock manually.',
    );
  }
}

async function cleanupStartupArtifacts(plan) {
  const directories = new Map();
  for (const directory of [plan.output, ...plan.targets]) directories.set(directory.identity, directory);

  for (const directory of directories.values()) {
    await assertDirectoryUnchanged(directory);
    const entries = await fsp.readdir(directory.canonicalPath, { withFileTypes: true });
    const removals = [];
    for (const entry of entries) {
      if (!TEMPORARY_FILE_PATTERN.test(entry.name)) continue;
      const entryPath = path.join(directory.canonicalPath, entry.name);
      let isFile = entry.isFile();
      if (!isFile && direntTypeIsUnknown(entry)) {
        const details = await fsp.lstat(entryPath);
        isFile = details.isFile();
      }
      if (isFile) removals.push(fsp.rm(entryPath, { force: true }));
    }
    await Promise.all(removals);
  }
}

function archiveWarningMessage(error) {
  const entry = error.path || error.file || error.entry;
  const reason = error.message || error.code || 'source content was omitted';
  return `Archiver warning${entry ? ` for ${entry}` : ''}: ${reason}`;
}

function createArchive(sourceDirectory, archivePath, context, dependencies = {}) {
  const archiveFactory = dependencies.archiveFactory || archiver;
  const outputFactory = dependencies.outputFactory || ((file) => fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  const onProgress = dependencies.onProgress;
  const progressIntervalMs = dependencies.progressIntervalMs || 5_000;
  context.track(archivePath);
  return new Promise((resolve, reject) => {
    let output;
    try {
      output = outputFactory(archivePath);
    } catch (error) {
      reject(error);
      return;
    }
    let archive;
    try {
      archive = archiveFactory('zip', { zlib: { level: 6 } });
    } catch (error) {
      output.once('error', () => {});
      output.once('close', () => reject(error));
      output.destroy();
      return;
    }
    let failure = null;
    let settled = false;
    let finalizationSucceeded = false;
    let outputFinished = output.writableFinished;
    let outputClosed = output.closed;
    let unregister = () => {};
    let progressTimer;
    let progress = { entries: 0, processedBytes: 0, outputBytes: 0 };

    const reportProgress = () => {
      if (!onProgress) return;
      try {
        onProgress(progress);
      } catch {}
    };
    const updateProgress = (details) => {
      progress = {
        entries: details.entries.processed,
        processedBytes: details.fs.processedBytes,
        outputBytes: typeof archive.pointer === 'function' ? archive.pointer() : 0,
      };
    };

    const settle = () => {
      if (settled) return;
      if (!failure && !(finalizationSucceeded && outputFinished && outputClosed)) return;
      settled = true;
      clearInterval(progressTimer);
      if (!failure) reportProgress();
      unregister();
      failure ? reject(failure) : resolve();
    };
    const abort = (error) => {
      if (!failure) failure = error;
      try { archive.abort(); } catch {}
      if (!output.destroyed) output.destroy();
      if (output.closed) queueMicrotask(settle);
    };
    const onOutputFinish = () => {
      outputFinished = true;
      settle();
    };
    const onOutputClose = () => {
      outputClosed = true;
      if (!outputFinished && !failure) {
        abort(new Error(`Archive output closed before finishing: ${archivePath}`));
        return;
      }
      settle();
    };
    const closed = new Promise((resolveClosed) => output.once('close', resolveClosed));
    output.once('finish', onOutputFinish);
    output.once('close', onOutputClose);
    output.once('error', abort);
    archive.once('error', abort);
    archive.on('warning', (error) => abort(new Error(archiveWarningMessage(error))));
    archive.on('progress', updateProgress);
    unregister = context.onAbort((error) => {
      abort(error);
      return closed;
    });
    if (failure) return;
    try {
      archive.pipe(output);
      archive.directory(sourceDirectory, false);
      if (onProgress) {
        reportProgress();
        progressTimer = setInterval(reportProgress, progressIntervalMs);
        progressTimer.unref?.();
      }
      Promise.resolve(archive.finalize()).then(
        () => {
          finalizationSucceeded = true;
          settle();
        },
        abort,
      );
    } catch (error) {
      abort(error);
    }
  });
}

async function copyAtomically(source, target, context, dependencies = {}) {
  const temporary = shortTempPath(target.directory.canonicalPath, 'copy');
  const controller = new AbortController();
  const unregister = context.onAbort(() => controller.abort());
  context.track(temporary);
  try {
    context.throwIfInterrupted();
    await assertDirectoryUnchanged(target.directory);
    const input = (dependencies.createReadStream || fs.createReadStream)(source);
    const output = (dependencies.createWriteStream || fs.createWriteStream)(temporary, { flags: 'wx', mode: 0o600 });
    await pipeline(input, output, { signal: controller.signal });
    context.throwIfInterrupted();
    await assertDirectoryUnchanged(target.directory);
    context.throwIfInterrupted();
    await fsp.rename(temporary, target.destination);
    context.untrack(temporary);
  } catch (error) {
    context.throwIfInterrupted();
    throw error;
  } finally {
    unregister();
  }
}

async function execute(plan, context, dependencies = {}) {
  const temporaryArchive = shortTempPath(plan.output.canonicalPath, 'archive');
  const removeFile = dependencies.removeFile || fsp.rm;
  const onStage = dependencies.onStage || (() => {});
  let replicationSource = temporaryArchive;
  try {
    context.throwIfInterrupted();
    await assertDirectoryUnchanged(plan.source);
    await assertDirectoryUnchanged(plan.output);
    onStage({ phase: 'archive-start' });
    await createArchive(plan.source.canonicalPath, temporaryArchive, context, dependencies.archive);
    onStage({ phase: 'archive-complete' });
    context.throwIfInterrupted();
    await assertDirectoryUnchanged(plan.source);
    await assertDirectoryUnchanged(plan.output);
    if (plan.retainArchive) {
      context.throwIfInterrupted();
      await fsp.rename(temporaryArchive, plan.archivePath);
      context.untrack(temporaryArchive);
      replicationSource = plan.archivePath;
    }
  } catch (error) {
    context.throwIfInterrupted();
    const archiveLocation = plan.retainArchive ? plan.archivePath : plan.output.canonicalPath;
    error.message = `Failed to create archive in ${archiveLocation}: ${error.message}`;
    error.exitCode = EXIT.ARCHIVE;
    throw error;
  }

  const copied = [];
  let replicationFailure = null;
  try {
    for (const [index, target] of plan.copyTargets.entries()) {
      context.throwIfInterrupted();
      onStage({ phase: 'copy-start', destination: target.destination, index, total: plan.copyTargets.length });
      try {
        await copyAtomically(replicationSource, target, context, dependencies.copy);
        copied.push(target.destination);
      } catch (error) {
        context.throwIfInterrupted();
        error.message = `Failed to copy archive to ${target.destination}: ${error.message}`;
        error.exitCode = EXIT.COPY;
        replicationFailure = error;
        throw error;
      }
    }
    return copied;
  } catch (error) {
    if (!replicationFailure) replicationFailure = error;
    throw error;
  } finally {
    if (!plan.retainArchive) {
      try {
        await removeFile(temporaryArchive, { force: true });
        context.untrack(temporaryArchive);
      } catch (cleanupError) {
        if (replicationFailure) {
          replicationFailure.message += ` Cleanup also failed for ${temporaryArchive}: ${cleanupError.message}`;
        } else {
          cleanupError.message = `Failed to remove staging archive ${temporaryArchive}: ${cleanupError.message}`;
          cleanupError.exitCode = EXIT.ARCHIVE;
          throw cleanupError;
        }
      }
    }
    context.throwIfInterrupted();
  }
}

function reportCleanupFailures(failures) {
  for (const failure of failures) {
    console.error(`Error: Failed to remove temporary artifact ${failure.path}: ${failure.error.code || failure.error.message}`);
  }
  if (failures.length && !process.exitCode) process.exitCode = EXIT.ARCHIVE;
}

function reportCleanupRetries(failures) {
  for (const failure of failures) {
    console.error(`Warning: Asynchronous cleanup failed for ${failure.path}; retrying synchronously: ${failure.error.code || failure.error.message}`);
  }
}

async function main() {
  const argument = process.argv[2];
  if (!argument || process.argv.length !== 3) {
    usage();
    fail('Provide exactly one configuration file path.', EXIT.USAGE);
    return;
  }

  let plan;
  let lockPath;
  try {
    lockPath = resolveRunLockPath();
    plan = await readAndValidate(path.resolve(argument));
    printPreview(plan);
  } catch (error) {
    fail(error.message, EXIT.VALIDATION);
    return;
  }

  const context = new OperationContext();
  let runLock;
  const onSigint = () => { void context.interrupt('SIGINT'); };
  const onSigterm = () => { void context.interrupt('SIGTERM'); };
  const onExit = () => {
    context.cleanupSync();
    runLock?.releaseSync();
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.once('exit', onExit);
  try {
    if (!await confirmExecution(context)) {
      console.log('\nCANCELLED — No archive or replicated copy was created.');
      if (plan.output.createdDuringPreflight) {
        console.log(`Preflight created the output directory: ${plan.output.canonicalPath}`);
      }
      return;
    }
    console.log('\nPreparing backup...');
    try {
      context.throwIfInterrupted();
      runLock = await acquireRunLock(lockPath);
      context.throwIfInterrupted();
      await cleanupStartupArtifacts(plan);
      context.throwIfInterrupted();
    } catch (error) {
      if (!error.exitCode) error.exitCode = EXIT.VALIDATION;
      throw error;
    }
    const copied = await execute(plan, context, {
      onStage(status) {
        if (status.phase === 'archive-start') console.log('Creating archive...');
        if (status.phase === 'archive-complete') console.log('Archive created.');
        if (status.phase === 'copy-start') {
          console.log(`Replicating copy ${status.index + 1} of ${status.total}: ${status.destination}`);
        }
      },
      archive: {
        onProgress(progress) {
          const entryLabel = progress.entries === 1 ? 'entry' : 'entries';
          console.log(
            `${INDENT_PREFIX}${progress.entries} ${entryLabel}, ` +
            `${formatBytes(BigInt(progress.processedBytes))} read, ` +
            `${formatBytes(BigInt(progress.outputBytes))} written`,
          );
        },
      },
    });
    context.throwIfInterrupted();
    console.log('\nBackup complete');
    console.log('===============');
    if (plan.retainArchive) {
      console.log('');
      console.log('Archive');
      console.log(`${INDENT_PREFIX}${plan.archivePath}`);
    } else {
      console.log('');
      console.log('Staging');
      console.log(`${INDENT_PREFIX}Removed from ${plan.output.canonicalPath}`);
    }
    console.log('');
    console.log(`Replicated copies (${copied.length})`);
    copied.forEach((destination, index) => console.log(`${INDENT_PREFIX}${index + 1}. ${destination}`));
  } catch (error) {
    fail(error.message, error.exitCode || EXIT.ARCHIVE);
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    reportCleanupRetries(await context.cleanup());
    reportCleanupFailures(context.cleanupSync());
    if (runLock) {
      reportCleanupRetries(await runLock.release());
      reportCleanupFailures(runLock.releaseSync());
    }
    process.removeListener('exit', onExit);
  }
}

if (require.main === module) {
  main().catch((error) => fail(`Unexpected failure: ${error.message}`, error.exitCode || EXIT.ARCHIVE));
}

module.exports = {
  EXIT,
  InterruptedError,
  OperationContext,
  assertDirectoryUnchanged,
  backupFilename,
  copyAtomically,
  cleanupStartupArtifacts,
  acquireRunLock,
  createArchive,
  execute,
  formatBytes,
  readAndValidate,
  resolveRunLockPath,
  shortTempPath,
};
