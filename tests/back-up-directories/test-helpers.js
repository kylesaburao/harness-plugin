'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const SCRIPT = path.resolve(__dirname, '../../plugins/harness/skills/back-up-directories/scripts/backup.js');

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

async function runCli(t, args, { input = '', environment = {}, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const child = spawn(process.execPath, [SCRIPT, ...args], {
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
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timeout);
  return { exitCode, stdout, stderr };
}

module.exports = {
  temporaryRoot,
  directoryDetails,
  successfulArchiveFactory,
  runCli,
};
