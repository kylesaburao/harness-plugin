'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.emitError = exports.publishVerified = exports.verifyFinalGif = exports.sha256File = exports.checkGifsiclePreflight = exports.checkGifskiPreflight = exports.platformPolicy = exports.RunError = exports.StartupError = exports.errorDetails = exports.subprocessError = exports.durationTolerance = exports.mediaFailed = exports.requireReadyCommands = exports.fieldsOf = void 0;
exports.referenceFrameCount = referenceFrameCount;
exports.parseArguments = parseArguments;
exports.validateNodeVersion = validateNodeVersion;
exports.readConfiguration = readConfiguration;
exports.validateInput = validateInput;
exports.inspectInput = inspectInput;
exports.validateOutput = validateOutput;
exports.parseVmafScore = parseVmafScore;
exports.scoreCandidate = scoreCandidate;
exports.createCandidateScorer = createCandidateScorer;
exports.cleanupArtifacts = cleanupArtifacts;
exports.emitWarnings = emitWarnings;
exports.emitPreflightReady = emitPreflightReady;
exports.resultPayload = resultPayload;
exports.emitResult = emitResult;
exports.preflightError = preflightError;
exports.usage = usage;
const errors = require("./errors.js");
const { StartupError, RunError, subprocessError, errorDetails, emitError, fieldsOf } = errors;
exports.StartupError = StartupError;
exports.RunError = RunError;
exports.subprocessError = subprocessError;
exports.errorDetails = errorDetails;
exports.emitError = emitError;
exports.fieldsOf = fieldsOf;
const preflight = require("./preflight.js");
const { platformPolicy, checkGifskiPreflight, checkGifsiclePreflight, requireReadyCommands } = preflight;
exports.platformPolicy = platformPolicy;
exports.checkGifskiPreflight = checkGifskiPreflight;
exports.checkGifsiclePreflight = checkGifsiclePreflight;
exports.requireReadyCommands = requireReadyCommands;
const verification = require("./verification.js");
const { durationTolerance, sha256File, probeValue, verifyFinalGif, publishVerified } = verification;
exports.durationTolerance = durationTolerance;
exports.sha256File = sha256File;
exports.verifyFinalGif = verifyFinalGif;
exports.publishVerified = publishVerified;
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mediaResult = require("../../../../shared/node/media-result.js");
const { mediaFailed, childDetails } = mediaResult;
exports.mediaFailed = mediaFailed;
const MAX_EXACT_INTEGER = 9007199254740991n;
function parseArguments(argv, basename = 'mov-to-gif.js') {
    const positional = [];
    let preflight = false;
    let json = false;
    let help = false;
    let positionalOnly = false;
    for (const value of argv) {
        if (positionalOnly)
            positional.push(value);
        else if (value === '--')
            positionalOnly = true;
        else if (value === '--preflight')
            preflight = true;
        else if (value === '--json')
            json = true;
        else if (value === '-h' || value === '--help')
            help = true;
        else if (value.startsWith('-'))
            throw new StartupError('usage_error', `unknown option: ${value}`, 'run with --help to see the accepted options', { json });
        else
            positional.push(value);
    }
    if (help)
        return { help, json, preflight, positional };
    if (preflight && positional.length > 1)
        throw new StartupError('usage_error', '--preflight accepts at most one INPUT_VIDEO', 'run --preflight alone or pass one input video', { json });
    if (!preflight && (positional.length < 1 || positional.length > 2)) {
        throw new StartupError('usage_error', 'expected INPUT_VIDEO and an optional OUTPUT.gif', `run: ${basename} INPUT_VIDEO [OUTPUT.gif]`, { json });
    }
    return { help, json, preflight, positional };
}
function validateNodeVersion(version = process.versions.node) {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!match || Number(match[1]) < 22)
        throw new StartupError('node_version_unsupported', `Node.js 22.0.0 or newer is required, got ${version}`, 'install Node.js 22.0.0 or newer');
}
function positive(env, name, fallback) {
    const value = env[name];
    const raw = value === undefined || value === '' ? String(fallback) : value;
    if (!/^[1-9][0-9]*$/.test(raw) || BigInt(raw) > MAX_EXACT_INTEGER)
        throw new StartupError('config_invalid', `${name} must be a positive integer no greater than ${MAX_EXACT_INTEGER}, got '${raw}'`, `unset ${name} to take the default, or set it to a positive integer`);
    return Number(raw);
}
function defaultJobs() { return Math.max(1, os.availableParallelism() - 2); }
function readConfiguration(env, backend) {
    const common = {
        maxBytes: positive(env, 'MAX_BYTES', 256000),
        gifSize: positive(env, 'GIF_SIZE', 128),
        minFps: positive(env, 'MIN_FPS', 15),
        maxFps: positive(env, 'MAX_FPS', 24),
        jobs: positive(env, 'JOBS', defaultJobs()),
        keepWork: env.KEEP_WORK === '1',
    };
    if (common.minFps > common.maxFps)
        throw new StartupError('config_invalid', `MIN_FPS (${common.minFps}) must not exceed MAX_FPS (${common.maxFps})`, 'set MIN_FPS at or below MAX_FPS, or unset both to take the defaults');
    if (backend === 'gifski') {
        const config = Object.assign(common, { minQuality: positive(env, 'MIN_QUALITY', 1), maxQuality: positive(env, 'MAX_QUALITY', 100) });
        for (const [name, value] of [['MIN_QUALITY', config.minQuality], ['MAX_QUALITY', config.maxQuality]]) {
            if (value > 100)
                throw new StartupError('config_invalid', `${name} must be between 1 and 100, got '${value}'`, `set ${name} to an integer from 1 through 100`);
        }
        if (config.maxFps > 100)
            throw new StartupError('config_invalid', `MAX_FPS (${config.maxFps}) must not exceed 100, gifski's maximum frame rate`, 'set MAX_FPS to 100 or lower, or use mov-to-gif.js for higher frame rates');
        if (config.minQuality > config.maxQuality)
            throw new StartupError('config_invalid', `MIN_QUALITY (${config.minQuality}) must not exceed MAX_QUALITY (${config.maxQuality})`, 'set MIN_QUALITY at or below MAX_QUALITY, or unset both to take the defaults');
        return config;
    }
    return common;
}
function validateInput(input) {
    try {
        if (!fs.statSync(input).isFile())
            throw new Error();
    }
    catch {
        throw new StartupError('input_unusable', `input is not a regular file: ${input}`, 'pass the path of an existing video file');
    }
}
async function inspectInput(manager, commands, input) {
    const inputPath = path.resolve(input);
    const stream = await manager.runOwned('input-stream', commands.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', inputPath], { stdout: 'capture', stderr: 'capture' });
    if (mediaFailed(stream))
        throw new StartupError('input_unusable', `ffprobe could not read input video: ${input}`, 'confirm the file is a video ffmpeg can decode', childDetails('input-stream', stream));
    if (!stream.stdout.trim())
        throw new StartupError('input_unusable', `input contains no video stream: ${input}`, 'pass a file that contains video, not audio or still images only');
    const decode = await manager.runOwned('input-decode', commands.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-threads', '1', '-filter_threads', '1', '-i', inputPath, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-f', 'null', '-'], { stderr: 'capture' });
    if (mediaFailed(decode))
        throw new StartupError('input_unusable', `input video does not have a decodable first frame: ${input}`, 'the file is truncated or corrupt, re-export it and try again', childDetails('input-decode', decode));
    const durationResult = await manager.runOwned('input-duration', commands.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', inputPath], { stdout: 'capture', stderr: 'capture' });
    const duration = durationResult.stdout.trim();
    if (mediaFailed(durationResult) || !/^[0-9]+(?:\.[0-9]+)?$/.test(duration) || Number(duration) <= 0)
        throw new StartupError('input_unusable', `ffprobe could not read a valid input duration: ${input}`, 'confirm the file is a complete video with a positive duration', childDetails('input-duration', durationResult));
    return Number(duration) > 3 ? [{ code: 'input_duration_long', condition: `input duration is ${duration}s, which is longer than 3 seconds`, recommendation: 'trim the clip to 3 seconds or less for better quality' }] : [];
}
function validateOutput(input, requested, size) {
    const parsed = path.parse(input);
    const output = requested || path.join(parsed.dir, `${parsed.name}_${size}x${size}.gif`);
    try {
        if (fs.existsSync(output) && fs.realpathSync(input) === fs.realpathSync(output))
            throw new StartupError('output_unusable', 'input and output paths must differ', 'pass an output path that is not the input file');
    }
    catch (error) {
        if (error instanceof StartupError)
            throw error;
    }
    if (fs.existsSync(output) && fs.statSync(output).isDirectory())
        throw new StartupError('output_unusable', `output path is a directory: ${output}`, 'pass a file path ending in .gif, not a directory');
    const directory = path.dirname(output);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory())
        throw new StartupError('output_unusable', `output directory does not exist: ${directory}`, `create it first: mkdir -p '${directory}'`);
    try {
        fs.accessSync(directory, fs.constants.W_OK);
    }
    catch {
        throw new StartupError('output_unusable', `output directory is not writable: ${directory}`, 'choose an output path in a writable directory');
    }
    return { output, outputDir: directory };
}
function parseVmafScore(text) {
    let report;
    try {
        report = JSON.parse(text);
    }
    catch { }
    const envelope = fieldsOf(report);
    const mean = fieldsOf(fieldsOf(envelope.pooled_metrics).vmaf).mean;
    if (!Array.isArray(envelope.frames) || !envelope.frames.length || typeof mean !== 'number' || !Number.isFinite(mean)) {
        throw new RunError('vmaf_nonnumeric', 'VMAF did not return a valid nonempty JSON score report', 'reinstall an ffmpeg build with a working libvmaf filter');
    }
    return { score: mean.toFixed(6), frames: envelope.frames.length };
}
async function referenceFrameCount(state) {
    const result = await state.manager.runOwned('reference-frames', state.commands.ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', path.join(state.workDir, 'vmaf-reference.mkv')], { stdout: 'capture', stderr: 'capture' });
    if (mediaFailed(result))
        throw subprocessError('reference_failed', 'could not decode the completed VMAF reference', 'fix the reported ffprobe error, then run again', 'reference-frames', result);
    const frames = Number(result.stdout.trim());
    if (!Number.isSafeInteger(frames) || frames <= 0)
        throw new RunError('reference_failed', 'VMAF reference has no valid decoded frame count', 'use an input with at least one frame at 24 FPS', childDetails('reference-frames', result));
    return frames;
}
async function scoreCandidate(manager, commands, workDir, candidate, task, referenceFrames, candidateFps, keepWork = false) {
    // libvmaf 3.2.0's integer ADM reads outside its buffers at 32x32.
    // Enlarge only the scoring inputs so all four ADM stages have sufficient pixels.
    const scoringFilters = "fps=24,setpts=PTS-STARTPTS,scale=w='max(iw,64)':h='max(ih,64)':flags=lanczos";
    const logName = `vmaf-${crypto.randomUUID()}.json`;
    const logPath = path.join(workDir, logName);
    try {
        const result = await manager.runOwned(`${task}-vmaf`, commands.ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-threads', '1', '-filter_complex_threads', '1', '-i', path.resolve(workDir, 'vmaf-reference.mkv'), '-i', path.resolve(candidate), '-lavfi', `[0:v]${scoringFilters}[ref];[1:v]${scoringFilters}[dist];[dist][ref]libvmaf=n_threads=1:log_fmt=json:log_path=${logName}`, '-f', 'null', '-'], { stderr: 'capture', cwd: workDir });
        if (mediaFailed(result))
            throw subprocessError('vmaf_failed', `VMAF scoring failed for ${task}: ${result.stderr.trim()}`, 'fix the reported ffmpeg libvmaf error, then run the same conversion again', task, result);
        let text;
        try {
            text = fs.readFileSync(logPath, 'utf8');
        }
        catch {
            text = '';
        }
        let report;
        try {
            report = parseVmafScore(text);
        }
        catch (error) {
            if (error === null || typeof error !== 'object')
                throw error;
            throw Object.assign(error, childDetails(task, result));
        }
        if (!Number.isSafeInteger(referenceFrames) || referenceFrames <= 0 || !Number.isFinite(candidateFps) || candidateFps <= 0 || Math.abs(report.frames - referenceFrames) > Math.ceil(24 * durationTolerance(candidateFps))) {
            throw new RunError('vmaf_failed', `VMAF coverage differs from the reference: scored ${report.frames} frames, reference ${referenceFrames}`, 'use a candidate that covers the complete reference clip', childDetails(task, result));
        }
        const duration = await probeValue(manager, commands.ffprobe, `${task} duration`, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', candidate], 'vmaf_failed');
        if (!Number.isFinite(Number(duration)) || Number(duration) <= 0 || Math.abs(Number(duration) - referenceFrames / 24) > durationTolerance(candidateFps)) {
            throw new RunError('vmaf_failed', `candidate duration ${duration}s differs from reference ${referenceFrames / 24}s`, 'use a candidate that covers the complete reference clip', childDetails(task, result));
        }
        return report.score;
    }
    finally {
        if (!keepWork)
            fs.rmSync(logPath, { force: true });
    }
}
// One fixed reference/scoring context per conversion. Store promises before yielding
// so concurrent identical candidates share work without retaining candidate files.
function createCandidateScorer(state) {
    const { manager, workDir, referenceFrames } = state;
    const commands = { ...state.commands };
    const keepWork = state.config.keepWork;
    const scores = new Map();
    const checkCancellation = () => {
        if (manager.cancelling)
            throw new RunError('cancelled', 'candidate scoring was cancelled', 'run the conversion again');
    };
    return async (candidate, task, candidateFps, digest) => {
        checkCancellation();
        const key = JSON.stringify([candidateFps, digest]);
        let pending = keepWork ? undefined : scores.get(key);
        if (!pending) {
            pending = scoreCandidate(manager, commands, workDir, candidate, task, referenceFrames, candidateFps, keepWork);
            if (!keepWork) {
                scores.set(key, pending);
                pending.catch(() => { if (scores.get(key) === pending)
                    scores.delete(key); });
            }
        }
        const score = await pending;
        checkCancellation();
        return score;
    };
}
function cleanupArtifacts({ workDir, outputTemp, config }) {
    const failures = [];
    for (const target of [outputTemp, config.keepWork ? null : workDir].filter((value) => Boolean(value))) {
        try {
            fs.rmSync(target, { recursive: true, force: true });
        }
        catch (error) {
            failures.push({ path: target, code: fieldsOf(error).code, condition: fieldsOf(error).message });
        }
    }
    if (workDir && fs.existsSync(workDir) && config.keepWork)
        process.stderr.write(`Kept work directory: ${workDir}\n`);
    return failures;
}
function emitWarnings(warnings, json) {
    if (!warnings.length)
        return;
    if (json)
        process.stderr.write(`${JSON.stringify({ warnings })}\n`);
    else
        for (const warning of warnings)
            process.stderr.write(`WARNING [${warning.code}]: ${warning.condition}\nRecommendation: ${warning.recommendation}\n`);
}
function emitPreflightReady(state, warnings, json) {
    if (json)
        process.stdout.write(`${JSON.stringify({ status: 'ready', os: state.policy.os, commands: state.commands, warnings })}\n`);
    else {
        process.stdout.write(`READY: ${state.policy.os}\n`);
        for (const [name, command] of Object.entries(state.commands))
            process.stdout.write(`${name}: ${command}\n`);
        for (const warning of warnings)
            process.stdout.write(`WARNING [${warning.code}]: ${warning.condition}\nRecommendation: ${warning.recommendation}\n`);
    }
}
function formatParameters(parameters) {
    if ('quality' in parameters)
        return `quality ${parameters.quality}, motion quality ${parameters.motionQuality}, lossy quality ${parameters.lossyQuality}`;
    return `${parameters.colors} colors, dither ${parameters.dither}`;
}
function resultPayload({ script, backend, input, output, config, winner, verified }) {
    const parameters = backend === 'gifski'
        ? { quality: winner.quality, motionQuality: winner.motionQuality, lossyQuality: winner.lossyQuality }
        : { colors: winner.colors, dither: winner.dither };
    const selected = backend === 'gifski'
        ? `${winner.fps} FPS, quality ${winner.quality}, motion quality ${winner.motionQuality}, lossy quality ${winner.lossyQuality}, VMAF ${winner.score}`
        : `${winner.fps} FPS, ${winner.colors} colors, dither ${winner.dither}, VMAF ${winner.score}`;
    const checks = [
        { name: 'codec is gif', status: 'pass' },
        { name: `dimensions are ${verified.dimensions}`, status: 'pass' },
        { name: `${verified.frameCount} frames`, status: 'pass' },
        { name: 'duration is positive', status: 'pass' },
        { name: 'duration agrees with the decoded reference', status: 'pass' },
        { name: `${verified.bytes} bytes is below the ${config.maxBytes} limit`, status: 'pass' },
        { name: 'sha256 matches after publication', status: 'pass' },
        { name: `loop is ${verified.loop.mode} (${verified.loop.extension}, repetition count ${verified.loop.repeatCount})`, status: 'pass' },
    ];
    return {
        status: 'verified',
        script,
        backend,
        input,
        output,
        dimensions: verified.dimensions,
        width: config.gifSize,
        height: config.gifSize,
        frames: verified.frameCount,
        durationSeconds: verified.duration,
        fps: winner.fps,
        bytes: verified.bytes,
        maxBytes: config.maxBytes,
        headroomBytes: config.maxBytes - verified.bytes,
        loop: verified.loop.mode,
        vmaf: winner.score,
        sha256: verified.digest,
        parameters,
        selected,
        checks,
    };
}
function emitResult(payload, json = false) {
    if (json) {
        process.stdout.write(`${JSON.stringify({ result: payload })}\n`);
        return;
    }
    const lines = [
        `Selected: ${payload.selected}`,
        `Output: ${payload.output}`,
        `Verified: ${payload.dimensions}, ${payload.frames} frames, ${payload.durationSeconds}s, ${payload.bytes} bytes`,
        `Report: ${payload.script}, ${payload.backend} backend`,
        `  source      ${payload.input}`,
        `  path        ${payload.output}`,
        `  dimensions  ${payload.dimensions}`,
        `  frames      ${payload.frames}`,
        `  duration    ${payload.durationSeconds} s`,
        `  frame rate  ${payload.fps} FPS`,
        `  bytes       ${payload.bytes} (limit ${payload.maxBytes}, headroom ${payload.headroomBytes})`,
        `  loop        ${payload.loop}`,
        `  parameters  ${formatParameters(payload.parameters)}`,
        `  vmaf        ${payload.vmaf}`,
        `  sha256      ${payload.sha256}`,
        ...payload.checks.map(check => `Check: ${check.status === 'pass' ? 'PASS' : 'FAIL'} ${check.name}`),
        'Verification: complete. ffprobe measured codec, dimensions, frames and duration.',
        'The GIF application extension establishes looping. Filesystem/hash code measured bytes',
        'and confirmed the digest after publication. FPS and parameters are selected encoder',
        'settings. VMAF comes from the scorer. No further inspection is required.',
    ];
    if (payload.cleanupFailures?.length)
        lines.push(`Cleanup incomplete: ${JSON.stringify(payload.cleanupFailures)}`);
    process.stdout.write(`${lines.join('\n')}\n`);
}
function preflightError(state) {
    if (!state.failures.length)
        return null;
    return new StartupError('preflight_failed', `${state.failures.length} preflight check(s) failed`, state.policy.installRemedy, { failures: state.failures });
}
function usage(backend, basename) {
    const quality = backend === 'gifski' ? '  MIN_QUALITY    Minimum gifski quality (default: 1, maximum: 100)\n  MAX_QUALITY    Maximum gifski quality (default: 100, maximum: 100)\n' : '';
    const maxFpsMaximum = backend === 'gifski' ? 100 : MAX_EXACT_INTEGER;
    return `Usage: ${basename} [OPTIONS] INPUT_VIDEO [OUTPUT.gif]\n\nOptions:\n  --preflight [INPUT_VIDEO]\n                  Check the environment and optional input, convert nothing, then exit\n  --json          Report readiness and errors as JSON\n  --help, -h      Print this message\n  --              Stop option parsing\n\nEnvironment:\n  MAX_BYTES       Strict byte ceiling (default: 256000, maximum: ${MAX_EXACT_INTEGER})\n  GIF_SIZE        Square width and height (default: 128, maximum: ${MAX_EXACT_INTEGER})\n  MIN_FPS         Minimum frame rate (default: 15, maximum: ${MAX_EXACT_INTEGER})\n  MAX_FPS         Maximum frame rate (default: 24, maximum: ${maxFpsMaximum})\n  JOBS            Parallel work limit (default: logical CPUs minus 2, minimum 1, maximum: ${MAX_EXACT_INTEGER})\n${quality}  KEEP_WORK       Keep the work directory when set to 1 (default: unset)\n\nAll positive integers have an exact-value ceiling of ${MAX_EXACT_INTEGER}.\n\nExit status:\n  0    Success or passed preflight\n  1    Conversion work started and failed\n  2    Work did not start\n  129  SIGHUP\n  130  SIGINT\n  143  SIGTERM\n`;
}
