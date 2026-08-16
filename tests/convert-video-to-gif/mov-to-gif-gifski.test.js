'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(
  REPO_ROOT,
  'plugins/harness/skills/convert-video-to-gif/scripts/mov-to-gif-gifski.sh',
);
const BASH = '/bin/bash';
const FFMPEG = 'ffmpeg';
const FFPROBE = 'ffprobe';
const BASE_ENV = {
  ...process.env,
  MAX_BYTES: '100000',
  GIF_SIZE: '64',
  MIN_FPS: '8',
  MAX_FPS: '8',
  MIN_QUALITY: '80',
  MAX_QUALITY: '80',
  JOBS: '1',
};

const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mov-to-gif-gifski-tests.'));
const inputWithSpaces = path.join(suiteDir, 'input with spaces.mp4');
const movInput = path.join(suiteDir, 'input.mov');
const longInput = path.join(suiteDir, 'long-input.mp4');
const nonVideo = path.join(suiteDir, 'not-video.txt');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

function runScript(args, env = {}) {
  return run(BASH, [SCRIPT, ...args], {
    env: { ...BASE_ENV, ...env },
  });
}

function makeExecutable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function verifyGif(file, maxBytes, expectedSize = 64) {
  const bytes = fs.statSync(file).size;
  assert.ok(bytes < maxBytes, `${bytes} must be strictly below ${maxBytes}`);

  const probe = run(FFPROBE, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=codec_name,width,height,nb_read_frames',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1',
    file,
  ]);
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /^codec_name=gif$/m);
  assert.match(probe.stdout, new RegExp(`^width=${expectedSize}$`, 'm'));
  assert.match(probe.stdout, new RegExp(`^height=${expectedSize}$`, 'm'));
  const frames = Number(probe.stdout.match(/^nb_read_frames=(\d+)$/m)?.[1]);
  const duration = Number(probe.stdout.match(/^duration=([0-9.]+)$/m)?.[1]);
  assert.ok(frames > 1, `expected animation, got ${frames} frame(s)`);
  assert.ok(duration > 0, `expected positive duration, got ${duration}`);
  return bytes;
}

test.before(() => {
  let result = run(FFMPEG, [
    '-v', 'error',
    '-f', 'lavfi',
    '-i', 'testsrc2=size=96x64:rate=8:duration=1',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    inputWithSpaces,
  ]);
  assert.equal(result.status, 0, result.stderr);

  result = run(FFMPEG, [
    '-v', 'error',
    '-i', inputWithSpaces,
    '-an', '-c:v', 'copy',
    movInput,
  ]);
  assert.equal(result.status, 0, result.stderr);

  result = run(FFMPEG, [
    '-v', 'error',
    '-f', 'lavfi',
    '-i', 'testsrc2=size=256x192:rate=24:duration=8',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    longInput,
  ]);
  assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(nonVideo, 'not a video\n');
});

test.after(() => {
  fs.rmSync(suiteDir, { recursive: true, force: true });
});

test('help reports the sibling interface and quality controls', () => {
  const result = runScript(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: mov-to-gif-gifski\.sh/);
  assert.match(result.stdout, /MIN_QUALITY, MAX_QUALITY/);
});

test('skill instructions keep gifski as an explicit secondary mode', () => {
  const skill = fs.readFileSync(path.join(
    REPO_ROOT,
    'plugins/harness/skills/convert-video-to-gif/SKILL.md',
  ), 'utf8');
  assert.match(skill, /Use `mov-to-gif\.sh` unless the user explicitly asks/);
  assert.match(skill, /use `mov-to-gif-gifski\.sh`/);
  assert.match(skill, /Run only the selected mode's preflight/);
  assert.match(skill, /Do not silently\s+substitute one mode for the other/);
});

test('plain and JSON preflight report the selected dependencies', () => {
  let result = runScript(['--preflight']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^READY:/m);
  assert.match(result.stdout, /^gifski: /m);

  result = runScript(['--preflight', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'ready');
  assert.ok(report.commands.ffmpeg);
  assert.ok(report.commands.ffprobe);
  assert.ok(report.commands.gifski);
});

test('JSON preflight identifies a missing gifski command', () => {
  const result = run(BASH, [SCRIPT, '--preflight', '--json'], {
    env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stderr);
  assert.equal(report.error.code, 'preflight_failed');
  assert.ok(report.error.failures.some(
    (failure) => failure.condition === 'required command not found: gifski'
      && failure.remedy === 'brew install gifski',
  ));
});

test('preflight rejects an unusable gifski executable', () => {
  const mockDir = fs.mkdtempSync(path.join(suiteDir, 'mock-unusable.'));
  makeExecutable(path.join(mockDir, 'gifski'), '#!/bin/sh\nexit 1\n');
  const result = runScript(['--preflight', '--json'], {
    PATH: `${mockDir}:${process.env.PATH}`,
  });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stderr);
  assert.ok(report.error.failures.some(
    (failure) => failure.code === 'gifski_probe_failed',
  ));
});

test('preflight rejects gifski when a required option is missing', () => {
  const mockDir = fs.mkdtempSync(path.join(suiteDir, 'mock-options.'));
  makeExecutable(path.join(mockDir, 'gifski'), `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo 'gifski test'
  exit 0
fi
if [ "$1" = "--help" ]; then
  echo '--fps --width --height --quality --lossy-quality --repeat --quiet --output'
  exit 0
fi
exit 1
`);
  const result = runScript(['--preflight', '--json'], {
    PATH: `${mockDir}:${process.env.PATH}`,
  });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stderr);
  assert.ok(report.error.failures.some(
    (failure) => failure.condition === 'gifski is missing required option: --motion-quality',
  ));
});

test('usage and configuration failures exit 2 with stable codes', () => {
  const cases = [
    { args: [], env: {}, code: 'usage_error' },
    { args: ['--unknown'], env: {}, code: 'usage_error' },
    { args: [inputWithSpaces], env: { MAX_BYTES: '0' }, code: 'config_invalid' },
    { args: [inputWithSpaces], env: { GIF_SIZE: 'large' }, code: 'config_invalid' },
    { args: [inputWithSpaces], env: { MIN_FPS: '9', MAX_FPS: '8' }, code: 'config_invalid' },
    { args: [inputWithSpaces], env: { MIN_QUALITY: '0' }, code: 'config_invalid' },
    { args: [inputWithSpaces], env: { MAX_QUALITY: '101' }, code: 'config_invalid' },
    { args: [inputWithSpaces], env: { MIN_QUALITY: '90', MAX_QUALITY: '80' }, code: 'config_invalid' },
  ];
  for (const entry of cases) {
    const result = runScript(['--json', ...entry.args], entry.env);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, entry.code);
  }
});

test('input and output validation reject unusable paths before search', () => {
  let result = runScript(['--json', path.join(suiteDir, 'missing.mp4')]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'input_unusable');

  result = runScript(['--json', nonVideo]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'input_unusable');

  result = runScript(['--json', inputWithSpaces, inputWithSpaces]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'output_unusable');

  result = runScript([
    '--json', inputWithSpaces, path.join(suiteDir, 'missing-directory', 'out.gif'),
  ]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'output_unusable');

  result = runScript(['--json', inputWithSpaces, suiteDir]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'output_unusable');

  const unwritable = path.join(suiteDir, 'unwritable');
  fs.mkdirSync(unwritable);
  fs.chmodSync(unwritable, 0o555);
  try {
    result = runScript(['--json', inputWithSpaces, path.join(unwritable, 'out.gif')]);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).error.code, 'output_unusable');
  } finally {
    fs.chmodSync(unwritable, 0o755);
  }

  result = runScript(['--json', inputWithSpaces, path.join(suiteDir, 'out.gif')], {
    TMPDIR: path.join(suiteDir, 'missing-tmp'),
  });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'work_directory_unusable');
});

test('normal conversion supports spaces and a generous byte budget', () => {
  const output = path.join(suiteDir, 'generous output.gif');
  const result = runScript([inputWithSpaces, output]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^Selected: 8 FPS, quality 80, motion quality 80, lossy quality 80, VMAF /m);
  assert.match(result.stdout, /^Verified: 64x64, /m);
  verifyGif(output, 100000);
});

test('MOV input and the default output path use the established invocation', () => {
  const expectedOutput = path.join(suiteDir, 'input_64x64.gif');
  const result = runScript([movInput]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`^Output: ${expectedOutput.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  verifyGif(expectedOutput, 100000);
});

test('a tight limit is strict and a one-byte-smaller ceiling fails without replacing output', () => {
  const sourceOutput = path.join(suiteDir, 'size-source.gif');
  let result = runScript([inputWithSpaces, sourceOutput]);
  assert.equal(result.status, 0, result.stderr);
  const exactBytes = verifyGif(sourceOutput, 100000);

  const tightOutput = path.join(suiteDir, 'tight.gif');
  result = runScript([inputWithSpaces, tightOutput], { MAX_BYTES: String(exactBytes + 1) });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(verifyGif(tightOutput, exactBytes + 1), exactBytes);

  fs.writeFileSync(tightOutput, 'existing output\n');
  result = runScript(['--json', inputWithSpaces, tightOutput], {
    MAX_BYTES: String(exactBytes),
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, 'no_candidate');
  assert.equal(fs.readFileSync(tightOutput, 'utf8'), 'existing output\n');
  assert.equal(
    fs.readdirSync(suiteDir).some((name) => name.startsWith('.mov-to-gif-gifski-output.')),
    false,
  );

  result = runScript(['--json', inputWithSpaces, path.join(suiteDir, 'impossible.gif')], {
    MAX_BYTES: '1',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, 'no_candidate');
});

test('multiple FPS workers remain bounded and produce a verified GIF', () => {
  const output = path.join(suiteDir, 'jobs-two.gif');
  const result = runScript([inputWithSpaces, output], {
    MIN_FPS: '7',
    MAX_FPS: '8',
    JOBS: '8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /with 2 encoder workers/);
  verifyGif(output, 100000);
});

test('KEEP_WORK retains deterministic candidates, metadata, logs, and pipes', () => {
  const output = path.join(suiteDir, 'kept-work.gif');
  const result = runScript([inputWithSpaces, output], { KEEP_WORK: '1' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const kept = result.stderr.match(/^Kept work directory: (.+)$/m)?.[1];
  assert.ok(kept, result.stderr);
  const names = fs.readdirSync(kept);
  assert.ok(names.includes('all-results.txt'));
  assert.ok(names.includes('result-f8.txt'));
  assert.ok(names.includes('f8-q80-m80-l80.gif'));
  assert.ok(names.includes('f8-q80-m80-l80.y4m.pipe'));
  assert.ok(names.includes('winner-regenerated.gif'));
  verifyGif(output, 100000);
  fs.rmSync(kept, { recursive: true, force: true });
});

async function verifyInterruption(signal, expectedStatus) {
  const signalName = signal.toLowerCase();
  const output = path.join(suiteDir, `interrupted-${signalName}.gif`);
  fs.writeFileSync(output, 'existing output\n');
  const interruptTmp = fs.mkdtempSync(path.join(suiteDir, `interrupt-${signalName}.`));
  const child = spawn(BASH, [SCRIPT, longInput, output], {
    cwd: REPO_ROOT,
    env: {
      ...BASE_ENV,
      TMPDIR: interruptTmp,
      KEEP_WORK: '1',
      GIF_SIZE: '192',
      MIN_FPS: '20',
      MAX_FPS: '20',
      MIN_QUALITY: '20',
      MAX_QUALITY: '100',
      MAX_BYTES: '1000000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  let workDir;
  let activePids = [];
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && activePids.length < 2) {
    const dirs = fs.readdirSync(interruptTmp)
      .filter((name) => name.startsWith('mov-to-gif-gifski.'));
    if (dirs.length > 0) {
      workDir = path.join(interruptTmp, dirs[0]);
      const pidFiles = fs.readdirSync(workDir)
        .filter((name) => name.startsWith('active-child-search-'));
      if (pidFiles.length > 0) {
        activePids = fs.readFileSync(path.join(workDir, pidFiles[0]), 'utf8')
          .trim().split('\n').filter(Boolean).map(Number);
      }
    }
    if (activePids.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.equal(activePids.length, 2, `did not observe both active children\n${stderr}`);

  child.kill(signal);
  const status = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  assert.equal(status, expectedStatus, stderr);
  assert.equal(fs.readFileSync(output, 'utf8'), 'existing output\n');
  assert.ok(workDir && fs.existsSync(workDir));

  for (const pid of activePids) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  assert.equal(
    fs.readdirSync(suiteDir).some((name) => name.startsWith('.mov-to-gif-gifski-output.')),
    false,
  );
  fs.rmSync(interruptTmp, { recursive: true, force: true });
}

test('SIGINT reaps active FFmpeg and gifski children and preserves the destination', async () => {
  await verifyInterruption('SIGINT', 130);
});

test('SIGTERM reaps active FFmpeg and gifski children and preserves the destination', async () => {
  await verifyInterruption('SIGTERM', 143);
});
