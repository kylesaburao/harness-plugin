#!/usr/bin/env node
// Minimum Node.js: 22.0.0. No packages or persistent state.
import { fileURLToPath } from 'node:url';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const helpCommand = `node ${quote(fileURLToPath(import.meta.url))} --help`;
const runtimeRemedy = 'Install supported Node.js with: brew install node@22 && export PATH="$(brew --prefix node@22)/bin:$PATH" (macOS), or nvm install 22 && nvm use 22 (Linux with nvm).';
const usage = `Usage: sample.mjs [--help | --preflight] [--json]

Read one complete JSON object from stdin, then output one JSON object.
  integer: {"op":"integer","min":1,"maxExclusive":101} -> op, value
    Safe integer endpoints, min inclusive, maxExclusive exclusive.
    Require 0 < maxExclusive - min < 2^48.
  boolean: {"op":"boolean"} -> op, value
  choice:  {"op":"choice","values":["heads","tails"]} -> op, index, value
    Nonempty array, uniform original position, duplicates preserved.
  sample:  {"op":"sample","values":["A","B"],"count":2} -> op, indices, values
    Ordered sampling without replacement, safe integer count in 0..length.
  shuffle: {"op":"shuffle","values":["A","B"]} -> op, indices, values
    Uniform permutation. Empty and singleton arrays are valid.
Only the fields shown are accepted. Array entries may be any JSON values.
System cryptographic randomness via node:crypto randomInt. Node.js >=22.0.0.
--help prints usage without reading stdin or checking the runtime.
--preflight checks runtime/crypto without reading stdin or drawing randomness.
--json selects JSON stderr diagnostics and JSON preflight output.
Normal success is always JSON. No automatic retries.
Exit: 0 success, 2 work not started (usage/input/runtime), 1 sampling failed.`;

function reject(code, condition, correction, status = 2) {
  throw Object.assign(new Error(condition), { code, remedy: correction, status });
}
function invalid(code, condition, correction) {
  reject(code, condition, `${correction} See: ${helpCommand}`);
}
function argumentsFor(argv) {
  const unknown = argv.find(arg => !['--help', '--preflight', '--json'].includes(arg));
  if (unknown !== undefined) invalid('UNKNOWN_ARGUMENT', `Unknown argument: ${unknown}`, 'Remove the unknown argument.');
  if (new Set(argv).size !== argv.length || (argv.includes('--help') && argv.includes('--preflight'))) {
    invalid('INVALID_ARGUMENTS', 'Duplicate flags or combined --help and --preflight.', 'Use each flag once and select at most one mode.');
  }
  return { help: argv.includes('--help'), preflight: argv.includes('--preflight') };
}
async function prerequisites() {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    reject('UNSUPPORTED_NODE', `Node.js 22.0.0 or newer is required, found ${process.versions.node}.`, runtimeRemedy);
  }
  try {
    const crypto = await import('node:crypto');
    if (typeof crypto.randomInt !== 'function') throw new Error('randomInt is not callable');
    return crypto;
  } catch (error) {
    reject('CRYPTO_UNAVAILABLE', `System cryptographic randomness is unavailable: ${error.message}`, runtimeRemedy);
  }
}
// Preserve candidate numeric tokens, including values outside IEEE-754 precision/range.
// Operation arguments must denote exact safe integers before conversion to Number.
function exactInteger(value) {
  // Older unsupported runtimes still validate input before the version diagnosis.
  if (typeof value === 'number') return value;
  if (typeof JSON.isRawJSON !== 'function' || !JSON.isRawJSON(value)) return NaN;
  const source = value.rawJSON;
  const number = Number(source);
  if (!Number.isSafeInteger(number)) return NaN;
  const [, sign, whole, fraction = '', exponent = '0'] = source.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return number;
  const significant = digits.replace(/0+$/, '');
  const shift = BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - significant.length);
  if (shift < 0n || shift > 16n || significant.length > 16) return NaN;
  return BigInt(sign + significant) * 10n ** shift === BigInt(number) ? number : NaN;
}
async function requestFromStdin() {
  let text = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) text += chunk;
  } catch (error) {
    invalid('INPUT_READ_FAILED', `Could not read stdin: ${error.message}`, 'Provide the complete JSON request through readable stdin.');
  }
  if (!text.trim()) invalid('EMPTY_INPUT', 'stdin contains no JSON request.', 'Send one JSON object through stdin.');
  let request;
  try {
    request = JSON.parse(text, typeof JSON.rawJSON === 'function'
      ? (key, value, context) => typeof value === 'number' ? JSON.rawJSON(context.source) : value
      : undefined);
  }
  catch { invalid('INVALID_JSON', 'stdin is not one complete JSON value.', 'Correct the JSON syntax and send exactly one object.'); }
  if (request === null || typeof request !== 'object' || Array.isArray(request) || typeof request.op !== 'string') {
    invalid('INVALID_REQUEST', 'Expected an object with a string op.', 'Provide a JSON object with an op field.');
  }
  const fields = { integer: ['min', 'maxExclusive'], boolean: [], choice: ['values'], sample: ['values', 'count'], shuffle: ['values'] };
  if (!Object.hasOwn(fields, request.op)) invalid('UNKNOWN_OPERATION', `Unknown operation: ${request.op}`, 'Use integer, boolean, choice, sample, or shuffle.');
  const unknown = Object.keys(request).find(key => key !== 'op' && !fields[request.op].includes(key));
  if (unknown !== undefined) invalid('INVALID_REQUEST', `Unknown field for ${request.op}: ${unknown}`, 'Remove or correct the unknown field.');
  if (request.op === 'integer') {
    const min = exactInteger(request.min);
    const maxExclusive = exactInteger(request.maxExclusive);
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(maxExclusive)
      || !(maxExclusive - min > 0 && maxExclusive - min < 2 ** 48)) {
      invalid('INVALID_INTEGER_RANGE', 'Expected safe integer endpoints with 0 < maxExclusive - min < 2^48.', 'Correct min and maxExclusive to satisfy these bounds.');
    }
    request.min = min;
    request.maxExclusive = maxExclusive;
  } else if (request.op !== 'boolean') {
    if (!Array.isArray(request.values) || (request.op === 'choice' && request.values.length === 0)) {
      invalid('INVALID_VALUES', 'Expected a values array, nonempty for choice.', 'Supply values as an array, with at least one entry for choice.');
    }
    if (request.op === 'sample') request.count = exactInteger(request.count);
    if (request.op === 'sample' && (!Number.isSafeInteger(request.count) || request.count < 0 || request.count > request.values.length)) {
      invalid('INVALID_COUNT', 'Expected a safe integer count in 0..values.length.', 'Set count to an integer from zero through values.length.');
    }
  }
  return request;
}
function sample(request, crypto) {
  const { op, min, maxExclusive, values, count } = request;
  if (op === 'integer') return { op, value: maxExclusive - min === 1 ? min : crypto.randomInt(min, maxExclusive) };
  if (op === 'boolean') return { op, value: crypto.randomInt(2) === 1 };
  if (op === 'choice') {
    const index = values.length === 1 ? 0 : crypto.randomInt(values.length);
    return { op, index, value: values[index] };
  }
  const indices = Array.from({ length: values.length }, (_, i) => i);
  if (op === 'sample') {
    // Partial Fisher-Yates retains draw order and treats duplicate positions separately.
    for (let i = 0; i < count && i < indices.length - 1; i++) {
      const j = crypto.randomInt(i, indices.length);
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    indices.length = count;
  } else {
    for (let i = indices.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
  }
  return { op, indices, values: indices.map(i => values[i]) };
}
async function main() {
  const argv = process.argv.slice(2);
  try {
    const mode = argumentsFor(argv);
    if (mode.help) { process.stdout.write(usage + '\n'); return; }
    const request = mode.preflight ? undefined : await requestFromStdin();
    const crypto = await prerequisites();
    if (mode.preflight) {
      process.stdout.write(argv.includes('--json')
        ? JSON.stringify({ preflight: { status: 'passed', node: process.versions.node, crypto: 'available' } }) + '\n'
        : `Preflight passed: Node.js ${process.versions.node}, crypto available.\n`);
      return;
    }
    let result;
    try { result = sample(request, crypto); }
    catch (error) { reject('SAMPLING_FAILED', `Sampling failed: ${error.message}`, 'Stop and report this failure. Restore working system cryptographic randomness before a user-requested new draw.', 1); }
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    const diagnostic = { code: error.code, condition: error.message, remedy: error.remedy };
    process.stderr.write(argv.includes('--json') ? JSON.stringify({ error: diagnostic }) + '\n'
      : `ERROR [${diagnostic.code}]: ${diagnostic.condition}\nRemedy: ${diagnostic.remedy}\n`);
    process.exitCode = error.status ?? 1;
  }
}
await main();
