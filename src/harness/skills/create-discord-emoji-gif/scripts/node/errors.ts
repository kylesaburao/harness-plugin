import { childDetails } from '../../../../shared/node/media-result.js';
import type { MediaProcessResult } from '../../../../shared/node/media-result.js';
export interface PreflightFailure { code: string; condition: string; remedy: string }
export interface CleanupFailure { path: string; code: unknown; condition: unknown }
export interface FailureContext {
  json?: boolean;
  failures?: PreflightFailure[];
  task?: string;
  childExitCode?: number | null;
  childSignal?: string | null;
  stderr?: string | undefined;
  cleanupFailures?: CleanupFailure[];
  cause?: unknown;
}
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object'; }
export function fieldsOf(error: unknown): Record<string, unknown> { return isObject(error) ? error : {}; }
export class StartupError extends Error {
  declare code: string; declare condition: string; declare remedy: string; declare exitCode: number;
  constructor(code: string, condition: string, remedy: string, details: FailureContext = {}) {
    super(condition);
    Object.assign(this, { code, condition, remedy, exitCode: 2 }, details);
  }
}
export class RunError extends Error {
  declare code: string; declare condition: string; declare remedy: string; declare exitCode: number;
  constructor(code: string, condition: string, remedy: string, details: FailureContext = {}) {
    super(condition);
    Object.assign(this, { code, condition, remedy, exitCode: 1 }, details);
  }
}

export function subprocessError(code: string, condition: string, remedy: string, task: string, result: MediaProcessResult) {
  return new RunError(code, condition, remedy, childDetails(task, result));
}

export function errorDetails(caught: unknown): Record<string, unknown> {
  const error = fieldsOf(caught);
  const payload: Record<string, unknown> = { code: error.code || 'unexpected_failure', condition: error.condition || error.message, remedy: error.remedy || 'run the conversion again and inspect the reported failure' };
  for (const key of ['failures', 'task', 'childExitCode', 'childSignal', 'stderr', 'cleanupFailures']) if (error[key] !== undefined) payload[key] = error[key];
  if (error.cause) payload.cause = errorDetails(error.cause);
  return payload;
}

export function emitError(error: unknown, json = false) {
  const payload = errorDetails(error);
  if (json) process.stderr.write(`${JSON.stringify({ error: payload })}\n`);
  else if (Array.isArray(payload.failures)) {
    process.stderr.write(`ERROR [${payload.code}]: ${payload.condition}\n`);
    for (const item of payload.failures) { const failure = fieldsOf(item); process.stderr.write(`  [${failure.code}] ${failure.condition}\n      Remedy: ${failure.remedy}\n`); }
  } else process.stderr.write(`ERROR [${payload.code}]: ${payload.condition}\nRemedy: ${payload.remedy}\n`);
  if (!json) for (const key of ['task', 'childExitCode', 'childSignal', 'stderr', 'cause', 'cleanupFailures']) if (payload[key] !== undefined) process.stderr.write(`${key}: ${JSON.stringify(payload[key])}\n`);
}
