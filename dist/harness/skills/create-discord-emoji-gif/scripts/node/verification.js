"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.durationTolerance = durationTolerance;
exports.sha256File = sha256File;
exports.probeValue = probeValue;
exports.verifyFinalGif = verifyFinalGif;
exports.publishVerified = publishVerified;
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const gif_loop_js_1 = require("./gif-loop.js");
const errors_js_1 = require("./errors.js");
const media_result_js_1 = require("../../../../shared/node/media-result.js");
function durationTolerance(candidateFps) { return 1 / candidateFps + 1 / 24 + 0.02; }
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
async function probeValue(manager, command, task, args, code = 'verification_failed') {
    const result = await manager.runOwned(task, command, args, { stdout: 'capture', stderr: 'capture' });
    if ((0, media_result_js_1.mediaFailed)(result))
        throw (0, errors_js_1.subprocessError)(code, `verification failed, ffprobe could not read ${task}`, 'reinstall ffmpeg, then run the conversion again', task, result);
    return result.stdout.trim();
}
async function verifyFinalGif(manager, commands, file, expected) {
    const text = await probeValue(manager, commands.ffprobe, 'output verification', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,codec_type,width,height,nb_read_frames:format=duration', '-of', 'json', file]);
    let report;
    try {
        report = JSON.parse(text);
    }
    catch {
        throw new errors_js_1.RunError('verification_failed', 'verification failed, ffprobe returned invalid JSON for output verification', 'reinstall ffmpeg, then run the conversion again');
    }
    const envelope = (0, errors_js_1.fieldsOf)(report);
    if (!Array.isArray(envelope.streams) || envelope.streams.length !== 1 || !envelope.streams[0] || typeof envelope.streams[0] !== 'object' || Array.isArray(envelope.streams[0]))
        throw new errors_js_1.RunError('verification_failed', 'verification failed, expected one selected output video stream', 'repair or reinstall the selected GIF encoder, then run the conversion again');
    const stream = (0, errors_js_1.fieldsOf)(envelope.streams[0]);
    const codec = `${stream.codec_name || 'missing'}|${stream.codec_type || 'missing'}`;
    if (stream.codec_name !== 'gif' || stream.codec_type !== 'video')
        throw new errors_js_1.RunError('verification_failed', `verification failed, expected a GIF video stream, got ${codec || 'missing'}`, 'repair or reinstall the selected GIF encoder, then run the conversion again');
    const dimensions = `${stream.width}x${stream.height}`;
    if (!Number.isInteger(stream.width) || !Number.isInteger(stream.height) || dimensions !== `${expected.size}x${expected.size}`)
        throw new errors_js_1.RunError('verification_failed', `verification failed, expected ${expected.size}x${expected.size}, got ${dimensions}`, 'repair or reinstall the selected GIF encoder, then run the conversion again');
    const frames = stream.nb_read_frames;
    if (typeof frames !== 'string' || !/^[0-9]+$/.test(frames) || Number(frames) <= 1)
        throw new errors_js_1.RunError('verification_failed', `verification failed, invalid frame count: ${frames || 'missing'}`, 'raise the selected FPS or use an input with more than one frame');
    const duration = (0, errors_js_1.fieldsOf)(envelope.format).duration;
    if (typeof duration !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(duration) || Number(duration) <= 0)
        throw new errors_js_1.RunError('verification_failed', `verification failed, invalid duration: ${duration || 'missing'}`, 'use an input video with a positive duration and run the conversion again');
    if (!Number.isSafeInteger(expected.referenceFrames) || expected.referenceFrames <= 0 || !Number.isFinite(expected.fps) || expected.fps <= 0 || Math.abs(Number(duration) - expected.referenceFrames / 24) > durationTolerance(expected.fps))
        throw new errors_js_1.RunError('verification_failed', `verification failed, GIF duration ${duration}s differs from reference ${expected.referenceFrames / 24}s`, 'use a candidate that covers the complete reference clip');
    const bytes = fs.statSync(file).size;
    if (bytes >= expected.maxBytes)
        throw new errors_js_1.RunError('verification_failed', `verification failed, output is ${bytes} bytes, limit is strictly below ${expected.maxBytes}`, 'increase MAX_BYTES or reduce GIF_SIZE, then run the conversion again');
    if (expected.bytes !== undefined && bytes !== expected.bytes)
        throw new errors_js_1.RunError('verification_failed', `verification failed, expected ${expected.bytes} bytes, got ${bytes}`, 'run the same conversion again');
    const buffer = fs.readFileSync(file);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    if (expected.digest && digest !== expected.digest)
        throw new errors_js_1.RunError('verification_failed', 'verification failed, output digest does not match the selected winner', 'ensure the output directory is on a reliable local filesystem, then run again');
    let loop;
    try {
        loop = (0, gif_loop_js_1.inspectGifLoop)(buffer);
    }
    catch (error) {
        throw new errors_js_1.RunError('verification_failed', `verification failed, ${(0, errors_js_1.fieldsOf)(error).message}`, 'repair or reinstall the selected GIF encoder, then run the conversion again');
    }
    return { dimensions, frameCount: Number(frames), duration, bytes, digest, loop };
}
function createPublicationTemp(outputDir, prefix) {
    const file = path.join(path.resolve(outputDir), `.${prefix}-output.${crypto.randomBytes(6).toString('hex')}`);
    try {
        fs.closeSync(fs.openSync(file, 'wx', 0o600));
        return file;
    }
    catch {
        throw new errors_js_1.RunError('publication_failed', 'could not create the destination temporary file', 'make the output directory writable and ensure it has free space');
    }
}
async function publishVerified(source, output, prefix, verify, onTemporary = () => { }) {
    const temporary = createPublicationTemp(path.dirname(output), prefix);
    onTemporary(temporary);
    try {
        try {
            fs.copyFileSync(source, temporary);
        }
        catch (error) {
            throw new errors_js_1.RunError('publication_failed', `could not prepare the destination temporary file: ${(0, errors_js_1.fieldsOf)(error).message}`, 'make the output directory writable and ensure it has free space');
        }
        const verified = await verify(temporary);
        try {
            fs.renameSync(temporary, output);
        }
        catch (error) {
            throw new errors_js_1.RunError('publication_failed', `could not atomically publish the verified GIF: ${(0, errors_js_1.fieldsOf)(error).message}`, 'make the output directory writable and ensure it has free space');
        }
        onTemporary('');
        if ((0, errors_js_1.fieldsOf)(verified).digest && sha256File(output) !== (0, errors_js_1.fieldsOf)(verified).digest)
            throw new errors_js_1.RunError('publication_failed', 'published file digest does not match the verified content', 'ensure the output directory is on a reliable local filesystem, then run again');
        return verified;
    }
    catch (error) {
        try {
            fs.rmSync(temporary, { force: true });
            onTemporary('');
        }
        catch { }
        throw error;
    }
}
