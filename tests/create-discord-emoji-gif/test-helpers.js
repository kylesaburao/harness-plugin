'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const skillDir = path.join(repoRoot, 'plugins/harness/skills/create-discord-emoji-gif');

function temporaryDirectory(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function makeExecutable(file, contents) { fs.writeFileSync(file, contents, { mode: 0o755 }); }
function runEntrypoint(command, file, args = [], env = {}) {
  return spawnSync(command, [file, ...args], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024 });
}

module.exports = { repoRoot, skillDir, temporaryDirectory, makeExecutable, runEntrypoint };
