#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MINIMUM_NODE = Object.freeze([20, 6, 0]);
const MINIMUM_MACOS = Object.freeze([26, 0, 0]);
const NS_PER_SECOND = 1000000000n;
const STDERR_TAIL_BYTES = 64 * 1024;
const MACOS_PUBLISH_SCRIPT = 'ObjC.import("Foundation"); function run(argv) { const manager = $.NSFileManager.defaultManager; const ok = manager.moveItemAtPathToPathError(argv[0], argv[1], null); if (ok) return "published"; return manager.fileExistsAtPath(argv[1]) ? "collision" : "failed"; }';
const SIGNAL_EXIT = Object.freeze({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
const EXIT = Object.freeze({ OK: 0, FAILED: 1, CANNOT_START: 2 });

class DraftError extends Error {
  constructor(code, condition, remedy, exitCode = EXIT.CANNOT_START, details = {}) {
    super(condition);
    Object.assign(this, { code, condition, remedy, exitCode, ...details });
  }
}

function versionAtLeast(actual, minimum) {
  const parts = String(actual).match(/\d+/g)?.map(Number) || [];
  for (let index = 0; index < minimum.length; index += 1) {
    if ((parts[index] || 0) > minimum[index]) return true;
    if ((parts[index] || 0) < minimum[index]) return false;
  }
  return true;
}

function parseTime(value, flag) {
  const text = String(value);
  let hours = 0n;
  let minutes = 0n;
  let seconds;
  let fraction = '';
  if (/^[0-9]+(?:\.[0-9]{1,9})?$/.test(text)) {
    [seconds, fraction = ''] = text.split('.');
  } else {
    const match = /^([0-9]+):([0-5][0-9]):([0-5][0-9])(?:\.([0-9]{1,9}))?$/.exec(text);
    if (!match) {
      throw new DraftError('window_invalid', `${flag} is not decimal seconds or HH:MM:SS[.fraction]: ${text}`, `pass ${flag} as a nonnegative time such as 12.5 or 00:00:12.5`);
    }
    hours = BigInt(match[1]);
    minutes = BigInt(match[2]);
    seconds = match[3];
    fraction = match[4] || '';
  }
  const whole = hours * 3600n + minutes * 60n + BigInt(seconds);
  return whole * NS_PER_SECOND + BigInt((fraction + '000000000').slice(0, 9));
}

function formatTime(nanoseconds) {
  const whole = nanoseconds / NS_PER_SECOND;
  const fraction = String(nanoseconds % NS_PER_SECOND).padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function parseArguments(argv, basename = 'extract-video-frames.js') {
  const options = { input: null, start: null, end: null, preflight: false, json: false, help: false };
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (positionalOnly) {
      if (options.input !== null) throw new DraftError('usage_error', 'more than one input path was supplied', `run ${basename} --help`);
      options.input = argument;
      continue;
    }
    if (argument === '--') { positionalOnly = true; continue; }
    if (argument === '--preflight') { options.preflight = true; continue; }
    if (argument === '--json') { options.json = true; continue; }
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    const equals = argument.indexOf('=');
    const flag = equals > 0 ? argument.slice(0, equals) : argument;
    if (flag === '--start' || flag === '--end') {
      const value = equals > 0 ? argument.slice(equals + 1) : argv[++index];
      if (!value || value.startsWith('--')) throw new DraftError('usage_error', `${flag} requires a time value`, `run ${basename} --help`);
      options[flag.slice(2)] = parseTime(value, flag);
      continue;
    }
    if (argument.startsWith('-')) throw new DraftError('usage_error', `unknown option: ${argument}`, `run ${basename} --help`);
    if (options.input !== null) throw new DraftError('usage_error', 'more than one input path was supplied', `run ${basename} --help`);
    options.input = argument;
  }
  if (options.help) return options;
  if (!options.input && !options.preflight) throw new DraftError('usage_error', 'INPUT_VIDEO is required', `run ${basename} INPUT_VIDEO`);
  if (!options.input && (options.start !== null || options.end !== null)) throw new DraftError('usage_error', 'window flags require INPUT_VIDEO', `run ${basename} --preflight without window flags, or add INPUT_VIDEO`);
  if (options.start !== null && options.end !== null && options.start > options.end) throw new DraftError('window_invalid', '--start must not be later than --end', 'swap the bounds or pass an end time at or after the start time');
  return options;
}

function derivePaths(input) {
  const supplied = path.resolve(input);
  const parsed = path.parse(supplied);
  const stem = parsed.ext ? parsed.name : parsed.base;
  return { supplied, output: path.join(parsed.dir, `${stem}-frames`) };
}

function pathExists(pathname) {
  try { fs.lstatSync(pathname); return true; } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

function validateInputAndOutput(input) {
  const paths = derivePaths(input);
  let source;
  try {
    source = fs.statSync(paths.supplied);
  } catch {
    throw new DraftError('input_unusable', `input is not an accessible file: ${paths.supplied}`, 'pass the path of an existing readable video file');
  }
  if (!source.isFile()) throw new DraftError('input_unusable', `input is not a regular file: ${paths.supplied}`, 'pass the path of an existing video file');
  try { fs.accessSync(paths.supplied, fs.constants.R_OK); } catch { throw new DraftError('input_unusable', `input is not readable: ${paths.supplied}`, 'grant read access or copy the video to a readable location'); }
  if (pathExists(paths.output)) throw new DraftError('output_collision', `output already exists: ${paths.output}`, 'move or remove the existing path, then run the same command again');
  try { fs.accessSync(path.dirname(paths.output), fs.constants.W_OK); } catch { throw new DraftError('output_unusable', `input directory is not writable: ${path.dirname(paths.output)}`, 'grant write access or place the input in a writable directory'); }
  return { ...paths, resolved: fs.realpathSync(paths.supplied), sourceIdentity: identity(source) };
}

function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function assertSourceUnchanged(paths) {
  let current;
  try { current = identity(fs.statSync(paths.supplied)); } catch {
    throw new DraftError('source_changed', 'input became inaccessible during extraction', 'restore a stable source file, then run again', EXIT.FAILED);
  }
  if (!sameIdentity(paths.sourceIdentity, current)) throw new DraftError('source_changed', 'input identity, size, or modification time changed during extraction', 'wait until the source file is stable, then run again', EXIT.FAILED);
}

function resolveCommand(name, env = process.env) {
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory || '.', name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); } catch {}
  }
  return null;
}

function commandRemedy() {
  return 'brew install ffmpeg-full && export PATH="$(brew --prefix ffmpeg-full)/bin:$PATH"';
}

function parseListing(text) {
  return new Set(text.split(/\r?\n/).flatMap(line => line.trim().split(/\s+/)));
}

class ProcessManager {
  constructor({ killTimeout = 5000 } = {}) { this.active = new Set(); this.signal = null; this.killTimeout = killTimeout; this.stopped = null; }

  assertRunning() {
    if (this.signal) throw new DraftError('interrupted', `interrupted by ${this.signal}`, 'run the command again', SIGNAL_EXIT[this.signal]);
  }

  async run(command, args, options = {}) {
    this.assertRunning();
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        reject(error);
        return;
      }
      this.active.add(child);
      child.closed = new Promise(resolve => child.once('close', resolve));
      const stdout = [];
      let stderr = Buffer.alloc(0);
      let settled = false;
      child.stdout.on('data', chunk => {
        if (options.progress) options.progress(chunk.toString());
        else stdout.push(chunk);
      });
      child.stderr.on('data', chunk => {
        stderr = boundedTail(stderr, chunk, options.stderrTailBytes || STDERR_TAIL_BYTES);
      });
      let launchError;
      child.once('error', error => { launchError = error; });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        this.active.delete(child);
        if (launchError) { reject(Object.assign(launchError, { task: command, childExitCode: code, childSignal: signal, stderr: stderr.toString() })); return; }
        resolve({ code, signal, stdout: Buffer.concat(stdout).toString(), stderr: stderr.toString() });
      });
    });
  }

  interrupt(signal) {
    if (this.stopped) return this.stopped;
    this.signal = signal;
    const children = [...this.active];
    for (const child of children) child.kill(signal);
    this.stopped = (async () => {
      const timer = setTimeout(() => {
        for (const child of children) if (this.active.has(child)) child.kill('SIGKILL');
      }, this.killTimeout);
      try { await Promise.all(children.map(child => child.closed)); }
      finally { clearTimeout(timer); }
    })();
    return this.stopped;
  }
}

function boundedTail(previous, chunk, limit = STDERR_TAIL_BYTES) {
  const combined = Buffer.concat([previous, Buffer.from(chunk)]);
  return combined.length <= limit ? combined : combined.subarray(combined.length - limit);
}

async function platformPreflight(manager) {
  if (!versionAtLeast(process.version, MINIMUM_NODE)) throw new DraftError('node_version_unsupported', `Node.js 20.6.0 or newer is required, running ${process.version}`, 'install Node.js 20.6.0 or newer');
  if (process.platform !== 'darwin') throw new DraftError('platform_unsupported', `unsupported platform: ${process.platform}`, 'run this skill on macOS 26.0 or newer');
  const swVers = resolveCommand('sw_vers');
  if (!swVers) throw new DraftError('command_missing', 'macOS sw_vers was not found', 'restore /usr/bin/sw_vers, which ships with macOS');
  const result = await manager.run(swVers, ['-productVersion']);
  const version = result.stdout.trim();
  if (result.code !== 0 || !versionAtLeast(version, MINIMUM_MACOS)) throw new DraftError('platform_unsupported', `macOS 26.0 or newer is required, running ${version || 'an unknown version'}`, 'upgrade this Mac to macOS 26.0 or newer');
  return { os: 'macos', version };
}

function executablePair(directory) {
  const ffmpeg = path.join(directory, 'ffmpeg');
  const ffprobe = path.join(directory, 'ffprobe');
  try {
    fs.accessSync(ffmpeg, fs.constants.X_OK);
    fs.accessSync(ffprobe, fs.constants.X_OK);
    return { ffmpeg: fs.realpathSync(ffmpeg), ffprobe: fs.realpathSync(ffprobe) };
  } catch { return null; }
}

async function resolveFfmpegPair(manager) {
  for (const directory of ['/opt/homebrew/opt/ffmpeg-full/bin', '/usr/local/opt/ffmpeg-full/bin']) {
    const pair = executablePair(directory);
    if (pair) return pair;
  }
  const brew = resolveCommand('brew');
  if (brew) {
    const result = await manager.run(brew, ['--prefix', 'ffmpeg-full']);
    if (result.code === 0) {
      const pair = executablePair(path.join(result.stdout.trim(), 'bin'));
      if (pair) return pair;
    }
  }
  const ffmpeg = resolveCommand('ffmpeg');
  const ffprobe = resolveCommand('ffprobe');
  return ffmpeg && ffprobe && path.dirname(ffmpeg) === path.dirname(ffprobe) ? { ffmpeg, ffprobe } : { ffmpeg: null, ffprobe: null };
}

async function toolchainPreflight(manager, platform) {
  const mediaTools = await resolveFfmpegPair(manager);
  let publisher = null;
  try { fs.accessSync('/usr/bin/osascript', fs.constants.X_OK); publisher = '/usr/bin/osascript'; } catch {}
  const commands = { ...mediaTools, publisher, swiftc: resolveCommand('swiftc'), sips: resolveCommand('sips') };
  const failures = [];
  for (const name of ['ffmpeg', 'ffprobe']) if (!commands[name]) failures.push({ code: 'command_missing', condition: `required command not found: ${name}`, remedy: commandRemedy() });
  if (!commands.publisher) failures.push({ code: 'publication_unsupported', condition: 'required publication command not found: /usr/bin/osascript', remedy: 'restore /usr/bin/osascript, which ships with macOS' });
  if (!commands.swiftc) failures.push({ code: 'command_missing', condition: 'required command not found: swiftc', remedy: 'install the macOS Command Line Tools with xcode-select --install' });
  if (!commands.sips) failures.push({ code: 'command_missing', condition: 'required command not found: sips', remedy: 'restore /usr/bin/sips, which ships with macOS' });
  if (commands.ffmpeg) {
    for (const [flag, wanted] of [
      ['-filters', ['zscale', 'select', 'setpts', 'format', 'transpose', 'hflip', 'vflip']],
      ['-encoders', ['png', 'tiff']],
      ['-muxers', ['image2']],
      ['-pix_fmts', ['rgb24', 'rgb48le', 'rgba', 'rgba64le']],
    ]) {
      const result = await manager.run(commands.ffmpeg, ['-hide_banner', flag]);
      if (result.code !== 0) failures.push({ code: 'ffmpeg_probe_failed', condition: `ffmpeg could not report ${flag.slice(1)}`, remedy: commandRemedy() });
      else {
        const listing = parseListing(result.stdout + result.stderr);
        for (const capability of wanted) if (!listing.has(capability)) failures.push({ code: 'ffmpeg_capability_missing', condition: `ffmpeg is missing required capability: ${capability}`, remedy: commandRemedy() });
      }
    }
  }
  if (commands.ffprobe) {
    const result = await manager.run(commands.ffprobe, ['-v', 'error', '-show_program_version', '-of', 'json']);
    if (result.code !== 0 || !result.stdout.trim()) failures.push({ code: 'ffprobe_probe_failed', condition: 'ffprobe could not report its version', remedy: commandRemedy() });
  }
  if (failures.length) throw new DraftError('preflight_failed', `${failures.length} toolchain preflight check(s) failed`, commandRemedy(), EXIT.CANNOT_START, { failures });
  return { platform, commands };
}

function mediaFailed(result) { return result.code !== 0 || Boolean(result.signal) || Boolean(result.stderr?.trim()); }
function childDetails(task, result) { return { task, childExitCode: result.code, childSignal: result.signal ?? null, stderr: result.stderr }; }

async function readJson(manager, command, args, code, condition, remedy, exitCode = EXIT.CANNOT_START) {
  const result = await manager.run(command, args);
  if (mediaFailed(result)) throw new DraftError(code, `${condition}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, remedy, exitCode, childDetails(code, result));
  try { return JSON.parse(result.stdout); } catch { throw new DraftError(code, `${condition}: output was not valid JSON`, remedy, exitCode, childDetails(code, result)); }
}

function sourceBitDepth(stream) {
  const explicit = Number.parseInt(stream.bits_per_raw_sample || stream.bits_per_coded_sample, 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const match = String(stream.pix_fmt || '').match(/(?:p|f)(9|10|12|14|16|32)(?:le|be)?$/);
  return match ? Number(match[1]) : 8;
}

function hasAlpha(stream) {
  return /(?:^|[^a-z])(?:rgba|bgra|argb|abgr|yuva|gbrap|gray[a-z]*a)/.test(String(stream.pix_fmt || '')) || stream.alpha_mode === 1;
}

const DISPLAY_TRANSFORMS = new Map([
  ['1,0,0,1', { rotationDegrees: 0, flips: [], filters: [] }],
  ['-1,0,0,1', { rotationDegrees: 0, flips: ['horizontal'], filters: ['hflip'] }],
  ['1,0,0,-1', { rotationDegrees: 0, flips: ['vertical'], filters: ['vflip'] }],
  ['-1,0,0,-1', { rotationDegrees: 180, flips: [], filters: ['hflip', 'vflip'] }],
  ['0,-1,1,0', { rotationDegrees: 270, flips: [], filters: ['transpose=clock'] }],
  ['0,1,-1,0', { rotationDegrees: 90, flips: [], filters: ['transpose=cclock'] }],
  ['0,-1,-1,0', { rotationDegrees: 270, flips: ['horizontal'], filters: ['hflip', 'transpose=clock'] }],
  ['0,1,1,0', { rotationDegrees: 270, flips: ['vertical'], filters: ['vflip', 'transpose=clock'] }],
]);

function displayMatrixValues(text) {
  const rows = String(text).split(/\r?\n/).map(line => {
    const match = /:\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/.exec(line.trim());
    return match ? match.slice(1).map(Number) : null;
  }).filter(Boolean);
  return rows.length === 3 ? rows.flat() : null;
}

function normalizedMatrixComponent(value) {
  const normalized = Math.round(value / 65536);
  return Math.abs(value - normalized * 65536) <= 1 ? normalized : null;
}

function transformFromMatrix(values) {
  if (!values || values.length !== 9 || values.some(value => !Number.isFinite(value))) return null;
  const [a, b, translateX, c, d, translateY, perspectiveX, perspectiveY, scale] = values;
  const normalized = [a, b, c, d].map(normalizedMatrixComponent);
  if (normalized.includes(null) || perspectiveX !== 0 || perspectiveY !== 0 || scale !== 1073741824 || !Number.isInteger(translateX) || !Number.isInteger(translateY)) return null;
  const supported = DISPLAY_TRANSFORMS.get(normalized.join(','));
  return supported ? { ...supported, matrix: values, swapsDimensions: normalized[1] !== 0 } : null;
}

function transformFromRotation(raw) {
  const rotation = Number(raw || 0);
  if (!Number.isFinite(rotation)) return null;
  const normalized = ((rotation % 360) + 360) % 360;
  const nearest = Math.round(normalized / 90) * 90 % 360;
  if (Math.abs(normalized - nearest) > 0.001) return null;
  const key = new Map([[0, '1,0,0,1'], [90, '0,1,-1,0'], [180, '-1,0,0,-1'], [270, '0,-1,1,0']]).get(nearest);
  return { ...DISPLAY_TRANSFORMS.get(key), matrix: null, swapsDimensions: nearest === 90 || nearest === 270 };
}

function displayTransform(stream) {
  const side = (stream.side_data_list || []).find(entry => entry.rotation !== undefined || /display matrix/i.test(entry.side_data_type || ''));
  const matrixText = side && (side.displaymatrix || side.display_matrix);
  const transform = matrixText ? transformFromMatrix(displayMatrixValues(matrixText)) : transformFromRotation(side && side.rotation !== undefined ? side.rotation : stream.tags && stream.tags.rotate);
  if (!transform) throw new DraftError('display_transform_unsupported', 'display matrix contains scale, shear, perspective, or a non-orthogonal rotation', 're-encode the video with only exact 90-degree rotations or axis flips');
  return transform;
}

function displayRotation(stream) {
  return displayTransform(stream).rotationDegrees;
}

const SDR_PRIMARIES = new Set(['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m']);
const SDR_TRANSFER = new Set(['bt709', 'iec61966-2-1', 'smpte170m', 'smpte240m', 'gamma22', 'gamma28']);
const SDR_MATRIX = new Set(['bt709', 'bt470bg', 'smpte170m', 'smpte240m', 'rgb', 'gbr']);

function classifyStream(stream) {
  const primaries = stream.color_primaries;
  const transfer = stream.color_transfer;
  const matrix = stream.color_space;
  const range = stream.color_range;
  const bitDepth = sourceBitDepth(stream);
  const alpha = hasAlpha(stream);
  const hdr = transfer === 'smpte2084' || transfer === 'arib-std-b67';
  const dovi = /^(?:dvhe|dvh1)$/i.test(stream.codec_tag_string || '') || (stream.side_data_list || []).some(entry => /dovi|dolby vision/i.test(entry.side_data_type || ''));
  if (!primaries || !transfer || !matrix || !range || ['unknown', 'unspecified', 'reserved'].includes(primaries) || ['unknown', 'unspecified', 'reserved'].includes(transfer) || ['unknown', 'unspecified', 'reserved'].includes(matrix)) {
    throw new DraftError('color_metadata_ambiguous', 'video color metadata is missing or unspecified', 're-export the source with explicit color primaries, transfer, matrix, and range metadata');
  }
  if (dovi && !hdr) throw new DraftError('hdr_unsupported', 'Dolby Vision input has no supported tagged PQ or HLG base layer', 'provide an HDR10 PQ or HLG base-layer export');
  if (hdr) {
    if (primaries !== 'bt2020' || !['bt2020nc', 'bt2020c'].includes(matrix) || bitDepth < 10) throw new DraftError('color_metadata_ambiguous', `HDR metadata is inconsistent: primaries=${primaries}, transfer=${transfer}, matrix=${matrix}, depth=${bitDepth}`, 're-export HDR with consistent BT.2020 PQ or HLG metadata at 10 bits or greater');
    return { dynamicRange: transfer === 'smpte2084' ? 'hdr-pq' : 'hdr-hlg', primaries, transfer, matrix, range, bitDepth, alpha, extension: 'heic', codec: 'heic', intermediateExtension: 'tiff', intermediatePixelFormat: alpha ? 'rgba64le' : 'rgb48le', outputPixelFormat: '10-bit', outputDepth: '10', outputColor: transfer === 'smpte2084' ? 'bt2100-pq' : 'bt2100-hlg' };
  }
  if (!SDR_PRIMARIES.has(primaries) || !SDR_TRANSFER.has(transfer) || !SDR_MATRIX.has(matrix)) throw new DraftError('color_metadata_ambiguous', `unsupported or conflicting SDR metadata: primaries=${primaries}, transfer=${transfer}, matrix=${matrix}`, 're-export SDR with consistent BT.709, BT.601, or sRGB-family color metadata');
  const highDepth = bitDepth > 8;
  return { dynamicRange: 'sdr', primaries, transfer, matrix, range, bitDepth, alpha, extension: 'png', codec: 'png', outputPixelFormat: alpha ? (highDepth ? 'rgba64le' : 'rgba') : (highDepth ? 'rgb48le' : 'rgb24'), outputDepth: highDepth ? '16' : '8', outputColor: 'srgb' };
}

function selectVideoStream(streams) {
  const stream = (streams || []).find(candidate => candidate.codec_type === 'video' && !(candidate.disposition && candidate.disposition.attached_pic));
  if (!stream) throw new DraftError('stream_unsupported', 'input contains no non-attached-picture video stream', 'pass a file containing a real video stream');
  return stream;
}

function analyzePresentedFrames(frameData, color, options) {
  for (const frame of frameData.frames || []) {
    for (const [field, expected] of [['color_primaries', color.primaries], ['color_transfer', color.transfer], ['color_space', color.matrix], ['color_range', color.range]]) {
      if (frame[field] && frame[field] !== expected) throw new DraftError('color_metadata_ambiguous', `frame-level ${field} changes from ${expected} to ${frame[field]}`, 're-export the video with one consistent color description for the selected stream');
    }
  }
  const timeBase = parseTimeBase(options.timeBase);
  const frames = (frameData.frames || []).map(frame => ({ pts: integerTimestamp(frame.best_effort_timestamp), duration: integerTimestamp(frame.duration ?? frame.pkt_duration ?? '0') })).filter(frame => frame.pts !== null);
  if (!frames.length) throw new DraftError('input_unusable', 'selected video stream has no timestamped frames', 'repair or re-export the source with valid presentation timestamps');
  const origin = frames[0].pts;
  const normalized = frames.map(frame => ({ pts: frame.pts - origin, duration: frame.duration || 0n }));
  const last = normalized.at(-1);
  const durationTicks = last.pts + last.duration;
  const duration = ticksToNanoseconds(durationTicks, timeBase, true);
  const start = options.start === null ? 0n : options.start;
  const end = options.end === null ? duration : options.end;
  if (start < 0n || end < 0n || compareNanosecondsToTicks(start, durationTicks, timeBase) > 0 || compareNanosecondsToTicks(end, durationTicks, timeBase) > 0) throw new DraftError('window_out_of_range', `requested window ${formatTime(start)}..${formatTime(end)} is outside 0..${formatTime(duration)}`, `pass bounds between 0 and ${formatTime(duration)} seconds`);
  const startTick = ceilDivide(start * timeBase.denominator, timeBase.numerator * NS_PER_SECOND);
  const endTick = end * timeBase.denominator / (timeBase.numerator * NS_PER_SECOND);
  const selected = normalized.filter(frame => frame.pts >= startTick && frame.pts <= endTick);
  if (!selected.length) throw new DraftError('window_empty', `inclusive window ${formatTime(start)}..${formatTime(end)} contains no presented frame`, 'widen the window or choose a timestamp matching a presented frame');
  return { start, end, duration, startTick, endTick, expectedFrames: selected.length, firstTick: selected[0].pts, lastTick: selected.at(-1).pts, firstPts: ticksToNanoseconds(selected[0].pts, timeBase), lastPts: ticksToNanoseconds(selected.at(-1).pts, timeBase), timeBase };
}

async function inspectInput(manager, state, options) {
  const metadata = await readJson(manager, state.commands.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', state.paths.supplied], 'input_unusable', `ffprobe could not inspect input video: ${state.paths.supplied}`, 'confirm the file is a complete video ffmpeg can decode');
  const stream = selectVideoStream(metadata.streams);
  if (!stream.width || !stream.height) throw new DraftError('stream_unsupported', 'selected video stream has no valid dimensions', 're-export the source with a decodable video stream');
  const color = classifyStream(stream);
  const transform = displayTransform(stream);
  const frameData = await readJson(manager, state.commands.ffprobe, ['-v', 'error', '-select_streams', String(stream.index), '-show_frames', '-show_entries', 'frame=best_effort_timestamp,duration,pkt_duration,color_range,color_space,color_primaries,color_transfer,pix_fmt', '-of', 'json', state.paths.supplied], 'input_unusable', 'ffprobe could not enumerate frame timestamps', 'repair or re-export the video with valid presentation timestamps');
  const timing = analyzePresentedFrames(frameData, color, { ...options, timeBase: stream.time_base });
  const orientedWidth = transform.swapsDimensions ? stream.height : stream.width;
  const orientedHeight = transform.swapsDimensions ? stream.width : stream.height;
  return {
    stream,
    color,
    transform,
    width: orientedWidth,
    height: orientedHeight,
    sampleAspectRatio: stream.sample_aspect_ratio || '1:1',
    displayAspectRatio: stream.display_aspect_ratio || null,
    fieldOrder: stream.field_order || 'unknown',
    ...timing,
  };
}

function integerTimestamp(value) {
  return /^-?[0-9]+$/.test(String(value)) ? BigInt(value) : null;
}

function parseTimeBase(value) {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(value || ''));
  if (!match) throw new DraftError('stream_unsupported', `selected video stream has an invalid time base: ${value || 'missing'}`, 're-export the source with a valid video time base');
  return { numerator: BigInt(match[1]), denominator: BigInt(match[2]), text: value };
}

function ceilDivide(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function ticksToNanoseconds(ticks, timeBase, roundUp = false) {
  const numerator = ticks * timeBase.numerator * NS_PER_SECOND;
  return roundUp ? ceilDivide(numerator, timeBase.denominator) : numerator / timeBase.denominator;
}

function compareNanosecondsToTicks(nanoseconds, ticks, timeBase) {
  const left = nanoseconds * timeBase.denominator;
  const right = ticks * timeBase.numerator * NS_PER_SECOND;
  return left < right ? -1 : left > right ? 1 : 0;
}

function ffmpegArguments(state, temporary) {
  const media = state.media;
  const color = media.color;
  const filters = filterGraph(media);
  const conversion = colorConversionFilter(color);
  const output = path.join(temporary, `frame-%06d.${color.intermediateExtension || color.extension}`);
  const codec = codecArguments(color);
  return ['-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-noautorotate', '-progress', 'pipe:1', '-nostats', '-i', state.paths.supplied, '-map', `0:${media.stream.index}`, '-an', '-sn', '-dn', '-vf', `${filters},${conversion}`, '-fps_mode', 'passthrough', '-start_number', '1', ...codec, '-f', 'image2', '-n', output];
}

function codecArguments(color) {
  return color.codec === 'png'
    ? ['-c:v', 'png', '-compression_level', '9']
    : ['-c:v', 'tiff'];
}

function filterGraph(media, startTick = media.startTick, endTick = media.endTick) {
  return [`setpts=PTS-STARTPTS`, `select=between(pts\\,${startTick}\\,${endTick})`, ...media.transform.filters].join(',');
}

function colorConversionFilter(color) {
  const inputRange = color.range === 'pc' || color.range === 'jpeg' ? 'full' : 'limited';
  if (color.dynamicRange !== 'sdr') {
    const planar = color.alpha ? 'gbrap16le' : 'gbrp16le';
    return `zscale=primariesin=bt2020:transferin=${color.transfer}:matrixin=${color.matrix}:rangein=${inputRange}:primaries=bt2020:transfer=${color.transfer}:matrix=gbr:range=full,format=${planar},format=${color.intermediatePixelFormat}`;
  }
  const planar = color.alpha
    ? (color.bitDepth > 8 ? 'gbrap16le' : 'gbrap')
    : (color.bitDepth > 8 ? 'gbrp16le' : 'gbrp');
  return `zscale=primariesin=${color.primaries}:transferin=${color.transfer}:matrixin=${color.matrix}:rangein=${inputRange}:primaries=bt709:transfer=iec61966-2-1:matrix=gbr:range=full,format=${planar},format=${color.outputPixelFormat}`;
}

function decodeProbeArguments(state) {
  const media = state.media;
  const conversion = colorConversionFilter(media.color);
  const output = media.color.dynamicRange === 'sdr' ? '-' : path.join(state.encoderDirectory, 'preflight-frame.tiff');
  const format = media.color.dynamicRange === 'sdr' ? 'null' : 'image2';
  return ['-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-noautorotate', '-progress', 'pipe:1', '-nostats', '-i', state.paths.supplied, '-map', `0:${media.stream.index}`, '-an', '-sn', '-dn', '-vf', `${filterGraph(media, media.firstTick, media.firstTick)},${conversion}`, '-frames:v', '1', ...codecArguments(media.color), '-f', format, '-n', output];
}

async function representativeDecodePreflight(manager, state) {
  const hdr = state.media.color.dynamicRange !== 'sdr';
  const tiff = hdr ? path.join(state.encoderDirectory, 'preflight-frame.tiff') : null;
  const heic = hdr ? path.join(state.encoderDirectory, 'preflight-frame.heic') : null;
  try {
    const result = await manager.run(state.commands.ffmpeg, decodeProbeArguments(state));
    if (mediaFailed(result)) throw new DraftError('input_decode_failed', `ffmpeg could not decode and convert a representative selected frame${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'repair or re-export the input with a supported video codec and color description', EXIT.CANNOT_START, childDetails('input_decode_failed', result));
    if (!/(?:^|\n)frame=1(?:\r?\n|$)/.test(result.stdout)) throw new DraftError('input_decode_failed', 'ffmpeg completed the representative decode probe without producing the selected frame', 'repair or re-export the input with valid presentation timestamps', EXIT.CANNOT_START, childDetails('input_decode_failed', result));
    if (hdr) {
      await encodeHeic(manager, state, tiff, heic, EXIT.CANNOT_START);
      await inspectHeic(manager, state, heic, path.basename(heic), EXIT.CANNOT_START);
    }
  } finally {
    for (const filename of [tiff, heic].filter(Boolean)) { try { fs.rmSync(filename, { force: true }); } catch {} }
  }
}

async function syntheticEncoderPreflight(manager, state) {
  const tiff = path.join(state.encoderDirectory, 'preflight-synthetic.tiff');
  const heic = path.join(state.encoderDirectory, 'preflight-synthetic.heic');
  const color = classifyStream({ pix_fmt: 'yuv420p10le', color_primaries: 'bt2020', color_transfer: 'arib-std-b67', color_space: 'bt2020nc', color_range: 'tv' });
  const originalMedia = state.media;
  state.media = { color, width: 64, height: 64 };
  try {
    const filters = `format=yuv420p10le,setparams=range=limited:color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc,${colorConversionFilter(color)}`;
    const result = await manager.run(state.commands.ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-f', 'lavfi', '-i', 'color=c=white:s=64x64:d=0.04', '-vf', filters, '-frames:v', '1', '-c:v', 'tiff', '-f', 'image2', '-n', tiff]);
    if (mediaFailed(result)) throw new DraftError('heic_encoder_unavailable', `ffmpeg could not create the synthetic HLG preflight frame${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'repair ffmpeg-full and run the same command again', EXIT.CANNOT_START, childDetails('heic_encoder_unavailable', result));
    await encodeHeic(manager, state, tiff, heic, EXIT.CANNOT_START);
    await inspectHeic(manager, state, heic, path.basename(heic), EXIT.CANNOT_START);
  } finally {
    state.media = originalMedia;
    for (const filename of [tiff, heic]) { try { fs.rmSync(filename, { force: true }); } catch {} }
  }
}

function hdrTransfer(color) {
  return color.transfer === 'smpte2084' ? 'pq' : 'hlg';
}

async function encodeHeic(manager, state, input, output, exitCode = EXIT.FAILED) {
  const result = await manager.run(state.commands.encoder, [input, output, hdrTransfer(state.media.color)]);
  if (result.code !== 0) throw new DraftError('heic_encode_failed', `HDR TIFF-to-HEIC encoding failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'repair the reported Core Image encoder failure and run again', exitCode, childDetails('heic_encode_failed', result));
}

async function inspectHeic(manager, state, filename, displayName, exitCode = EXIT.FAILED) {
  const result = await manager.run(state.commands.sips, ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'bitsPerSample', '-g', 'profile', filename]);
  if (result.code !== 0) throw new DraftError('structural_check_failed', `sips could not inspect extracted frame: ${displayName}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'repair the Core Image HEIC encoder and run again', exitCode, childDetails('structural_check_failed', result));
  const value = key => new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(result.stdout)?.[1].trim();
  const width = Number(value('pixelWidth'));
  const height = Number(value('pixelHeight'));
  const depth = Number(value('bitsPerSample'));
  const profile = value('profile') || '';
  const wantedProfile = state.media.color.dynamicRange === 'hdr-pq' ? /BT\.2100 PQ/i : /BT\.2100 HLG/i;
  if (width !== state.media.width || height !== state.media.height || depth !== 10 || !wantedProfile.test(profile)) throw new DraftError('structural_check_failed', `frame structure does not match 10-bit ${state.media.color.outputColor} HEIC ${state.media.width}x${state.media.height}: ${displayName}`, 'repair the FFmpeg TIFF conversion or Core Image HEIC encoder and run again', exitCode);
  return { file: displayName, codec: 'heic', pixelFormat: '10-bit', width, height, profile };
}

async function convertHdrFrames(manager, state, temporary) {
  const files = fs.readdirSync(temporary).filter(name => /^frame-[0-9]{6,}\.tiff$/.test(name)).sort();
  if (files.length !== state.media.expectedFrames) throw new DraftError('structural_check_failed', `expected ${state.media.expectedFrames} TIFF intermediates but found ${files.length}`, 'repair the reported FFmpeg extraction failure and run again', EXIT.FAILED);
  let next = 0;
  let failure = null;
  async function worker() {
    while (!failure && next < files.length) {
      const file = files[next++];
      const input = path.join(temporary, file);
      const output = path.join(temporary, file.replace(/\.tiff$/, '.heic'));
      try {
        await encodeHeic(manager, state, input, output);
        fs.rmSync(input);
      } catch (error) { failure = error; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(10, files.length) }, worker));
  if (failure) throw failure;
}

function progressReporter(json) {
  let pending = '';
  let last = 0;
  return chunk => {
    if (json) return;
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      const match = /^frame=([0-9]+)$/.exec(line.trim());
      if (match && Number(match[1]) >= last + 100) {
        last = Number(match[1]);
        process.stderr.write(`Extracted ${last} frames\n`);
      }
    }
  };
}

async function structuralChecks(manager, state, temporary) {
  const extension = state.media.color.extension;
  const pattern = new RegExp(`^frame-([0-9]{6,})\\.${extension}$`);
  const files = fs.readdirSync(temporary).filter(name => pattern.test(name)).sort();
  if (files.length !== state.media.expectedFrames) throw new DraftError('structural_check_failed', `expected ${state.media.expectedFrames} frames but found ${files.length}`, 'repair the reported FFmpeg extraction failure and run again', EXIT.FAILED);
  for (const file of files) if (fs.statSync(path.join(temporary, file)).size <= 0) throw new DraftError('structural_check_failed', `empty frame file: ${file}`, 'repair the reported FFmpeg encoder failure and run again', EXIT.FAILED);
  const probes = [];
  for (const file of [files[0], files.at(-1)]) {
    if (state.media.color.codec === 'heic') {
      probes.push(await inspectHeic(manager, state, path.join(temporary, file), file));
      continue;
    }
    const data = await readJson(manager, state.commands.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', path.join(temporary, file)], 'structural_check_failed', `ffprobe could not inspect extracted frame: ${file}`, 'repair the FFmpeg image encoder and run again', EXIT.FAILED);
    const stream = (data.streams || [])[0];
    if (!stream || stream.codec_name !== state.media.color.codec || stream.width !== state.media.width || stream.height !== state.media.height) throw new DraftError('structural_check_failed', `frame structure does not match ${state.media.color.codec} ${state.media.width}x${state.media.height}: ${file}`, 'repair the FFmpeg filter or image encoder and run again', EXIT.FAILED);
    probes.push({ file, codec: stream.codec_name, pixelFormat: stream.pix_fmt, width: stream.width, height: stream.height });
  }
  return { files, probes };
}

function preflightPayload(state) {
  const { encoder: _encoder, ...commands } = state.commands;
  const payload = { status: 'ready', platform: state.platform, commands };
  if (!state.media) return payload;
  return { ...payload, input: state.paths.supplied, resolvedInput: state.paths.resolved, outputDirectory: state.paths.output, streamIndex: state.media.stream.index, dynamicRange: state.media.color.dynamicRange, outputFormat: state.media.color.codec, outputDepth: state.media.color.outputDepth, dimensions: `${state.media.width}x${state.media.height}`, expectedFrames: state.media.expectedFrames, requestedWindow: { startSeconds: formatTime(state.media.start), endSeconds: formatTime(state.media.end) }, firstPtsSeconds: formatTime(state.media.firstPts), lastPtsSeconds: formatTime(state.media.lastPts) };
}

function resultPayload(state, checks) {
  const media = state.media;
  return {
    status: 'complete',
    input: state.paths.supplied,
    resolvedInput: state.paths.resolved,
    outputDirectory: state.paths.output,
    streamIndex: media.stream.index,
    dynamicRange: media.color.dynamicRange,
    sourceColor: { primaries: media.color.primaries, transfer: media.color.transfer, matrix: media.color.matrix, range: media.color.range, bitDepth: media.color.bitDepth },
    output: { format: media.color.codec, extension: media.color.extension, pixelFormat: media.color.outputPixelFormat, depth: media.color.outputDepth, colorSpace: media.color.outputColor, alpha: media.color.alpha, compression: media.color.codec === 'heic' ? 'heic-quality-1.0' : 'png-lossless' },
    dimensions: { width: media.width, height: media.height },
    orientation: { rotationDegrees: media.transform.rotationDegrees, flips: media.transform.flips, filters: media.transform.filters, applied: media.transform.filters.length > 0 },
    aspect: { sample: media.sampleAspectRatio, display: media.displayAspectRatio },
    fieldOrder: media.fieldOrder,
    window: { startSeconds: formatTime(media.start), endSeconds: formatTime(media.end), firstPtsSeconds: formatTime(media.firstPts), lastPtsSeconds: formatTime(media.lastPts), inclusive: true },
    frames: media.expectedFrames,
    checks: [
      { name: 'ffmpeg extraction completed', status: 'pass' },
      { name: `published frame count is ${media.expectedFrames}`, status: 'pass' },
      { name: 'all frame files are nonempty', status: 'pass' },
      { name: 'first and last frame structure match the output contract', status: 'pass', probes: checks.probes },
      { name: 'source identity is unchanged', status: 'pass' },
    ],
  };
}

function emit(payload, json, kind = 'result') {
  if (json) { process.stdout.write(`${JSON.stringify({ [kind]: payload })}\n`); return; }
  if (kind === 'preflight') {
    process.stdout.write(`READY: ${payload.platform.os}${payload.expectedFrames ? `, ${payload.expectedFrames} frames -> ${payload.outputDirectory}` : ''}\n`);
    return;
  }
  process.stdout.write([
    `Output: ${payload.outputDirectory}`,
    `Frames: ${payload.frames}`,
    `Format: ${payload.output.format}, ${payload.output.depth}, ${payload.output.colorSpace}`,
    `Dynamic range: ${payload.dynamicRange}`,
    `Dimensions: ${payload.dimensions.width}x${payload.dimensions.height}`,
    `Window: ${payload.window.startSeconds}..${payload.window.endSeconds} inclusive`,
    `Actual PTS: ${payload.window.firstPtsSeconds}..${payload.window.lastPtsSeconds}`,
    'Status: complete structural checks',
  ].join('\n') + '\n');
}

function emitError(error, json) {
  const payload = { code: error.code || 'unexpected_failure', condition: error.condition || error.message, remedy: error.remedy || 'inspect the reported failure and run again' };
  for (const key of ['failures', 'task', 'childExitCode', 'childSignal', 'stderr']) if (error[key] !== undefined) payload[key] = error[key];
  if (json) process.stderr.write(`${JSON.stringify({ error: payload })}\n`);
  else {
    process.stderr.write(`ERROR [${payload.code}]: ${payload.condition}\n`);
    if (payload.failures) for (const failure of payload.failures) process.stderr.write(`  [${failure.code}] ${failure.condition}\n      Remedy: ${failure.remedy}\n`);
    process.stderr.write(`Remedy: ${payload.remedy}\n`);
    for (const key of ['task', 'childExitCode', 'childSignal', 'stderr']) if (payload[key] !== undefined) process.stderr.write(`${key}: ${JSON.stringify(payload[key])}\n`);
  }
}

function usage(basename = 'extract-video-frames.js') {
  return `Usage: ${basename} [OPTIONS] INPUT_VIDEO\n\nOptions:\n  --start TIME       Inclusive start, decimal seconds or HH:MM:SS[.fraction]\n  --end TIME         Inclusive end, decimal seconds or HH:MM:SS[.fraction]\n  --preflight        Check readiness and input without creating frames\n  --json             Emit machine-readable readiness, result, or error data\n  -h, --help         Print this message\n  --                 Stop option parsing\n\nOutput:\n  <input-stem>-frames/frame-000001.png   for SDR\n  <input-stem>-frames/frame-000001.heic  for PQ or HLG HDR\n\nExit status:\n  0 success or passed preflight; 2 work did not start; 1 work started and failed\n  129 SIGHUP; 130 SIGINT; 143 SIGTERM\n`;
}

async function compileEncoder(manager, state, encoderDirectory) {
  const source = path.join(__dirname, 'tiff-to-heic.swift');
  const encoder = path.join(encoderDirectory, 'tiff-to-heic');
  const result = await manager.run(state.commands.swiftc, [source, '-o', encoder]);
  if (result.code !== 0) throw new DraftError('heic_encoder_unavailable', `Swift HEIC helper could not compile${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'install or repair the macOS Command Line Tools with xcode-select --install', EXIT.CANNOT_START, childDetails('heic_encoder_unavailable', result));
  state.commands.encoder = encoder;
  state.encoderDirectory = encoderDirectory;
}

async function prepare(manager, options, encoderDirectory) {
  try {
    const paths = options.input ? validateInputAndOutput(options.input) : null;
    const platform = await platformPreflight(manager);
    const toolchain = await toolchainPreflight(manager, platform);
    const state = { ...toolchain };
    await compileEncoder(manager, state, encoderDirectory);
    if (paths) {
      state.paths = paths;
      state.media = await inspectInput(manager, state, options);
      await representativeDecodePreflight(manager, state);
    } else await syntheticEncoderPreflight(manager, state);
    return state;
  } catch (error) {
    if (error instanceof DraftError) throw error;
    throw new DraftError('preflight_failed', `preflight could not complete: ${errorText(error)}`, 'fix the reported filesystem or process-launch failure, then run the same command again', EXIT.CANNOT_START, Object.fromEntries(['task', 'childExitCode', 'childSignal', 'stderr'].filter(key => error[key] !== undefined).map(key => [key, error[key]])));
  }
}

async function publishDirectoryNoReplace(manager, state, temporary) {
  const output = state.paths.output;
  const args = ['-l', 'JavaScript', '-e', MACOS_PUBLISH_SCRIPT, '--', temporary, output];
  let result;
  try { result = await manager.run(state.commands.publisher, args); } catch (error) {
    throw new DraftError('publication_failed', `atomic publication command could not start: ${errorText(error)}`, 'restore the required system publication command, then run again', EXIT.FAILED);
  }
  if (result.code === 0 && result.stdout.trim() === 'published') return;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new DraftError('publication_failed', `output was not published without replacement: ${output}${detail ? `: ${detail}` : ''}`, 'move or remove any competing output, fix destination permissions, then run again', EXIT.FAILED);
}

async function main(argv) {
  let options;
  const manager = new ProcessManager();
  let temporary = null;
  let encoderDirectory = null;
  const signalHandler = signal => manager.interrupt(signal);
  for (const signal of Object.keys(SIGNAL_EXIT)) process.once(signal, signalHandler);
  try {
    options = parseArguments(argv, path.basename(process.argv[1] || 'extract-video-frames.js'));
    if (options.help) { process.stdout.write(usage(path.basename(process.argv[1] || 'extract-video-frames.js'))); return EXIT.OK; }
    encoderDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-video-frames-encoder-'));
    const state = await prepare(manager, options, encoderDirectory);
    if (manager.signal) return SIGNAL_EXIT[manager.signal];
    if (options.preflight) { emit(preflightPayload(state), options.json, 'preflight'); return EXIT.OK; }
    if (pathExists(state.paths.output)) throw new DraftError('output_collision', `output appeared during preflight: ${state.paths.output}`, 'move or remove the existing path, then run again');
    temporary = fs.mkdtempSync(path.join(path.dirname(state.paths.output), `.${path.basename(state.paths.output)}.partial-`));
    const extraction = await manager.run(state.commands.ffmpeg, ffmpegArguments(state, temporary), { progress: progressReporter(options.json) });
    if (manager.signal) return SIGNAL_EXIT[manager.signal];
    if (mediaFailed(extraction)) throw new DraftError('extraction_failed', `ffmpeg extraction failed${extraction.stderr.trim() ? `: ${extraction.stderr.trim()}` : ''}`, 'fix the reported decode, color-conversion, or image-encoder error and run again', EXIT.FAILED, childDetails('extraction', extraction));
    if (state.media.color.dynamicRange !== 'sdr') await convertHdrFrames(manager, state, temporary);
    if (manager.signal) return SIGNAL_EXIT[manager.signal];
    const checks = await structuralChecks(manager, state, temporary);
    manager.assertRunning();
    assertSourceUnchanged(state.paths);
    await publishDirectoryNoReplace(manager, state, temporary);
    temporary = null;
    emit(resultPayload(state, checks), options.json);
    return EXIT.OK;
  } catch (error) {
    if (manager.signal) return SIGNAL_EXIT[manager.signal];
    emitError(error, options ? options.json : argv.includes('--json'));
    return error.exitCode || EXIT.FAILED;
  } finally {
    if (manager.active.size || manager.signal) await manager.interrupt(manager.signal || 'SIGTERM');
    if (temporary) { try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {} }
    if (encoderDirectory) { try { fs.rmSync(encoderDirectory, { recursive: true, force: true }); } catch {} }
    for (const signal of Object.keys(SIGNAL_EXIT)) process.removeListener(signal, signalHandler);
  }
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { emitError(error, process.argv.includes('--json')); process.exitCode = EXIT.FAILED; });

module.exports = { emitError, ProcessManager, analyzePresentedFrames, assertSourceUnchanged, boundedTail, classifyStream, codecArguments, colorConversionFilter, convertHdrFrames, decodeProbeArguments, derivePaths, displayRotation, ffmpegArguments, formatTime, identity, parseArguments, parseTime, prepare, publishDirectoryNoReplace, representativeDecodePreflight, resultPayload, selectVideoStream, structuralChecks, transformFromMatrix };
