// Test-only fault injection and entropy tracing. Production has no test controls.
const crypto = require('node:crypto');
const { syncBuiltinESMExports, registerHooks } = require('node:module');
const { writeSync } = require('node:fs');
const mode = process.env.SAMPLER_TEST_MODE;
if (mode === 'old') Object.defineProperty(process.versions, 'node', { value: '21.9.0' });
if (mode === 'old-json') {
  Object.defineProperty(process.versions, 'node', { value: '20.0.0' });
  delete JSON.rawJSON;
  delete JSON.isRawJSON;
}
if (mode === 'floor') Object.defineProperty(process.versions, 'node', { value: '22.0.0' });
if (mode === 'import') registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:crypto') throw new Error('injected import failure');
  return next(specifier, context);
} });
if (mode === 'read') process.stdin[Symbol.asyncIterator] = async function* () { throw new Error('injected read failure'); };
crypto.randomInt = mode === 'missing' ? undefined : (...args) => {
  writeSync(3, JSON.stringify(args) + '\n');
  if (mode === 'throw') throw new Error('injected entropy failure');
  // Select the upper endpoint minus one to expose order and duplicate handling.
  return args.at(-1) - 1;
};
syncBuiltinESMExports();
