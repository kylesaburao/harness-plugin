'use strict';
// Test-only oracle copied unchanged from 71ca03d713fea3b4e662ed31aac44959312217ab.
const NS_PER_SECOND = 1000000000n;
const EXIT = { CANNOT_START: 2 };

class DraftError extends Error {
  constructor(code, condition, remedy, exitCode = EXIT.CANNOT_START, details = {}) {
    super(condition);
    Object.assign(this, { code, condition, remedy, exitCode, ...details });
  }
}


function formatTime(nanoseconds) {
  const whole = nanoseconds / NS_PER_SECOND;
  const fraction = String(nanoseconds % NS_PER_SECOND).padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function analyzePresentedFrames(frameData, color, options) {
  let origin = null;
  let lastTimestamp;
  let lastDuration;
  for (const frame of frameData.frames || []) {
    for (const [field, expected] of [['color_primaries', color.primaries], ['color_transfer', color.transfer], ['color_space', color.matrix], ['color_range', color.range]]) {
      if (frame[field] && frame[field] !== expected) throw new DraftError('color_metadata_ambiguous', `frame-level ${field} changes from ${expected} to ${frame[field]}`, 're-export the video with one consistent color description for the selected stream');
    }
    const pts = integerTimestamp(frame.best_effort_timestamp);
    if (pts !== null) {
      origin ??= pts;
      lastTimestamp = pts;
      lastDuration = integerTimestamp(frame.duration ?? frame.pkt_duration ?? '0') || 0n;
    }
  }
  const timeBase = parseTimeBase(options.timeBase);
  if (origin === null) throw new DraftError('input_unusable', 'selected video stream has no timestamped frames', 'repair or re-export the source with valid presentation timestamps');
  const durationTicks = lastTimestamp - origin + lastDuration;
  const duration = ticksToNanoseconds(durationTicks, timeBase, true);
  const start = options.start === null ? 0n : options.start;
  const end = options.end === null ? duration : options.end;
  if (start < 0n || end < 0n || compareNanosecondsToTicks(start, durationTicks, timeBase) > 0 || (options.end !== null && compareNanosecondsToTicks(end, durationTicks, timeBase) > 0)) throw new DraftError('window_out_of_range', `requested window ${formatTime(start)}..${formatTime(end)} is outside 0..${formatTime(duration)}`, `pass bounds between 0 and ${formatTime(duration)} seconds`);
  const startTick = ceilDivide(start * timeBase.denominator, timeBase.numerator * NS_PER_SECOND);
  const endTick = options.end === null ? durationTicks : end * timeBase.denominator / (timeBase.numerator * NS_PER_SECOND);
  let expectedFrames = 0;
  let firstTick;
  let lastTick;
  for (const frame of frameData.frames || []) {
    const timestamp = integerTimestamp(frame.best_effort_timestamp);
    if (timestamp === null) continue;
    const pts = timestamp - origin;
    if (pts >= startTick && pts <= endTick) {
      firstTick ??= pts;
      lastTick = pts;
      expectedFrames += 1;
    }
  }
  if (!expectedFrames) throw new DraftError('window_empty', `inclusive window ${formatTime(start)}..${formatTime(end)} contains no presented frame`, 'widen the window or choose a timestamp matching a presented frame');
  return { start, end, duration, startTick, endTick, expectedFrames, firstTick, lastTick, firstPts: ticksToNanoseconds(firstTick, timeBase), lastPts: ticksToNanoseconds(lastTick, timeBase), timeBase };
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

module.exports = { analyzePresentedFrames };
