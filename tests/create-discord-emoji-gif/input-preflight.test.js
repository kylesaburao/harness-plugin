'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SKILL_DIR = path.join(
  REPO_ROOT,
  'plugins/harness/skills/create-discord-emoji-gif',
);
const RUNNERS = [
  { name: 'Bash gifsicle', command: '/bin/bash', file: 'scripts/bash/mov-to-gif.sh' },
  { name: 'Bash gifski', command: '/bin/bash', file: 'scripts/bash/mov-to-gif-gifski.sh' },
  { name: 'Node gifsicle', command: process.execPath, file: 'scripts/node/mov-to-gif.js' },
  { name: 'Node gifski', command: process.execPath, file: 'scripts/node/mov-to-gif-gifski.js' },
];
const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-emoji-preflight.'));
const clips = {
  short: path.join(suiteDir, 'short.mp4'),
  exact: path.join(suiteDir, 'exact.mp4'),
  long: path.join(suiteDir, 'long.mp4'),
};

function runScript(runner, args, env = {}) {
  return spawnSync(runner.command, [path.join(SKILL_DIR, runner.file), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 10 * 1024 * 1024,
  });
}

test.before(() => {
  for (const [name, duration] of [['short', '2.5'], ['exact', '3'], ['long', '3.5']]) {
    const result = spawnSync('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi',
      '-i', `testsrc2=size=96x64:rate=8:duration=${duration}`,
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      clips[name],
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test.after(() => {
  fs.rmSync(suiteDir, { recursive: true, force: true });
});

for (const runner of RUNNERS) {
  test(`${runner.name} environment-only preflight reports no warnings`, () => {
    const result = runScript(runner, ['--preflight', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'ready');
    assert.deepEqual(report.warnings, []);
  });

  test(`${runner.name} input preflight accepts clips at or below 3 seconds`, () => {
    for (const input of [clips.short, clips.exact]) {
      const result = runScript(runner, ['--preflight', '--json', input]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).warnings, []);
    }
  });

  test(`${runner.name} reports a missing input before missing dependencies`, () => {
    const result = runScript(runner, [
      '--preflight', '--json', path.join(suiteDir, 'missing.mp4'),
    ], {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, 'input_unusable');
  });

  test(`${runner.name} long input preflight warns in plain and JSON modes without artifacts`, () => {
    const temporaryRoot = fs.mkdtempSync(path.join(suiteDir, `${runner.name.replaceAll(' ', '-')}.preflight.`));
    try {
      let result = runScript(runner, ['--preflight', clips.long], {
        TMPDIR: temporaryRoot,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^READY:/m);
      assert.match(result.stdout, /WARNING \[input_duration_long\]/);
      assert.match(result.stdout, /trim the clip to 3 seconds or less/);
      assert.deepEqual(fs.readdirSync(temporaryRoot), []);

      result = runScript(runner, ['--preflight', '--json', clips.long], {
        TMPDIR: temporaryRoot,
      });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, 'ready');
      assert.equal(report.warnings.length, 1);
      assert.equal(report.warnings[0].code, 'input_duration_long');
      assert.match(report.warnings[0].recommendation, /3 seconds or less/);
      assert.deepEqual(fs.readdirSync(temporaryRoot), []);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test(`${runner.name} normal runs warn before work-directory creation without changing status`, () => {
    const stem = runner.name.replaceAll(' ', '-');
    const missingTmp = path.join(suiteDir, `${stem}.missing-tmp`);
    const shortOutput = path.join(suiteDir, `${stem}.short.gif`);
    const longOutput = path.join(suiteDir, `${stem}.long.gif`);
    const shortResult = runScript(runner, [clips.short, shortOutput], { TMPDIR: missingTmp });
    const longResult = runScript(runner, [clips.long, longOutput], { TMPDIR: missingTmp });
    assert.equal(longResult.status, shortResult.status);
    assert.doesNotMatch(shortResult.stderr, /input_duration_long/);
    assert.match(longResult.stderr, /WARNING \[input_duration_long\]/);
    assert.match(longResult.stderr, /trim the clip to 3 seconds or less/);
    assert.equal(fs.existsSync(missingTmp), false);
  });
}
