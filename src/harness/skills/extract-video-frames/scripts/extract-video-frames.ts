#!/usr/bin/env node
'use strict';

import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import commandResolution = require('../../../shared/node/resolve-command.js');
const { resolveCommand } = commandResolution;
import mediaResult = require('../../../shared/node/media-result.js');
const { mediaFailed, childDetails } = mediaResult;
import frameProcesses = require('./process-manager.js');
const { ProcessManager, boundedTail } = frameProcesses;
import frameErrors = require('./errors.js');
const { DraftError, errorText, errorFields, spoolStorageError, SIGNAL_EXIT, EXIT } = frameErrors;
import mediaModel = require('./media-model.js');
const { analyzeFrameSpool, parseTime, formatTime, identity, sameIdentity, commandRemedy, descriptorMap, pixelProperties, classifyStream, displayTransform, displayRotation, selectVideoStream, transformFromMatrix, metadataRecord } = mediaModel;


import type { ExtractionSignal } from './errors.js';
import type { ColorPlan, DisplayTransform, FrameWindow, PixelDescriptors, SourceIdentity, StreamMetadata } from './media-model.js';

type Manager = InstanceType<typeof ProcessManager>;
interface ExtractionOptions {
  input: string | null;
  start: bigint | null;
  end: bigint | null;
  preflight: boolean;
  json: boolean;
  help: boolean;
}
interface InputPaths { supplied: string; output: string; resolved: string; sourceIdentity: SourceIdentity }
interface ToolCommands { ffmpeg: string; ffprobe: string; publisher: string; swiftc: string; sips: string; encoder?: string }
interface Platform { os: string; version: string }
interface Toolchain { platform: Platform; commands: ToolCommands; pixelDescriptors: PixelDescriptors }
interface ToolchainPrepared extends Toolchain { encoderDirectory: string; paths?: never; media?: undefined }
interface InputSetup extends Toolchain { encoderDirectory: string; paths: InputPaths }
interface InspectedMedia extends FrameWindow {
  stream: StreamMetadata;
  color: ColorPlan;
  transform: DisplayTransform;
  width: number;
  height: number;
  sampleAspectRatio: unknown;
  displayAspectRatio: unknown;
  fieldOrder: unknown;
}
export interface PreparedExtraction extends InputSetup { media: InspectedMedia }
interface HeicState { commands: ToolCommands; media: Pick<InspectedMedia, 'color' | 'width' | 'height'> }
interface CleanupFailure { path: string; code: unknown; condition: string }
interface PreflightResult {
  status: 'ready'; platform: Platform; commands: Omit<ToolCommands, 'encoder'>;
  input?: string; resolvedInput?: string; outputDirectory?: string; streamIndex?: unknown;
  dynamicRange?: string; outputFormat?: string; outputDepth?: string; dimensions?: string;
  expectedFrames?: number; requestedWindow?: { startSeconds: string; endSeconds: string };
  firstPtsSeconds?: string; lastPtsSeconds?: string; cleanupFailures?: CleanupFailure[];
}
export type ExtractionResult = ReturnType<typeof resultPayload> & { cleanupFailures?: CleanupFailure[] };
type StructuralChecks = Awaited<ReturnType<typeof structuralChecks>>;

const MINIMUM_NODE = Object.freeze([20, 6, 0]);
const MINIMUM_MACOS = Object.freeze([26, 0, 0]);
const MACOS_PUBLISH_SCRIPT = 'ObjC.import("Foundation"); function run(argv) { const manager = $.NSFileManager.defaultManager; const ok = manager.moveItemAtPathToPathError(argv[0], argv[1], null); if (ok) return "published"; return manager.fileExistsAtPath(argv[1]) ? "collision" : "failed"; }';
function versionAtLeast(actual: string, minimum: readonly number[]) {
  const parts = String(actual).match(/\d+/g)?.map(Number) || [];
  for (let index = 0; index < minimum.length; index += 1) {
    if ((parts[index] || 0) > minimum[index]!) return true;
    if ((parts[index] || 0) < minimum[index]!) return false;
  }
  return true;
}

function parseArguments(argv: string[], basename = 'extract-video-frames.js') {
  const options: ExtractionOptions = { input: null, start: null, end: null, preflight: false, json: false, help: false };
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
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
      options[flag === '--start' ? 'start' : 'end'] = parseTime(value, flag);
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

function derivePaths(input: string) {
  const supplied = path.resolve(input);
  const parsed = path.parse(supplied);
  const stem = parsed.ext ? parsed.name : parsed.base;
  return { supplied, output: path.join(parsed.dir, `${stem}-frames`) };
}

function pathExists(pathname: string) {
  try { fs.lstatSync(pathname); return true; } catch (error) {
    if (errorFields(error).code === 'ENOENT') return false;
    throw error;
  }
}

function validateInputAndOutput(input: string): InputPaths {
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

function assertSourceUnchanged(paths: InputPaths) {
  let current;
  try { current = identity(fs.statSync(paths.supplied)); } catch {
    throw new DraftError('source_changed', 'input became inaccessible during extraction', 'restore a stable source file, then run again', EXIT.FAILED);
  }
  if (!sameIdentity(paths.sourceIdentity, current)) throw new DraftError('source_changed', 'input identity, size, or modification time changed during extraction', 'wait until the source file is stable, then run again', EXIT.FAILED);
}

function parseListing(text: string) {
  return new Set(text.split(/\r?\n/).flatMap(line => line.trim().split(/\s+/)));
}

async function platformPreflight(manager: Manager) {
  if (!versionAtLeast(process.version, MINIMUM_NODE)) throw new DraftError('node_version_unsupported', `Node.js 20.6.0 or newer is required, running ${process.version}`, 'install Node.js 20.6.0 or newer');
  if (process.platform !== 'darwin') throw new DraftError('platform_unsupported', `unsupported platform: ${process.platform}`, 'run this skill on macOS 26.0 or newer');
  const swVers = resolveCommand('sw_vers');
  if (!swVers) throw new DraftError('command_missing', 'macOS sw_vers was not found', 'restore /usr/bin/sw_vers, which ships with macOS');
  const result = await manager.run(swVers, ['-productVersion']);
  const version = result.stdout.trim();
  if (result.code !== 0 || !versionAtLeast(version, MINIMUM_MACOS)) throw new DraftError('platform_unsupported', `macOS 26.0 or newer is required, running ${version || 'an unknown version'}`, 'upgrade this Mac to macOS 26.0 or newer');
  return { os: 'macos', version };
}

function executablePair(directory: string) {
  const ffmpeg = path.join(directory, 'ffmpeg');
  const ffprobe = path.join(directory, 'ffprobe');
  try {
    fs.accessSync(ffmpeg, fs.constants.X_OK);
    fs.accessSync(ffprobe, fs.constants.X_OK);
    return { ffmpeg: fs.realpathSync(ffmpeg), ffprobe: fs.realpathSync(ffprobe) };
  } catch { return null; }
}

async function resolveFfmpegPair(manager: Manager) {
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

async function toolchainPreflight(manager: Manager, platform: Platform): Promise<Toolchain> {
  const mediaTools = await resolveFfmpegPair(manager);
  let publisher = null;
  try { fs.accessSync('/usr/bin/osascript', fs.constants.X_OK); publisher = '/usr/bin/osascript'; } catch {}
  const commands = { ...mediaTools, publisher, swiftc: resolveCommand('swiftc'), sips: resolveCommand('sips') };
  const failures = [];
  for (const name of ['ffmpeg', 'ffprobe'] as const) if (!commands[name]) failures.push({ code: 'command_missing', condition: `required command not found: ${name}`, remedy: commandRemedy() });
  if (!commands.publisher) failures.push({ code: 'publication_unsupported', condition: 'required publication command not found: /usr/bin/osascript', remedy: 'restore /usr/bin/osascript, which ships with macOS' });
  if (!commands.swiftc) failures.push({ code: 'command_missing', condition: 'required command not found: swiftc', remedy: 'install the macOS Command Line Tools with xcode-select --install' });
  if (!commands.sips) failures.push({ code: 'command_missing', condition: 'required command not found: sips', remedy: 'restore /usr/bin/sips, which ships with macOS' });
  if (commands.ffmpeg) {
    for (const [flag, wanted] of [
      ['-filters', ['zscale', 'select', 'setpts', 'format', 'transpose', 'hflip', 'vflip']],
      ['-encoders', ['png', 'tiff']],
      ['-muxers', ['image2']],
      ['-pix_fmts', ['rgb24', 'rgb48le', 'rgba', 'rgba64le']],
    ] as const) {
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
  if (failures.length || !commands.ffmpeg || !commands.ffprobe || !commands.publisher || !commands.swiftc || !commands.sips) throw new DraftError('preflight_failed', `${failures.length} toolchain preflight check(s) failed`, commandRemedy(), EXIT.CANNOT_START, { failures });
  const pixelDescriptors = descriptorMap(await readJson(manager, commands.ffprobe, ['-v', 'error', '-show_pixel_formats', '-of', 'json'], 'ffprobe_probe_failed', 'ffprobe could not report pixel format descriptors', commandRemedy()));
  return { platform, commands: { ...commands, ffmpeg: commands.ffmpeg, ffprobe: commands.ffprobe, publisher: commands.publisher, swiftc: commands.swiftc, sips: commands.sips }, pixelDescriptors };
}

async function readJson(manager: Manager, command: string, args: string[], code: string, condition: string, remedy: string, exitCode: number = EXIT.CANNOT_START): Promise<unknown> {
  const result = await manager.run(command, args);
  if (mediaFailed(result)) throw new DraftError(code, `${condition}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, remedy, exitCode, childDetails(code, result));
  try { return JSON.parse(result.stdout); } catch { throw new DraftError(code, `${condition}: output was not valid JSON`, remedy, exitCode, childDetails(code, result)); }
}

async function inspectInput(manager: Manager, state: InputSetup, options: ExtractionOptions): Promise<InspectedMedia> {
  const metadata = await readJson(manager, state.commands.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', state.paths.supplied], 'input_unusable', `ffprobe could not inspect input video: ${state.paths.supplied}`, 'confirm the file is a complete video ffmpeg can decode');
  const stream = selectVideoStream(metadataRecord(metadata).streams);
  if (typeof stream.width !== 'number' || typeof stream.height !== 'number' || !stream.width || !stream.height) throw new DraftError('stream_unsupported', 'selected video stream has no valid dimensions', 're-export the source with a decodable video stream');
  const color = classifyStream(stream, pixelProperties(stream, state.pixelDescriptors));
  const transform = displayTransform(stream);
  const spool = path.join(state.encoderDirectory, 'frame-metadata.json');
  const result = await manager.run(state.commands.ffprobe, ['-v', 'error', '-threads', '0', '-select_streams', String(stream.index), '-show_frames', '-show_entries', 'frame=best_effort_timestamp,duration,pkt_duration,color_range,color_space,color_primaries,color_transfer,pix_fmt', '-of', 'json', state.paths.supplied], { stdoutFile: spool });
  manager.assertRunning();
  if (mediaFailed(result)) {
    const details = childDetails('input_unusable', result);
    if (/no space left on device|ENOSPC|disk quota exceeded/i.test(result.stderr)) throw spoolStorageError(spool, new Error(result.stderr.trim()), details);
    throw new DraftError('input_unusable', `ffprobe could not enumerate frame timestamps${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'repair or re-export the video with valid presentation timestamps', EXIT.CANNOT_START, details);
  }
  let timing;
  try {
    timing = await analyzeFrameSpool(spool, color, { ...options, timeBase: stream.time_base }, { assertRunning: () => manager.assertRunning() });
  } catch (error) {
    if (error instanceof DraftError && error.code === 'input_unusable' && error.condition.endsWith('output was not valid JSON')) Object.assign(error, childDetails('input_unusable', result));
    throw error;
  }
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

function ffmpegArguments(state: PreparedExtraction, temporary: string) {
  const media = state.media;
  const color = media.color;
  const filters = filterGraph(media);
  const conversion = colorConversionFilter(color);
  const output = path.join(temporary, `frame-%06d.${color.intermediateExtension || color.extension}`);
  const codec = codecArguments(color);
  return ['-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-noautorotate', '-progress', 'pipe:1', '-nostats', '-i', state.paths.supplied, '-map', `0:${media.stream.index}`, '-an', '-sn', '-dn', '-vf', `${filters},${conversion}`, '-fps_mode', 'passthrough', '-start_number', '1', ...codec, '-f', 'image2', '-n', output];
}

function codecArguments(color: ColorPlan) {
  return color.codec === 'png'
    ? ['-c:v', 'png', '-compression_level', '6']
    : ['-c:v', 'tiff'];
}

function filterGraph(media: InspectedMedia, startTick = media.startTick, endTick = media.endTick) {
  return [`setpts=PTS-STARTPTS`, `select=between(pts\\,${startTick}\\,${endTick})`, ...media.transform.filters].join(',');
}

function colorConversionFilter(color: ColorPlan) {
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

function decodeProbeArguments(state: PreparedExtraction) {
  const media = state.media;
  const conversion = colorConversionFilter(media.color);
  const output = media.color.dynamicRange === 'sdr' ? '-' : path.join(state.encoderDirectory, 'preflight-frame.tiff');
  const format = media.color.dynamicRange === 'sdr' ? 'null' : 'image2';
  return ['-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-noautorotate', '-progress', 'pipe:1', '-nostats', '-i', state.paths.supplied, '-map', `0:${media.stream.index}`, '-an', '-sn', '-dn', '-vf', `${filterGraph(media, media.firstTick, media.firstTick)},${conversion}`, '-frames:v', '1', ...codecArguments(media.color), '-f', format, '-n', output];
}

async function representativeDecodePreflight(manager: Manager, state: PreparedExtraction) {
  const hdr = state.media.color.dynamicRange !== 'sdr';
  const tiff = hdr ? path.join(state.encoderDirectory, 'preflight-frame.tiff') : null;
  const heic = hdr ? path.join(state.encoderDirectory, 'preflight-frame.heic') : null;
  // The invocation-owned encoder directory is cleaned after children terminate.
  const result = await manager.run(state.commands.ffmpeg, decodeProbeArguments(state));
  if (mediaFailed(result)) throw new DraftError('input_decode_failed', `ffmpeg could not decode and convert a representative selected frame${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'repair or re-export the input with a supported video codec and color description', EXIT.CANNOT_START, childDetails('input_decode_failed', result));
  if (!/(?:^|\n)frame=1(?:\r?\n|$)/.test(result.stdout)) throw new DraftError('input_decode_failed', 'ffmpeg completed the representative decode probe without producing the selected frame', 'repair or re-export the input with valid presentation timestamps', EXIT.CANNOT_START, childDetails('input_decode_failed', result));
  if (hdr) {
    await encodeHeic(manager, state, tiff!, heic!, EXIT.CANNOT_START);
    await inspectHeic(manager, state, heic!, path.basename(heic!), EXIT.CANNOT_START);
  }
}

async function syntheticEncoderPreflight(manager: Manager, state: ToolchainPrepared) {
  const tiff = path.join(state.encoderDirectory, 'preflight-synthetic.tiff');
  const heic = path.join(state.encoderDirectory, 'preflight-synthetic.heic');
  const stream = { pix_fmt: 'yuv420p10le', color_primaries: 'bt2020', color_transfer: 'arib-std-b67', color_space: 'bt2020nc', color_range: 'tv' };
  const color = classifyStream(stream, pixelProperties(stream, state.pixelDescriptors));
  const syntheticState = { ...state, media: { color, width: 64, height: 64 } };
  const filters = `format=yuv420p10le,setparams=range=limited:color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc,${colorConversionFilter(color)}`;
  const result = await manager.run(state.commands.ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-f', 'lavfi', '-i', 'color=c=white:s=64x64:d=0.04', '-vf', filters, '-frames:v', '1', '-c:v', 'tiff', '-f', 'image2', '-n', tiff]);
  if (mediaFailed(result)) throw new DraftError('heic_encoder_unavailable', `ffmpeg could not create the synthetic HLG preflight frame${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'repair ffmpeg-full and run the same command again', EXIT.CANNOT_START, childDetails('heic_encoder_unavailable', result));
  await encodeHeic(manager, syntheticState, tiff, heic, EXIT.CANNOT_START);
  await inspectHeic(manager, syntheticState, heic, path.basename(heic), EXIT.CANNOT_START);
}

function hdrTransfer(color: ColorPlan) {
  return color.transfer === 'smpte2084' ? 'pq' : 'hlg';
}

async function encodeHeic(manager: Manager, state: HeicState, input: string, output: string, exitCode: number = EXIT.FAILED) {
  const encoder = state.commands.encoder;
  if (!encoder) throw new DraftError('heic_encoder_unavailable', 'Swift HEIC helper has not been compiled', 'run preflight before encoding HDR frames', exitCode);
  const result = await manager.run(encoder, [input, output, hdrTransfer(state.media.color)]);
  if (result.code !== 0) throw new DraftError('heic_encode_failed', `HDR TIFF-to-HEIC encoding failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'repair the reported Core Image encoder failure and run again', exitCode, childDetails('heic_encode_failed', result));
}

async function inspectHeic(manager: Manager, state: HeicState, filename: string, displayName: string, exitCode: number = EXIT.FAILED) {
  const result = await manager.run(state.commands.sips, ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'bitsPerSample', '-g', 'profile', filename]);
  if (result.code !== 0) throw new DraftError('structural_check_failed', `sips could not inspect extracted frame: ${displayName}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'repair the Core Image HEIC encoder and run again', exitCode, childDetails('structural_check_failed', result));
  const value = (key: string) => new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(result.stdout)?.[1]?.trim();
  const width = Number(value('pixelWidth'));
  const height = Number(value('pixelHeight'));
  const depth = Number(value('bitsPerSample'));
  const profile = value('profile') || '';
  const wantedProfile = state.media.color.dynamicRange === 'hdr-pq' ? /BT\.2100 PQ/i : /BT\.2100 HLG/i;
  if (width !== state.media.width || height !== state.media.height || depth !== 10 || !wantedProfile.test(profile)) throw new DraftError('structural_check_failed', `frame structure does not match 10-bit ${state.media.color.outputColor} HEIC ${state.media.width}x${state.media.height}: ${displayName}`, 'repair the FFmpeg TIFF conversion or Core Image HEIC encoder and run again', exitCode);
  return { file: displayName, codec: 'heic', pixelFormat: '10-bit', width, height, profile };
}

async function convertHdrFrames(manager: Manager, state: PreparedExtraction, temporary: string) {
  const files = fs.readdirSync(temporary).filter(name => /^frame-[0-9]{6,}\.tiff$/.test(name)).sort();
  if (files.length !== state.media.expectedFrames) throw new DraftError('structural_check_failed', `expected ${state.media.expectedFrames} TIFF intermediates but found ${files.length}`, 'repair the reported FFmpeg extraction failure and run again', EXIT.FAILED);
  let next = 0;
  let failure: unknown = null;
  async function worker() {
    while (!failure && next < files.length) {
      const file = files[next++]!;
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

function progressReporter(json: boolean) {
  let pending = '';
  let last = 0;
  return (chunk: string) => {
    if (json) return;
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop()!;
    for (const line of lines) {
      const match = /^frame=([0-9]+)$/.exec(line.trim());
      if (match && Number(match[1]) >= last + 100) {
        last = Number(match[1]);
        process.stderr.write(`Extracted ${last} frames\n`);
      }
    }
  };
}

async function structuralChecks(manager: Manager, state: PreparedExtraction, temporary: string) {
  const extension = state.media.color.extension;
  const pattern = new RegExp(`^frame-([0-9]{6,})\\.${extension}$`);
  const files = fs.readdirSync(temporary).filter(name => pattern.test(name)).sort();
  if (files.length !== state.media.expectedFrames) throw new DraftError('structural_check_failed', `expected ${state.media.expectedFrames} frames but found ${files.length}`, 'repair the reported FFmpeg extraction failure and run again', EXIT.FAILED);
  for (const file of files) if (fs.statSync(path.join(temporary, file)).size <= 0) throw new DraftError('structural_check_failed', `empty frame file: ${file}`, 'repair the reported FFmpeg encoder failure and run again', EXIT.FAILED);
  const probes = [];
  for (const file of [files[0]!, files.at(-1)!]) {
    if (state.media.color.codec === 'heic') {
      probes.push(await inspectHeic(manager, state, path.join(temporary, file), file));
      continue;
    }
    const data = await readJson(manager, state.commands.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', path.join(temporary, file)], 'structural_check_failed', `ffprobe could not inspect extracted frame: ${file}`, 'repair the FFmpeg image encoder and run again', EXIT.FAILED);
    const streams = metadataRecord(data).streams;
    const stream = Array.isArray(streams) ? metadataRecord(streams[0]) : undefined;
    if (!stream || stream.codec_name !== state.media.color.codec || stream.width !== state.media.width || stream.height !== state.media.height) throw new DraftError('structural_check_failed', `frame structure does not match ${state.media.color.codec} ${state.media.width}x${state.media.height}: ${file}`, 'repair the FFmpeg filter or image encoder and run again', EXIT.FAILED);
    let properties;
    try { properties = pixelProperties(stream, state.pixelDescriptors); } catch (error) {
      throw new DraftError('structural_check_failed', `cannot verify frame pixel properties: ${file}: ${errorFields(error).condition}`, String(errorFields(error).remedy), EXIT.FAILED);
    }
    if (properties.alpha !== state.media.color.alpha || properties.bitDepth !== Number(state.media.color.outputDepth)) throw new DraftError('structural_check_failed', `frame alpha/depth does not match alpha=${state.media.color.alpha}, depth=${state.media.color.outputDepth}: ${file} (${stream.pix_fmt})`, 'repair the FFmpeg filter or PNG encoder and run again', EXIT.FAILED);
    probes.push({ file, codec: stream.codec_name, pixelFormat: stream.pix_fmt, width: stream.width, height: stream.height, ...properties });
  }
  return { files, probes };
}

function preflightPayload(state: PreparedExtraction | ToolchainPrepared): PreflightResult {
  const { encoder: _encoder, ...commands } = state.commands;
  const payload = { status: 'ready' as const, platform: state.platform, commands };
  if (!state.media) return payload;
  return { ...payload, input: state.paths.supplied, resolvedInput: state.paths.resolved, outputDirectory: state.paths.output, streamIndex: state.media.stream.index, dynamicRange: state.media.color.dynamicRange, outputFormat: state.media.color.codec, outputDepth: state.media.color.outputDepth, dimensions: `${state.media.width}x${state.media.height}`, expectedFrames: state.media.expectedFrames, requestedWindow: { startSeconds: formatTime(state.media.start), endSeconds: formatTime(state.media.end) }, firstPtsSeconds: formatTime(state.media.firstPts), lastPtsSeconds: formatTime(state.media.lastPts) };
}

function resultPayload(state: PreparedExtraction, checks: StructuralChecks) {
  const media = state.media;
  return {
    status: 'complete' as const,
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

function emit(payload: ExtractionResult | PreflightResult, json: boolean, kind = 'result') {
  if (json) { process.stdout.write(`${JSON.stringify({ [kind]: payload })}\n`); return; }
  if (payload.status === 'ready') {
    process.stdout.write(`READY: ${payload.platform.os}${payload.expectedFrames ? `, ${payload.expectedFrames} frames -> ${payload.outputDirectory}` : ''}\n`);
    emitCleanupFailures(payload.cleanupFailures);
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
  emitCleanupFailures(payload.cleanupFailures);
}

function emitCleanupFailures(failures: unknown) {
  if (Array.isArray(failures) && failures.length) {
    process.stderr.write('Cleanup incomplete:\n');
    for (const raw of failures) { const failure = errorFields(raw); process.stderr.write(`  [${failure.code}] ${failure.path}: ${failure.condition}\n`); }
  }
}

function cleanupPaths(paths: (string | null)[]): CleanupFailure[] {
  const failures = [];
  for (const pathname of paths.filter((value): value is string => Boolean(value))) {
    try { fs.rmSync(pathname, { recursive: true, force: true }); }
    catch (error) { failures.push({ path: path.resolve(pathname), code: errorFields(error).code || 'cleanup_failed', condition: errorText(error) }); }
  }
  return failures;
}

function emitError(error: unknown, json: boolean) {
  const fields = errorFields(error);
  const payload: Record<string, unknown> = { code: fields.code || 'unexpected_failure', condition: fields.condition || fields.message, remedy: fields.remedy || 'inspect the reported failure and run again' };
  for (const key of ['failures', 'task', 'childExitCode', 'childSignal', 'stderr', 'cleanupFailures']) if (fields[key] !== undefined) payload[key] = fields[key];
  if (json) process.stderr.write(`${JSON.stringify({ error: payload })}\n`);
  else {
    process.stderr.write(`ERROR [${payload.code}]: ${payload.condition}\n`);
    if (Array.isArray(payload.failures)) for (const failure of payload.failures.map(errorFields)) process.stderr.write(`  [${failure.code}] ${failure.condition}\n      Remedy: ${failure.remedy}\n`);
    process.stderr.write(`Remedy: ${payload.remedy}\n`);
    emitCleanupFailures(payload.cleanupFailures);
    for (const key of ['task', 'childExitCode', 'childSignal', 'stderr']) if (payload[key] !== undefined) process.stderr.write(`${key}: ${JSON.stringify(payload[key])}\n`);
  }
}

function usage(basename = 'extract-video-frames.js') {
  return `Usage: ${basename} [OPTIONS] INPUT_VIDEO\n\nOptions:\n  --start TIME       Inclusive start, decimal seconds or HH:MM:SS[.fraction]\n  --end TIME         Inclusive end, decimal seconds or HH:MM:SS[.fraction]\n  --preflight        Check readiness and input without creating frames\n  --json             Emit machine-readable readiness, result, or error data\n  -h, --help         Print this message\n  --                 Stop option parsing\n\nOutput:\n  <input-stem>-frames/frame-000001.png   for SDR\n  <input-stem>-frames/frame-000001.heic  for PQ or HLG HDR\n\nExit status:\n  0 success or passed preflight; 2 work did not start; 1 work or cleanup failed\n  129 SIGHUP; 130 SIGINT; 143 SIGTERM\n`;
}

async function compileEncoder(manager: Manager, state: Toolchain & { encoderDirectory: string }, encoderDirectory: string) {
  const source = path.join(__dirname, 'tiff-to-heic.swift');
  const encoder = path.join(encoderDirectory, 'tiff-to-heic');
  const result = await manager.run(state.commands.swiftc, [source, '-o', encoder]);
  if (result.code !== 0) throw new DraftError('heic_encoder_unavailable', `Swift HEIC helper could not compile${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'install or repair the macOS Command Line Tools with xcode-select --install', EXIT.CANNOT_START, childDetails('heic_encoder_unavailable', result));
  state.commands.encoder = encoder;
  state.encoderDirectory = encoderDirectory;
}

async function prepare(manager: Manager, options: ExtractionOptions, encoderDirectory: string): Promise<PreparedExtraction | ToolchainPrepared> {
  try {
    const paths = options.input ? validateInputAndOutput(options.input) : null;
    const platform = await platformPreflight(manager);
    const toolchain = await toolchainPreflight(manager, platform);
    const state = { ...toolchain, encoderDirectory };
    if (paths) {
      const inputState = { ...state, paths };
      const prepared = { ...inputState, media: await inspectInput(manager, inputState, options) };
      if (prepared.media.color.dynamicRange !== 'sdr') await compileEncoder(manager, prepared, encoderDirectory);
      await representativeDecodePreflight(manager, prepared);
      return prepared;
    } else {
      await compileEncoder(manager, state, encoderDirectory);
      await syntheticEncoderPreflight(manager, state);
    }
    // Synthetic preparation historically leaves this own property present.
    return Object.assign(state, { media: undefined });
  } catch (error) {
    if (error instanceof DraftError) throw error;
    throw new DraftError('preflight_failed', `preflight could not complete: ${errorText(error)}`, 'fix the reported filesystem or process-launch failure, then run the same command again', EXIT.CANNOT_START, Object.fromEntries(['task', 'childExitCode', 'childSignal', 'stderr'].filter(key => errorFields(error)[key] !== undefined).map(key => [key, errorFields(error)[key]])));
  }
}

async function publishDirectoryNoReplace(manager: Manager, state: PreparedExtraction, temporary: string) {
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

async function main(argv: string[]) {
  let options: ExtractionOptions | undefined;
  const manager = new ProcessManager();
  let temporary = null;
  let encoderDirectory = null;
  let payload: ExtractionResult | PreflightResult | undefined;
  let primaryError: unknown;
  let kind = 'result';
  let cleanupFailures;
  const signalHandler = (signal: ExtractionSignal) => manager.interrupt(signal);
  for (const signal of (Object.keys(SIGNAL_EXIT) as ExtractionSignal[])) process.once(signal, signalHandler);
  try {
    options = parseArguments(argv, path.basename(process.argv[1] || 'extract-video-frames.js'));
    if (options.help) { process.stdout.write(usage(path.basename(process.argv[1] || 'extract-video-frames.js'))); return EXIT.OK; }
    encoderDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-video-frames-encoder-'));
    const state = await prepare(manager, options, encoderDirectory);
    manager.assertRunning();
    if (options.preflight) {
      payload = preflightPayload(state);
      kind = 'preflight';
    } else {
      if (!state.paths || !state.media) throw new DraftError('input_unusable', 'input preparation did not produce media', 'pass a readable video input');
      if (pathExists(state.paths.output)) throw new DraftError('output_collision', `output appeared during preflight: ${state.paths.output}`, 'move or remove the existing path, then run again');
      temporary = fs.mkdtempSync(path.join(path.dirname(state.paths.output), `.${path.basename(state.paths.output)}.partial-`));
      const extraction = await manager.run(state.commands.ffmpeg, ffmpegArguments(state, temporary), { progress: progressReporter(options.json) });
      manager.assertRunning();
      if (mediaFailed(extraction)) throw new DraftError('extraction_failed', `ffmpeg extraction failed${extraction.stderr.trim() ? `: ${extraction.stderr.trim()}` : ''}`, 'fix the reported decode, color-conversion, or image-encoder error and run again', EXIT.FAILED, childDetails('extraction', extraction));
      if (state.media.color.dynamicRange !== 'sdr') await convertHdrFrames(manager, state, temporary);
      manager.assertRunning();
      const checks = await structuralChecks(manager, state, temporary);
      manager.assertRunning();
      assertSourceUnchanged(state.paths);
      await publishDirectoryNoReplace(manager, state, temporary);
      temporary = null;
      payload = resultPayload(state, checks);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (manager.active.size || manager.signal) await manager.interrupt(manager.signal || 'SIGTERM');
    cleanupFailures = cleanupPaths([temporary, encoderDirectory]);
    for (const signal of (Object.keys(SIGNAL_EXIT) as ExtractionSignal[])) process.removeListener(signal, signalHandler);
  }
  const json = options ? options.json : argv.includes('--json');
  if (manager.signal) {
    if (cleanupFailures.length) emitError(new DraftError('interrupted', `interrupted by ${manager.signal}`, 'inspect the retained paths before deciding whether to remove them or run again', SIGNAL_EXIT[manager.signal], { cleanupFailures }), json);
    return SIGNAL_EXIT[manager.signal];
  }
  if (primaryError) {
    if (cleanupFailures.length) Object.assign(primaryError, { cleanupFailures });
    emitError(primaryError, json);
    const exitCode = errorFields(primaryError).exitCode;
    return typeof exitCode === 'number' && exitCode ? exitCode : EXIT.FAILED;
  }
  if (!payload) throw new Error('extraction completed without a report');
  if (cleanupFailures.length) payload.cleanupFailures = cleanupFailures;
  emit(payload, json, kind);
  return cleanupFailures.length ? EXIT.FAILED : EXIT.OK;
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { emitError(error, process.argv.includes('--json')); process.exitCode = EXIT.FAILED; });

export { cleanupPaths, descriptorMap, pixelProperties, emitError, ProcessManager, analyzeFrameSpool, assertSourceUnchanged, boundedTail, classifyStream, codecArguments, colorConversionFilter, convertHdrFrames, decodeProbeArguments, derivePaths, displayRotation, ffmpegArguments, formatTime, identity, inspectInput, parseArguments, parseTime, prepare, publishDirectoryNoReplace, representativeDecodePreflight, resultPayload, selectVideoStream, structuralChecks, transformFromMatrix };
