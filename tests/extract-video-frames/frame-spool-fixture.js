'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const subject = require('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames');
const oracle = require('./frame-analysis-oracle');
async function outcome(fn) {
  try { return { result: await fn() }; }
  catch (error) { return { error: { code: error.code, condition: error.condition, remedy: error.remedy, exitCode: error.exitCode } }; }
}
async function analyzeFixture(data, color, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-fixture-'));
  try {
    const spool = path.join(root, 'frames.json');
    fs.writeFileSync(spool, JSON.stringify(data));
    const expected = await outcome(() => oracle.analyzePresentedFrames(data, color, options));
    const actual = await outcome(() => subject.analyzeFrameSpool(spool, color, options));
    assert.deepEqual(actual, expected);
    if (actual.error) throw Object.assign(new Error(actual.error.condition), actual.error);
    return actual.result;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = { analyzeFixture, outcome };
