'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const SCRIPT = require('../helpers/plugin-paths').artifactPath('skills/back-up-directories/scripts/backup.js');

async function temporaryRoot(t, prefix = 'backup-test-') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function directoryDetails(directory, label) {
  const canonicalPath = await fsp.realpath(directory);
  const details = await fsp.stat(canonicalPath, { bigint: true });
  return { label, configuredPath: directory, canonicalPath, identity: `${details.dev}:${details.ino}` };
}

function successfulArchiveFactory(contents = 'zip-data') {
  return () => {
    const archive = new EventEmitter();
    archive.pipe = (output) => { archive.output = output; };
    archive.directory = () => {};
    archive.finalize = async () => { archive.output.end(contents); };
    archive.abort = () => archive.output?.destroy();
    return archive;
  };
}

// Write errors a child can cause by exiting (or closing stdin) before the
// parent finishes writing its input. The exit code still reports the outcome.
const IGNORED_STDIN_ERROR_CODES = new Set(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED']);

async function runNode(t, nodeArgs, { input = '', environment = {}, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const child = spawn(process.execPath, nodeArgs, {
    env: { ...process.env, ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: controller.signal,
  });
  t.after(() => {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let stdout = '';
  let stderr = '';
  let stdinError = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', (error) => {
    if (!IGNORED_STDIN_ERROR_CODES.has(error.code)) stdinError ??= error;
  });
  child.stdin.end(input);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timeout);
  if (stdinError) throw stdinError;
  return { exitCode, stdout, stderr };
}

function runCli(t, args, options) {
  return runNode(t, [SCRIPT, ...args], options);
}

module.exports = {
  temporaryRoot,
  directoryDetails,
  successfulArchiveFactory,
  runCli,
  runNode,
};
