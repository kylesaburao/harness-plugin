"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mediaFailed = mediaFailed;
exports.childDetails = childDetails;
// For existing media commands where stderr is failure evidence, not a universal
// subprocess-success predicate.
function mediaFailed(result) {
    return result.code !== 0 ||
        Boolean(result.signal) ||
        Boolean(result.stderr?.trim());
}
function childDetails(task, result) {
    return {
        task,
        childExitCode: result.code,
        childSignal: result.signal ?? null,
        stderr: result.stderr,
    };
}
