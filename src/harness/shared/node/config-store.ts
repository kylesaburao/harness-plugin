'use strict';
// Shared persistence mechanics for skill configuration under ~/.harness-plugin/<skill>/.
// Each skill keeps its own error class, codes and recovery wording; this module owns
// the exclusive directory lock (with ownership verification on release) and the
// atomic publication of a configuration document.
import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');

export type LockErrorFactory = (code: string, condition: string, remedy: string) => Error;
export interface DirectoryLockPolicy {
  busyCode: string;
  failedCode: string;
  cleanupCode: string;
  recovery: string;
  error: LockErrorFactory;
}
// true: the operation published; false: it did not; 'unknown': the caller cannot tell.
export type Publication = boolean | 'unknown';
export type ReleaseDirectoryLock = (published: Publication, operationFailure?: unknown) => void;

function field(error: unknown, key: 'code' | 'condition' | 'message'): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
function message(error: unknown): string { return field(error, 'message') ?? String(error); }

// Acquire an exclusive lock directory. Locks are never retried, expired, or stolen.
export function acquireDirectoryLock(lockPath: string, policy: DirectoryLockPolicy): ReleaseDirectoryLock {
  const { error, recovery } = policy;
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); }
  catch (failure) {
    throw error(policy.failedCode, `${lockPath}: cannot prepare configuration directory: ${message(failure)}`, recovery);
  }
  try { fs.mkdirSync(lockPath); }
  catch (failure) {
    if (field(failure, 'code') === 'EEXIST') {
      throw error(policy.busyCode, `${lockPath}: another mutation holds the configuration lock. Retry after it finishes; an interrupted writer requires manual recovery.`, recovery);
    }
    throw error(policy.failedCode, `${lockPath}: cannot acquire configuration lock: ${message(failure)}`, recovery);
  }
  let identity: fs.Stats;
  try { identity = fs.lstatSync(lockPath); }
  catch (failure) {
    // Without an identity it is unsafe to remove this directory.
    throw error(policy.cleanupCode, `${lockPath}: cannot establish acquired lock ownership: ${message(failure)}`, recovery);
  }
  return (published, operationFailure) => {
    try {
      const current = fs.lstatSync(lockPath);
      if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error('configuration lock ownership changed');
      }
      fs.rmdirSync(lockPath);
    } catch (failure) {
      const state = published === true ? 'configuration was saved; '
        : published === 'unknown' && operationFailure === undefined ? 'operation completed and configuration may already be published; ' : '';
      const previous = operationFailure === undefined ? ''
        : `; operation also failed: ${field(operationFailure, 'code') || 'internal_error'}: ${field(operationFailure, 'condition') || message(operationFailure)}`;
      throw error(policy.cleanupCode, `${lockPath}: ${state}cannot release configuration lock: ${message(failure)}${previous}`, recovery);
    }
  };
}

// Run fn while holding the lock. The release diagnostic cannot know whether fn published.
export function withDirectoryLock<T>(lockPath: string, policy: DirectoryLockPolicy, fn: () => T): T {
  const release = acquireDirectoryLock(lockPath, policy);
  let result: T;
  try { result = fn(); }
  catch (failure) {
    release('unknown', failure);
    throw failure;
  }
  release('unknown');
  return result;
}

// Publish text atomically through a uniquely named sibling temporary file. Failures
// throw a plain Error (no condition) after removing the temporary file; callers wrap it.
export function writeJsonAtomic(file: string, text: string, { mode = 0o666 }: { mode?: number } = {}): void {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let staged = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(temporary, 'wx', mode);
    staged = true;
    try { fs.writeFileSync(fd, text); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } catch (failure) {
    let cleanup = '';
    if (staged) {
      try { fs.unlinkSync(temporary); }
      catch (unlinkFailure) { cleanup = `; temporary cleanup failed at ${temporary}: ${message(unlinkFailure)}`; }
    }
    throw Object.assign(new Error(`${message(failure)}${cleanup}`), { cause: failure });
  }
}
