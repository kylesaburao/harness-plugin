"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunError = exports.StartupError = void 0;
exports.fieldsOf = fieldsOf;
exports.subprocessError = subprocessError;
exports.errorDetails = errorDetails;
exports.emitError = emitError;
const media_result_js_1 = require("../../../../shared/node/media-result.js");
function isObject(value) { return value !== null && typeof value === 'object'; }
function fieldsOf(error) { return isObject(error) ? error : {}; }
class StartupError extends Error {
    constructor(code, condition, remedy, details = {}) {
        super(condition);
        Object.assign(this, { code, condition, remedy, exitCode: 2 }, details);
    }
}
exports.StartupError = StartupError;
class RunError extends Error {
    constructor(code, condition, remedy, details = {}) {
        super(condition);
        Object.assign(this, { code, condition, remedy, exitCode: 1 }, details);
    }
}
exports.RunError = RunError;
function subprocessError(code, condition, remedy, task, result) {
    return new RunError(code, condition, remedy, (0, media_result_js_1.childDetails)(task, result));
}
function errorDetails(caught) {
    const error = fieldsOf(caught);
    const payload = { code: error.code || 'unexpected_failure', condition: error.condition || error.message, remedy: error.remedy || 'run the conversion again and inspect the reported failure' };
    for (const key of ['failures', 'task', 'childExitCode', 'childSignal', 'stderr', 'cleanupFailures'])
        if (error[key] !== undefined)
            payload[key] = error[key];
    if (error.cause)
        payload.cause = errorDetails(error.cause);
    return payload;
}
function emitError(error, json = false) {
    const payload = errorDetails(error);
    if (json)
        process.stderr.write(`${JSON.stringify({ error: payload })}\n`);
    else if (Array.isArray(payload.failures)) {
        process.stderr.write(`ERROR [${payload.code}]: ${payload.condition}\n`);
        for (const item of payload.failures) {
            const failure = fieldsOf(item);
            process.stderr.write(`  [${failure.code}] ${failure.condition}\n      Remedy: ${failure.remedy}\n`);
        }
    }
    else
        process.stderr.write(`ERROR [${payload.code}]: ${payload.condition}\nRemedy: ${payload.remedy}\n`);
    if (!json)
        for (const key of ['task', 'childExitCode', 'childSignal', 'stderr', 'cause', 'cleanupFailures'])
            if (payload[key] !== undefined)
                process.stderr.write(`${key}: ${JSON.stringify(payload[key])}\n`);
}
