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
const SCRIPTS = ['mov-to-gif.sh', 'mov-to-gif-gifski.sh'];
const BASH = '/bin/bash';
const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-emoji-preflight.'));
const clips = {
  short: path.join(suiteDir, 'short.mp4'),
  exact: path.join(suiteDir, 'exact.mp4'),
  long: path.join(suiteDir, 'long.mp4'),
};

function runScript(scriptName, args, env = {}) {
  return spawnSync(BASH, [path.join(SKILL_DIR, 'scripts', scriptName), ...args], {
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

for (const scriptName of SCRIPTS) {
  test(`${scriptName} environment-only preflight reports no warnings`, () => {
    const result = runScript(scriptName, ['--preflight', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'ready');
    assert.deepEqual(report.warnings, []);
  });

  test(`${scriptName} input preflight accepts clips at or below 3 seconds`, () => {
    for (const input of [clips.short, clips.exact]) {
      const result = runScript(scriptName, ['--preflight', '--json', input]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).warnings, []);
    }
  });

  test(`${scriptName} reports a missing input before missing dependencies`, () => {
    const result = runScript(scriptName, [
      '--preflight', '--json', path.join(suiteDir, 'missing.mp4'),
    ], {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      OSTYPE: 'darwin',
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, 'input_unusable');
  });

  test(`${scriptName} long input preflight warns in plain and JSON modes without artifacts`, () => {
    const temporaryRoot = fs.mkdtempSync(path.join(suiteDir, `${scriptName}.preflight.`));
    try {
      let result = runScript(scriptName, ['--preflight', clips.long], {
        TMPDIR: temporaryRoot,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^READY:/m);
      assert.match(result.stdout, /WARNING \[input_duration_long\]/);
      assert.match(result.stdout, /trim the clip to 3 seconds or less/);
      assert.deepEqual(fs.readdirSync(temporaryRoot), []);

      result = runScript(scriptName, ['--preflight', '--json', clips.long], {
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

  test(`${scriptName} normal runs warn before work-directory creation without changing status`, () => {
    const missingTmp = path.join(suiteDir, `${scriptName}.missing-tmp`);
    const shortOutput = path.join(suiteDir, `${scriptName}.short.gif`);
    const longOutput = path.join(suiteDir, `${scriptName}.long.gif`);
    const shortResult = runScript(scriptName, [clips.short, shortOutput], { TMPDIR: missingTmp });
    const longResult = runScript(scriptName, [clips.long, longOutput], { TMPDIR: missingTmp });
    assert.equal(longResult.status, shortResult.status);
    assert.doesNotMatch(shortResult.stderr, /input_duration_long/);
    assert.match(longResult.stderr, /WARNING \[input_duration_long\]/);
    assert.match(longResult.stderr, /trim the clip to 3 seconds or less/);
    assert.equal(fs.existsSync(missingTmp), false);
  });
}
