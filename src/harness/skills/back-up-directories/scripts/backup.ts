#!/usr/bin/env node
'use strict';

import fs = require('node:fs');
import fsp = require('node:fs/promises');
import os = require('node:os');
import path = require('node:path');
import crypto = require('node:crypto');
import nodeModule = require('node:module');
const { createRequire } = nodeModule;
import readline = require('node:readline/promises');
import streamPromises = require('node:stream/promises');
const { finished, pipeline } = streamPromises;
import { assertDirectoryUnchanged, backupFilename, readAndValidate } from './backup-plan.js';
import type { BackupPlan, BackupTarget, ValidatedDirectory } from './backup-plan.js';


export interface BackupCliOptions { configPath: string | null; preflightOnly: boolean; json: boolean; help: boolean }
interface Failure { code?: unknown; condition?: unknown; remedy?: unknown; message?: unknown; exitCode?: number | undefined }
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
function failureDetails(error: unknown): Failure {
  const fields = isObject(error) ? error : {};
  return { code: fields.code, condition: fields.condition, remedy: fields.remedy, message: fields.message,
    exitCode: typeof fields.exitCode === 'number' ? fields.exitCode : undefined };
}
function mutableFailure(error: unknown): Failure {
  // Native filesystem/stream failures and injected lifecycle errors are objects.
  // Keep that object, including its identity, while adding lifecycle context.
  if (!isObject(error)) throw error;
  if (error.exitCode !== undefined && typeof error.exitCode !== 'number') throw error;
  return error;
}
interface CleanupFailure { path: string; error: unknown }
interface ArchiveOptions { zlib: { level: number } }
interface ArchiveEntryData { name: string; store?: boolean }
interface ArchiveProgress { entries: number; processedBytes: number; outputBytes: number }
interface ArchiveProgressEvent { entries: { processed: number }; fs: { processedBytes: number } }
interface ArchiveHandle {
  once(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'warning', listener: (error: unknown) => void): unknown;
  on(event: 'progress', listener: (details: ArchiveProgressEvent) => void): unknown;
  pointer?(): number;
  abort(): unknown;
  pipe(output: fs.WriteStream): unknown;
  directory(source: string, destination: false, data: (entry: ArchiveEntryData) => ArchiveEntryData): unknown;
  finalize(): unknown;
}
type ArchiveFactory = (options: ArchiveOptions) => ArchiveHandle;
interface ArchiveDependencies {
  archiveFactory?: ArchiveFactory;
  outputFactory?: (file: string) => fs.WriteStream;
  onProgress?: (progress: ArchiveProgress) => void;
  progressIntervalMs?: number;
}
interface CopyDependencies { createReadStream?: typeof fs.createReadStream; createWriteStream?: typeof fs.createWriteStream }
type BackupStage = { phase: 'archive-start' | 'archive-complete' }
  | { phase: 'copy-start'; destination: string; index: number; total: number }
  | { phase: 'copy-parallel-start'; total: number }
  | { phase: 'copy-complete'; destination: string; index: number; total: number; failed: boolean };
interface ExecutionDependencies {
  archive?: ArchiveDependencies;
  copy?: CopyDependencies;
  removeFile?: typeof fsp.rm;
  onStage?: (status: BackupStage) => void;
}
export interface ArchiveResult { source: string; archive: string | null; stagingRemoved: boolean; copies: string[]; bytes: number }
type ReadyPlan = { source: string; output: string; targets: string[]; filename: string; runLock: string; outputDirectoryCreated: string | null }
  | { source?: never; output?: never; targets?: never; filename?: never };
function hasZipArchive(value: unknown): value is { ZipArchive: new (options: ArchiveOptions) => ArchiveHandle } {
  // The locked archiver package supplies the stream contract. Preserve the
  // existing lazy boundary check, without constructing an archive in preflight.
  return value !== null && typeof value === 'object' && 'ZipArchive' in value && typeof value.ZipArchive === 'function';
}

// Exit status contract, shared with the other scripts in this plugin. Status 0
// is success and 2 or 3 both mean the backup never started, so nothing was
// written. The finer-grained values predate the contract and stay as they are.
const EXIT = Object.freeze({
  USAGE: 2,
  VALIDATION: 3,
  ARCHIVE: 4,
  COPY: 5,
  INTERRUPTED: 130,
});
// Interruption exit status per signal, 128 plus the signal number, matching the
// other scripts in this plugin. SIGINT keeps EXIT.INTERRUPTED.
const SIGNAL_EXIT: Readonly<Record<string, number>> = Object.freeze({ SIGHUP: 129, SIGINT: EXIT.INTERRUPTED, SIGTERM: 143 });
const MINIMUM_NODE = [24, 0, 0];
const UUID_V4_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const TEMPORARY_FILE_PATTERN = new RegExp(`^\\.backup-(?:archive|copy)-${UUID_V4_PATTERN}\\.tmp$`, 'i');
// Earlier releases staged archives (never copies) in the system
// temporary directory. Such a file is removed only once it is old enough that
// no run of an older installed release, which takes a different lock, can
// still be writing it.
const LEGACY_STAGING_PATTERN = new RegExp(`^\\.backup-archive-${UUID_V4_PATTERN}\\.tmp$`, 'i');
const LEGACY_STAGING_MINIMUM_AGE_MS = 24 * 60 * 60 * 1000;
// Per-user Harness state lives under ~/.harness-plugin/<skill>/: the run lock
// and the installed npm dependencies. Neither lives in the installed skill
// directory, which a plugin upgrade replaces.
const USER_STATE_RELATIVE_PATH = path.join('.harness-plugin', 'back-up-directories');
const RUN_LOCK_RELATIVE_PATH = path.join(USER_STATE_RELATIVE_PATH, 'run.lock');
// Entries with these extensions are already compressed, so DEFLATE spends CPU
// for little or no saving. They are written with the STORE method instead.
// Matching is by the final extension, case-insensitively. Fixed policy, not a
// configuration option; references/backup-usage.md lists the same set.
const STORED_EXTENSIONS: ReadonlySet<string> = new Set([
  // Archives and compressed streams.
  '7z', 'br', 'bz2', 'gz', 'lz4', 'rar', 'tgz', 'xz', 'zip', 'zst',
  // Images.
  'avif', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'webp',
  // Audio and video.
  'aac', 'flac', 'm4a', 'm4v', 'mkv', 'mov', 'mp3', 'mp4', 'ogg', 'opus', 'webm',
]);
function storeEntry(name: string): boolean {
  const extension = path.extname(name).slice(1).toLowerCase();
  return extension !== '' && STORED_EXTENSIONS.has(extension);
}
const INDENT_PREFIX = '  ';
const LIST_DETAIL_PREFIX = '   ';

class InterruptedError extends Error {
  declare signal: string;
  declare exitCode: number;
  constructor(signal = 'SIGINT') {
    super(`Interrupted by ${signal}; temporary-file cleanup was requested.`);
    this.name = 'InterruptedError';
    this.signal = signal;
    this.exitCode = SIGNAL_EXIT[signal] ?? EXIT.INTERRUPTED;
  }
}

class StartupError extends Error {
  declare code: string;
  declare condition: string;
  declare remedy: string;
  declare exitCode: number;
  constructor(code: string, condition: string, remedy: string, exitCode: number = EXIT.USAGE) {
    super(condition);
    this.name = 'StartupError';
    this.code = code;
    this.condition = condition;
    this.remedy = remedy;
    this.exitCode = exitCode;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// The dependency is installed from this skill's own manifest and lockfile into
// the user-level state directory, so it survives plugin upgrades and is shared
// by every harness. This is the single install command: the preflight remedy
// prints it with the paths filled in.
function dependencyInstallCommand(dependencyRoot: string): string {
  const skillDirectory = path.resolve(__dirname, '..');
  return `mkdir -p ${shellQuote(dependencyRoot)}`
    + ` && cp ${shellQuote(path.join(skillDirectory, 'package.json'))} ${shellQuote(path.join(skillDirectory, 'package-lock.json'))} ${shellQuote(dependencyRoot)}`
    + ` && npm ci --omit=dev --prefix ${shellQuote(dependencyRoot)}`;
}

// Resolves archiver only from <dependencyRoot>/node_modules. Node's ordinary
// lookup would continue into parent node_modules directories, NODE_PATH, and
// the global folders, so a package found anywhere else counts as missing.
// The request stays the bare 'archiver' so the loader sees the same request
// a plain require would issue.
function requireFromDependencyRoot(dependencyRoot: string): NodeJS.Require | null {
  let modules: string;
  try {
    modules = fs.realpathSync(path.join(dependencyRoot, 'node_modules'));
  } catch (error) {
    const code = failureDetails(error).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  const requireFromRoot = createRequire(path.join(dependencyRoot, 'package.json'));
  let resolved: string;
  try {
    resolved = requireFromRoot.resolve('archiver');
  } catch (error) {
    if (failureDetails(error).code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
  return resolved.startsWith(modules + path.sep) ? requireFromRoot : null;
}

// archiver is the only dependency that needs installing, so it is resolved on
// demand. A top-level require turned a missing install into a MODULE_NOT_FOUND
// stack trace instead of an answerable diagnostic. Repeat calls are free:
// require caches the module itself. archiver is ESM-only as of 8.0.0; Node's
// require(esm) support handles that, but the package no longer has a default
// export, so this wraps its named ZipArchive in the zero-argument factory shape
// createArchive expects. The export is checked here rather than left to the
// wrapper: a resolvable archiver that no longer carries ZipArchive would
// otherwise pass this preflight and fail much later, mid-run, as a bare
// "ZipArchive is not a constructor".
function loadArchiver(homeDirectory = os.homedir()): ArchiveFactory {
  const dependencyRoot = path.join(homeDirectory, USER_STATE_RELATIVE_PATH);
  const remedy = dependencyInstallCommand(dependencyRoot);
  const missing = (condition = `the archiver package is not installed in ${path.join(dependencyRoot, 'node_modules')}, so no ZIP can be written`) =>
    new StartupError('dependency_missing', condition, remedy);
  const loadFailed = (error: unknown) => new StartupError('dependency_load_failed',
    `the installed archiver package could not load: ${failureDetails(error).message || String(error)}`, remedy);
  let archiver: unknown;
  try {
    const requireFromRoot = requireFromDependencyRoot(dependencyRoot);
    if (requireFromRoot === null) throw missing();
    archiver = requireFromRoot('archiver');
  } catch (error) {
    if (error instanceof StartupError) throw error;
    if (failureDetails(error).code !== 'MODULE_NOT_FOUND') throw loadFailed(error);
    throw missing();
  }
  if (!hasZipArchive(archiver)) {
    throw missing('the installed archiver package does not export ZipArchive, so no ZIP can be written');
  }
  return (options) => new archiver.ZipArchive(options);
}

function nodeVersionAtLeast(version: string, minimum: readonly number[]) {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const part = parts[index] || 0;
    if (part > minimum[index]!) return true;
    if (part < minimum[index]!) return false;
  }
  return true;
}

// Environment checks only. Configuration validation stays in readAndValidate.
function checkEnvironment() {
  if (!nodeVersionAtLeast(process.version, MINIMUM_NODE)) {
    throw new StartupError(
      'node_version_unsupported',
      `Node.js ${MINIMUM_NODE.join('.')} or newer is required, running ${process.version}`,
      `install Node.js ${MINIMUM_NODE.join('.')} or newer`,
    );
  }
  loadArchiver();
}

let jsonOutput = false;

// The caller knows which failure this is, so it names the code and the remedy.
// Deriving them from exitCode reported archive, copy, and interruption failures
// as usage_error.
function fail(message: unknown, exitCode: number, code = 'run_failed', remedy = 'correct the reported failure and run the same command again') {
  if (jsonOutput) {
    console.error(JSON.stringify({ error: { code, condition: message, remedy } }));
  } else {
    console.error(`ERROR [${code}]: ${message}\nRemedy: ${remedy}`);
  }
  process.exitCode = exitCode;
}

function failStartup(caught: unknown) {
  const error = failureDetails(caught);
  const nonempty = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() ? value : fallback;
  const code = nonempty(error.code, 'startup_failed');
  const condition = nonempty(error.condition, nonempty(error.message, String(caught)));
  const remedy = nonempty(error.remedy, 'correct the reported startup failure and run the same command again');
  const exitCode = error.exitCode !== undefined && Number.isInteger(error.exitCode)
    && error.exitCode > 0 && error.exitCode <= 255 ? error.exitCode : EXIT.USAGE;
  fail(condition, exitCode, code, remedy);
}

function usage(): string {
  return `Usage: node scripts/backup.js [OPTIONS] <backup-config.local.json>

Options:
  --preflight   Check the environment and configuration, back nothing up, exit
  --json        Report readiness, completion, and errors as JSON (preview and prompt use stderr)
  -h, --help    Print this message

Exit status:
  0         Success, a passed preflight, or a cancelled run
  2 or 3    Nothing started
  4 or 5    The run failed
  129       Interrupted by SIGHUP
  130       Interrupted by SIGINT
  143       Interrupted by SIGTERM

--preflight with a configuration file runs the same validation as a real run,
which creates the output directory if it is missing.
`;
}

// The output directory preflight created for this run, or null when it
// already existed. Both the readiness report and the cancellation report use it.
function createdOutputDirectory(plan: BackupPlan): string | null {
  return plan.output.createdDuringPreflight ? plan.output.canonicalPath : null;
}

// checkEnvironment has already passed by the time this runs, so the environment
// half of the report is the same every time and only the plan varies.
function reportReady(plan: ReadyPlan = {}) {
  const details = { status: 'ready', node: process.version, archiver: true, ...plan };
  if (jsonOutput) {
    console.log(JSON.stringify(details));
    return;
  }
  console.log(`READY: Node ${details.node}, archiver installed`);
  if (details.source) {
    console.log(`Source:  ${details.source}`);
    console.log(`Output:  ${details.output}`);
    for (const target of details.targets) console.log(`Target:  ${target}`);
    console.log(`Archive: ${details.filename}`);
  }
}

function parseArguments(argv: string[]): BackupCliOptions {
  const options: BackupCliOptions = { configPath: null, preflightOnly: false, json: false, help: false };
  const positional = [];

  for (const argument of argv) {
    switch (argument) {
      case '--preflight':
        options.preflightOnly = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        if (argument.startsWith('-')) {
          throw new StartupError(
            'usage_error',
            `unknown option: ${argument}`,
            'run with --help to see the accepted arguments',
          );
        }
        positional.push(argument);
    }
  }

  if (positional.length > 1) {
    throw new StartupError(
      'usage_error',
      'more than one configuration file path was given',
      'pass exactly one configuration file path',
    );
  }
  options.configPath = positional[0] || null;
  return options;
}

function direntTypeIsUnknown(entry: fs.Dirent) {
  return !entry.isFile() &&
    !entry.isDirectory() &&
    !entry.isSymbolicLink() &&
    !entry.isBlockDevice() &&
    !entry.isCharacterDevice() &&
    !entry.isFIFO() &&
    !entry.isSocket();
}

function formatBytes(bytes: bigint) {
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

function shortTempPath(directory: string, kind = 'work') {
  return path.join(directory, `.backup-${kind}-${crypto.randomUUID()}.tmp`);
}

function humanLog(...values: unknown[]) {
  (jsonOutput ? console.error : console.log)(...values);
}

function printPreview(plan: BackupPlan) {
  humanLog('Backup preview');
  humanLog('==============');
  humanLog('');
  humanLog('Source');
  humanLog(`${INDENT_PREFIX}${plan.source.canonicalPath}`);
  humanLog('');
  humanLog('Archive');
  humanLog(`${INDENT_PREFIX}Filename    ${plan.filename}`);
  if (plan.retainArchive) {
    humanLog(`${INDENT_PREFIX}Destination ${plan.archivePath}`);
    humanLog(`${INDENT_PREFIX}Action      ${plan.archiveExists ? 'Overwrite existing file' : 'Create new file'}`);
  } else if (plan.stagingTarget) {
    humanLog(`${INDENT_PREFIX}Staging     ${plan.output.canonicalPath}`);
    humanLog(`${INDENT_PREFIX}After run   Rename staging archive into target 1 after replication`);
  } else {
    humanLog(`${INDENT_PREFIX}Staging     ${plan.output.canonicalPath}`);
    humanLog(`${INDENT_PREFIX}After run   Remove staging archive after replication`);
  }
  humanLog('');
  const targetsHeading = `Targets (${plan.previewTargets.length})`;
  humanLog(targetsHeading);
  humanLog('-'.repeat(targetsHeading.length));
  plan.previewTargets.forEach((target, index) => {
    humanLog(`${index + 1}. ${target.destination}`);
    humanLog(`${LIST_DETAIL_PREFIX}Action             ${target.action}`);
    if (index < plan.previewTargets.length - 1) humanLog('');
  });
}

async function confirmExecution(context: OperationContext) {
  const prompt = readline.createInterface({ input: process.stdin, output: jsonOutput ? process.stderr : process.stdout });
  const unregister = context.onAbort(() => prompt.close());
  try {
    (jsonOutput ? process.stderr : process.stdout).write('\nProceed? [y/N] ');
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

type AbortHandler = (error: InterruptedError) => unknown;
class OperationContext {
  declare temporaryPaths: Set<string>;
  declare abortHandlers: Set<AbortHandler>;
  declare interruption: InterruptedError | null;
  constructor() {
    this.temporaryPaths = new Set();
    this.abortHandlers = new Set();
    this.interruption = null;
  }

  track(temporaryPath: string) {
    this.temporaryPaths.add(temporaryPath);
  }

  untrack(temporaryPath: string) {
    this.temporaryPaths.delete(temporaryPath);
  }

  onAbort(handler: AbortHandler) {
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

  async interrupt(signal: string) {
    if (this.interruption) return;
    this.interruption = new InterruptedError(signal);
    const handlers = [...this.abortHandlers].map(async (handler) => handler(this.interruption!));
    await Promise.allSettled(handlers);
  }

  // Cleanup runs at end of run or from the 'exit' handler, where nothing else is
  // waiting on the event loop, so it is synchronous.
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
  declare lockPath: string;
  declare token: string;
  declare held: boolean;
  constructor(lockPath: string, token: string) {
    this.lockPath = lockPath;
    this.token = token;
    this.held = true;
  }

  releaseSync(): CleanupFailure[] {
    if (!this.held) return [];
    try {
      const owner: unknown = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      // Preserve the legacy diagnostic for a null lock envelope.
      if (owner === null) throw new TypeError("Cannot read properties of null (reading 'token')");
      if (typeof owner === 'object' && 'token' in owner && owner.token === this.token) fs.unlinkSync(this.lockPath);
      this.held = false;
      return [];
    } catch (error) {
      if (failureDetails(error).code === 'ENOENT') {
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
      throw new StartupError(
        'usage_error',
        'BACKUP_LOCK_PATH must be an absolute path.',
        'set BACKUP_LOCK_PATH to an absolute path or unset it to use the default lock location',
      );
    }
    return path.normalize(environment.BACKUP_LOCK_PATH);
  }
  return path.join(homeDirectory, RUN_LOCK_RELATIVE_PATH);
}

async function acquireRunLock(lockPath = resolveRunLockPath()) {
  const token = crypto.randomUUID();
  const owner = { pid: process.pid, hostname: os.hostname(), token };
  const directory = path.dirname(lockPath);
  const unavailable = (error: unknown) => new StartupError(
    'lock_directory_failed',
    `Cannot create the run lock in ${directory}: ${failureDetails(error).code || failureDetails(error).message}.`,
    `make ${directory} a writable directory (or set BACKUP_LOCK_PATH to an absolute path in a writable directory) and run the same command again`,
    EXIT.VALIDATION,
  );
  try {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw unavailable(error);
  }
  try {
    await fsp.writeFile(lockPath, JSON.stringify(owner), { flag: 'wx' });
    return new RunLock(lockPath, token);
  } catch (error) {
    if (failureDetails(error).code !== 'EEXIST') throw unavailable(error);
    throw new Error(
      `Another backup run may already be active (lock: ${lockPath}). ` +
      'If no backup is running, inspect and remove this stale lock manually.',
    );
  }
}

interface StartupCleanupDependencies {
  removeFile?: typeof fsp.rm;
  lstat?: (file: string) => Promise<{ isFile(): boolean; uid: number }>;
  uid?: number | null;
}
const RETAINABLE_CLEANUP_CODES = new Set(['EPERM', 'EACCES']);

// Removes this user's stale temporary artifacts. On POSIX, files owned by
// another user (for example in a shared sticky temporary directory) are
// skipped. A permission failure leaves the file in place and is returned as a
// retained path instead of failing startup; any other failure is raised.
async function cleanupStartupArtifacts(plan: BackupPlan, dependencies: StartupCleanupDependencies = {}): Promise<CleanupFailure[]> {
  const removeFile = dependencies.removeFile || fsp.rm;
  const lstat = dependencies.lstat || ((file: string) => fsp.lstat(file));
  const uid = dependencies.uid !== undefined ? dependencies.uid
    : (typeof process.getuid === 'function' ? process.getuid() : null);
  const directories = new Map<string, ValidatedDirectory>();
  for (const directory of [plan.output, ...plan.targets]) directories.set(directory.identity, directory);

  const retained: CleanupFailure[] = [];
  for (const directory of directories.values()) {
    await assertDirectoryUnchanged(directory);
    const entries = await fsp.readdir(directory.canonicalPath, { withFileTypes: true });
    const candidates: string[] = [];
    for (const entry of entries) {
      if (!TEMPORARY_FILE_PATTERN.test(entry.name)) continue;
      if (!entry.isFile() && !direntTypeIsUnknown(entry)) continue;
      candidates.push(path.join(directory.canonicalPath, entry.name));
    }
    const outcomes = await Promise.allSettled(candidates.map(async (entryPath) => {
      const details = await lstat(entryPath);
      if (!details.isFile()) return;
      if (uid !== null && details.uid !== uid) return;
      await removeFile(entryPath, { force: true });
    }));
    const unexpected: unknown[] = [];
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') return;
      const code = failureDetails(outcome.reason).code;
      if (code === 'ENOENT') return;
      if (typeof code === 'string' && RETAINABLE_CLEANUP_CODES.has(code)) {
        retained.push({ path: candidates[index]!, error: outcome.reason });
      } else {
        unexpected.push(outcome.reason);
      }
    });
    if (unexpected.length) throw unexpected[0];
  }
  return retained;
}

interface LegacyStagingDependencies extends StartupCleanupDependencies {
  tmpdir?: string;
  now?: number;
  lstat?: (file: string) => Promise<{ isFile(): boolean; uid: number; mtimeMs: number }>;
}

// Removes this user's staging archives that older releases left in the system
// temporary directory. The directory is not part of the plan, so nothing here
// fails the run: an unreadable directory is skipped, and a file that cannot be
// inspected or removed is returned as a retained path.
async function cleanupLegacyStaging(plan: BackupPlan, dependencies: LegacyStagingDependencies = {}): Promise<CleanupFailure[]> {
  const removeFile = dependencies.removeFile || fsp.rm;
  const lstat = dependencies.lstat || ((file: string) => fsp.lstat(file));
  const uid = dependencies.uid !== undefined ? dependencies.uid
    : (typeof process.getuid === 'function' ? process.getuid() : null);
  const now = dependencies.now ?? Date.now();
  let directory: string;
  let entries: fs.Dirent[];
  try {
    directory = await fsp.realpath(dependencies.tmpdir ?? os.tmpdir());
    if ([plan.output, ...plan.targets].some((scanned) => scanned.canonicalPath === directory)) return [];
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = entries
    .filter((entry) => LEGACY_STAGING_PATTERN.test(entry.name) && (entry.isFile() || direntTypeIsUnknown(entry)))
    .map((entry) => path.join(directory, entry.name));
  const outcomes = await Promise.allSettled(candidates.map(async (entryPath) => {
    const details = await lstat(entryPath);
    if (!details.isFile()) return;
    if (uid !== null && details.uid !== uid) return;
    if (now - details.mtimeMs < LEGACY_STAGING_MINIMUM_AGE_MS) return;
    await removeFile(entryPath, { force: true });
  }));
  const retained: CleanupFailure[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled' || failureDetails(outcome.reason).code === 'ENOENT') return;
    retained.push({ path: candidates[index]!, error: outcome.reason });
  });
  return retained;
}

function reportRetainedStartupArtifacts(retained: CleanupFailure[]) {
  for (const item of retained) {
    console.error(`Warning: Retained stale temporary artifact ${item.path}: ${failureDetails(item.error).code || failureDetails(item.error).message}`);
  }
}

function archiveWarningMessage(error: unknown) {
  const details = isObject(error) ? error : {};
  const fields = failureDetails(error);
  const entry = details.path || details.file || details.entry;
  const reason = fields.message || fields.code || 'source content was omitted';
  return `Archiver warning${entry ? ` for ${entry}` : ''}: ${reason}`;
}

function createArchive(sourceDirectory: string, archivePath: string, context: OperationContext, dependencies: ArchiveDependencies = {}): Promise<void> {
  const archiveFactory = dependencies.archiveFactory || loadArchiver();
  const outputFactory = dependencies.outputFactory || ((file) => fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  const onProgress = dependencies.onProgress;
  const progressIntervalMs = dependencies.progressIntervalMs || 5_000;
  context.track(archivePath);
  return new Promise<void>((resolve, reject) => {
    let output: fs.WriteStream;
    try {
      output = outputFactory(archivePath);
    } catch (error) {
      reject(error);
      return;
    }
    let archive: ArchiveHandle;
    try {
      archive = archiveFactory({ zlib: { level: 6 } });
    } catch (error) {
      output.once('error', () => {});
      output.once('close', () => reject(error));
      output.destroy();
      return;
    }
    let failure: unknown = null;
    let settled = false;
    let finalizationSucceeded = false;
    let outputFinished = output.writableFinished;
    let outputClosed = output.closed;
    let unregister = () => {};
    let progressTimer: NodeJS.Timeout | undefined;
    let progress = { entries: 0, processedBytes: 0, outputBytes: 0 };

    const reportProgress = () => {
      if (!onProgress) return;
      try {
        onProgress(progress);
      } catch {}
    };
    const updateProgress = (details: ArchiveProgressEvent) => {
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
    const abort = (error: unknown) => {
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
    const closed = new Promise<void>((resolveClosed) => output.once('close', resolveClosed));
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
      archive.directory(sourceDirectory, false, (entry) => {
        if (storeEntry(entry.name)) entry.store = true;
        return entry;
      });
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

async function copyAtomically(source: string, target: BackupTarget, context: OperationContext, dependencies: CopyDependencies = {}) {
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

// The checks copyAtomically makes before its rename, in the same order, for a
// temporary file that is already complete.
async function installCopy(temporary: string, target: BackupTarget, context: OperationContext) {
  context.throwIfInterrupted();
  await assertDirectoryUnchanged(target.directory);
  context.throwIfInterrupted();
  await fsp.rename(temporary, target.destination);
  context.untrack(temporary);
}

function closeOutput(output: fs.WriteStream | null): Promise<void> {
  if (!output || output.closed) return Promise.resolve();
  return new Promise((resolve) => {
    output.once('close', () => resolve());
    output.destroy();
  });
}

interface FanOutCopy { target: BackupTarget; temporary: string; output: fs.WriteStream | null; failure: unknown }

// Copies one file to several targets from a single read stream, writing every
// target in parallel. Each target still gets its own temporary file and
// rename, so each install stays atomic. A failure in one target stops only
// that target; its partial temporary file stays tracked for context cleanup.
// Returns each target's failure, or null when it was installed, in target
// order. Interruption is thrown, not returned.
async function copyToTargets(source: string, targets: BackupTarget[], context: OperationContext, dependencies: CopyDependencies = {}, onSettled: (index: number, failure: unknown) => void = () => {}): Promise<unknown[]> {
  const copies: FanOutCopy[] = targets.map((target) => ({
    target,
    temporary: shortTempPath(target.directory.canonicalPath, 'copy'),
    output: null,
    failure: null,
  }));
  let input: fs.ReadStream | null = null;
  const closeAll = () => Promise.all(copies.map((copy) => closeOutput(copy.output))).then(() => {});
  const unregister = context.onAbort(() => {
    input?.destroy();
    return closeAll();
  });
  const failCopy = (copy: FanOutCopy, error: unknown) => {
    if (copy.failure === null) copy.failure = error;
    copy.output?.destroy();
  };
  const live = () => copies.filter((copy) => copy.failure === null);
  const writeChunk = (copy: FanOutCopy, chunk: unknown) => new Promise<void>((resolve) => {
    copy.output!.write(chunk, (error) => {
      if (error) failCopy(copy, error);
      resolve();
    });
  });
  try {
    context.throwIfInterrupted();
    for (const copy of copies) context.track(copy.temporary);
    await Promise.all(copies.map(async (copy) => {
      try {
        await assertDirectoryUnchanged(copy.target.directory);
        if (context.interruption) return;
        const output = (dependencies.createWriteStream || fs.createWriteStream)(copy.temporary, { flags: 'wx', mode: 0o600 });
        copy.output = output;
        output.on('error', (error) => failCopy(copy, error));
      } catch (error) {
        failCopy(copy, error);
      }
    }));
    context.throwIfInterrupted();
    if (live().length) {
      input = (dependencies.createReadStream || fs.createReadStream)(source);
      try {
        for await (const chunk of input) {
          const writers = live();
          if (!writers.length) break;
          await Promise.all(writers.map((copy) => writeChunk(copy, chunk)));
          context.throwIfInterrupted();
        }
      } catch (error) {
        context.throwIfInterrupted();
        for (const copy of live()) failCopy(copy, error);
      }
      context.throwIfInterrupted();
      await Promise.all(live().map(async (copy) => {
        try {
          copy.output!.end();
          await finished(copy.output!);
        } catch (error) {
          failCopy(copy, error);
        }
      }));
    }
    await closeAll();
    context.throwIfInterrupted();
    await Promise.all(copies.map(async (copy, index) => {
      if (copy.failure === null) {
        try {
          await installCopy(copy.temporary, copy.target, context);
        } catch (error) {
          failCopy(copy, error);
        }
      }
      if (!context.interruption) onSettled(index, copy.failure);
    }));
    context.throwIfInterrupted();
    return copies.map((copy) => copy.failure);
  } catch (error) {
    input?.destroy();
    await closeAll();
    throw error;
  } finally {
    unregister();
  }
}

// One copy-phase error for every failed target, in target order, naming the
// copies that were installed. The first target's failure object carries it.
function copyFailure(targets: BackupTarget[], failures: Map<BackupTarget, unknown>, copied: string[]): Failure {
  const failed = targets.filter((target) => failures.has(target));
  const reasons = failed.map((target) => {
    const failure = failures.get(target);
    const message = failureDetails(failure).message;
    const reason = typeof message === 'string' ? message : String(failure);
    return `Failed to copy archive to ${target.destination}: ${reason.replace(/\.$/, '')}.`;
  });
  const error = mutableFailure(failures.get(failed[0]!));
  const installed = copied.length ? `Installed copies: ${copied.join(', ')}.` : 'No copy was installed.';
  error.message = `${reasons.join(' ')} ${installed}`;
  error.exitCode = EXIT.COPY;
  return error;
}

async function execute(plan: BackupPlan, context: OperationContext, dependencies: ExecutionDependencies = {}): Promise<string[]> {
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
  } catch (caught) {
    context.throwIfInterrupted();
    const error = mutableFailure(caught);
    const archiveLocation = plan.retainArchive ? plan.archivePath : plan.output.canonicalPath;
    error.message = `Failed to create archive in ${archiveLocation}: ${error.message}`;
    error.exitCode = EXIT.ARCHIVE;
    throw error;
  }

  const copied: string[] = [];
  let replicationFailure: Failure | null = null;
  try {
    if (!plan.retainArchive) {
      // Staging-only archive: copy every other target in parallel from one
      // read of the staging file, then publish to the staging target, if any,
      // by renaming the staging file into it.
      const stagingTarget = plan.stagingTarget ?? null;
      const fanOutTargets = plan.copyTargets.filter((target) => target !== stagingTarget);
      context.throwIfInterrupted();
      const total = plan.copyTargets.length;
      const settled = (target: BackupTarget, failure: unknown) => onStage({
        phase: 'copy-complete', destination: target.destination, index: plan.copyTargets.indexOf(target), total, failed: failure !== null,
      });
      onStage({ phase: 'copy-parallel-start', total });
      const failures = new Map<BackupTarget, unknown>();
      if (fanOutTargets.length) {
        const outcomes = await copyToTargets(temporaryArchive, fanOutTargets, context, dependencies.copy,
          (index, failure) => settled(fanOutTargets[index]!, failure));
        fanOutTargets.forEach((target, index) => {
          if (outcomes[index] !== null) failures.set(target, outcomes[index]);
        });
      }
      if (stagingTarget) {
        try {
          await installCopy(temporaryArchive, stagingTarget, context);
          settled(stagingTarget, null);
        } catch (caught) {
          context.throwIfInterrupted();
          failures.set(stagingTarget, caught);
          settled(stagingTarget, caught);
        }
      }
      for (const target of plan.copyTargets) if (!failures.has(target)) copied.push(target.destination);
      if (failures.size) {
        replicationFailure = copyFailure(plan.copyTargets, failures, copied);
        throw replicationFailure;
      }
      return copied;
    }
    // A retained archive is copied to the other targets one at a time.
    for (const [index, target] of plan.copyTargets.entries()) {
      context.throwIfInterrupted();
      onStage({ phase: 'copy-start', destination: target.destination, index, total: plan.copyTargets.length });
      try {
        await copyAtomically(replicationSource, target, context, dependencies.copy);
        copied.push(target.destination);
      } catch (caught) {
        context.throwIfInterrupted();
        const error = mutableFailure(caught);
        error.message = `Failed to copy archive to ${target.destination}: ${error.message}`;
        error.exitCode = EXIT.COPY;
        replicationFailure = error;
        throw error;
      }
    }
    return copied;
  } catch (error) {
    if (!replicationFailure) replicationFailure = mutableFailure(error);
    throw error;
  } finally {
    if (!plan.retainArchive) {
      try {
        await removeFile(temporaryArchive, { force: true });
        context.untrack(temporaryArchive);
      } catch (caught) {
        const cleanupError = mutableFailure(caught);
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

function reportCleanupFailures(failures: CleanupFailure[]) {
  for (const failure of failures) {
    console.error(`Error: Failed to remove temporary artifact ${failure.path}: ${failureDetails(failure.error).code || failureDetails(failure.error).message}`);
  }
  if (failures.length && !process.exitCode) process.exitCode = EXIT.ARCHIVE;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    jsonOutput = process.argv.includes('--json');
    failStartup(error);
    return;
  }
  jsonOutput = options.json;

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  if (!options.configPath && !options.preflightOnly) {
    if (!jsonOutput) process.stderr.write(usage());
    fail(
      'Provide exactly one configuration file path.',
      EXIT.USAGE,
      'usage_error',
      'run with --help to see the accepted arguments',
    );
    return;
  }

  try {
    checkEnvironment();
  } catch (error) {
    failStartup(error);
    return;
  }

  if (!options.configPath) {
    reportReady();
    return;
  }

  let lockPath;
  try {
    lockPath = resolveRunLockPath();
  } catch (error) {
    failStartup(error);
    return;
  }

  let plan;
  try {
    plan = await readAndValidate(path.resolve(options.configPath));
    if (!options.preflightOnly || !jsonOutput) printPreview(plan);
  } catch (error) {
    fail(
      failureDetails(error).message,
      EXIT.VALIDATION,
      'config_invalid',
      'correct the configuration file, then run --preflight again',
    );
    return;
  }

  if (options.preflightOnly) {
    reportReady({
      source: plan.source.canonicalPath,
      output: plan.output.canonicalPath,
      targets: plan.targets.map((target) => target.canonicalPath),
      filename: plan.filename,
      runLock: lockPath,
      outputDirectoryCreated: createdOutputDirectory(plan),
    });
    return;
  }

  const context = new OperationContext();
  let runLock: RunLock | undefined;
  const onSigint = () => { void context.interrupt('SIGINT'); };
  const onSigterm = () => { void context.interrupt('SIGTERM'); };
  const onSighup = () => { void context.interrupt('SIGHUP'); };
  const onExit = () => {
    context.cleanupSync();
    runLock?.releaseSync();
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('SIGHUP', onSighup);
  process.once('exit', onExit);
  try {
    if (!await confirmExecution(context)) {
      if (jsonOutput) console.log(JSON.stringify({ result: { cancelled: true, outputDirectoryCreated: createdOutputDirectory(plan) } }));
      humanLog('\nCANCELLED — No archive or replicated copy was created.');
      if (plan.output.createdDuringPreflight) {
        humanLog(`Preflight created the output directory: ${plan.output.canonicalPath}`);
      }
      return;
    }
    humanLog('\nPreparing backup...');
    try {
      context.throwIfInterrupted();
      runLock = await acquireRunLock(lockPath);
      context.throwIfInterrupted();
      reportRetainedStartupArtifacts(await cleanupStartupArtifacts(plan));
      reportRetainedStartupArtifacts(await cleanupLegacyStaging(plan));
      context.throwIfInterrupted();
    } catch (caught) {
      const error = mutableFailure(caught);
      if (!error.exitCode) error.exitCode = EXIT.VALIDATION;
      throw error;
    }
    const copied = await execute(plan, context, {
      onStage(status) {
        if (status.phase === 'archive-start') humanLog('Creating archive...');
        if (status.phase === 'archive-complete') humanLog('Archive created.');
        if (status.phase === 'copy-start') {
          humanLog(`Replicating copy ${status.index + 1} of ${status.total}: ${status.destination}`);
        }
        if (status.phase === 'copy-parallel-start') humanLog(`Replicating ${status.total} copies in parallel...`);
        if (status.phase === 'copy-complete') {
          humanLog(`Copy ${status.index + 1} of ${status.total} ${status.failed ? 'failed' : 'finished'}: ${status.destination}`);
        }
      },
      archive: {
        onProgress(progress) {
          const entryLabel = progress.entries === 1 ? 'entry' : 'entries';
          humanLog(
            `${INDENT_PREFIX}${progress.entries} ${entryLabel}, ` +
            `${formatBytes(BigInt(progress.processedBytes))} read, ` +
            `${formatBytes(BigInt(progress.outputBytes))} written`,
          );
        },
      },
    });
    context.throwIfInterrupted();
    if (jsonOutput) {
      const result: ArchiveResult = {
        source: plan.source.canonicalPath,
        archive: plan.retainArchive ? plan.archivePath : null,
        stagingRemoved: !plan.retainArchive,
        copies: copied,
        bytes: fs.statSync(plan.retainArchive ? plan.archivePath : copied[0]!).size,
      };
      console.log(JSON.stringify({ result }));
    } else {
      humanLog('\nBackup complete');
      humanLog('===============');
      if (plan.retainArchive) {
        humanLog('');
        humanLog('Archive');
        humanLog(`${INDENT_PREFIX}${plan.archivePath}`);
      } else if (plan.stagingTarget) {
        humanLog('');
        humanLog('Staging');
        humanLog(`${INDENT_PREFIX}Renamed into ${plan.stagingTarget.destination}`);
      } else {
        humanLog('');
        humanLog('Staging');
        humanLog(`${INDENT_PREFIX}Removed from ${plan.output.canonicalPath}`);
      }
      humanLog('');
      humanLog(`Replicated copies (${copied.length})`);
      copied.forEach((destination, index) => humanLog(`${INDENT_PREFIX}${index + 1}. ${destination}`));
    }
  } catch (error) {
    if (error instanceof StartupError) failStartup(error);
    else fail(failureDetails(error).message, failureDetails(error).exitCode || EXIT.ARCHIVE);
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGHUP', onSighup);
    reportCleanupFailures(context.cleanupSync());
    if (runLock) reportCleanupFailures(runLock.releaseSync());
    process.removeListener('exit', onExit);
  }
}

if (require.main === module) {
  main().catch((error) => fail(
    `Unexpected failure: ${failureDetails(error).message}`,
    failureDetails(error).exitCode || EXIT.ARCHIVE,
    'internal_error',
  ));
}

export {
  EXIT,
  InterruptedError,
  OperationContext,
  assertDirectoryUnchanged,
  backupFilename,
  copyAtomically,
  cleanupStartupArtifacts,
  cleanupLegacyStaging,
  acquireRunLock,
  createArchive,
  execute,
  formatBytes,
  readAndValidate,
  resolveRunLockPath,
  shortTempPath,
};
