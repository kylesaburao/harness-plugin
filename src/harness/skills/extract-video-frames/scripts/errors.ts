import path = require('node:path');

export const SIGNAL_EXIT = Object.freeze({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
export type ExtractionSignal = keyof typeof SIGNAL_EXIT;
export const EXIT = Object.freeze({ OK: 0, FAILED: 1, CANNOT_START: 2 });

export class DraftError extends Error {
  declare code: string;
  declare condition: string;
  declare remedy: string;
  declare exitCode: number;
  constructor(code: string, condition: string, remedy: string, exitCode: number = EXIT.CANNOT_START, details: Record<string, unknown> = {}) {
    super(condition);
    Object.assign(this, { code, condition, remedy, exitCode, ...details });
  }
}

export function errorFields(error: unknown): Record<string, unknown> {
  return error !== null && (typeof error === 'object' || typeof error === 'function') ? error as Record<string, unknown> : {};
}

export function errorText(error: unknown): string {
  const message = errorFields(error).message;
  return message ? String(message) : String(error);
}

export function spoolStorageError(filename: string, error: unknown, details: Record<string, unknown> = {}) {
  return new DraftError('frame_metadata_storage_failed', `could not store or read frame metadata at ${filename}: ${errorText(error)}`, `ensure sufficient free space and read/write access in ${path.dirname(filename)}, then run the same command again`, EXIT.CANNOT_START, details);
}
