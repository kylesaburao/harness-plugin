"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProcessManager = void 0;
exports.boundedTail = boundedTail;
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const media_result_js_1 = require("../../../shared/node/media-result.js");
const errors_js_1 = require("./errors.js");
const { spawn } = childProcess;
const STDERR_TAIL_BYTES = 64 * 1024;
class ProcessManager {
    constructor({ killTimeout = 5000 } = {}) { this.active = new Set(); this.signal = null; this.killTimeout = killTimeout; this.stopped = null; }
    assertRunning() {
        if (this.signal)
            throw new errors_js_1.DraftError('interrupted', `interrupted by ${this.signal}`, 'run the command again', errors_js_1.SIGNAL_EXIT[this.signal]);
    }
    async run(command, args, options = {}) {
        this.assertRunning();
        return new Promise((resolve, reject) => {
            let child;
            let stdoutFd;
            let closeError;
            let opening = options.stdoutFile !== undefined;
            try {
                if (options.stdoutFile !== undefined) {
                    if (!path.isAbsolute(options.stdoutFile))
                        throw new Error('stdoutFile must be absolute');
                    stdoutFd = fs.openSync(options.stdoutFile, 'wx', 0o600);
                }
                opening = false;
                child = spawn(command, args, { stdio: ['ignore', stdoutFd ?? 'pipe', 'pipe'] });
            }
            catch (error) {
                reject(opening ? (0, errors_js_1.spoolStorageError)(options.stdoutFile, error) : error);
                return;
            }
            finally {
                if (stdoutFd !== undefined) {
                    try {
                        fs.closeSync(stdoutFd);
                    }
                    catch (error) {
                        closeError = error;
                    }
                }
            }
            this.active.add(child);
            child.closed = new Promise(resolve => child.once('close', () => resolve()));
            const stdout = options.stdoutFile === undefined ? [] : null;
            let stderr = Buffer.alloc(0);
            let settled = false;
            child.stdout?.on('data', (chunk) => {
                if (options.progress)
                    options.progress(chunk.toString());
                else
                    stdout.push(chunk);
            });
            child.stderr.on('data', (chunk) => {
                stderr = boundedTail(stderr, chunk, options.stderrTailBytes || STDERR_TAIL_BYTES);
            });
            let launchError;
            child.once('error', error => { launchError = error; });
            child.once('close', (code, signal) => {
                if (settled)
                    return;
                settled = true;
                this.active.delete(child);
                if (closeError) {
                    reject((0, errors_js_1.spoolStorageError)(options.stdoutFile, closeError, (0, media_result_js_1.childDetails)(command, { code, signal, stderr: stderr.toString() })));
                    return;
                }
                if (launchError) {
                    reject(Object.assign(launchError, { task: command, childExitCode: code, childSignal: signal, stderr: stderr.toString() }));
                    return;
                }
                resolve({ code, signal, ...(stdout ? { stdout: Buffer.concat(stdout).toString() } : {}), stderr: stderr.toString() });
            });
            if (closeError)
                child.kill('SIGKILL');
        });
    }
    interrupt(signal) {
        if (this.stopped)
            return this.stopped;
        this.signal = signal;
        const children = [...this.active];
        for (const child of children)
            child.kill(signal);
        this.stopped = (async () => {
            const timer = setTimeout(() => {
                for (const child of children)
                    if (this.active.has(child))
                        child.kill('SIGKILL');
            }, this.killTimeout);
            try {
                await Promise.all(children.map(child => child.closed));
            }
            finally {
                clearTimeout(timer);
            }
        })();
        return this.stopped;
    }
}
exports.ProcessManager = ProcessManager;
function boundedTail(previous, chunk, limit = STDERR_TAIL_BYTES) {
    const combined = Buffer.concat([previous, Buffer.from(chunk)]);
    return combined.length <= limit ? combined : combined.subarray(combined.length - limit);
}
