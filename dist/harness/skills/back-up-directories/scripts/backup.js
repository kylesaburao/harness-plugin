#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.readAndValidate = exports.backupFilename = exports.assertDirectoryUnchanged = exports.OperationContext = exports.InterruptedError = exports.EXIT = void 0;
exports.copyAtomically = copyAtomically;
exports.cleanupStartupArtifacts = cleanupStartupArtifacts;
exports.acquireRunLock = acquireRunLock;
exports.createArchive = createArchive;
exports.execute = execute;
exports.formatBytes = formatBytes;
exports.resolveRunLockPath = resolveRunLockPath;
exports.shortTempPath = shortTempPath;
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline/promises");
const streamPromises = require("node:stream/promises");
const { pipeline } = streamPromises;
const backup_plan_js_1 = require("./backup-plan.js");
Object.defineProperty(exports, "assertDirectoryUnchanged", { enumerable: true, get: function () { return backup_plan_js_1.assertDirectoryUnchanged; } });
Object.defineProperty(exports, "backupFilename", { enumerable: true, get: function () { return backup_plan_js_1.backupFilename; } });
Object.defineProperty(exports, "readAndValidate", { enumerable: true, get: function () { return backup_plan_js_1.readAndValidate; } });
function isObject(value) {
    return value !== null && typeof value === 'object';
}
function failureDetails(error) {
    const fields = isObject(error) ? error : {};
    return { code: fields.code, condition: fields.condition, remedy: fields.remedy, message: fields.message,
        exitCode: typeof fields.exitCode === 'number' ? fields.exitCode : undefined };
}
function mutableFailure(error) {
    // Native filesystem/stream failures and injected lifecycle errors are objects.
    // Keep that object, including its identity, while adding lifecycle context.
    if (!isObject(error))
        throw error;
    if (error.exitCode !== undefined && typeof error.exitCode !== 'number')
        throw error;
    return error;
}
function hasZipArchive(value) {
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
exports.EXIT = EXIT;
const MINIMUM_NODE = [22, 12, 0];
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
exports.InterruptedError = InterruptedError;
class StartupError extends Error {
    constructor(code, condition, remedy, exitCode = EXIT.USAGE) {
        super(condition);
        this.name = 'StartupError';
        this.code = code;
        this.condition = condition;
        this.remedy = remedy;
        this.exitCode = exitCode;
    }
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
function loadArchiver() {
    const remedy = `npm install --omit=dev --prefix '${path.resolve(__dirname, '..').replaceAll("'", "'\\''")}'`;
    let archiver;
    try {
        archiver = require('archiver');
    }
    catch (error) {
        if (failureDetails(error).code !== 'MODULE_NOT_FOUND') {
            throw new StartupError('dependency_load_failed', `the installed archiver package could not load: ${failureDetails(error).message || String(error)}`, remedy);
        }
        throw new StartupError('dependency_missing', 'the archiver package is not installed, so no ZIP can be written', remedy);
    }
    if (!hasZipArchive(archiver)) {
        throw new StartupError('dependency_missing', 'the installed archiver package does not export ZipArchive, so no ZIP can be written', remedy);
    }
    return (options) => new archiver.ZipArchive(options);
}
function nodeVersionAtLeast(version, minimum) {
    const parts = version.replace(/^v/, '').split('.').map(Number);
    for (let index = 0; index < minimum.length; index += 1) {
        const part = parts[index] || 0;
        if (part > minimum[index])
            return true;
        if (part < minimum[index])
            return false;
    }
    return true;
}
// Environment checks only. Configuration validation stays in readAndValidate.
function checkEnvironment() {
    if (!nodeVersionAtLeast(process.version, MINIMUM_NODE)) {
        throw new StartupError('node_version_unsupported', `Node.js ${MINIMUM_NODE.join('.')} or newer is required, running ${process.version}`, `install Node.js ${MINIMUM_NODE.join('.')} or newer`);
    }
    loadArchiver();
}
let jsonOutput = false;
// The caller knows which failure this is, so it names the code and the remedy.
// Deriving them from exitCode reported archive, copy, and interruption failures
// as usage_error.
function fail(message, exitCode, code = 'run_failed', remedy = 'correct the reported failure and run the same command again') {
    if (jsonOutput) {
        console.error(JSON.stringify({ error: { code, condition: message, remedy } }));
    }
    else {
        console.error(`ERROR [${code}]: ${message}\nRemedy: ${remedy}`);
    }
    process.exitCode = exitCode;
}
function failStartup(caught) {
    const error = failureDetails(caught);
    const nonempty = (value, fallback) => typeof value === 'string' && value.trim() ? value : fallback;
    const code = nonempty(error.code, 'startup_failed');
    const condition = nonempty(error.condition, nonempty(error.message, String(caught)));
    const remedy = nonempty(error.remedy, 'correct the reported startup failure and run the same command again');
    const exitCode = error.exitCode !== undefined && Number.isInteger(error.exitCode)
        && error.exitCode > 0 && error.exitCode <= 255 ? error.exitCode : EXIT.USAGE;
    fail(condition, exitCode, code, remedy);
}
function usage() {
    console.error(`Usage: node scripts/backup.js [OPTIONS] <backup-config.local.json>

Options:
  --preflight   Check the environment and configuration, back nothing up, exit
  --json        Report readiness, completion, and errors as JSON (preview and prompt use stderr)
  -h, --help    Print this message

Exit status: 0 success, 2 or 3 nothing started, 4 or 5 the run failed, 130 interrupted.

--preflight with a configuration file runs the same validation as a real run,
which creates the output directory if it is missing.`);
}
// checkEnvironment has already passed by the time this runs, so the environment
// half of the report is the same every time and only the plan varies.
function reportReady(plan = {}) {
    const details = { status: 'ready', node: process.version, archiver: true, ...plan };
    if (jsonOutput) {
        console.log(JSON.stringify(details));
        return;
    }
    console.log(`READY: Node ${details.node}, archiver installed`);
    if (details.source) {
        console.log(`Source:  ${details.source}`);
        console.log(`Output:  ${details.output}`);
        for (const target of details.targets)
            console.log(`Target:  ${target}`);
        console.log(`Archive: ${details.filename}`);
    }
}
function parseArguments(argv) {
    const options = { configPath: null, preflightOnly: false, json: false, help: false };
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
                    throw new StartupError('usage_error', `unknown option: ${argument}`, 'run with --help to see the accepted arguments');
                }
                positional.push(argument);
        }
    }
    if (positional.length > 1) {
        throw new StartupError('usage_error', 'more than one configuration file path was given', 'pass exactly one configuration file path');
    }
    options.configPath = positional[0] || null;
    return options;
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
    if (unitIndex === 0)
        return `${bytes} B`;
    const hundredths = (bytes * 100n + divisor / 2n) / divisor;
    return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')} ${units[unitIndex]}`;
}
function shortTempPath(directory, kind = 'work') {
    return path.join(directory, `.backup-${kind}-${crypto.randomUUID()}.tmp`);
}
function humanLog(...values) {
    (jsonOutput ? console.error : console.log)(...values);
}
function printPreview(plan) {
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
    }
    else {
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
        if (index < plan.previewTargets.length - 1)
            humanLog('');
    });
}
async function confirmExecution(context) {
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
    }
    finally {
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
                Promise.resolve(handler(this.interruption)).catch(() => { });
            }
            catch { }
            return () => { };
        }
        this.abortHandlers.add(handler);
        return () => this.abortHandlers.delete(handler);
    }
    throwIfInterrupted() {
        if (this.interruption)
            throw this.interruption;
    }
    async interrupt(signal) {
        if (this.interruption)
            return;
        this.interruption = new InterruptedError(signal);
        const handlers = [...this.abortHandlers].map(async (handler) => handler(this.interruption));
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
            }
            catch (error) {
                failures.push({ path: temporaryPath, error });
            }
        }
        return failures;
    }
}
exports.OperationContext = OperationContext;
class RunLock {
    constructor(lockPath, token) {
        this.lockPath = lockPath;
        this.token = token;
        this.held = true;
    }
    releaseSync() {
        if (!this.held)
            return [];
        try {
            const owner = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
            // Preserve the legacy diagnostic for a null lock envelope.
            if (owner === null)
                throw new TypeError("Cannot read properties of null (reading 'token')");
            if (typeof owner === 'object' && 'token' in owner && owner.token === this.token)
                fs.unlinkSync(this.lockPath);
            this.held = false;
            return [];
        }
        catch (error) {
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
    }
    catch (error) {
        if (failureDetails(error).code !== 'EEXIST')
            throw error;
        throw new Error(`Another backup run may already be active (lock: ${lockPath}). ` +
            'If no backup is running, inspect and remove this stale lock manually.');
    }
}
async function cleanupStartupArtifacts(plan) {
    const directories = new Map();
    for (const directory of [plan.output, ...plan.targets])
        directories.set(directory.identity, directory);
    for (const directory of directories.values()) {
        await (0, backup_plan_js_1.assertDirectoryUnchanged)(directory);
        const entries = await fsp.readdir(directory.canonicalPath, { withFileTypes: true });
        const removals = [];
        for (const entry of entries) {
            if (!TEMPORARY_FILE_PATTERN.test(entry.name))
                continue;
            const entryPath = path.join(directory.canonicalPath, entry.name);
            let isFile = entry.isFile();
            if (!isFile && direntTypeIsUnknown(entry)) {
                const details = await fsp.lstat(entryPath);
                isFile = details.isFile();
            }
            if (isFile)
                removals.push(fsp.rm(entryPath, { force: true }));
        }
        await Promise.all(removals);
    }
}
function archiveWarningMessage(error) {
    const details = isObject(error) ? error : {};
    const fields = failureDetails(error);
    const entry = details.path || details.file || details.entry;
    const reason = fields.message || fields.code || 'source content was omitted';
    return `Archiver warning${entry ? ` for ${entry}` : ''}: ${reason}`;
}
function createArchive(sourceDirectory, archivePath, context, dependencies = {}) {
    const archiveFactory = dependencies.archiveFactory || loadArchiver();
    const outputFactory = dependencies.outputFactory || ((file) => fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    const onProgress = dependencies.onProgress;
    const progressIntervalMs = dependencies.progressIntervalMs || 5_000;
    context.track(archivePath);
    return new Promise((resolve, reject) => {
        let output;
        try {
            output = outputFactory(archivePath);
        }
        catch (error) {
            reject(error);
            return;
        }
        let archive;
        try {
            archive = archiveFactory({ zlib: { level: 6 } });
        }
        catch (error) {
            output.once('error', () => { });
            output.once('close', () => reject(error));
            output.destroy();
            return;
        }
        let failure = null;
        let settled = false;
        let finalizationSucceeded = false;
        let outputFinished = output.writableFinished;
        let outputClosed = output.closed;
        let unregister = () => { };
        let progressTimer;
        let progress = { entries: 0, processedBytes: 0, outputBytes: 0 };
        const reportProgress = () => {
            if (!onProgress)
                return;
            try {
                onProgress(progress);
            }
            catch { }
        };
        const updateProgress = (details) => {
            progress = {
                entries: details.entries.processed,
                processedBytes: details.fs.processedBytes,
                outputBytes: typeof archive.pointer === 'function' ? archive.pointer() : 0,
            };
        };
        const settle = () => {
            if (settled)
                return;
            if (!failure && !(finalizationSucceeded && outputFinished && outputClosed))
                return;
            settled = true;
            clearInterval(progressTimer);
            if (!failure)
                reportProgress();
            unregister();
            failure ? reject(failure) : resolve();
        };
        const abort = (error) => {
            if (!failure)
                failure = error;
            try {
                archive.abort();
            }
            catch { }
            if (!output.destroyed)
                output.destroy();
            if (output.closed)
                queueMicrotask(settle);
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
        if (failure)
            return;
        try {
            archive.pipe(output);
            archive.directory(sourceDirectory, false);
            if (onProgress) {
                reportProgress();
                progressTimer = setInterval(reportProgress, progressIntervalMs);
                progressTimer.unref?.();
            }
            Promise.resolve(archive.finalize()).then(() => {
                finalizationSucceeded = true;
                settle();
            }, abort);
        }
        catch (error) {
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
        await (0, backup_plan_js_1.assertDirectoryUnchanged)(target.directory);
        const input = (dependencies.createReadStream || fs.createReadStream)(source);
        const output = (dependencies.createWriteStream || fs.createWriteStream)(temporary, { flags: 'wx', mode: 0o600 });
        await pipeline(input, output, { signal: controller.signal });
        context.throwIfInterrupted();
        await (0, backup_plan_js_1.assertDirectoryUnchanged)(target.directory);
        context.throwIfInterrupted();
        await fsp.rename(temporary, target.destination);
        context.untrack(temporary);
    }
    catch (error) {
        context.throwIfInterrupted();
        throw error;
    }
    finally {
        unregister();
    }
}
async function execute(plan, context, dependencies = {}) {
    const temporaryArchive = shortTempPath(plan.output.canonicalPath, 'archive');
    const removeFile = dependencies.removeFile || fsp.rm;
    const onStage = dependencies.onStage || (() => { });
    let replicationSource = temporaryArchive;
    try {
        context.throwIfInterrupted();
        await (0, backup_plan_js_1.assertDirectoryUnchanged)(plan.source);
        await (0, backup_plan_js_1.assertDirectoryUnchanged)(plan.output);
        onStage({ phase: 'archive-start' });
        await createArchive(plan.source.canonicalPath, temporaryArchive, context, dependencies.archive);
        onStage({ phase: 'archive-complete' });
        context.throwIfInterrupted();
        await (0, backup_plan_js_1.assertDirectoryUnchanged)(plan.source);
        await (0, backup_plan_js_1.assertDirectoryUnchanged)(plan.output);
        if (plan.retainArchive) {
            context.throwIfInterrupted();
            await fsp.rename(temporaryArchive, plan.archivePath);
            context.untrack(temporaryArchive);
            replicationSource = plan.archivePath;
        }
    }
    catch (caught) {
        context.throwIfInterrupted();
        const error = mutableFailure(caught);
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
            }
            catch (caught) {
                context.throwIfInterrupted();
                const error = mutableFailure(caught);
                error.message = `Failed to copy archive to ${target.destination}: ${error.message}`;
                error.exitCode = EXIT.COPY;
                replicationFailure = error;
                throw error;
            }
        }
        return copied;
    }
    catch (error) {
        if (!replicationFailure)
            replicationFailure = mutableFailure(error);
        throw error;
    }
    finally {
        if (!plan.retainArchive) {
            try {
                await removeFile(temporaryArchive, { force: true });
                context.untrack(temporaryArchive);
            }
            catch (caught) {
                const cleanupError = mutableFailure(caught);
                if (replicationFailure) {
                    replicationFailure.message += ` Cleanup also failed for ${temporaryArchive}: ${cleanupError.message}`;
                }
                else {
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
        console.error(`Error: Failed to remove temporary artifact ${failure.path}: ${failureDetails(failure.error).code || failureDetails(failure.error).message}`);
    }
    if (failures.length && !process.exitCode)
        process.exitCode = EXIT.ARCHIVE;
}
async function main() {
    let options;
    try {
        options = parseArguments(process.argv.slice(2));
    }
    catch (error) {
        jsonOutput = process.argv.includes('--json');
        failStartup(error);
        return;
    }
    jsonOutput = options.json;
    if (options.help) {
        usage();
        return;
    }
    if (!options.configPath && !options.preflightOnly) {
        if (!jsonOutput)
            usage();
        fail('Provide exactly one configuration file path.', EXIT.USAGE, 'usage_error', 'run with --help to see the accepted arguments');
        return;
    }
    try {
        checkEnvironment();
    }
    catch (error) {
        failStartup(error);
        return;
    }
    if (!options.configPath) {
        reportReady();
        return;
    }
    let plan;
    let lockPath;
    try {
        lockPath = resolveRunLockPath();
        plan = await (0, backup_plan_js_1.readAndValidate)(path.resolve(options.configPath));
        if (!options.preflightOnly || !jsonOutput)
            printPreview(plan);
    }
    catch (error) {
        fail(failureDetails(error).message, EXIT.VALIDATION, 'config_invalid', 'correct the configuration file, then run --preflight again');
        return;
    }
    if (options.preflightOnly) {
        reportReady({
            source: plan.source.canonicalPath,
            output: plan.output.canonicalPath,
            targets: plan.targets.map((target) => target.canonicalPath),
            filename: plan.filename,
            runLock: lockPath,
            outputDirectoryCreated: plan.output.createdDuringPreflight,
        });
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
            if (jsonOutput)
                console.log(JSON.stringify({ result: { cancelled: true, outputDirectoryCreated: plan.output.createdDuringPreflight ? plan.output.canonicalPath : null } }));
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
            await cleanupStartupArtifacts(plan);
            context.throwIfInterrupted();
        }
        catch (caught) {
            const error = mutableFailure(caught);
            if (!error.exitCode)
                error.exitCode = EXIT.VALIDATION;
            throw error;
        }
        const copied = await execute(plan, context, {
            onStage(status) {
                if (status.phase === 'archive-start')
                    humanLog('Creating archive...');
                if (status.phase === 'archive-complete')
                    humanLog('Archive created.');
                if (status.phase === 'copy-start') {
                    humanLog(`Replicating copy ${status.index + 1} of ${status.total}: ${status.destination}`);
                }
            },
            archive: {
                onProgress(progress) {
                    const entryLabel = progress.entries === 1 ? 'entry' : 'entries';
                    humanLog(`${INDENT_PREFIX}${progress.entries} ${entryLabel}, ` +
                        `${formatBytes(BigInt(progress.processedBytes))} read, ` +
                        `${formatBytes(BigInt(progress.outputBytes))} written`);
                },
            },
        });
        context.throwIfInterrupted();
        if (jsonOutput) {
            const result = {
                source: plan.source.canonicalPath,
                archive: plan.retainArchive ? plan.archivePath : null,
                stagingRemoved: !plan.retainArchive,
                copies: copied,
                bytes: fs.statSync(plan.retainArchive ? plan.archivePath : copied[0]).size,
            };
            console.log(JSON.stringify({ result }));
        }
        else {
            humanLog('\nBackup complete');
            humanLog('===============');
            if (plan.retainArchive) {
                humanLog('');
                humanLog('Archive');
                humanLog(`${INDENT_PREFIX}${plan.archivePath}`);
            }
            else {
                humanLog('');
                humanLog('Staging');
                humanLog(`${INDENT_PREFIX}Removed from ${plan.output.canonicalPath}`);
            }
            humanLog('');
            humanLog(`Replicated copies (${copied.length})`);
            copied.forEach((destination, index) => humanLog(`${INDENT_PREFIX}${index + 1}. ${destination}`));
        }
    }
    catch (error) {
        fail(failureDetails(error).message, failureDetails(error).exitCode || EXIT.ARCHIVE);
    }
    finally {
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
        reportCleanupFailures(context.cleanupSync());
        if (runLock)
            reportCleanupFailures(runLock.releaseSync());
        process.removeListener('exit', onExit);
    }
}
if (require.main === module) {
    main().catch((error) => fail(`Unexpected failure: ${failureDetails(error).message}`, failureDetails(error).exitCode || EXIT.ARCHIVE, 'internal_error'));
}
