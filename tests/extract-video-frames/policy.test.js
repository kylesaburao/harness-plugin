'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const subject = require('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js');

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

test('strict HDR classification produces float32 OpenEXR and preserves alpha', () => {
  const result = subject.classifyStream({ pix_fmt: 'yuva444p10le', color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc', color_range: 'tv' });
  assert.equal(result.dynamicRange, 'hdr-pq');
  assert.equal(result.extension, 'exr');
  assert.equal(result.outputPixelFormat, 'gbrapf32le');
  assert.equal(result.outputDepth, 'float32');
});

test('SDR preserves useful depth while normalizing to sRGB PNG', () => {
  const eight = subject.classifyStream({ pix_fmt: 'yuv420p', color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709', color_range: 'tv' });
  const ten = subject.classifyStream({ pix_fmt: 'yuv420p10le', color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709', color_range: 'tv' });
  assert.equal(eight.outputPixelFormat, 'rgb24');
  assert.equal(ten.outputPixelFormat, 'rgb48le');
});

test('ambiguous color and Dolby Vision-only streams fail before work', () => {
  assert.throws(() => subject.classifyStream({ pix_fmt: 'yuv420p', color_primaries: 'unknown', color_transfer: 'unknown', color_space: 'unknown', color_range: 'tv' }), { code: 'color_metadata_ambiguous' });
  assert.throws(() => subject.classifyStream({ pix_fmt: 'yuv420p10le', codec_tag_string: 'dvh1', color_primaries: 'bt2020', color_transfer: 'bt709', color_space: 'bt2020nc', color_range: 'tv' }), { code: 'hdr_unsupported' });
});

test('non-orthogonal display rotation is rejected', () => {
  assert.equal(subject.displayRotation({ tags: { rotate: '90' } }), 90);
  assert.throws(() => subject.displayRotation({ tags: { rotate: '12.5' } }), { code: 'display_transform_unsupported' });
});
