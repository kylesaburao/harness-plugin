'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inspectGifLoop } = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/gif-loop');
const shared = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/shared');
const { ProcessManager } = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/process-manager');
const { temporaryDirectory } = require('./test-helpers');

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
