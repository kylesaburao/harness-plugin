'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.acquireDirectoryLock = acquireDirectoryLock;
exports.withDirectoryLock = withDirectoryLock;
exports.writeJsonAtomic = writeJsonAtomic;
// Shared persistence mechanics for skill configuration under ~/.harness-plugin/<skill>/.
// Each skill keeps its own error class, codes and recovery wording; this module owns
// the exclusive directory lock (with ownership verification on release) and the
// atomic publication of a configuration document.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
function field(error, key) {
    if (error === null || typeof error !== 'object')
        return undefined;
    const value = error[key];
    return typeof value === 'string' ? value : undefined;
}
function message(error) { return field(error, 'message') ?? String(error); }
// Acquire an exclusive lock directory. Locks are never retried, expired, or stolen.
function acquireDirectoryLock(lockPath, policy) {
    const { error, recovery } = policy;
    try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    }
    catch (failure) {
        throw error(policy.failedCode, `${lockPath}: cannot prepare configuration directory: ${message(failure)}`, recovery);
    }
    try {
        fs.mkdirSync(lockPath);
    }
    catch (failure) {
        if (field(failure, 'code') === 'EEXIST') {
            throw error(policy.busyCode, `${lockPath}: another mutation holds the configuration lock. Retry after it finishes; an interrupted writer requires manual recovery.`, recovery);
        }
        throw error(policy.failedCode, `${lockPath}: cannot acquire configuration lock: ${message(failure)}`, recovery);
    }
    let identity;
    try {
        identity = fs.lstatSync(lockPath);
    }
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
        }
        catch (failure) {
            const state = published === true ? 'configuration was saved; '
                : published === 'unknown' && operationFailure === undefined ? 'operation completed and configuration may already be published; ' : '';
            const previous = operationFailure === undefined ? ''
                : `; operation also failed: ${field(operationFailure, 'code') || 'internal_error'}: ${field(operationFailure, 'condition') || message(operationFailure)}`;
            throw error(policy.cleanupCode, `${lockPath}: ${state}cannot release configuration lock: ${message(failure)}${previous}`, recovery);
        }
    };
}
// Run fn while holding the lock. The release diagnostic cannot know whether fn published.
function withDirectoryLock(lockPath, policy, fn) {
    const release = acquireDirectoryLock(lockPath, policy);
    let result;
    try {
        result = fn();
    }
    catch (failure) {
        release('unknown', failure);
        throw failure;
    }
    release('unknown');
    return result;
}
// Publish text atomically through a uniquely named sibling temporary file. Failures
// throw a plain Error (no condition) after removing the temporary file; callers wrap it.
function writeJsonAtomic(file, text, { mode = 0o666 } = {}) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    let staged = false;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const fd = fs.openSync(temporary, 'wx', mode);
        staged = true;
        try {
            fs.writeFileSync(fd, text);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temporary, file);
    }
    catch (failure) {
        let cleanup = '';
        if (staged) {
            try {
                fs.unlinkSync(temporary);
            }
            catch (unlinkFailure) {
                cleanup = `; temporary cleanup failed at ${temporary}: ${message(unlinkFailure)}`;
            }
        }
        throw Object.assign(new Error(`${message(failure)}${cleanup}`), { cause: failure });
    }
}
