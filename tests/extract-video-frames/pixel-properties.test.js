'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const subject = require('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js');
const fixture = require('./pixel-formats.json');
const descriptors = subject.descriptorMap(fixture);
const tags = { color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709', color_range: 'tv' };

for (const [pix_fmt, alpha, bitDepth] of [
  ['ya8', true, 8], ['ya16le', true, 16], ['ya16be', true, 16],
  ['rgba', true, 8], ['rgba64le', true, 16], ['rgba64be', true, 16],
  ['yuv420p', false, 8], ['yuv420p10le', false, 10],
]) test(`authoritative ${pix_fmt} descriptor determines alpha and useful component depth`, () => {
  for (const fields of [{}, { bits_per_raw_sample: '12', bits_per_coded_sample: '64', alpha_mode: 1 }]) {
    const stream = { ...tags, pix_fmt, ...fields };
    const properties = subject.pixelProperties(stream, descriptors);
    assert.deepEqual(properties, { alpha, bitDepth });
    const color = subject.classifyStream(stream, properties);
    assert.equal(color.outputDepth, bitDepth > 8 ? '16' : '8');
    assert.equal(color.alpha, alpha);
  }
});

test('missing and malformed descriptors fail without guessing a depth', () => {
  for (const data of [null, {}, { pixel_formats: [] }, { pixel_formats: [null] }, { pixel_formats: [{ name: 'x' }, { name: 'x' }] }]) {
    assert.throws(() => subject.descriptorMap(data), { code: 'ffprobe_probe_failed', exitCode: 2 });
  }
  for (const stream of [{}, { pix_fmt: 'unknown' }]) assert.throws(() => subject.pixelProperties(stream, descriptors), { code: 'pixel_format_unsupported', exitCode: 2 });
  const valid = descriptors.get('ya16le');
  for (const override of [
    { flags: {} }, { flags: { alpha: '1' } }, { nb_components: 0 },
    { components: [] }, { components: [{ index: 1, bit_depth: 16 }] },
    { components: [{ index: 1, bit_depth: 16 }, { index: 2, bit_depth: '16' }] },
    { components: [{ index: 1, bit_depth: 0 }, { index: 2, bit_depth: 16 }] },
  ]) {
    const malformed = new Map([['ya16le', { ...valid, ...override }]]);
    assert.throws(() => subject.pixelProperties({ pix_fmt: 'ya16le', bits_per_raw_sample: '16' }, malformed), error => {
      assert.equal(error.code, 'pixel_format_unsupported');
      assert.equal(error.exitCode, 2);
      assert.match(error.condition, /ya16le/);
      assert.match(error.remedy, /brew install ffmpeg-full/);
      return true;
    });
  }
});

for (const transfer of ['smpte2084', 'arib-std-b67']) test(`${transfer} alpha is rejected before extraction`, () => {
  const stream = { ...tags, pix_fmt: 'yuva444p10le', color_primaries: 'bt2020', color_transfer: transfer, color_space: 'bt2020nc' };
  assert.throws(() => subject.classifyStream(stream, subject.pixelProperties(stream, descriptors)), { code: 'hdr_alpha_unsupported', exitCode: 2 });
});

for (const badFormat of ['rgb48be', 'rgba', 'unknown']) {
  for (const badIndex of [0, 1]) test(`PNG checks reject ${badFormat} in ${badIndex ? 'last' : 'first'} output`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-pixel-check-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const name of ['frame-000001.png', 'frame-000002.png']) fs.writeFileSync(path.join(root, name), 'image');
    let count = 0;
    const manager = { run: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ streams: [{ codec_name: 'png', width: 16, height: 16, pix_fmt: count++ === badIndex ? badFormat : 'rgba64be' }] }) }) };
    const state = { pixelDescriptors: descriptors, commands: { ffprobe: 'ffprobe' }, media: { expectedFrames: 2, width: 16, height: 16, color: { codec: 'png', extension: 'png', alpha: true, outputDepth: '16' } } };
    await assert.rejects(subject.structuralChecks(manager, state, root), { code: 'structural_check_failed', exitCode: 1 });
  });
}

test('PNG checks accept equivalent endian descriptors and report measured properties', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-pixel-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['frame-000001.png', 'frame-000002.png']) fs.writeFileSync(path.join(root, name), 'image');
  let count = 0;
  const manager = { run: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ streams: [{ codec_name: 'png', width: 16, height: 16, pix_fmt: count++ ? 'rgba64be' : 'rgba64le' }] }) }) };
  const state = { pixelDescriptors: descriptors, commands: { ffprobe: 'ffprobe' }, media: { expectedFrames: 2, width: 16, height: 16, color: { codec: 'png', extension: 'png', alpha: true, outputDepth: '16' } } };
  const result = await subject.structuralChecks(manager, state, root);
  assert.deepEqual(result.probes.map(({ alpha, bitDepth }) => ({ alpha, bitDepth })), [{ alpha: true, bitDepth: 16 }, { alpha: true, bitDepth: 16 }]);
});
