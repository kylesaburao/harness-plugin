'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

class ProcessManager {
  constructor({ platform = process.platform, killTimeout = 5000 } = {}) {
    this.platform = platform;
    this.killTimeout = killTimeout;
    this.active = new Set();
    this.cancelling = false;
    this.cancelSignal = null;
  }

  spawnOwned(task, command, args, options = {}) {
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
    child.task = task;
    const record = {
      task,
      child,
      pgid: child.pid,
      ownsGroup: (this.platform === 'darwin' || this.platform === 'linux') && Boolean(child.pid),
    };
    child.ownedRecord = record;
    this.active.add(record);
    record.closed = new Promise(resolve => child.once('close', resolve));
    record.gone = record.closed.then(async () => {
      while (this.groupExists(record)) await new Promise(resolve => setTimeout(resolve, 25));
      this.active.delete(record);
    });
    return child;
  }

  async runOwned(task, command, args, options = {}) {
    const opened = [];
    const toStdio = (value, fallback) => {
      if (value === undefined) return fallback;
      if (typeof value === 'number' || ['inherit', 'ignore', 'pipe'].includes(value)) return value;
      if (value && value.path) {
        const fd = fs.openSync(value.path, value.flags || 'r');
        opened.push(fd);
        return fd;
      }
      return value;
    };
    const captureStdout = options.stdout === 'capture';
    const captureStderr = options.stderr === 'capture';
    const stdio = [
      toStdio(options.stdin, 'ignore'),
      captureStdout ? 'pipe' : toStdio(options.stdout, 'ignore'),
      captureStderr ? 'pipe' : toStdio(options.stderr, 'ignore'),
    ];
    let child;
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
    if (captureStdout) child.stdout.on('data', chunk => { stdout += chunk; });
    if (captureStderr) child.stderr.on('data', chunk => { stderr += chunk; });
    let spawnError;
    const result = await new Promise(resolve => {
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    }).finally(() => {
      for (const fd of opened) fs.closeSync(fd);
    });
    await child.ownedRecord.gone;
    if (spawnError) throw spawnError;
    return result;
  }

  async runOldestBounded(items, limit, worker) {
    const pending = new Set();
    const results = [];
    let nextIndex = 0;
    const launch = index => {
      const entry = { index };
      entry.promise = Promise.resolve().then(() => worker(items[index], index)).then(
        value => ({ entry, ok: true, value }),
        error => ({ entry, ok: false, error }),
      );
      pending.add(entry);
    };
    while ((nextIndex < items.length || pending.size) && !this.cancelling) {
      while (nextIndex < items.length && pending.size < limit && !this.cancelling) {
        launch(nextIndex);
        nextIndex += 1;
      }
      if (!pending.size) break;
      const outcome = await Promise.race([...pending].map(entry => entry.promise));
      pending.delete(outcome.entry);
      if (!outcome.ok) {
        try { await this.cancel('SIGTERM'); } catch {}
        await Promise.all([...pending].map(entry => entry.promise));
        throw outcome.error;
      }
      results[outcome.entry.index] = outcome.value;
    }
    if (pending.size) await Promise.all([...pending].map(entry => entry.promise));
    return results;
  }

  signalChild(subject, signal) {
    const record = subject.ownedRecord || subject;
    const child = record.child;
    try {
      if (record.ownsGroup && record.pgid) {
        process.kill(-record.pgid, signal);
      } else if (child.pid) {
        child.kill(signal);
      }
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }

  groupExists(subject) {
    const record = subject.ownedRecord || subject;
    if (!record.ownsGroup || !record.pgid) {
      return this.active.has(record) && record.child.exitCode === null && record.child.signalCode === null;
    }
    try {
      process.kill(-record.pgid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
      throw error;
    }
  }

  async cancel(signal) {
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

  installSignalHandlers(onSignal) {
    const handlers = new Map();
    for (const signal of Object.keys(SIGNAL_EXIT)) {
      const handler = () => {
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
module.exports = { ProcessManager };
