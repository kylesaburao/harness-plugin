'use strict';

import fs = require('node:fs');
import Stream = require('node:stream');
import childProcess = require('node:child_process');
const { spawn } = childProcess;

const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
export type InterruptionSignal = keyof typeof SIGNAL_EXIT;
export interface OwnedProcessRecord {
  task: string;
  child: childProcess.ChildProcess;
  pgid: number | undefined;
  ownsGroup: boolean;
  closed?: Promise<number | null>;
  gone?: Promise<void>;
}
export interface OwnedProcessResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
type OwnedChild = childProcess.ChildProcess & { task: string; ownedRecord: OwnedProcessRecord };
type StreamOption = childProcess.IOType | number | Stream | null;
type StdioInput = StreamOption | { path: string; flags?: string };
export interface OwnedRunOptions {
  stdin?: StdioInput;
  stdout?: StdioInput | 'capture';
  stderr?: StdioInput | 'capture';
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}
interface PendingWorker<R> { index: number; promise?: Promise<WorkerOutcome<R>> }
export type WorkerOutcome<R> = { entry: PendingWorker<R> } & ({ ok: true; value: R } | { ok: false; error: unknown });
function errorCode(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

class ProcessManager {
  declare platform: string;
  declare killTimeout: number;
  declare active: Set<OwnedProcessRecord>;
  declare cancelling: boolean;
  declare cancelSignal: NodeJS.Signals | null;
  declare interruptionSignal: InterruptionSignal | undefined;
  constructor({ platform = process.platform, killTimeout = 5000 }: { platform?: string; killTimeout?: number } = {}) {
    this.platform = platform;
    this.killTimeout = killTimeout;
    this.active = new Set();
    this.cancelling = false;
    this.cancelSignal = null;
  }

  spawnOwned(task: string, command: string, args: string[], options: childProcess.SpawnOptions = {}): OwnedChild {
    if (this.cancelling) {
      throw Object.assign(new Error(`cannot start ${task}, cancellation is in progress`), {
        code: 'cancelled',
      });
    }
    const child = spawn(command, args, {
      ...options,
      shell: false,
      detached: this.platform === 'darwin' || this.platform === 'linux',
    });
    const tasked = Object.assign(child, { task });
    const record: OwnedProcessRecord = {
      task,
      child,
      pgid: child.pid,
      ownsGroup: (this.platform === 'darwin' || this.platform === 'linux') && Boolean(child.pid),
    };
    const owned = Object.assign(tasked, { ownedRecord: record });
    this.active.add(record);
    record.closed = new Promise<number | null>(resolve => child.once('close', resolve));
    record.gone = record.closed.then(async () => {
      while (this.groupExists(record)) await new Promise(resolve => setTimeout(resolve, 25));
      this.active.delete(record);
    });
    return owned;
  }

  async runOwned(task: string, command: string, args: string[], options: OwnedRunOptions = {}): Promise<OwnedProcessResult> {
    const opened: number[] = [];
    const toStdio = (value: StdioInput | undefined, fallback: childProcess.IOType): StreamOption => {
      if (value === undefined) return fallback;
      if (typeof value === 'number' || value === 'inherit' || value === 'ignore' || value === 'pipe') return value;
      if (value && typeof value === 'object' && 'path' in value) {
        const fd = fs.openSync(value.path, value.flags || 'r');
        opened.push(fd);
        return fd;
      }
      return value;
    };
    const captureStdout = options.stdout === 'capture';
    const captureStderr = options.stderr === 'capture';
    const stdio: childProcess.StdioOptions = [
      toStdio(options.stdin, 'ignore'),
      options.stdout === 'capture' ? 'pipe' : toStdio(options.stdout, 'ignore'),
      options.stderr === 'capture' ? 'pipe' : toStdio(options.stderr, 'ignore'),
    ];
    let child: OwnedChild;
    try {
      child = this.spawnOwned(task, command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio,
      });
    } catch (error) {
      for (const fd of opened) fs.closeSync(fd);
      throw error;
    }
    let stdout = '';
    let stderr = '';
    if (captureStdout) child.stdout!.on('data', chunk => { stdout += chunk; });
    if (captureStderr) child.stderr!.on('data', chunk => { stderr += chunk; });
    let spawnError: Error | undefined;
    const result = await new Promise<OwnedProcessResult>(resolve => {
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    }).finally(() => {
      for (const fd of opened) fs.closeSync(fd);
    });
    await child.ownedRecord.gone;
    if (spawnError) throw Object.assign(spawnError, { task, childExitCode: result.code, childSignal: result.signal });
    return result;
  }

  async runOldestBounded<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => R | Promise<R>): Promise<R[]> {
    const pending = new Set<PendingWorker<R>>();
    const results: R[] = [];
    let nextIndex = 0;
    const launch = (index: number) => {
      const entry: PendingWorker<R> = { index };
      entry.promise = Promise.resolve().then(() => worker(items[index]!, index)).then(
        value => ({ entry, ok: true as const, value }),
        error => ({ entry, ok: false as const, error }),
      );
      pending.add(entry);
    };
    while ((nextIndex < items.length || pending.size) && !this.cancelling) {
      while (nextIndex < items.length && pending.size < limit && !this.cancelling) {
        launch(nextIndex);
        nextIndex += 1;
      }
      if (!pending.size) break;
      const outcome = await Promise.race([...pending].map(entry => entry.promise!));
      pending.delete(outcome.entry);
      if (!outcome.ok) {
        try { await this.cancel('SIGTERM'); } catch {}
        await Promise.all([...pending].map(entry => entry.promise!));
        throw outcome.error;
      }
      results[outcome.entry.index] = outcome.value;
    }
    if (pending.size) await Promise.all([...pending].map(entry => entry.promise!));
    return results;
  }

  signalChild(subject: OwnedChild | OwnedProcessRecord, signal: NodeJS.Signals) {
    const record = 'ownedRecord' in subject ? subject.ownedRecord : subject;
    const child = record.child;
    try {
      if (record.ownsGroup && record.pgid) {
        process.kill(-record.pgid, signal);
      } else if (child.pid) {
        child.kill(signal);
      }
    } catch (error) { if (errorCode(error) !== 'ESRCH') throw error; }
  }

  groupExists(subject: OwnedChild | OwnedProcessRecord) {
    const record = 'ownedRecord' in subject ? subject.ownedRecord : subject;
    if (!record.ownsGroup || !record.pgid) {
      return this.active.has(record) && record.child.exitCode === null && record.child.signalCode === null;
    }
    try {
      process.kill(-record.pgid, 0);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return false;
      if (errorCode(error) === 'EPERM') return true;
      throw error;
    }
  }

  async cancel(signal: NodeJS.Signals) {
    if (!this.cancelling) {
      this.cancelling = true;
      this.cancelSignal = signal;
    }
    const groups = [...this.active];
    for (const group of groups) this.signalChild(group, signal);
    if (groups.length) {
      const deadline = Date.now() + this.killTimeout;
      while (Date.now() < deadline && groups.some(group => this.groupExists(group))) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      for (const group of groups) {
        if (this.groupExists(group)) {
          this.signalChild(group, 'SIGKILL');
        }
      }
      await Promise.all(groups.map(group => group.gone));
    }
  }

  installSignalHandlers(onSignal: (signal: InterruptionSignal, exitCode: number, error?: unknown) => void) {
    const handlers = new Map<InterruptionSignal, () => void>();
    for (const signal of Object.keys(SIGNAL_EXIT) as InterruptionSignal[]) {
      const handler = () => {
        this.interruptionSignal ||= signal;
        if (this.cancelling) return;
        this.cancel(signal).then(() => onSignal(signal, SIGNAL_EXIT[signal]), error => {
          onSignal(signal, SIGNAL_EXIT[signal], error);
        });
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    return () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
  }
}

// POSIX descendants remain owned only while they stay in the spawned process group.
// A descendant that deliberately starts a new session cannot be reaped portably here.
export { ProcessManager };
