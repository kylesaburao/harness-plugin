import fs = require('node:fs');
import path = require('node:path');
import childProcess = require('node:child_process');
import { childDetails } from '../../../shared/node/media-result.js';
import { DraftError, spoolStorageError, SIGNAL_EXIT } from './errors.js';
import type { ExtractionSignal } from './errors.js';
import type { ChildProcess } from 'node:child_process';
const { spawn } = childProcess;
const STDERR_TAIL_BYTES = 64 * 1024;

type OwnedChild = ChildProcess & { closed?: Promise<void> };

export interface ProcessOptions {
  stdoutFile?: string;
  progress?: (chunk: string) => void;
  stderrTailBytes?: number;
}
export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}
export interface CapturedResult extends ProcessResult { stdout: string }
export interface SpooledResult extends ProcessResult { stdout?: never }

class ProcessManager {
  declare active: Set<OwnedChild>;
  declare signal: ExtractionSignal | null;
  declare killTimeout: number;
  declare stopped: Promise<void> | null;
  constructor({ killTimeout = 5000 } = {}) { this.active = new Set(); this.signal = null; this.killTimeout = killTimeout; this.stopped = null; }

  assertRunning() {
    if (this.signal) throw new DraftError('interrupted', `interrupted by ${this.signal}`, 'run the command again', SIGNAL_EXIT[this.signal]);
  }

  run(command: string, args: string[], options: ProcessOptions & { stdoutFile: string }): Promise<SpooledResult>;
  run(command: string, args: string[], options?: ProcessOptions & { stdoutFile?: never }): Promise<CapturedResult>;
  async run(command: string, args: string[], options: ProcessOptions = {}): Promise<CapturedResult | SpooledResult> {
    this.assertRunning();
    return new Promise<CapturedResult | SpooledResult>((resolve, reject) => {
      let child: OwnedChild;
      let stdoutFd: number | undefined;
      let closeError: unknown;
      let opening = options.stdoutFile !== undefined;
      try {
        if (options.stdoutFile !== undefined) {
          if (!path.isAbsolute(options.stdoutFile)) throw new Error('stdoutFile must be absolute');
          stdoutFd = fs.openSync(options.stdoutFile, 'wx', 0o600);
        }
        opening = false;
        child = spawn(command, args, { stdio: ['ignore', stdoutFd ?? 'pipe', 'pipe'] });
      } catch (error) {
        reject(opening ? spoolStorageError(options.stdoutFile!, error) : error);
        return;
      } finally {
        if (stdoutFd !== undefined) {
          try { fs.closeSync(stdoutFd); } catch (error) { closeError = error; }
        }
      }
      this.active.add(child);
      child.closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      const stdout: Buffer[] | null = options.stdoutFile === undefined ? [] : null;
      let stderr: Buffer = Buffer.alloc(0);
      let settled = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        if (options.progress) options.progress(chunk.toString());
        else stdout!.push(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr = boundedTail(stderr, chunk, options.stderrTailBytes || STDERR_TAIL_BYTES);
      });
      let launchError: Error | undefined;
      child.once('error', error => { launchError = error; });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        this.active.delete(child);
        if (closeError) { reject(spoolStorageError(options.stdoutFile!, closeError, childDetails(command, { code, signal, stderr: stderr.toString() }))); return; }
        if (launchError) { reject(Object.assign(launchError, { task: command, childExitCode: code, childSignal: signal, stderr: stderr.toString() })); return; }
        resolve({ code, signal, ...(stdout ? { stdout: Buffer.concat(stdout).toString() } : {}), stderr: stderr.toString() });
      });
      if (closeError) child.kill('SIGKILL');
    });
  }

  interrupt(signal: ExtractionSignal) {
    if (this.stopped) return this.stopped;
    this.signal = signal;
    const children = [...this.active];
    for (const child of children) child.kill(signal);
    this.stopped = (async () => {
      const timer = setTimeout(() => {
        for (const child of children) if (this.active.has(child)) child.kill('SIGKILL');
      }, this.killTimeout);
      try { await Promise.all(children.map(child => child.closed)); }
      finally { clearTimeout(timer); }
    })();
    return this.stopped;
  }
}

function boundedTail(previous: Uint8Array, chunk: Uint8Array | string, limit = STDERR_TAIL_BYTES) {
  const combined = Buffer.concat([previous, Buffer.from(chunk)]);
  return combined.length <= limit ? combined : combined.subarray(combined.length - limit);
}

export { ProcessManager, boundedTail };
