'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_EXACT_INTEGER = 9007199254740991n;

class StartupError extends Error {
  constructor(code, condition, remedy, details = {}) {
    super(condition);
    Object.assign(this, { code, condition, remedy, exitCode: 2 }, details);
  }
}
class RunError extends Error {
  constructor(code, condition, remedy, details = {}) {
    super(condition);
    Object.assign(this, { code, condition, remedy, exitCode: 1 }, details);
  }
}

function parseArguments(argv, basename = 'mov-to-gif.js') {
  const positional = [];
  let preflight = false;
  let json = false;
  let help = false;
  let positionalOnly = false;
  for (const value of argv) {
    if (positionalOnly) positional.push(value);
    else if (value === '--') positionalOnly = true;
    else if (value === '--preflight') preflight = true;
    else if (value === '--json') json = true;
    else if (value === '-h' || value === '--help') help = true;
    else if (value.startsWith('-')) throw new StartupError('usage_error', `unknown option: ${value}`, 'run with --help to see the accepted options', { json });
    else positional.push(value);
  }
  if (help) return { help, json, preflight, positional };
  if (preflight && positional.length > 1) throw new StartupError('usage_error', '--preflight accepts at most one INPUT_VIDEO', 'run --preflight alone or pass one input video', { json });
  if (!preflight && (positional.length < 1 || positional.length > 2)) {
    throw new StartupError('usage_error', 'expected INPUT_VIDEO and an optional OUTPUT.gif', `run: ${basename} INPUT_VIDEO [OUTPUT.gif]`, { json });
  }
  return { help, json, preflight, positional };
}

function validateNodeVersion(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match || Number(match[1]) < 22) throw new StartupError('node_version_unsupported', `Node.js 22.0.0 or newer is required, got ${version}`, 'install Node.js 22.0.0 or newer');
}

function positive(env, name, fallback) {
  const raw = env[name] === undefined || env[name] === '' ? String(fallback) : env[name];
  if (!/^[1-9][0-9]*$/.test(raw) || BigInt(raw) > MAX_EXACT_INTEGER) throw new StartupError('config_invalid', `${name} must be a positive integer no greater than ${MAX_EXACT_INTEGER}, got '${raw}'`, `unset ${name} to take the default, or set it to a positive integer`);
  return Number(raw);
}

function defaultJobs() { return Math.max(1, os.availableParallelism() - 2); }

function readConfiguration(env, backend) {
  const config = {
    maxBytes: positive(env, 'MAX_BYTES', 256000),
    gifSize: positive(env, 'GIF_SIZE', 128),
    minFps: positive(env, 'MIN_FPS', 15),
    maxFps: positive(env, 'MAX_FPS', 24),
    jobs: positive(env, 'JOBS', defaultJobs()),
    keepWork: env.KEEP_WORK === '1',
  };
  if (config.minFps > config.maxFps) throw new StartupError('config_invalid', `MIN_FPS (${config.minFps}) must not exceed MAX_FPS (${config.maxFps})`, 'set MIN_FPS at or below MAX_FPS, or unset both to take the defaults');
  if (backend === 'gifski') {
    config.minQuality = positive(env, 'MIN_QUALITY', 1);
    config.maxQuality = positive(env, 'MAX_QUALITY', 100);
    for (const [name, value] of [['MIN_QUALITY', config.minQuality], ['MAX_QUALITY', config.maxQuality]]) {
      if (value > 100) throw new StartupError('config_invalid', `${name} must be between 1 and 100, got '${value}'`, `set ${name} to an integer from 1 through 100`);
    }
    if (config.maxFps > 100) throw new StartupError('config_invalid', `MAX_FPS (${config.maxFps}) must not exceed 100, gifski's maximum frame rate`, 'set MAX_FPS to 100 or lower, or use mov-to-gif.js for higher frame rates');
    if (config.minQuality > config.maxQuality) throw new StartupError('config_invalid', `MIN_QUALITY (${config.minQuality}) must not exceed MAX_QUALITY (${config.maxQuality})`, 'set MIN_QUALITY at or below MAX_QUALITY, or unset both to take the defaults');
  }
  return config;
}

function platformPolicy(platform, backend) {
  if (platform !== 'darwin' && platform !== 'linux') throw new StartupError('platform_unsupported', `unsupported platform: ${platform}`, 'run this converter on macOS, Linux, or inside WSL2');
  const mac = platform === 'darwin';
  const commandRemedy = name => {
    if (mac) {
      if (name === 'ffmpeg' || name === 'ffprobe') return 'brew install ffmpeg';
      return `brew install ${name}`;
    }
    if (name === 'gifski') return 'cargo install gifski, or install the prebuilt binary from https://gif.ski';
    if (name === 'gifsicle') return 'sudo apt install gifsicle';
    if (backend === 'gifski') return 'sudo apt install ffmpeg (or use a build with libvmaf if the VMAF filter check fails)';
    return 'sudo apt install ffmpeg';
  };
  const installRemedy = backend === 'gifski'
    ? (mac ? 'brew install ffmpeg gifski' : 'sudo apt install ffmpeg; cargo install gifski (or install the prebuilt binary from https://gif.ski)')
    : (mac ? 'brew install ffmpeg gifsicle' : 'sudo apt install ffmpeg gifsicle');
  const libvmafRemedy = mac ? 'brew reinstall ffmpeg' : 'install an ffmpeg build with libvmaf enabled, for example a static build from https://johnvansickle.com/ffmpeg/, jellyfin-ffmpeg, or a source build configured with --enable-libvmaf; the distribution ffmpeg package commonly omits it';
  return { os: platform === 'darwin' ? 'darwin' : 'linux', commandRemedy, installRemedy, libvmafRemedy };
}

function resolveCommand(name, env = process.env) {
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory || '.', name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); } catch {}
  }
  return null;
}

async function probe(manager, task, command, args) {
  const result = await manager.runOwned(task, command, args, { stdout: 'capture', stderr: 'capture' });
  return { ...result, output: result.stdout + result.stderr };
}

function listingContains(listing, wanted) {
  return listing.split(/\r?\n/).some(line => {
    const fields = line.trim().split(/\s+/);
    return fields.length > 1 && fields[1].split(',').includes(wanted);
  });
}

function optionListingContains(listing, wanted) {
  return listing.split(/[\s,]+/).some(token => token === wanted || token.startsWith(`${wanted}=`) || token.startsWith(`${wanted}[`));
}

function toolRemedy(platform, tool, action) {
  if (platform === 'darwin') return `brew ${action} ${tool === 'ffprobe' ? 'ffmpeg' : tool}`;
  if (tool === 'ffprobe') return action === 'reinstall' ? 'reinstall ffmpeg from your package manager or a static build' : 'install an ffprobe build that includes it';
  if (tool === 'gifsicle') return `${action} gifsicle from your package manager`;
  return `${action} gifski, for example with cargo install gifski or the prebuilt binary from https://gif.ski`;
}

async function checkFfprobePreflight(manager, state, platform) {
  if (!state.commands.ffprobe) return;
  const version = await probe(manager, 'ffprobe-version', state.commands.ffprobe, ['-v', 'error', '-show_program_version', '-of', 'json']);
  if (version.code !== 0 || !version.output.trim()) state.failures.push({ code: 'ffprobe_probe_failed', condition: 'ffprobe is present but could not report its program version', remedy: toolRemedy(platform, 'ffprobe', 'reinstall') });
  const help = await probe(manager, 'ffprobe-help', state.commands.ffprobe, ['-hide_banner', '-h', 'full']);
  if (help.code !== 0) state.failures.push({ code: 'ffprobe_probe_failed', condition: 'ffprobe is present but could not report its options', remedy: toolRemedy(platform, 'ffprobe', 'reinstall') });
  else for (const option of ['-of', '-select_streams', '-show_entries', '-count_frames']) if (!optionListingContains(help.output, option)) state.failures.push({ code: 'ffprobe_capability_missing', condition: `ffprobe is missing required option: ${option}`, remedy: toolRemedy(platform, 'ffprobe', 'upgrade') });
}

async function checkCommonPreflight(manager, backend, platform = process.platform, env = process.env) {
  const policy = platformPolicy(platform, backend);
  const names = ['ffmpeg', 'ffprobe', backend];
  const commands = {};
  const failures = [];
  for (const name of names) {
    const resolved = resolveCommand(name, env);
    if (resolved) commands[name] = resolved;
    else failures.push({ code: 'command_missing', condition: `required command not found: ${name}`, remedy: policy.commandRemedy(name) });
  }
  if (commands.ffmpeg) {
    const groups = [
      ['filter', backend === 'gifski' ? ['fps', 'scale', 'format', 'setpts', 'libvmaf'] : ['fps', 'scale', 'format', 'palettegen', 'paletteuse', 'setpts', 'libvmaf']],
      ['encoder', backend === 'gifski' ? ['rawvideo', 'ffv1'] : ['rawvideo', 'ffv1', 'png', 'gif']],
      ['decoder', backend === 'gifski' ? ['rawvideo', 'ffv1', 'gif'] : ['rawvideo', 'ffv1', 'gif', 'png']],
      ['muxer', backend === 'gifski' ? ['yuv4mpegpipe', 'matroska', 'null'] : ['nut', 'matroska', 'image2', 'gif', 'null']],
      ['demuxer', backend === 'gifski' ? ['yuv4mpegpipe', 'matroska', 'gif'] : ['nut', 'matroska', 'image2', 'gif']],
    ];
    for (const [kind, capabilities] of groups) {
      const result = await probe(manager, `ffmpeg-${kind}s`, commands.ffmpeg, ['-hide_banner', `-${kind}s`]);
      if (result.code !== 0) failures.push({ code: 'ffmpeg_probe_failed', condition: `ffmpeg could not report its available ${kind}s`, remedy: platform === 'darwin' ? 'brew reinstall ffmpeg' : 'reinstall ffmpeg from your package manager or a static build' });
      else for (const capability of capabilities) if (!listingContains(result.output, capability)) failures.push({ code: 'ffmpeg_capability_missing', condition: `ffmpeg is missing required ${kind}: ${capability}`, remedy: capability === 'libvmaf' ? policy.libvmafRemedy : (platform === 'darwin' ? 'brew reinstall ffmpeg' : 'install an ffmpeg build that includes it') });
    }
  }
  await checkFfprobePreflight(manager, { commands, failures }, platform);
  return { policy, commands, failures };
}

async function checkGifskiPreflight(manager, platform, env) {
  const state = await checkCommonPreflight(manager, 'gifski', platform, env);
  if (state.commands.gifski) {
    const version = await probe(manager, 'gifski-version', state.commands.gifski, ['--version']);
    if (version.code !== 0 || !version.output.trim()) state.failures.push({ code: 'gifski_probe_failed', condition: 'gifski is present but could not report its version', remedy: toolRemedy(platform, 'gifski', 'reinstall') });
    const help = await probe(manager, 'gifski-help', state.commands.gifski, ['--help']);
    if (help.code !== 0) state.failures.push({ code: 'gifski_probe_failed', condition: 'gifski is present but could not report its options', remedy: toolRemedy(platform, 'gifski', 'reinstall') });
    else for (const option of ['--fps', '--width', '--height', '--quality', '--motion-quality', '--lossy-quality', '--repeat', '--quiet', '--output']) if (!optionListingContains(help.output, option)) state.failures.push({ code: 'gifski_capability_missing', condition: `gifski is missing required option: ${option}`, remedy: toolRemedy(platform, 'gifski', 'upgrade') });
  }
  return state;
}
async function checkGifsiclePreflight(manager, platform, env) {
  const state = await checkCommonPreflight(manager, 'gifsicle', platform, env);
  if (state.commands.gifsicle) {
    const version = await probe(manager, 'gifsicle-version', state.commands.gifsicle, ['--version']);
    if (version.code !== 0 || !version.output.trim()) state.failures.push({ code: 'gifsicle_probe_failed', condition: 'gifsicle is present but could not report its version', remedy: toolRemedy(platform, 'gifsicle', 'reinstall') });
    const help = await probe(manager, 'gifsicle-help', state.commands.gifsicle, ['--help']);
    if (help.code !== 0) state.failures.push({ code: 'gifsicle_probe_failed', condition: 'gifsicle is present but could not report its options', remedy: toolRemedy(platform, 'gifsicle', 'reinstall') });
    else for (const option of ['--optimize', '--output']) if (!optionListingContains(help.output, option)) state.failures.push({ code: 'gifsicle_capability_missing', condition: `gifsicle is missing required option: ${option}`, remedy: toolRemedy(platform, 'gifsicle', 'upgrade') });
  }
  return state;
}

function validateInput(input) {
  try { if (!fs.statSync(input).isFile()) throw new Error(); } catch { throw new StartupError('input_unusable', `input is not a regular file: ${input}`, 'pass the path of an existing video file'); }
}

function mediaFailed(result) { return result.code !== 0 || Boolean(result.signal) || Boolean(result.stderr?.trim()); }
function childDetails(task, result) { return { task, childExitCode: result.code, childSignal: result.signal ?? null, stderr: result.stderr }; }

async function inspectInput(manager, commands, input) {
  const stream = await manager.runOwned('input-stream', commands.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', input], { stdout: 'capture', stderr: 'capture' });
  if (mediaFailed(stream)) throw new StartupError('input_unusable', `ffprobe could not read input video: ${input}`, 'confirm the file is a video ffmpeg can decode', childDetails('input-stream', stream));
  if (!stream.stdout.trim()) throw new StartupError('input_unusable', `input contains no video stream: ${input}`, 'pass a file that contains video, not audio or still images only');
  const decode = await manager.runOwned('input-decode', commands.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-threads', '1', '-filter_threads', '1', '-i', input, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-f', 'null', '-'], { stderr: 'capture' });
  if (mediaFailed(decode)) throw new StartupError('input_unusable', `input video does not have a decodable first frame: ${input}`, 'the file is truncated or corrupt, re-export it and try again', childDetails('input-decode', decode));
  const durationResult = await manager.runOwned('input-duration', commands.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input], { stdout: 'capture', stderr: 'capture' });
  const duration = durationResult.stdout.trim();
  if (mediaFailed(durationResult) || !/^[0-9]+(?:\.[0-9]+)?$/.test(duration) || Number(duration) <= 0) throw new StartupError('input_unusable', `ffprobe could not read a valid input duration: ${input}`, 'confirm the file is a complete video with a positive duration', childDetails('input-duration', durationResult));
  return Number(duration) > 3 ? [{ code: 'input_duration_long', condition: `input duration is ${duration}s, which is longer than 3 seconds`, recommendation: 'trim the clip to 3 seconds or less for better quality' }] : [];
}

function validateOutput(input, requested, size) {
  const parsed = path.parse(input);
  const output = requested || path.join(parsed.dir, `${parsed.name}_${size}x${size}.gif`);
  try { if (fs.existsSync(output) && fs.realpathSync(input) === fs.realpathSync(output)) throw new StartupError('output_unusable', 'input and output paths must differ', 'pass an output path that is not the input file'); } catch (error) { if (error instanceof StartupError) throw error; }
  if (fs.existsSync(output) && fs.statSync(output).isDirectory()) throw new StartupError('output_unusable', `output path is a directory: ${output}`, 'pass a file path ending in .gif, not a directory');
  const directory = path.dirname(output);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new StartupError('output_unusable', `output directory does not exist: ${directory}`, `create it first: mkdir -p '${directory}'`);
  try { fs.accessSync(directory, fs.constants.W_OK); } catch { throw new StartupError('output_unusable', `output directory is not writable: ${directory}`, 'choose an output path in a writable directory'); }
  return { output, outputDir: directory };
}

function parseVmafScore(text) {
  let report;
  try { report = JSON.parse(text); } catch {}
  const mean = report?.pooled_metrics?.vmaf?.mean;
  if (!Array.isArray(report?.frames) || !report.frames.length || !Number.isFinite(mean)) {
    throw new RunError('vmaf_nonnumeric', 'VMAF did not return a valid nonempty JSON score report', 'reinstall an ffmpeg build with a working libvmaf filter');
  }
  return { score: mean.toFixed(6), frames: report.frames.length };
}

function durationTolerance(candidateFps) { return 1 / candidateFps + 1 / 24 + 0.02; }

async function referenceFrameCount(state) {
  const result = await state.manager.runOwned('reference-frames', state.commands.ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', path.join(state.workDir, 'vmaf-reference.mkv')], { stdout: 'capture', stderr: 'capture' });
  if (mediaFailed(result)) throw subprocessError('reference_failed', 'could not decode the completed VMAF reference', 'fix the reported ffprobe error, then run again', 'reference-frames', result);
  const frames = Number(result.stdout.trim());
  if (!Number.isSafeInteger(frames) || frames <= 0) throw new RunError('reference_failed', 'VMAF reference has no valid decoded frame count', 'use an input with at least one frame at 24 FPS', childDetails('reference-frames', result));
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
    if (mediaFailed(result)) throw subprocessError('vmaf_failed', `VMAF scoring failed for ${task}: ${result.stderr.trim()}`, 'fix the reported ffmpeg libvmaf error, then run the same conversion again', task, result);
    let text;
    try { text = fs.readFileSync(logPath, 'utf8'); } catch { text = ''; }
    let report;
    try { report = parseVmafScore(text); } catch (error) { throw Object.assign(error, childDetails(task, result)); }
    if (!Number.isSafeInteger(referenceFrames) || referenceFrames <= 0 || !Number.isFinite(candidateFps) || candidateFps <= 0 || Math.abs(report.frames - referenceFrames) > Math.ceil(24 * durationTolerance(candidateFps))) {
      throw new RunError('vmaf_failed', `VMAF coverage differs from the reference: scored ${report.frames} frames, reference ${referenceFrames}`, 'use a candidate that covers the complete reference clip', childDetails(task, result));
    }
    const duration = await probeValue(manager, commands.ffprobe, `${task} duration`, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', candidate], 'vmaf_failed');
    if (!Number.isFinite(Number(duration)) || Number(duration) <= 0 || Math.abs(Number(duration) - referenceFrames / 24) > durationTolerance(candidateFps)) {
      throw new RunError('vmaf_failed', `candidate duration ${duration}s differs from reference ${referenceFrames / 24}s`, 'use a candidate that covers the complete reference clip', childDetails(task, result));
    }
    return report.score;
  } finally { if (!keepWork) fs.rmSync(logPath, { force: true }); }
}

function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

async function probeValue(manager, command, task, args, code = 'verification_failed') {
  const result = await manager.runOwned(task, command, args, { stdout: 'capture', stderr: 'capture' });
  if (mediaFailed(result)) throw subprocessError(code, `verification failed, ffprobe could not read ${task}`, 'reinstall ffmpeg, then run the conversion again', task, result);
  return result.stdout.trim();
}

async function verifyFinalGif(manager, commands, file, expected) {
  const codec = await probeValue(manager, commands.ffprobe, 'output codec', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,codec_type', '-of', "csv=s=|:p=0", file]);
  if (codec !== 'gif|video') throw new RunError('verification_failed', `verification failed, expected a GIF video stream, got ${codec || 'missing'}`, 'repair or reinstall the selected GIF encoder, then run the conversion again');
  const dimensions = await probeValue(manager, commands.ffprobe, 'output dimensions', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', file]);
  if (dimensions !== `${expected.size}x${expected.size}`) throw new RunError('verification_failed', `verification failed, expected ${expected.size}x${expected.size}, got ${dimensions}`, 'repair or reinstall the selected GIF encoder, then run the conversion again');
  const frames = await probeValue(manager, commands.ffprobe, 'output frames', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', file]);
  if (!/^[0-9]+$/.test(frames) || Number(frames) <= 1) throw new RunError('verification_failed', `verification failed, invalid frame count: ${frames || 'missing'}`, 'raise the selected FPS or use an input with more than one frame');
  const duration = await probeValue(manager, commands.ffprobe, 'output duration', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(duration) || Number(duration) <= 0) throw new RunError('verification_failed', `verification failed, invalid duration: ${duration || 'missing'}`, 'use an input video with a positive duration and run the conversion again');
  if (!Number.isSafeInteger(expected.referenceFrames) || expected.referenceFrames <= 0 || !Number.isFinite(expected.fps) || expected.fps <= 0 || Math.abs(Number(duration) - expected.referenceFrames / 24) > durationTolerance(expected.fps)) throw new RunError('verification_failed', `verification failed, GIF duration ${duration}s differs from reference ${expected.referenceFrames / 24}s`, 'use a candidate that covers the complete reference clip');
  const bytes = fs.statSync(file).size;
  if (bytes >= expected.maxBytes) throw new RunError('verification_failed', `verification failed, output is ${bytes} bytes, limit is strictly below ${expected.maxBytes}`, 'increase MAX_BYTES or reduce GIF_SIZE, then run the conversion again');
  if (expected.bytes !== undefined && bytes !== expected.bytes) throw new RunError('verification_failed', `verification failed, expected ${expected.bytes} bytes, got ${bytes}`, 'run the same conversion again');
  const digest = sha256File(file);
  if (expected.digest && digest !== expected.digest) throw new RunError('verification_failed', 'verification failed, output digest does not match the selected winner', 'ensure the output directory is on a reliable local filesystem, then run again');
  return { dimensions, frameCount: Number(frames), duration, bytes, digest };
}

function createPublicationTemp(outputDir, prefix) {
  const file = path.join(outputDir, `.${prefix}-output.${crypto.randomBytes(6).toString('hex')}`);
  try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); return file; } catch { throw new RunError('publication_failed', 'could not create the destination temporary file', 'make the output directory writable and ensure it has free space'); }
}
async function publishVerified(source, output, prefix, verify, onTemporary = () => {}) {
  const temporary = createPublicationTemp(path.dirname(output), prefix);
  onTemporary(temporary);
  try {
    try { fs.copyFileSync(source, temporary); } catch (error) { throw new RunError('publication_failed', `could not prepare the destination temporary file: ${error.message}`, 'make the output directory writable and ensure it has free space'); }
    const verified = await verify(temporary);
    try { fs.renameSync(temporary, output); } catch (error) { throw new RunError('publication_failed', `could not atomically publish the verified GIF: ${error.message}`, 'make the output directory writable and ensure it has free space'); }
    onTemporary('');
    if (verified?.digest && sha256File(output) !== verified.digest) throw new RunError('publication_failed', 'published file digest does not match the verified content', 'ensure the output directory is on a reliable local filesystem, then run again');
    return verified;
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    onTemporary('');
    throw error;
  }
}
function cleanupArtifacts({ workDir, outputTemp, config }) {
  const failures = [];
  for (const target of [outputTemp, config.keepWork ? null : workDir].filter(Boolean)) {
    try { fs.rmSync(target, { recursive: true, force: true }); }
    catch (error) { failures.push({ path: target, code: error.code, condition: error.message }); }
  }
  if (workDir && fs.existsSync(workDir) && config.keepWork) process.stderr.write(`Kept work directory: ${workDir}\n`);
  return failures;
}

function subprocessError(code, condition, remedy, task, result) {
  return new RunError(code, condition, remedy, { task, childExitCode: result.code, childSignal: result.signal ?? null, stderr: result.stderr });
}

function errorDetails(error) {
  const payload = { code: error.code || 'unexpected_failure', condition: error.condition || error.message, remedy: error.remedy || 'run the conversion again and inspect the reported failure' };
  for (const key of ['failures', 'task', 'childExitCode', 'childSignal', 'stderr', 'cleanupFailures']) if (error[key] !== undefined) payload[key] = error[key];
  if (error.cause) payload.cause = errorDetails(error.cause);
  return payload;
}

function emitError(error, json = false) {
  const payload = errorDetails(error);
  if (json) process.stderr.write(`${JSON.stringify({ error: payload })}\n`);
  else if (payload.failures) {
    process.stderr.write(`ERROR [${payload.code}]: ${payload.condition}\n`);
    for (const failure of payload.failures) process.stderr.write(`  [${failure.code}] ${failure.condition}\n      Remedy: ${failure.remedy}\n`);
  } else process.stderr.write(`ERROR [${payload.code}]: ${payload.condition}\nRemedy: ${payload.remedy}\n`);
  if (!json) for (const key of ['task', 'childExitCode', 'childSignal', 'stderr', 'cause', 'cleanupFailures']) if (payload[key] !== undefined) process.stderr.write(`${key}: ${JSON.stringify(payload[key])}\n`);
}
function emitWarnings(warnings, json) {
  if (!warnings.length) return;
  if (json) process.stderr.write(`${JSON.stringify({ warnings })}\n`);
  else for (const warning of warnings) process.stderr.write(`WARNING [${warning.code}]: ${warning.condition}\nRecommendation: ${warning.recommendation}\n`);
}
function emitPreflightReady(state, warnings, json) {
  if (json) process.stdout.write(`${JSON.stringify({ status: 'ready', os: state.policy.os, commands: state.commands, warnings })}\n`);
  else {
    process.stdout.write(`READY: ${state.policy.os}\n`);
    for (const [name, command] of Object.entries(state.commands)) process.stdout.write(`${name}: ${command}\n`);
    for (const warning of warnings) process.stdout.write(`WARNING [${warning.code}]: ${warning.condition}\nRecommendation: ${warning.recommendation}\n`);
  }
}
function formatParameters(parameters) {
  if ('quality' in parameters) return `quality ${parameters.quality}, motion quality ${parameters.motionQuality}, lossy quality ${parameters.lossyQuality}`;
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
    loop: 'infinite',
    vmaf: winner.score,
    sha256: verified.digest,
    parameters,
    selected,
    checks,
  };
}

function emitResult(payload, json = false) {
  if (json) { process.stdout.write(`${JSON.stringify({ result: payload })}\n`); return; }
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
    'Verification: complete. ffprobe measured every value above, and the digest was confirmed',
    'on the published file after rename. No further inspection is required.',
  ];
  if (payload.cleanupFailures?.length) lines.push(`Cleanup incomplete: ${JSON.stringify(payload.cleanupFailures)}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}
function preflightError(state) {
  if (!state.failures.length) return null;
  return new StartupError('preflight_failed', `${state.failures.length} preflight check(s) failed`, state.policy.installRemedy, { failures: state.failures });
}
function usage(backend, basename) {
  const quality = backend === 'gifski' ? '  MIN_QUALITY    Minimum gifski quality (default: 1, maximum: 100)\n  MAX_QUALITY    Maximum gifski quality (default: 100, maximum: 100)\n' : '';
  const maxFpsMaximum = backend === 'gifski' ? 100 : MAX_EXACT_INTEGER;
  return `Usage: ${basename} [OPTIONS] INPUT_VIDEO [OUTPUT.gif]\n\nOptions:\n  --preflight [INPUT_VIDEO]\n                  Check the environment and optional input, convert nothing, then exit\n  --json          Report readiness and errors as JSON\n  --help, -h      Print this message\n  --              Stop option parsing\n\nEnvironment:\n  MAX_BYTES       Strict byte ceiling (default: 256000, maximum: ${MAX_EXACT_INTEGER})\n  GIF_SIZE        Square width and height (default: 128, maximum: ${MAX_EXACT_INTEGER})\n  MIN_FPS         Minimum frame rate (default: 15, maximum: ${MAX_EXACT_INTEGER})\n  MAX_FPS         Maximum frame rate (default: 24, maximum: ${maxFpsMaximum})\n  JOBS            Parallel work limit (default: logical CPUs minus 2, minimum 1, maximum: ${MAX_EXACT_INTEGER})\n${quality}  KEEP_WORK       Keep the work directory when set to 1 (default: unset)\n\nAll positive integers have an exact-value ceiling of ${MAX_EXACT_INTEGER}.\n\nExit status:\n  0    Success or passed preflight\n  1    Conversion work started and failed\n  2    Work did not start\n  129  SIGHUP\n  130  SIGINT\n  143  SIGTERM\n`;
}

module.exports = { mediaFailed, referenceFrameCount, durationTolerance, subprocessError, errorDetails, StartupError, RunError, parseArguments, validateNodeVersion, readConfiguration, platformPolicy, checkGifskiPreflight, checkGifsiclePreflight, validateInput, inspectInput, validateOutput, parseVmafScore, scoreCandidate, sha256File, verifyFinalGif, publishVerified, cleanupArtifacts, emitError, emitWarnings, emitPreflightReady, resultPayload, emitResult, preflightError, usage };
