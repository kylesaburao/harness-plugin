"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DraftError = exports.EXIT = exports.SIGNAL_EXIT = void 0;
exports.errorFields = errorFields;
exports.errorText = errorText;
exports.spoolStorageError = spoolStorageError;
const path = require("node:path");
exports.SIGNAL_EXIT = Object.freeze({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
exports.EXIT = Object.freeze({ OK: 0, FAILED: 1, CANNOT_START: 2 });
class DraftError extends Error {
    constructor(code, condition, remedy, exitCode = exports.EXIT.CANNOT_START, details = {}) {
        super(condition);
        Object.assign(this, { code, condition, remedy, exitCode, ...details });
    }
}
exports.DraftError = DraftError;
function errorFields(error) {
    return error !== null && (typeof error === 'object' || typeof error === 'function') ? error : {};
}
function errorText(error) {
    const message = errorFields(error).message;
    return message ? String(message) : String(error);
}
function spoolStorageError(filename, error, details = {}) {
    return new DraftError('frame_metadata_storage_failed', `could not store or read frame metadata at ${filename}: ${errorText(error)}`, `ensure sufficient free space and read/write access in ${path.dirname(filename)}, then run the same command again`, exports.EXIT.CANNOT_START, details);
}
