import type { Stats } from 'node:fs';
import { DraftError, spoolStorageError } from './errors.js';
import { frameRecords } from './frame-records.js';
import type { FrameReaderOptions } from './frame-records.js';

export const NS_PER_SECOND = 1000000000n;

export interface SourceIdentity {
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
}

export interface TimeBase {
  numerator: bigint;
  denominator: bigint;
  text: unknown;
}

export interface FrameWindow {
  start: bigint;
  end: bigint;
  duration: bigint;
  startTick: bigint;
  endTick: bigint;
  expectedFrames: number;
  firstTick: bigint;
  lastTick: bigint;
  firstPts: bigint;
  lastPts: bigint;
  timeBase: TimeBase;
}

function parseTime(value: unknown, flag: string): bigint {
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
    hours = BigInt(match[1]!);
    minutes = BigInt(match[2]!);
    seconds = match[3];
    fraction = match[4] || '';
  }
  const whole = hours * 3600n + minutes * 60n + BigInt(seconds!);
  return whole * NS_PER_SECOND + BigInt((fraction + '000000000').slice(0, 9));
}

function formatTime(nanoseconds: bigint): string {
  const whole = nanoseconds / NS_PER_SECOND;
  const fraction = String(nanoseconds % NS_PER_SECOND).padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}


function identity(stat: Stats): SourceIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino), size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}


function integerTimestamp(value: unknown): bigint | null {
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
    throw new DraftError('input_unusable', 'timestamp or duration is an unsafe JavaScript number',
      'supply exact integer timestamp and duration text or raw integer JSON from ffprobe');
  }
  return /^-?[0-9]+$/.test(String(value)) ? BigInt(String(value)) : null;
}

function parseTimeBase(value: unknown): TimeBase {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(value || ''));
  if (!match) throw new DraftError('stream_unsupported', `selected video stream has an invalid time base: ${value || 'missing'}`, 're-export the source with a valid video time base');
  return { numerator: BigInt(match[1]!), denominator: BigInt(match[2]!), text: value };
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function ticksToNanoseconds(ticks: bigint, timeBase: TimeBase, roundUp = false): bigint {
  const numerator = ticks * timeBase.numerator * NS_PER_SECOND;
  return roundUp ? ceilDivide(numerator, timeBase.denominator) : numerator / timeBase.denominator;
}

function compareNanosecondsToTicks(nanoseconds: bigint, ticks: bigint, timeBase: TimeBase): -1 | 0 | 1 {
  const left = nanoseconds * timeBase.denominator;
  const right = ticks * timeBase.numerator * NS_PER_SECOND;
  return left < right ? -1 : left > right ? 1 : 0;
}

export { parseTime, formatTime, identity, sameIdentity, integerTimestamp, parseTimeBase, ceilDivide, ticksToNanoseconds, compareNanosecondsToTicks };

export interface FrameColorDescription {
  primaries: string;
  transfer: string;
  matrix: string;
  range: string;
}

export interface FrameAnalysisOptions {
  start: bigint | null;
  end: bigint | null;
  timeBase: unknown;
}

async function analyzeFrameSpool(filename: string, color: FrameColorDescription, options: FrameAnalysisOptions, readerOptions: FrameReaderOptions = {}): Promise<FrameWindow> {
  try {
    return await reduceFrameSpool(filename, color, options, readerOptions);
  } catch (error) {
    if (error instanceof DraftError) throw error;
    if (error instanceof SyntaxError) throw new DraftError('input_unusable', 'ffprobe could not enumerate frame timestamps: output was not valid JSON', 'repair or re-export the video with valid presentation timestamps');
    throw spoolStorageError(filename, error);
  }
}

async function reduceFrameSpool(filename: string, color: FrameColorDescription, options: FrameAnalysisOptions, readerOptions: FrameReaderOptions): Promise<FrameWindow> {
  let origin: bigint | null = null;
  let lastTimestamp: bigint | undefined;
  let lastDuration: bigint | undefined;
  let colorError: DraftError | undefined;
  for await (const frame of frameRecords(filename, readerOptions)) {
    for (const [field, expected] of [['color_primaries', color.primaries], ['color_transfer', color.transfer], ['color_space', color.matrix], ['color_range', color.range]] as const) {
      if (frame[field] && frame[field] !== expected) colorError ??= new DraftError('color_metadata_ambiguous', `frame-level ${field} changes from ${expected} to ${frame[field]}`, 're-export the video with one consistent color description for the selected stream');
    }
    const pts = integerTimestamp(frame.best_effort_timestamp);
    if (pts !== null) {
      origin ??= pts;
      lastTimestamp = pts;
      lastDuration = integerTimestamp(frame.duration ?? frame.pkt_duration ?? '0') || 0n;
    }
  }
  if (colorError) throw colorError;
  const timeBase = parseTimeBase(options.timeBase);
  if (origin === null || lastTimestamp === undefined || lastDuration === undefined) throw new DraftError('input_unusable', 'selected video stream has no timestamped frames', 'repair or re-export the source with valid presentation timestamps');
  const durationTicks = lastTimestamp - origin + lastDuration;
  const duration = ticksToNanoseconds(durationTicks, timeBase, true);
  const start = options.start === null ? 0n : options.start;
  const end = options.end === null ? duration : options.end;
  if (start < 0n || end < 0n || compareNanosecondsToTicks(start, durationTicks, timeBase) > 0 || (options.end !== null && compareNanosecondsToTicks(end, durationTicks, timeBase) > 0)) throw new DraftError('window_out_of_range', `requested window ${formatTime(start)}..${formatTime(end)} is outside 0..${formatTime(duration)}`, `pass bounds between 0 and ${formatTime(duration)} seconds`);
  const startTick = ceilDivide(start * timeBase.denominator, timeBase.numerator * NS_PER_SECOND);
  const endTick = options.end === null ? durationTicks : end * timeBase.denominator / (timeBase.numerator * NS_PER_SECOND);
  let expectedFrames = 0;
  let firstTick: bigint | undefined;
  let lastTick: bigint | undefined;
  for await (const frame of frameRecords(filename, readerOptions)) {
    const timestamp = integerTimestamp(frame.best_effort_timestamp);
    if (timestamp === null) continue;
    const pts = timestamp - origin;
    if (pts >= startTick && pts <= endTick) {
      firstTick ??= pts;
      lastTick = pts;
      expectedFrames += 1;
    }
  }
  if (!expectedFrames || firstTick === undefined || lastTick === undefined) throw new DraftError('window_empty', `inclusive window ${formatTime(start)}..${formatTime(end)} contains no presented frame`, 'widen the window or choose a timestamp matching a presented frame');
  return { start, end, duration, startTick, endTick, expectedFrames, firstTick, lastTick, firstPts: ticksToNanoseconds(firstTick, timeBase), lastPts: ticksToNanoseconds(lastTick, timeBase), timeBase };
}

export { analyzeFrameSpool };

// Only the outer record is narrowed here. ffprobe fields stay unknown until their consumer checks them.
export interface StreamMetadata extends Record<string, unknown> {
  index?: unknown;
  width?: unknown;
  height?: unknown;
  pix_fmt?: unknown;
  time_base?: unknown;
  color_primaries?: unknown;
  color_transfer?: unknown;
  color_space?: unknown;
  color_range?: unknown;
  side_data_list?: unknown;
}

export function metadataRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function metadataList(value: unknown): StreamMetadata[] {
  if (!value) return [];
  if (!Array.isArray(value)) throw new TypeError('expected a metadata list');
  return value.map(metadataRecord);
}

export type PixelDescriptors = Map<string, Record<string, unknown>>;
interface PixelComponent { index: number; bit_depth: number }
export interface PixelProperties { alpha: boolean; bitDepth: number }
interface DisplayAxes { rotationDegrees: number; flips: ('horizontal' | 'vertical')[]; filters: string[] }
export interface DisplayTransform extends DisplayAxes { matrix: number[] | null; swapsDimensions: boolean }
interface ColorDescription extends FrameColorDescription, PixelProperties {}
interface SdrColorPlan extends ColorDescription {
  dynamicRange: 'sdr'; extension: 'png'; codec: 'png';
  outputPixelFormat: 'rgba64le' | 'rgba' | 'rgb48le' | 'rgb24';
  outputDepth: '16' | '8'; outputColor: 'srgb';
  intermediateExtension?: never;
  intermediatePixelFormat?: never;
}
interface HdrColorPlan extends ColorDescription {
  dynamicRange: 'hdr-pq' | 'hdr-hlg'; extension: 'heic'; codec: 'heic';
  intermediateExtension: 'tiff'; intermediatePixelFormat: 'rgba64le' | 'rgb48le';
  outputPixelFormat: '10-bit'; outputDepth: '10'; outputColor: 'bt2100-pq' | 'bt2100-hlg';
}
export type ColorPlan = SdrColorPlan | HdrColorPlan;

function commandRemedy() {
  return 'brew install ffmpeg-full && export PATH="$(brew --prefix ffmpeg-full)/bin:$PATH"';
}

function descriptorMap(data: unknown): PixelDescriptors {
  const formats = metadataRecord(data).pixel_formats;
  if (!Array.isArray(formats) || !formats.length) throw new DraftError('ffprobe_probe_failed', 'ffprobe returned no pixel format descriptors', commandRemedy());
  const descriptors: PixelDescriptors = new Map();
  for (const raw of formats) {
    const descriptor = metadataRecord(raw);
    if (!descriptor || typeof descriptor.name !== 'string' || !descriptor.name || descriptors.has(descriptor.name)) throw new DraftError('ffprobe_probe_failed', 'ffprobe returned invalid or duplicate pixel format descriptor names', commandRemedy());
    descriptors.set(descriptor.name, descriptor);
  }
  return descriptors;
}

function pixelProperties(stream: StreamMetadata, descriptors: PixelDescriptors): PixelProperties {
  const name = stream.pix_fmt;
  const descriptor = typeof name === 'string' ? descriptors?.get(name) : undefined;
  const components = descriptor?.components;
  const alpha = metadataRecord(descriptor?.flags).alpha;
  if (!descriptor || (alpha !== 0 && alpha !== 1) ||
      typeof descriptor.nb_components !== 'number' || !Number.isInteger(descriptor.nb_components) || descriptor.nb_components < 1 ||
      !Array.isArray(components) || components.length !== descriptor.nb_components ||
      !components.every((component: unknown, index: number): component is PixelComponent => {
        const fields = metadataRecord(component);
        return fields.index === index + 1 && typeof fields.bit_depth === 'number' && Number.isInteger(fields.bit_depth) && fields.bit_depth >= 1 && fields.bit_depth <= 64;
      })) {
    throw new DraftError('pixel_format_unsupported', `missing or unusable pixel format descriptor: ${name || 'missing pix_fmt'}`, commandRemedy());
  }
  return { alpha: alpha === 1, bitDepth: Math.max(...components.map(component => component.bit_depth)) };
}

const DISPLAY_TRANSFORMS = new Map<string, DisplayAxes>([
  ['1,0,0,1', { rotationDegrees: 0, flips: [], filters: [] }],
  ['-1,0,0,1', { rotationDegrees: 0, flips: ['horizontal'], filters: ['hflip'] }],
  ['1,0,0,-1', { rotationDegrees: 0, flips: ['vertical'], filters: ['vflip'] }],
  ['-1,0,0,-1', { rotationDegrees: 180, flips: [], filters: ['hflip', 'vflip'] }],
  ['0,-1,1,0', { rotationDegrees: 270, flips: [], filters: ['transpose=clock'] }],
  ['0,1,-1,0', { rotationDegrees: 90, flips: [], filters: ['transpose=cclock'] }],
  ['0,-1,-1,0', { rotationDegrees: 270, flips: ['horizontal'], filters: ['hflip', 'transpose=clock'] }],
  ['0,1,1,0', { rotationDegrees: 270, flips: ['vertical'], filters: ['vflip', 'transpose=clock'] }],
]);

function displayMatrixValues(text: unknown): number[] | null {
  const rows = String(text).split(/\r?\n/).map(line => {
    const match = /:\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/.exec(line.trim());
    return match ? match.slice(1).map(Number) : null;
  }).filter((row): row is number[] => row !== null);
  return rows.length === 3 ? rows.flat() : null;
}

function normalizedMatrixComponent(value: number) {
  const normalized = Math.round(value / 65536);
  return Math.abs(value - normalized * 65536) <= 1 ? normalized : null;
}

function transformFromMatrix(values: number[] | null): DisplayTransform | null {
  if (!values || values.length !== 9 || values.some(value => !Number.isFinite(value))) return null;
  const [a, b, perspectiveX, c, d, perspectiveY, translateX, translateY, scale] = values;
  const normalized = [a!, b!, c!, d!].map(normalizedMatrixComponent);
  if (normalized.includes(null) || perspectiveX !== 0 || perspectiveY !== 0 || scale !== 1073741824 || !Number.isInteger(translateX) || !Number.isInteger(translateY)) return null;
  const supported = DISPLAY_TRANSFORMS.get(normalized.join(','));
  return supported ? { ...supported, matrix: values, swapsDimensions: normalized[1] !== 0 } : null;
}

function transformFromRotation(raw: unknown): DisplayTransform | null {
  const rotation = Number(raw || 0);
  if (!Number.isFinite(rotation)) return null;
  const normalized = ((rotation % 360) + 360) % 360;
  const nearest = Math.round(normalized / 90) * 90 % 360;
  if (Math.abs(normalized - nearest) > 0.001) return null;
  const key = new Map([[0, '1,0,0,1'], [90, '0,1,-1,0'], [180, '-1,0,0,-1'], [270, '0,-1,1,0']]).get(nearest);
  return { ...DISPLAY_TRANSFORMS.get(key!)!, matrix: null, swapsDimensions: nearest === 90 || nearest === 270 };
}

function displayTransform(stream: StreamMetadata): DisplayTransform {
  const side = metadataList(stream.side_data_list).find(entry => entry.rotation !== undefined || /display matrix/i.test(String(entry.side_data_type || '')));
  const matrixText = side && (side.displaymatrix || side.display_matrix);
  const transform = matrixText ? transformFromMatrix(displayMatrixValues(matrixText)) : transformFromRotation(side && side.rotation !== undefined ? side.rotation : metadataRecord(stream.tags).rotate);
  if (!transform) throw new DraftError('display_transform_unsupported', 'display matrix contains scale, shear, perspective, or a non-orthogonal rotation', 're-encode the video with only exact 90-degree rotations or axis flips');
  return transform;
}

function displayRotation(stream: StreamMetadata) {
  return displayTransform(stream).rotationDegrees;
}

const SDR_PRIMARIES = new Set(['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m']);
const SDR_TRANSFER = new Set(['bt709', 'iec61966-2-1', 'smpte170m', 'smpte240m', 'gamma22', 'gamma28']);
const SDR_MATRIX = new Set(['bt709', 'bt470bg', 'smpte170m', 'smpte240m', 'rgb', 'gbr']);

function classifyStream(stream: StreamMetadata, { bitDepth, alpha }: PixelProperties): ColorPlan {
  const primaries = stream.color_primaries;
  const transfer = stream.color_transfer;
  const matrix = stream.color_space;
  const range = stream.color_range;
  const hdr = transfer === 'smpte2084' || transfer === 'arib-std-b67';
  const dovi = /^(?:dvhe|dvh1)$/i.test(String(stream.codec_tag_string || '')) || metadataList(stream.side_data_list).some(entry => /dovi|dolby vision/i.test(String(entry.side_data_type || '')));
  if (typeof primaries !== 'string' || typeof transfer !== 'string' || typeof matrix !== 'string' || typeof range !== 'string' || !primaries || !transfer || !matrix || !range || ['unknown', 'unspecified', 'reserved'].includes(primaries) || ['unknown', 'unspecified', 'reserved'].includes(transfer) || ['unknown', 'unspecified', 'reserved'].includes(matrix)) {
    throw new DraftError('color_metadata_ambiguous', 'video color metadata is missing or unspecified', 're-export the source with explicit color primaries, transfer, matrix, and range metadata');
  }
  if (hdr && alpha) throw new DraftError('hdr_alpha_unsupported', `HDR alpha is unsupported by the native HEIC10 encoder: ${stream.pix_fmt}`, 'provide an opaque HDR source or an SDR export that preserves transparency');
  if (dovi && !hdr) throw new DraftError('hdr_unsupported', 'Dolby Vision input has no supported tagged PQ or HLG base layer', 'provide an HDR10 PQ or HLG base-layer export');
  if (hdr) {
    if (primaries !== 'bt2020' || !['bt2020nc', 'bt2020c'].includes(matrix) || bitDepth < 10) throw new DraftError('color_metadata_ambiguous', `HDR metadata is inconsistent: primaries=${primaries}, transfer=${transfer}, matrix=${matrix}, depth=${bitDepth}`, 're-export HDR with consistent BT.2020 PQ or HLG metadata at 10 bits or greater');
    return { dynamicRange: transfer === 'smpte2084' ? 'hdr-pq' : 'hdr-hlg', primaries, transfer, matrix, range, bitDepth, alpha, extension: 'heic', codec: 'heic', intermediateExtension: 'tiff', intermediatePixelFormat: alpha ? 'rgba64le' : 'rgb48le', outputPixelFormat: '10-bit', outputDepth: '10', outputColor: transfer === 'smpte2084' ? 'bt2100-pq' : 'bt2100-hlg' };
  }
  if (!SDR_PRIMARIES.has(primaries) || !SDR_TRANSFER.has(transfer) || !SDR_MATRIX.has(matrix)) throw new DraftError('color_metadata_ambiguous', `unsupported or conflicting SDR metadata: primaries=${primaries}, transfer=${transfer}, matrix=${matrix}`, 're-export SDR with consistent BT.709, BT.601, or sRGB-family color metadata');
  const highDepth = bitDepth > 8;
  return { dynamicRange: 'sdr', primaries, transfer, matrix, range, bitDepth, alpha, extension: 'png', codec: 'png', outputPixelFormat: alpha ? (highDepth ? 'rgba64le' : 'rgba') : (highDepth ? 'rgb48le' : 'rgb24'), outputDepth: highDepth ? '16' : '8', outputColor: 'srgb' };
}

function selectVideoStream(streams: unknown): StreamMetadata {
  const stream = metadataList(streams).find(candidate => candidate.codec_type === 'video' && !metadataRecord(candidate.disposition).attached_pic);
  if (!stream) throw new DraftError('stream_unsupported', 'input contains no non-attached-picture video stream', 'pass a file containing a real video stream');
  return stream;
}

export { commandRemedy, descriptorMap, pixelProperties, classifyStream, displayTransform, displayRotation, selectVideoStream, transformFromMatrix };
