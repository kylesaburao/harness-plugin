'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { analyzeFixture } = require('./frame-spool-fixture');

const subject = require('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js');
const descriptors = subject.descriptorMap(require('./pixel-formats.json'));
const classify = stream => subject.classifyStream(stream, subject.pixelProperties(stream, descriptors));

test('time syntax is exact to nanoseconds', () => {
  assert.equal(subject.parseTime('12.5', '--start'), 12500000000n);
  assert.equal(subject.parseTime('01:02:03.000000004', '--end'), 3723000000004n);
  assert.equal(subject.formatTime(3723000000004n), '3723.000000004');
});

test('invalid, negative, and over-precise times are rejected', () => {
  for (const value of ['-1', '1:2:3', '00:60:00', '1.0000000000']) {
    assert.throws(() => subject.parseTime(value, '--start'), { code: 'window_invalid' });
  }
});

test('arguments accept independent inclusive bounds and reject reversed ranges', () => {
  const parsed = subject.parseArguments(['--start', '1', '--end=2.5', '--json', 'clip.mov']);
  assert.equal(parsed.start, 1000000000n);
  assert.equal(parsed.end, 2500000000n);
  assert.equal(parsed.input, 'clip.mov');
  assert.equal(parsed.json, true);
  assert.throws(() => subject.parseArguments(['--start', '2', '--end', '1', 'clip.mov']), { code: 'window_invalid' });
});

test('environment-only preflight rejects window flags without an input', () => {
  assert.throws(() => subject.parseArguments(['--preflight', '--start', '1']), { code: 'usage_error' });
});

test('output is a fixed sibling derived from the supplied path', () => {
  const result = subject.derivePaths(path.join('somewhere', 'clip.final.mov'));
  assert.equal(result.output, path.join(path.dirname(result.supplied), 'clip.final-frames'));
});

test('strict HDR classification produces 10-bit HEIC through a 16-bit TIFF', () => {
  const result = classify({ pix_fmt: 'yuv420p10le', color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc', color_range: 'tv' });
  assert.equal(result.dynamicRange, 'hdr-pq');
  assert.equal(result.extension, 'heic');
  assert.equal(result.intermediateExtension, 'tiff');
  assert.equal(result.intermediatePixelFormat, 'rgb48le');
  assert.equal(result.outputDepth, '10');
});

test('HLG is accepted only as tagged 10-bit BT.2020 HDR', () => {
  const result = classify({ pix_fmt: 'yuv420p10le', color_primaries: 'bt2020', color_transfer: 'arib-std-b67', color_space: 'bt2020nc', color_range: 'tv' });
  assert.equal(result.dynamicRange, 'hdr-hlg');
  assert.equal(result.outputColor, 'bt2100-hlg');
  assert.throws(() => classify({ pix_fmt: 'yuv420p', color_primaries: 'bt2020', color_transfer: 'arib-std-b67', color_space: 'bt2020nc', color_range: 'tv' }), { code: 'color_metadata_ambiguous' });
});

test('SDR preserves useful depth while normalizing to sRGB PNG', () => {
  const eight = classify({ pix_fmt: 'yuv420p', color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709', color_range: 'tv' });
  const ten = classify({ pix_fmt: 'yuv420p10le', color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709', color_range: 'tv' });
  assert.equal(eight.outputPixelFormat, 'rgb24');
  assert.equal(ten.outputPixelFormat, 'rgb48le');
  assert.match(subject.colorConversionFilter(eight), /format=gbrp,format=rgb24$/);
  assert.match(subject.colorConversionFilter(ten), /format=gbrp16le,format=rgb48le$/);
});

test('ambiguous color and Dolby Vision-only streams fail before work', () => {
  assert.throws(() => classify({ pix_fmt: 'yuv420p', color_primaries: 'unknown', color_transfer: 'unknown', color_space: 'unknown', color_range: 'tv' }), { code: 'color_metadata_ambiguous' });
  assert.throws(() => classify({ pix_fmt: 'yuv420p10le', codec_tag_string: 'dvh1', color_primaries: 'bt2020', color_transfer: 'bt709', color_space: 'bt2020nc', color_range: 'tv' }), { code: 'hdr_unsupported' });
});

test('non-orthogonal display rotation is rejected', () => {
  assert.equal(subject.displayRotation({ tags: { rotate: '90' } }), 90);
  assert.throws(() => subject.displayRotation({ tags: { rotate: '12.5' } }), { code: 'display_transform_unsupported' });
});

test('complete display matrices become explicit rotation and flip filters', () => {
  const cases = [
    [[65536, 0, 0, 0, 65536, 0, 7, 9, 1073741824], []],
    [[-65536, 0, 0, 0, 65536, 0, 7, 9, 1073741824], ['hflip']],
    [[65536, 0, 0, 0, -65536, 0, 7, 9, 1073741824], ['vflip']],
    [[-65536, 0, 0, 0, -65536, 0, 7, 9, 1073741824], ['hflip', 'vflip']],
    [[0, -65536, 0, 65536, 0, 0, 7, 9, 1073741824], ['transpose=clock']],
    [[0, 65536, 0, -65536, 0, 0, 7, 9, 1073741824], ['transpose=cclock']],
    [[0, -65536, 0, -65536, 0, 0, 7, 9, 1073741824], ['hflip', 'transpose=clock']],
    [[0, 65536, 0, 65536, 0, 0, 7, 9, 1073741824], ['vflip', 'transpose=clock']],
  ];
  for (const [matrix, filters] of cases) assert.deepEqual(subject.transformFromMatrix(matrix).filters, filters);
});

test('display matrices with scale, shear, perspective, or arbitrary angles are rejected', () => {
  const scaled = [131072, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
  const sheared = [65536, 32768, 0, 0, 65536, 0, 0, 0, 1073741824];
  const perspective = [65536, 0, 1, 0, 65536, 0, 0, 0, 1073741824];
  assert.equal(subject.transformFromMatrix(scaled), null);
  assert.equal(subject.transformFromMatrix(sheared), null);
  assert.equal(subject.transformFromMatrix(perspective), null);
});

test('first real video stream is selected instead of attached artwork', () => {
  const selected = subject.selectVideoStream([
    { index: 0, codec_type: 'video', disposition: { attached_pic: 1 } },
    { index: 2, codec_type: 'video', disposition: { attached_pic: 0 } },
    { index: 3, codec_type: 'video', disposition: { attached_pic: 0 } },
  ]);
  assert.equal(selected.index, 2);
});

test('presented-frame selection includes exact start and end timestamps', async () => {
  const color = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' };
  const frameData = { frames: ['8', '9', '10', '11'].map(best_effort_timestamp => ({ best_effort_timestamp, pkt_duration: '1' })) };
  const timing = await analyzeFixture(frameData, color, { start: 500000000n, end: 1000000000n, timeBase: '1/2' });
  assert.equal(timing.expectedFrames, 2);
  assert.equal(timing.firstPts, 500000000n);
  assert.equal(timing.lastPts, 1000000000n);
});

test('timestamp analysis ignores invalid records and retains exact large origins and final duration', async () => {
  const color = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' };
  const frames = [
    { best_effort_timestamp: 'N/A', duration: '999' },
    { best_effort_timestamp: '9007199254740993', duration: '1' },
    { best_effort_timestamp: 'bad' },
    { best_effort_timestamp: '9007199254740994', duration: '2', pkt_duration: '99' },
    { duration: '999' },
  ];
  const options = { start: null, end: null, timeBase: '1/2' };
  const timing = await analyzeFixture({ frames }, color, options);
  assert.equal(timing.expectedFrames, 2);
  assert.equal(timing.firstTick, 0n);
  assert.equal(timing.lastTick, 1n);
  assert.equal(timing.duration, 1500000000n);
  await assert.rejects(() => analyzeFixture({ frames: [{}] }, color, options), { code: 'input_unusable' });
  await assert.rejects(() => analyzeFixture({ frames }, color, { ...options, end: 1500000001n }), { code: 'window_out_of_range' });
  await assert.rejects(() => analyzeFixture({ frames }, color, { ...options, start: 1000000000n }), { code: 'window_empty' });
});

test('color changes outside the selected interval and on invalid timestamps remain errors', async () => {
  const color = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' };
  for (const best_effort_timestamp of ['2', 'N/A']) {
    const frames = [{ best_effort_timestamp: '0' }, { best_effort_timestamp, color_transfer: 'smpte2084' }];
    await assert.rejects(() => analyzeFixture({ frames }, color, { start: 0n, end: 0n, timeBase: '1/2' }), { code: 'color_metadata_ambiguous' });
  }
});

// ffprobe renamed the per-frame `pkt_duration` field to `duration`. Reading only the old name
// made clip duration stop at the last frame's PTS instead of its end, so an --end at the true
// end of the clip was rejected as out of range. Both names are accepted.
test('clip duration includes the final frame, using either ffprobe duration field name', async () => {
  const color = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' };
  const modern = { frames: [8, 9, 10, 11].map(best_effort_timestamp => ({ best_effort_timestamp, duration: 1 })) };
  const legacy = { frames: ['8', '9', '10', '11'].map(best_effort_timestamp => ({ best_effort_timestamp, pkt_duration: '1' })) };

  for (const frameData of [modern, legacy]) {
    const timing = await analyzeFixture(frameData, color, { start: null, end: null, timeBase: '1/2' });
    assert.equal(timing.duration, 2000000000n);
    assert.equal(timing.expectedFrames, 4);
    // An --end at the true clip end is in range, not window_out_of_range.
    assert.equal((await analyzeFixture(frameData, color, { start: null, end: 2000000000n, timeBase: '1/2' })).expectedFrames, 4);
  }
});

test('ffmpeg extraction disables autorotation and applies explicit transforms', () => {
  const state = fixtureState();
  state.media.transform = { rotationDegrees: 270, flips: [], filters: ['transpose=clock'], swapsDimensions: true };
  const args = subject.ffmpegArguments(state, '/tmp/frames');
  assert.ok(args.includes('-noautorotate'));
  assert.match(args[args.indexOf('-vf') + 1], /transpose=clock/);
  assert.equal(args[args.indexOf('-map') + 1], '0:2');
});

test('representative decode probe uses the selected frame and a null sink', () => {
  const args = subject.decodeProbeArguments(fixtureState());
  assert.ok(args.includes('-noautorotate'));
  assert.equal(args[args.indexOf('-frames:v') + 1], '1');
  assert.equal(args[args.indexOf('-f') + 1], 'null');
  assert.match(args[args.indexOf('-vf') + 1], /between\(pts\\,1\\,1\)/);
  assert.equal(args[args.indexOf('-progress') + 1], 'pipe:1');
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-f')), ['-c:v', 'png', '-compression_level', '6']);
});

test('HDR extraction writes TIFF intermediates with the source transfer intact', () => {
  const color = { codec: 'heic', dynamicRange: 'hdr-hlg', primaries: 'bt2020', transfer: 'arib-std-b67', matrix: 'bt2020nc', range: 'tv', intermediatePixelFormat: 'rgb48le', intermediateExtension: 'tiff' };
  assert.deepEqual(subject.codecArguments(color), ['-c:v', 'tiff']);
  assert.match(subject.colorConversionFilter(color), /transfer=arib-std-b67/);
  assert.doesNotMatch(subject.colorConversionFilter(color), /transfer=linear/);
});

test('representative decode requires an emitted frame', async () => {
  const manager = { run: async () => ({ code: 0, stdout: 'progress=end\n', stderr: '' }) };
  await assert.rejects(subject.representativeDecodePreflight(manager, fixtureState()), { code: 'input_decode_failed', exitCode: 2 });
});

test('diagnostics retain only the configured stderr tail', () => {
  assert.equal(subject.boundedTail(Buffer.from('abcdefgh'), Buffer.from('ijklmnop'), 10).toString(), 'ghijklmnop');
});

function fixtureState() {
  return {
    commands: { ffmpeg: '/fake/ffmpeg' },
    paths: { supplied: '/tmp/clip.mov', output: '/tmp/clip-frames', resolved: '/tmp/clip.mov' },
    media: {
      stream: { index: 2 },
      color: { dynamicRange: 'sdr', primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv', outputPixelFormat: 'rgb24', extension: 'png', codec: 'png', outputDepth: '8', outputColor: 'srgb', alpha: false, bitDepth: 8 },
      transform: { rotationDegrees: 0, flips: [], filters: [], swapsDimensions: false },
      width: 320,
      height: 240,
      sampleAspectRatio: '1:1',
      displayAspectRatio: '4:3',
      fieldOrder: 'progressive',
      start: 0n,
      end: 1000000000n,
      startTick: 0n,
      endTick: 2n,
      firstTick: 1n,
      lastTick: 2n,
      firstPts: 500000000n,
      lastPts: 1000000000n,
      expectedFrames: 2,
    },
  };
}

for (const result of [
  { code: 0, signal: null, stdout: 'frame=1\n', stderr: 'CRC mismatch\n' },
  { code: null, signal: 'SIGSEGV', stdout: '', stderr: 'decoder crashed\n' },
]) test(`representative decode retains child evidence for ${result.signal || 'exit zero'}`, async () => {
  await assert.rejects(subject.representativeDecodePreflight({ run: async () => result }, fixtureState()), error => {
    assert.equal(error.exitCode, 2);
    assert.equal(error.task, 'input_decode_failed');
    assert.equal(error.childExitCode, result.code);
    assert.equal(error.childSignal, result.signal);
    assert.equal(error.stderr, result.stderr);
    return true;
  });
});

test('representative decode accepts normal stdout progress', async () => {
  await subject.representativeDecodePreflight({ run: async () => ({ code: 0, signal: null, stdout: 'frame=1\nprogress=end\n', stderr: '' }) }, fixtureState());
  const args = subject.ffmpegArguments(fixtureState(), '/tmp/frames');
  assert.equal(args[args.indexOf('-progress') + 1], 'pipe:1');
  assert.ok(args.includes('-xerror'));
});

test('omitted fractional end uses exact duration ticks', async () => {
  const data = { frames: [{ best_effort_timestamp: '0', duration: '1' }] };
  const options = { start: null, end: null, timeBase: '1/30' };
  const result = await analyzeFixture(data, {}, options);
  assert.equal(result.endTick, 1n);
  assert.equal(result.expectedFrames, 1);
  await assert.rejects(() => analyzeFixture(data, {}, { ...options, end: 33333334n }), { code: 'window_out_of_range' });
});

test('textual display matrices accept translation and reject both perspective fields', () => {
  const stream = values => ({ side_data_list: [{ side_data_type: 'Display Matrix', displaymatrix: values.map((row, i) => `${i}: ${row.join(' ')}`).join('\n') }] });
  assert.equal(subject.displayRotation(stream([[0,65536,0],[-65536,0,0],[7,9,1073741824]])), 90);
  for (const rows of [[[65536,0,1],[0,65536,0],[0,0,1073741824]], [[65536,0,0],[0,65536,1],[0,0,1073741824]]]) {
    assert.throws(() => subject.displayRotation(stream(rows)), { code: 'display_transform_unsupported' });
  }
});
