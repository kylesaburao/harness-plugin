'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runNode } = require('./test-helpers.js');

test('test helpers / runNode resolves with the exit code when the child exits before reading stdin', async (t) => {
  // Far larger than any pipe buffer, so the write cannot finish before the child exits.
  const input = 'x'.repeat(32 * 1024 * 1024);
  const result = await runNode(t, ['-e', 'process.stderr.write("early"); process.exit(3)'], { input });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'early');
});
