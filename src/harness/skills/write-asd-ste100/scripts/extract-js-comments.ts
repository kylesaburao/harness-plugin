#!/usr/bin/env node
'use strict';

// Comment-range extraction for JavaScript-family sources. ste_check.py sends one
// JSON request on stdin and receives comment ranges, never an AST or findings.
// The Python resolver owns profile selection; this helper only translates a
// profile into fixed parser options and does not guess a language from a path.

import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import nodeModule = require('node:module');
const { createRequire } = nodeModule;

const MINIMUM_NODE = [24, 0, 0] as const;
const PROTOCOL_VERSION = 1;
const PARSER_PACKAGE = '@babel/parser';
const USER_STATE_RELATIVE_PATH = path.join('.harness-plugin', 'write-asd-ste100');
const SKILL_DIRECTORY = path.resolve(__dirname, '..');
const SOURCE_TYPES = new Set(['module', 'commonjs', 'unambiguous']);
const PROFILE_KEYS = ['typescript', 'jsx', 'sourceType', 'declaration', 'disallowAmbiguousJsxLike'];
const FILE_KEYS = ['id', 'path', 'profile', 'text'];
const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2 });

interface Profile {
  typescript: boolean;
  jsx: boolean;
  sourceType: 'module' | 'commonjs' | 'unambiguous';
  declaration: boolean;
  disallowAmbiguousJsxLike: boolean;
}
interface RequestFile { id: number; path: string; profile: Profile; text: string }
interface CommentRange { kind: 'line' | 'block'; start: number; end: number }
type FileResult =
  | { id: number; comments: CommentRange[] }
  | { id: number; error: { reason: string; message: string; offset: number | null } };

// The narrow part of @babel/parser this helper relies on. The package is
// loaded at run time from the user-level install, so it has no compile-time types.
interface ParsedFile { comments?: unknown }
type ParseFunction = (source: string, options: Record<string, unknown>) => ParsedFile;
interface Readiness { parse: ParseFunction; parserVersion: string; dependencyRoot: string }

class HelperError extends Error {
  code: string;
  condition: string;
  remedy: string;
  exitCode: number;
  details: Record<string, unknown>;

  constructor(code: string, condition: string, remedy: string, exitCode: number = EXIT.USAGE,
    details: Record<string, unknown> = {}) {
    super(condition);
    this.name = 'HelperError';
    this.code = code;
    this.condition = condition;
    this.remedy = remedy;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return isObject(error) && typeof error.message === 'string' ? error.message : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function usage(): string {
  return `Usage: node scripts/extract-js-comments.js [--json] [--preflight] [--help]

Read one JSON comment-extraction request on stdin and print comment ranges.
ste_check.py runs this helper for JavaScript, TypeScript, JSX, and TSX inputs.

Options:
  --preflight  Check Node.js and the @babel/parser install, read nothing, exit
  --json       Report errors as one JSON line on stderr (results are always JSON)
  --help, -h   Print this message

The parser is loaded only from ~/.harness-plugin/write-asd-ste100/node_modules,
installed from this skill's package.json and package-lock.json.

Exit status: 0 success or a passed preflight, 2 bad usage, invalid request, or
missing dependency, 1 unexpected extraction failure.
`;
}

interface Options { json: boolean; preflight: boolean; help: boolean }

function parseArguments(argv: string[]): Options {
  const options: Options = { json: false, preflight: false, help: false };
  for (const argument of argv) {
    if (argument === '--json') options.json = true;
    else if (argument === '--preflight') options.preflight = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else {
      throw new HelperError('usage_error', `unrecognized argument: ${argument}`,
        'run node extract-js-comments.js --help and correct the arguments');
    }
  }
  return options;
}

function nodeVersionAtLeast(version: string, minimum: readonly number[]): boolean {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const part = parts[index] || 0;
    if (part > minimum[index]!) return true;
    if (part < minimum[index]!) return false;
  }
  return true;
}

function dependencyInstallCommand(dependencyRoot: string): string {
  return `mkdir -p ${shellQuote(dependencyRoot)}`
    + ` && cp ${shellQuote(path.join(SKILL_DIRECTORY, 'package.json'))} ${shellQuote(path.join(SKILL_DIRECTORY, 'package-lock.json'))} ${shellQuote(dependencyRoot)}`
    + ` && npm ci --omit=dev --prefix ${shellQuote(dependencyRoot)}`;
}

function readBytes(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    const code = isObject(error) ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

function expectedParserVersion(): string {
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(SKILL_DIRECTORY, 'package.json'), 'utf8'));
  const dependencies = isObject(manifest) ? manifest.dependencies : undefined;
  const version = isObject(dependencies) ? dependencies[PARSER_PACKAGE] : undefined;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new HelperError('dependency_invalid',
      `the skill manifest ${path.join(SKILL_DIRECTORY, 'package.json')} does not pin ${PARSER_PACKAGE} exactly`,
      'reinstall or update the plugin');
  }
  return version;
}

// Resolves @babel/parser only from <dependencyRoot>/node_modules, installed from
// this skill's own manifest and lockfile. A package found at the repository
// root, in a target project, through NODE_PATH, or beside the installed skill
// does not count. The same checks serve --preflight and a real run.
function checkReadiness(homeDirectory = os.homedir()): Readiness {
  if (!nodeVersionAtLeast(process.version, MINIMUM_NODE)) {
    throw new HelperError('node_version_unsupported',
      `Node.js ${MINIMUM_NODE.join('.')} or newer is required for JavaScript-family comment extraction, running ${process.version}`,
      `install Node.js ${MINIMUM_NODE.join('.')} or newer`);
  }
  const dependencyRoot = path.join(homeDirectory, USER_STATE_RELATIVE_PATH);
  const remedy = dependencyInstallCommand(dependencyRoot);
  const details = { dependencyRoot };
  const missing = () => new HelperError('dependency_missing',
    `${PARSER_PACKAGE} is not installed in ${path.join(dependencyRoot, 'node_modules')}, so JavaScript-family comments cannot be extracted`,
    remedy, EXIT.USAGE, details);
  const invalid = (condition: string) => new HelperError('dependency_invalid', condition, remedy, EXIT.USAGE, details);

  let modules: string;
  try {
    modules = fs.realpathSync(path.join(dependencyRoot, 'node_modules'));
  } catch (error) {
    const code = isObject(error) ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw missing();
    throw error;
  }
  const requireFromRoot = createRequire(path.join(dependencyRoot, 'package.json'));
  let resolved: string;
  try {
    resolved = fs.realpathSync(requireFromRoot.resolve(PARSER_PACKAGE));
  } catch (error) {
    if (isObject(error) && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ENOENT')) throw missing();
    throw error;
  }
  if (!resolved.startsWith(modules + path.sep)) throw missing();

  for (const name of ['package.json', 'package-lock.json']) {
    const installed = readBytes(path.join(dependencyRoot, name));
    const selected = readBytes(path.join(SKILL_DIRECTORY, name));
    if (selected === null) {
      throw invalid(`the skill file ${path.join(SKILL_DIRECTORY, name)} is missing; reinstall or update the plugin`);
    }
    if (installed === null || !installed.equals(selected)) {
      throw invalid(`the install in ${dependencyRoot} was not made from this skill's ${name}: ${path.join(SKILL_DIRECTORY, name)}`);
    }
  }

  const expected = expectedParserVersion();
  let installedVersion: unknown;
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(modules, '@babel', 'parser', 'package.json'), 'utf8'));
    installedVersion = isObject(manifest) ? manifest.version : undefined;
  } catch (error) {
    throw invalid(`the installed ${PARSER_PACKAGE} manifest cannot be read: ${messageOf(error)}`);
  }
  if (installedVersion !== expected) {
    throw invalid(`${PARSER_PACKAGE} ${String(installedVersion)} is installed in ${dependencyRoot}; this skill requires ${expected}`);
  }

  let parser: unknown;
  try {
    parser = requireFromRoot(PARSER_PACKAGE);
  } catch (error) {
    throw invalid(`the installed ${PARSER_PACKAGE} package could not load: ${messageOf(error)}`);
  }
  if (!isObject(parser) || typeof parser.parse !== 'function') {
    throw invalid(`the installed ${PARSER_PACKAGE} package does not export a parse function`);
  }
  return { parse: parser.parse as ParseFunction, parserVersion: expected, dependencyRoot };
}

function invalidRequest(condition: string): HelperError {
  return new HelperError('request_invalid', condition,
    'send one {"protocolVersion":1,"files":[...]} request as ste_check.py does');
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidRequest(`${where} must have exactly the keys ${expected.join(', ')}`);
  }
}

function validateRequest(value: unknown): RequestFile[] {
  if (!isObject(value)) throw invalidRequest('the request must be a JSON object');
  exactKeys(value, ['protocolVersion', 'files'], 'the request');
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw invalidRequest(`protocolVersion must be ${PROTOCOL_VERSION}`);
  }
  if (!Array.isArray(value.files)) throw invalidRequest('files must be an array');
  const seen = new Set<number>();
  return value.files.map((file: unknown, index: number): RequestFile => {
    const where = `files[${index}]`;
    if (!isObject(file)) throw invalidRequest(`${where} must be an object`);
    exactKeys(file, FILE_KEYS, where);
    const { id, path: filePath, profile, text } = file;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
      throw invalidRequest(`${where}.id must be a non-negative integer`);
    }
    if (seen.has(id)) throw invalidRequest(`${where}.id ${id} is a duplicate`);
    seen.add(id);
    if (typeof filePath !== 'string') throw invalidRequest(`${where}.path must be a string`);
    if (typeof text !== 'string') throw invalidRequest(`${where}.text must be a string`);
    if (!isObject(profile)) throw invalidRequest(`${where}.profile must be an object`);
    exactKeys(profile, PROFILE_KEYS, `${where}.profile`);
    for (const key of ['typescript', 'jsx', 'declaration', 'disallowAmbiguousJsxLike']) {
      if (typeof profile[key] !== 'boolean') throw invalidRequest(`${where}.profile.${key} must be a boolean`);
    }
    if (typeof profile.sourceType !== 'string' || !SOURCE_TYPES.has(profile.sourceType)) {
      throw invalidRequest(`${where}.profile.sourceType must be module, commonjs, or unambiguous`);
    }
    if (profile.declaration === true && profile.typescript !== true) {
      throw invalidRequest(`${where}.profile.declaration requires typescript`);
    }
    return { id, path: filePath, profile: profile as unknown as Profile, text };
  });
}

// Fixed options: no proposal, decorator, Flow, or Annex B syntax, and no
// recovery. Unsupported syntax fails visibly instead of being guessed.
function parserOptions(profile: Profile): Record<string, unknown> {
  const plugins: unknown[] = [];
  if (profile.typescript) {
    plugins.push(['typescript', {
      dts: profile.declaration,
      disallowAmbiguousJSXLike: profile.disallowAmbiguousJsxLike,
    }]);
  }
  if (profile.jsx) plugins.push('jsx');
  return {
    sourceType: profile.sourceType,
    // Accepts CommonJS-style top-level return when the file name does not
    // declare a module system. Explicit module profiles stay strict, and the
    // commonjs source type implies it: Babel rejects the option there.
    ...(profile.sourceType === 'unambiguous' ? { allowReturnOutsideFunction: true } : {}),
    attachComment: false,
    errorRecovery: false,
    tokens: false,
    annexB: false,
    plugins,
  };
}

function isParserSyntaxError(error: unknown): error is Record<string, unknown> {
  return isObject(error) && typeof error.code === 'string' && error.code.startsWith('BABEL_PARSER_');
}

function extractFile(parse: ParseFunction, file: RequestFile): FileResult {
  let parsed: ParsedFile;
  try {
    parsed = parse(file.text, parserOptions(file.profile));
  } catch (error) {
    if (!isParserSyntaxError(error)) throw error;
    const offset = typeof error.pos === 'number' && Number.isSafeInteger(error.pos) ? error.pos : null;
    return {
      id: file.id,
      error: {
        reason: typeof error.reasonCode === 'string' ? error.reasonCode : String(error.code),
        // Babel appends its own (line:column); ste_check.py reports positions
        // in its canonical units instead.
        message: messageOf(error).replace(/ \(\d+:\d+\)$/, ''),
        offset,
      },
    };
  }
  if (!Array.isArray(parsed.comments)) {
    throw new Error(`${PARSER_PACKAGE} returned no comment collection`);
  }
  // File.comments is the flat collection, independent of comment attachment,
  // so each comment appears exactly once.
  const comments = parsed.comments.map((comment: unknown): CommentRange => {
    if (!isObject(comment) || typeof comment.start !== 'number' || typeof comment.end !== 'number') {
      throw new Error(`${PARSER_PACKAGE} returned a comment without numeric bounds`);
    }
    if (comment.type !== 'CommentLine' && comment.type !== 'CommentBlock') {
      throw new Error(`${PARSER_PACKAGE} returned an unknown comment type: ${String(comment.type)}`);
    }
    return { kind: comment.type === 'CommentLine' ? 'line' : 'block', start: comment.start, end: comment.end };
  });
  return { id: file.id, comments };
}

function report(error: HelperError, json: boolean): void {
  if (json) {
    process.stderr.write(`${JSON.stringify({ error: {
      code: error.code, condition: error.condition, remedy: error.remedy, ...error.details,
    } })}\n`);
  } else {
    process.stderr.write(`ERROR [${error.code}]: ${error.condition}\nRemedy: ${error.remedy}\n`);
  }
  process.exitCode = error.exitCode;
}

function main(argv: string[]): void {
  let options: Options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    report(error as HelperError, argv.includes('--json'));
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  try {
    if (options.preflight) {
      const ready = checkReadiness();
      const status = { status: 'ready', parserVersion: ready.parserVersion, dependencyRoot: ready.dependencyRoot };
      process.stdout.write(options.json ? `${JSON.stringify(status)}\n`
        : `READY: ${PARSER_PACKAGE} ${ready.parserVersion} in ${ready.dependencyRoot}\n`);
      return;
    }
    let request: unknown;
    try {
      request = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch (error) {
      throw invalidRequest(`standard input is not one JSON request: ${messageOf(error)}`);
    }
    // The request is input, so it is validated before the environment.
    const files = validateRequest(request);
    const { parse } = checkReadiness();
    // Sequential parsing: each AST is dropped once its comment ranges are captured.
    const results = files.map(file => extractFile(parse, file));
    process.stdout.write(`${JSON.stringify({ result: {
      protocolVersion: PROTOCOL_VERSION, offsetEncoding: 'utf16', files: results,
    } })}\n`);
  } catch (error) {
    if (error instanceof HelperError) report(error, options.json);
    else {
      report(new HelperError('extraction_failed', `comment extraction failed: ${messageOf(error)}`,
        'report this failure with the input format and parser version', EXIT.FAILED), options.json);
    }
  }
}

if (require.main === module) main(process.argv.slice(2));

export { checkReadiness, parserOptions, validateRequest };
