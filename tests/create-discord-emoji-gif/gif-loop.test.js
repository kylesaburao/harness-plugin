'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inspectGifLoop, gifDurationCentiseconds } = require(require('../helpers/plugin-paths').artifactPath('skills/create-discord-emoji-gif/scripts/node/gif-loop'));
const shared = require(require('../helpers/plugin-paths').artifactPath('skills/create-discord-emoji-gif/scripts/node/shared'));
const { ProcessManager } = require(require('../helpers/plugin-paths').artifactPath('skills/create-discord-emoji-gif/scripts/node/process-manager'));
const { spawnSync } = require('node:child_process');
const { temporaryDirectory, tinyGif } = require('./test-helpers');

const bytes = (...values) => Buffer.from(values);
const header = Buffer.concat([Buffer.from('GIF89a'), bytes(1, 0, 1, 0, 0, 0, 0)]);
const sub = payload => Buffer.concat([bytes(payload.length), payload, bytes(0)]);
const app = (identity = 'NETSCAPE2.0', count = 0) => Buffer.concat([
  bytes(0x21, 0xff, 11), Buffer.from(identity), sub(bytes(1, count & 255, count >> 8)),
]);
const image = (payload = bytes(0x44, 1), local = false) => Buffer.concat([
  bytes(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, local ? 0x80 : 0),
  local ? Buffer.alloc(6) : Buffer.alloc(0), bytes(2), sub(payload),
]);
const gif = (...blocks) => Buffer.concat([header, ...blocks, bytes(0x3b)]);

test('loop walker accepts both identities, headers, color tables and compatible duplicates', () => {
  for (const identity of ['NETSCAPE2.0', 'ANIMEXTS1.0']) {
    const other = identity === 'NETSCAPE2.0' ? 'ANIMEXTS1.0' : 'NETSCAPE2.0';
    for (const version of ['GIF87a', 'GIF89a']) {
      const data = gif(app(identity), image(), app(identity), app(other), image(bytes(0x44, 1), true));
      data.write(version);
      assert.deepEqual(inspectGifLoop(data), { mode: 'infinite', repeatCount: 0, extension: identity });
    }
  }
  const global = Buffer.from(header);
  global[10] = 0x87;
  assert.equal(inspectGifLoop(Buffer.concat([global, Buffer.alloc(768), app(), image(), bytes(0x3b)])).mode, 'infinite');
});

test('only structural supported application identifiers count', () => {
  const identity = Buffer.from('NETSCAPE2.0');
  const comment = Buffer.concat([bytes(0x21, 0xfe), sub(identity)]);
  const unknown = app('UNKNOWN0000');
  const control = Buffer.concat([bytes(0x21, 0xf9), sub(bytes(0, 1, 0, 0))]);
  const highBitIdentity = app();
  highBitIdentity[3] |= 0x80;
  for (const blocks of [[image(identity)], [comment, image()], [unknown, image()], [highBitIdentity, image()]]) {
    assert.throws(() => inspectGifLoop(gif(...blocks)), /missing supported loop/);
    assert.equal(inspectGifLoop(gif(...blocks, control, app('ANIMEXTS1.0'))).extension, 'ANIMEXTS1.0');
  }
});

test('finite, conflicting, absent and ambiguous loop controls fail', () => {
  for (const count of [1, 256, 65535]) assert.throws(() => inspectGifLoop(gif(app('NETSCAPE2.0', count), image())), /finite repetition count/);
  for (const blocks of [[app(), app('ANIMEXTS1.0', 1)], [app('ANIMEXTS1.0', 1), app()]]) {
    assert.throws(() => inspectGifLoop(gif(...blocks, image())), /conflicting loop declarations/);
  }
  const prefix = Buffer.concat([bytes(0x21, 0xff, 11), Buffer.from('NETSCAPE2.0')]);
  for (const payload of [bytes(0), bytes(2, 1, 0, 0), bytes(3, 2, 0, 0, 0), bytes(3, 1, 0, 0, 3, 1, 0, 0, 0), bytes(4, 1, 0, 0, 0, 0)]) {
    assert.throws(() => inspectGifLoop(gif(Buffer.concat([prefix, payload]), image())), /loop control/);
  }
});

test('truncated framing, invalid identifiers, missing terminators and trailers fail', () => {
  const data = gif(app(), image(bytes(0x44, 1), true));
  for (let length = 0; length < data.length; length++) {
    assert.throws(() => inspectGifLoop(data.subarray(0, length)), /invalid GIF looping/, `prefix length ${length}`);
  }
  const invalidHeader = Buffer.from(data);
  invalidHeader[0] |= 0x80;
  assert.throws(() => inspectGifLoop(invalidHeader), /unsupported header/);
  const global = Buffer.from(header);
  global[10] = 0x87;
  assert.throws(() => inspectGifLoop(Buffer.concat([global, bytes(0)])), /truncated/);
  assert.throws(() => inspectGifLoop(gif(bytes(0x21, 0xff, 10), Buffer.alloc(10), bytes(0))), /11 bytes/);
  assert.throws(() => inspectGifLoop(gif(app(), bytes(0x21, 0xfe, 255, 1))), /truncated/);
  assert.throws(() => inspectGifLoop(gif(app(), bytes(0x21, 0xfe, 1, 1))), /truncated/);
  assert.throws(() => inspectGifLoop(gif(app(), bytes(0x00))), /sentinel/);
  assert.throws(() => inspectGifLoop(Buffer.concat([data, bytes(0)])), /data after trailer/);
});

test('supplied decodable nonlooping GIF fails verification and preserves the destination', async t => {
  const dir = temporaryDirectory('gif-loop-fixture.');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(__dirname, 'fixtures/nonlooping.gif');
  const output = path.join(dir, 'output.gif');
  fs.writeFileSync(output, 'existing destination');
  await assert.rejects(shared.publishVerified(source, output, 'loop-test', file => shared.verifyFinalGif(
    new ProcessManager(), { ffprobe: 'ffprobe' }, file,
    { size: 128, maxBytes: 256000, referenceFrames: 24, fps: 24, bytes: fs.statSync(source).size, digest: shared.sha256File(source) },
  )), error => error.code === 'verification_failed' && /missing supported loop declaration/.test(error.condition));
  assert.equal(fs.readFileSync(output, 'utf8'), 'existing destination');
  assert.deepEqual(fs.readdirSync(dir), ['output.gif']);
});

test('GIF duration sums control delays the way FFmpeg reports format=duration', t => {
  const dir = temporaryDirectory('gif-duration.');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const control = (size, delay) => Buffer.concat([bytes(0x21, 0xf9, size), Buffer.from([0, delay & 255, delay >> 8, 0, 0, 0].slice(0, size)), bytes(0)]);
  const cases = [
    ['zero delay reads as the 10 cs default', tinyGif([0]), 10],
    ['one centisecond is kept', tinyGif([1]), 1],
    ['ordinary delays are summed', tinyGif([2, 3, 10]), 15],
    ['maximum delay', tinyGif([65535]), 65535],
    ['a frame without a control block adds nothing', tinyGif([null, 5]), 5],
    ['a control block shorter than 4 bytes is ignored', gif(control(4, 5), image(), control(3, 9), image(), control(4, 7), image()), 12],
    ['every control block counts', gif(control(4, 5), control(4, 7), image(), control(4, 9), image()), 21],
    ['a control block longer than 4 bytes is ignored', gif(control(5, 8), image(), control(6, 9), image(), control(4, 3), image()), 3],
  ];
  for (const [name, data, expected] of cases) {
    assert.equal(gifDurationCentiseconds(data), expected, name);
    const file = path.join(dir, `${expected}-${cases.findIndex(entry => entry[0] === name)}.gif`);
    fs.writeFileSync(file, data);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim(), (expected / 100).toFixed(6), `ffprobe agreement: ${name}`);
  }
  assert.equal(gifDurationCentiseconds(tinyGif([null, null])), 0);
  // Timing ignores loop policy; looping verification still rejects the same file.
  const finite = gif(app('NETSCAPE2.0', 1), control(4, 6), image());
  assert.equal(gifDurationCentiseconds(finite), 6);
  assert.throws(() => inspectGifLoop(finite), /finite repetition count 1/);
  assert.throws(() => gifDurationCentiseconds(tinyGif([5]).subarray(0, 40)), /invalid GIF timing: truncated block/);
});

test('loop inspection reads past control blocks', () => {
  assert.deepEqual(inspectGifLoop(tinyGif([4, 0, 65535])), { mode: 'infinite', repeatCount: 0, extension: 'NETSCAPE2.0' });
});
