const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { frameRecords } = require('../../dist/harness/skills/extract-video-frames/scripts/frame-records');
const { integerTimestamp, analyzeFrameSpool } = require('../../dist/harness/skills/extract-video-frames/scripts/media-model');
const color = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-integer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'frames.json');
}
async function read(file, highWaterMark) {
  const result = []; for await (const record of frameRecords(file, { highWaterMark })) result.push(record); return result;
}
test('literal integer tokens retain exact values at both safe boundaries for all timing fields', async t => {
  const file = fixture(t);
  for (const token of ['9007199254740990', '9007199254740991', '9007199254740992', '9007199254740993', '-9007199254740990', '-9007199254740991', '-9007199254740992', '-9007199254740993']) {
    for (const field of ['best_effort_timestamp', 'duration', 'pkt_duration']) {
      fs.writeFileSync(file, `{"frames":[{"${field}":${token}}]}`);
      for (const chunk of [1, 7, 65536]) {
        const value = (await read(file, chunk))[0][field];
        assert.equal(BigInt(value), BigInt(token));
        assert.equal(typeof value, BigInt(token) > 9007199254740991n || BigInt(token) < -9007199254740991n ? 'string' : 'number');
      }
    }
  }
});
test('positive and negative raw origins preserve inclusive bigint point windows and large durations', async t => {
  const file = fixture(t);
  for (const origin of [9007199254740990n, 9007199254740991n, 9007199254740992n, 9007199254740993n, -9007199254740993n]) {
    for (const field of ['duration', 'pkt_duration']) {
      const delta = 33333333n;
      fs.writeFileSync(file, `{"frames":[{"best_effort_timestamp":${origin},"${field}":${delta}},{"best_effort_timestamp":${origin + delta},"${field}":9007199254740993}]}`);
      for (const highWaterMark of [1, 7]) {
        const result = await analyzeFrameSpool(file, color, { start: delta, end: delta, timeBase: '1/1000000000' }, { highWaterMark });
        assert.equal(result.expectedFrames, 1);
        assert.equal(result.firstTick, delta);
        assert.equal(result.lastTick, delta);
        assert.equal(result.duration, delta + 9007199254740993n);
      }
    }
  }
});
test('escaped keys, duplicates, strings and nested lookalikes respect ordinary JSON semantics', async t => {
  const file = fixture(t);
  const raw = String.raw`{"frames":[{"best_effort_\u0074imestamp":9007199254740993,"duration":9007199254740993,"duration":1.5,"pkt_duration":"9007199254740993","nested":{"best_effort_timestamp":9007199254740993},"array":[{"duration":9007199254740993}],"text":"escaped \\\" } ,","unrelated":9007199254740993},{"duration":9007199254740993,"duration":null},{"duration":9007199254740993,"duration":{"x":1}},{"duration":3,"duration":9007199254740993},{"duration":2e3},{"duration":9007199254740993,"duration":9e2},{"best_effort_timestamp":"9007199254740993"}]}`;
  fs.writeFileSync(file, raw);
  const expected = JSON.parse(raw).frames;
  expected[0].best_effort_timestamp = '9007199254740993';
  expected[3].duration = '9007199254740993';
  for (const chunk of [1, 2, 7]) assert.deepEqual(await read(file, chunk), expected);
  for (const invalid of ['{"frames":[{"duration":01}]}', '{"frames":[{"duration":9007199254740993,}]}']) {
    fs.writeFileSync(file, invalid); await assert.rejects(read(file, 1), SyntaxError);
  }
});
test('unsafe direct numbers reject before bigint conversion while safe numeric behavior stays unchanged', () => {
  for (const value of [9007199254740992, -9007199254740992, 1e30, Infinity, NaN]) {
    assert.throws(() => integerTimestamp(value), { code: 'input_unusable' });
  }
  assert.equal(integerTimestamp(1.5), null);
  assert.equal(integerTimestamp(2e3), 2000n);
  assert.equal(integerTimestamp('9007199254740993'), 9007199254740993n);
});
