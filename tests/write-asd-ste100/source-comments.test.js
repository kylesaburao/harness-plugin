'use strict';

// The compiled JavaScript-family comment helper, run directly. Its parser comes
// from the user-level install that npm run test:setup creates; these tests
// never install anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { artifactPath } = require('../helpers/plugin-paths');

const skill = artifactPath('skills/write-asd-ste100');
const helper = path.join(skill, 'scripts/extract-js-comments.js');
const installedModules = path.join(os.homedir(), '.harness-plugin/write-asd-ste100/node_modules');

function run(args, { input = '', home = os.homedir(), file = helper, cwd = undefined } = {}) {
  const result = spawnSync(process.execPath, [file, ...args], {
    input, cwd, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: home, NODE_PATH: '', NODE_OPTIONS: '' },
  });
  assert.equal(result.error, undefined);
  return result;
}

function failure(result, status, code) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^[^\n]+\n$/);
  const { error } = JSON.parse(result.stderr);
  assert.equal(error.code, code, result.stderr);
  return error;
}

const ready = run(['--preflight', '--json']).status === 0;
const needsParser = { skip: !ready && 'the comment parser is not installed; run npm run test:setup' };

function profile(overrides = {}) {
  return { typescript: false, jsx: false, sourceType: 'unambiguous', declaration: false, disallowAmbiguousJsxLike: false, ...overrides };
}

function extract(files) {
  const request = { protocolVersion: 1, files: files.map((file, id) => ({ id, path: `input-${id}`, ...file })) };
  const result = run(['--json'], { input: JSON.stringify(request) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^[^\n]+\n$/);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(envelope), ['result']);
  assert.equal(envelope.result.protocolVersion, 1);
  assert.equal(envelope.result.offsetEncoding, 'utf16');
  return envelope.result.files;
}

function commentTexts(text, options = {}) {
  const [result] = extract([{ profile: profile(options), text }]);
  assert.ok(result.comments, JSON.stringify(result));
  return result.comments.map(comment => [comment.kind, text.slice(comment.start, comment.end)]);
}

test('help and usage need no dependencies', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ste-helper-empty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const flag of ['--help', '-h']) {
    const help = run([flag], { home });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^Usage: /);
  }
  failure(run(['--bogus', '--json'], { home }), 2, 'usage_error');
  const plain = run(['--bogus'], { home });
  assert.equal(plain.status, 2);
  assert.match(plain.stderr, /^ERROR \[usage_error\]: .*\nRemedy: /);
});

test('requests are validated before the environment', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ste-helper-empty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = { id: 0, path: 'a.ts', profile: profile(), text: '' };
  for (const request of [
    '{',
    '[]',
    { protocolVersion: 2, files: [] },
    { protocolVersion: 1, files: [], extra: true },
    { protocolVersion: 1, files: [file, file] },
    { protocolVersion: 1, files: [{ ...file, id: -1 }] },
    { protocolVersion: 1, files: [{ ...file, text: 1 }] },
    { protocolVersion: 1, files: [{ ...file, profile: { ...profile(), sourceType: 'script' } }] },
    { protocolVersion: 1, files: [{ ...file, profile: { ...profile(), plugins: [] } }] },
    { protocolVersion: 1, files: [{ ...file, profile: profile({ declaration: true }) }] },
  ]) {
    const input = typeof request === 'string' ? request : JSON.stringify(request);
    failure(run(['--json'], { input, home }), 2, 'request_invalid');
  }
  const missing = failure(run(['--json'], { input: JSON.stringify({ protocolVersion: 1, files: [file] }), home }), 2, 'dependency_missing');
  assert.equal(missing.dependencyRoot, path.join(home, '.harness-plugin/write-asd-ste100'));
  assert.ok(missing.remedy.includes(`'${path.join(skill, 'package-lock.json')}'`), missing.remedy);
  assert.ok(missing.remedy.includes(`npm ci --omit=dev --prefix '${missing.dependencyRoot}'`), missing.remedy);
  failure(run(['--preflight', '--json'], { home }), 2, 'dependency_missing');
});

test('preflight reports the exact parser version and location', needsParser, () => {
  const result = run(['--preflight', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const expected = JSON.parse(fs.readFileSync(path.join(skill, 'package.json'), 'utf8')).dependencies['@babel/parser'];
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'ready', parserVersion: expected, dependencyRoot: path.join(os.homedir(), '.harness-plugin/write-asd-ste100'),
  });
});

test('an installed skill copy runs as CommonJS beneath an ESM parent', needsParser, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ste helper é ')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  const copy = path.join(root, 'write-asd-ste100');
  fs.cpSync(skill, copy, { recursive: true, filter: source => !source.includes('__pycache__') });
  const home = path.join(root, 'home');
  const dependencyRoot = path.join(home, '.harness-plugin/write-asd-ste100');
  fs.mkdirSync(dependencyRoot, { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(skill, name), path.join(dependencyRoot, name));
  fs.symlinkSync(installedModules, path.join(dependencyRoot, 'node_modules'), 'dir');
  const copied = path.join(copy, 'scripts/extract-js-comments.js');
  assert.equal(run(['--preflight', '--json'], { home, file: copied, cwd: root }).status, 0);
  const request = { protocolVersion: 1, files: [{ id: 3, path: 'a.js', profile: profile(), text: 'x; // c\n' }] };
  const result = run(['--json'], { home, file: copied, cwd: root, input: JSON.stringify(request) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).result.files, [{ id: 3, comments: [{ kind: 'line', start: 3, end: 7 }] }]);
});

test('every comment is reported once, in source order, and the hashbang is not a comment', needsParser, () => {
  const text = '#!/usr/bin/env node\n/** a */\nfunction f(/* b */ x) { // c\n  return x; /* d */\n}\n// e\n';
  assert.deepEqual(commentTexts(text), [
    ['block', '/** a */'], ['block', '/* b */'], ['line', '// c'], ['block', '/* d */'], ['line', '// e'],
  ]);
});

test('lexical boundaries come from the grammar', needsParser, () => {
  const text = "const a = '// no', r = /\\/* no [/*]/g, d = a / 2 / 1; // yes\nconst t = `// no ${/* yes */ `${1} // no`}`;\n";
  assert.deepEqual(commentTexts(text), [['line', '// yes'], ['block', '/* yes */']]);
  assert.deepEqual(commentTexts('const e = <a title="// no">// no {/* yes */}</a>;\n', { jsx: true }), [['block', '/* yes */']]);
});

test('profiles select TypeScript, JSX, module, and declaration parsing', needsParser, () => {
  const cases = [
    ['const x = <number>y; // c\n', profile({ typescript: true })],
    ['declare const x: number; // c\n', profile({ typescript: true, declaration: true })],
    ['import x from "y"; // c\nexport = x;\n', profile({ typescript: true, disallowAmbiguousJsxLike: true })],
    ['const x = require("y"); // c\nreturn;\n', profile({ sourceType: 'commonjs' })],
    ['module.exports = 1; // c\nreturn;\n', profile()],
    ['const e = <a />; // c\n', profile({ typescript: true, jsx: true })],
  ];
  const results = extract(cases.map(([text, options]) => ({ profile: options, text })));
  assert.deepEqual(results.map(result => result.id), [0, 1, 2, 3, 4, 5]);
  for (const result of results) assert.equal(result.comments?.length, 1, JSON.stringify(result));
});

test('unsupported syntax is a per-file parse error with a UTF-16 offset', needsParser, () => {
  const results = extract([
    { profile: profile({ typescript: true }), text: '@dec class A {}\n' },
    { profile: profile(), text: '<!-- c\n' },
    { profile: profile({ typescript: true, sourceType: 'module', disallowAmbiguousJsxLike: true }), text: 'const x = <number>y;\n' },
    { profile: profile({ sourceType: 'module' }), text: 'return 1;\n' },
    { profile: profile(), text: 'const x: number = 1;\n' },
    { profile: profile(), text: "'😀'; const = 1;\n" },
    { profile: profile(), text: '// fine\n' },
  ]);
  for (const result of results.slice(0, 6)) {
    assert.deepEqual(Object.keys(result).sort(), ['error', 'id']);
    assert.equal(typeof result.error.reason, 'string');
    assert.doesNotMatch(result.error.message, /\(\d+:\d+\)$/);
    assert.equal(typeof result.error.offset, 'number');
  }
  assert.equal(results[5].error.offset, 12);
  assert.deepEqual(results[6].comments, [{ kind: 'line', start: 0, end: 7 }]);
});

test('offsets are UTF-16 indexes of the supplied text', needsParser, () => {
  const text = "'😀 '; /* é */ // c\n";
  const [result] = extract([{ profile: profile(), text }]);
  assert.deepEqual(result.comments, [{ kind: 'block', start: 7, end: 14 }, { kind: 'line', start: 15, end: 19 }]);
  assert.equal(text.slice(7, 14), '/* é */');
});
