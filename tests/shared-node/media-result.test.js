'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mediaFailed, childDetails } = require('../../plugins/harness/shared/node/media-result');

for (const [label, result, expected] of [
  ['empty stderr', { code: 0, signal: null, stderr: '' }, false],
  ['whitespace stderr', { code: 0, stderr: ' \n\t' }, false],
  ['nonzero exit', { code: 1, stderr: '' }, true],
  ['termination signal', { code: 0, signal: 'SIGTERM', stderr: '' }, true],
  ['nonempty stderr', { code: 0, stderr: 'warning\n' }, true],
  ['null exit', { code: null, stderr: '' }, true],
  ['missing stderr', { code: 0, signal: null }, false],
]) {
  test(`mediaFailed: ${label}`, () => {
    const before = { ...result };
    assert.equal(mediaFailed(Object.freeze(result)), expected);
    assert.deepEqual(result, before);
  });
}

test('childDetails preserves values and field order without mutating input', () => {
  for (const signal of ['SIGSEGV', null, undefined]) {
    const result = { code: null, stderr: ' exact diagnostic\n', stdout: 'unused' };
    if (signal !== undefined) result.signal = signal;
    const before = { ...result };
    const details = childDetails('decode task', Object.freeze(result));
    assert.deepEqual(details, {
      task: 'decode task', childExitCode: null, childSignal: signal ?? null, stderr: ' exact diagnostic\n',
    });
    assert.deepEqual(Object.keys(details), ['task', 'childExitCode', 'childSignal', 'stderr']);
    assert.deepEqual(result, before);
  }
  assert.deepEqual(childDetails('probe', { code: 7 }), {
    task: 'probe', childExitCode: 7, childSignal: null, stderr: undefined,
  });
});
