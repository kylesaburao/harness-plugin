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
  'plugins/harness/skills/create-discord-emoji-gif/scripts/bash/mov-to-gif-gifski.sh',
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

function commandPath(command) {
  const result = run('/bin/sh', ['-c', `command -v ${command}`]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
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
  assert.match(result.stdout, /MIN_QUALITY[\s\S]*MAX_QUALITY/);
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const requiredCommands = source.match(/required_commands=\(([^)]*)\)/)?.[1];
  const removedCommand = ['mk', 'fifo'].join('');
  assert.ok(requiredCommands);
  assert.equal(requiredCommands.split(/\s+/).includes(removedCommand), false);
  assert.match(source, /^readonly DEFAULT_MIN_QUALITY=1$/m);
});

test('skill instructions define the Discord target and fallback rules', () => {
  const skill = fs.readFileSync(path.join(
    REPO_ROOT,
    'plugins/harness/skills/create-discord-emoji-gif/SKILL.md',
  ), 'utf8');
  assert.match(skill, /^name: create-discord-emoji-gif$/m);
  assert.match(skill, /Discord emoji/);
  assert.match(skill, /128x128/);
  assert.match(skill, /fewer than 256000 bytes/);
  assert.match(skill, /3 seconds or less/);
  assert.match(skill, /Use gifski by default/);
  assert.match(skill, /Node\.js 22\.0\.0 or newer/);
  assert.match(skill, /fall through to Node\.js gifsicle only for/);
  assert.match(skill, /fall through only from Node\.js gifski\n   `no_candidate`/);
  assert.match(skill, /An explicit gifsicle request selects Node\.js gifsicle/);
  assert.match(skill, /A normal backend comparison runs both Node\.js implementations/);
  assert.match(skill, /`min\(FPS count, max\(1, floor\(JOBS \/ 2\)\)\)`/);
  assert.match(skill, /`RAYON_NUM_THREADS = clamp\(floor\(JOBS \/ encoder workers\), 2, 8\)`/);

  const agentMetadata = fs.readFileSync(path.join(
    REPO_ROOT,
    'plugins/harness/skills/create-discord-emoji-gif/agents/openai.yaml',
  ), 'utf8');
  assert.match(agentMetadata, /display_name: "Discord Emoji GIF"/);
  assert.match(agentMetadata, /\$create-discord-emoji-gif/);
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
  const expectedRemedy = process.platform === 'darwin'
    ? 'brew install gifski'
    : 'cargo install gifski, or install the prebuilt binary from https://gif.ski';
  const result = run(BASH, [SCRIPT, '--preflight', '--json'], {
    env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stderr);
  assert.equal(report.error.code, 'preflight_failed');
  assert.ok(report.error.failures.some(
    (failure) => failure.condition === 'required command not found: gifski'
      && failure.remedy === expectedRemedy,
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

test('MAX_FPS above 100 fails before preflight or candidate encoding', () => {
  const mockDir = fs.mkdtempSync(path.join(suiteDir, 'mock-fps-limit.'));
  const temporaryRoot = fs.mkdtempSync(path.join(suiteDir, 'fps-limit-tmp.'));
  const marker = path.join(mockDir, 'gifski-called');
  makeExecutable(path.join(mockDir, 'gifski'), `#!/bin/sh
touch "${marker}"
exit 1
`);
  const result = runScript(['--json', inputWithSpaces], {
    MAX_FPS: '101',
    PATH: `${mockDir}:${process.env.PATH}`,
    TMPDIR: temporaryRoot,
  });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stderr);
  assert.equal(report.error.code, 'config_invalid');
  assert.match(report.error.condition, /must not exceed 100/);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readdirSync(temporaryRoot), []);
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

test('worker and Rayon settings cover pinned, narrow, and default FPS ranges', () => {
  const cases = [
    { name: 'pinned', min: '8', max: '8', jobs: '16', workers: 1, threads: 8 },
    { name: 'narrow', min: '7', max: '9', jobs: '8', workers: 3, threads: 2 },
    { name: 'default', min: '15', max: '24', jobs: '16', workers: 8, threads: 2 },
  ];
  for (const entry of cases) {
    const output = path.join(suiteDir, `workers-${entry.name}.gif`);
    const result = runScript([inputWithSpaces, output], {
      MIN_FPS: entry.min,
      MAX_FPS: entry.max,
      JOBS: entry.jobs,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(
      result.stderr,
      new RegExp(`with ${entry.workers} encoder workers and ${entry.threads} gifski threads each`),
    );
    verifyGif(output, 100000);
  }
});

test('KEEP_WORK retains deterministic candidates, metadata, logs, and caches', () => {
  const output = path.join(suiteDir, 'kept-work.gif');
  const result = runScript([inputWithSpaces, output], { KEEP_WORK: '1' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const kept = result.stderr.match(/^Kept work directory: (.+)$/m)?.[1];
  assert.ok(kept, result.stderr);
  try {
    const names = fs.readdirSync(kept);
    const pipeSuffix = ['.', 'pipe'].join('');
    const fifoMarker = ['.', 'mk', 'fifo'].join('');
    assert.ok(names.includes('all-results.txt'));
    assert.ok(names.includes('result-f8.txt'));
    assert.ok(names.includes('f8-q80-m80-l80.gif'));
    assert.ok(names.includes('source-f8.y4m'));
    assert.ok(names.includes('winner-regenerated.gif'));
    const y4mHeader = fs.readFileSync(path.join(kept, 'source-f8.y4m'))
      .subarray(0, 200).toString('ascii').split('\n')[0];
    assert.match(y4mHeader, / C444(?: |$)/);
    assert.equal(names.some((name) => name.endsWith(pipeSuffix)), false);
    assert.equal(names.some((name) => name.includes(fifoMarker)), false);
    verifyGif(output, 100000);
  } finally {
    fs.rmSync(kept, { recursive: true, force: true });
  }
});

test('the default quality ladder behaviorally reaches quality 1', () => {
  const output = path.join(suiteDir, 'default-quality-floor.gif');
  const env = { ...BASE_ENV, MAX_BYTES: '1', KEEP_WORK: '1' };
  delete env.MIN_QUALITY;
  delete env.MAX_QUALITY;
  const result = run(BASH, [SCRIPT, '--json', inputWithSpaces, output], { env });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stderr.match(/\{"error".*\}/)?.[0] || '{}').error.code, 'no_candidate');
  const kept = result.stderr.match(/^Kept work directory: (.+)$/m)?.[1];
  assert.ok(kept, result.stderr);
  try {
    const seen = fs.readFileSync(path.join(kept, 'seen-f8.txt'), 'utf8').split('\n');
    assert.ok(seen.includes('1|1|1'), 'default coarse ladder did not reach quality 1');
  } finally {
    fs.rmSync(kept, { recursive: true, force: true });
  }
});

test('normal conversion removes its work directory and source cache', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(suiteDir, 'normal-cleanup.'));
  const output = path.join(suiteDir, 'normal-cleanup.gif');
  try {
    const result = runScript([inputWithSpaces, output], { TMPDIR: temporaryRoot });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(fs.readdirSync(temporaryRoot), []);
    verifyGif(output, 100000);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('concurrent source caches stay within the worker bound and disappear as workers finish', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(suiteDir, 'bounded-caches.'));
  const output = path.join(suiteDir, 'bounded-caches.gif');
  const child = spawn(BASH, [SCRIPT, longInput, output], {
    cwd: REPO_ROOT,
    env: {
      ...BASE_ENV,
      TMPDIR: temporaryRoot,
      MIN_FPS: '6',
      MAX_FPS: '10',
      JOBS: '4',
      MAX_BYTES: '1000000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let exited = false;
  const exitPromise = new Promise((resolve) => child.on('exit', (code) => {
    exited = true;
    resolve(code);
  }));
  const seen = new Set();
  let maximumConcurrent = 0;

  try {
    while (!exited) {
      const workName = fs.readdirSync(temporaryRoot)
        .find((name) => name.startsWith('mov-to-gif-gifski.'));
      if (workName) {
        const workDir = path.join(temporaryRoot, workName);
        const caches = fs.readdirSync(workDir)
          .filter((name) => /^source-f\d+[.]y4m$/.test(name));
        maximumConcurrent = Math.max(maximumConcurrent, caches.length);
        for (const cache of caches) seen.add(cache);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const status = await exitPromise;
    assert.equal(status, 0, `${stdout}\n${stderr}`);
    assert.ok(seen.size > 2, `expected sequential cache turnover, saw ${[...seen]}`);
    assert.ok(maximumConcurrent <= 2, `saw ${maximumConcurrent} caches with a 2-worker bound`);
    assert.deepEqual(fs.readdirSync(temporaryRoot), []);
    verifyGif(output, 1000000);
  } finally {
    if (!exited) {
      child.kill('SIGKILL');
      await exitPromise;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('real quality range records candidates and selects with the production order', () => {
  const output = path.join(suiteDir, 'real-range.gif');
  const result = runScript([inputWithSpaces, output], {
    MIN_FPS: '8',
    MAX_FPS: '8',
    MIN_QUALITY: '60',
    MAX_QUALITY: '100',
    MAX_BYTES: '1000000',
    KEEP_WORK: '1',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const kept = result.stderr.match(/^Kept work directory: (.+)$/m)?.[1];
  assert.ok(kept, result.stderr);
  try {
    const rows = fs.readFileSync(path.join(kept, 'result-f8.txt'), 'utf8')
      .split('\n').filter(Boolean).map((line) => line.split('|'));
    assert.ok(rows.length > 1, `expected multiple result rows, got ${rows.length}`);
    assert.ok(rows.every((row) => row.length === 7));
    const expected = rows.reduce((best, row) => {
      if (!best) return row;
      const rowValues = row.slice(0, 6).map(Number);
      const bestValues = best.slice(0, 6).map(Number);
      const higherFields = [0, 2, 3, 4, 5];
      for (const index of higherFields) {
        if (rowValues[index] !== bestValues[index]) {
          return rowValues[index] > bestValues[index] ? row : best;
        }
      }
      return rowValues[1] < bestValues[1] ? row : best;
    }, null);
    const selected = result.stdout.match(
      /^Selected: (\d+) FPS, quality (\d+), motion quality (\d+), lossy quality (\d+), VMAF (-?[0-9.]+)$/m,
    );
    assert.ok(selected, result.stdout);
    assert.deepEqual(selected.slice(1), [expected[2], expected[3], expected[4], expected[5], expected[0]]);
  } finally {
    fs.rmSync(kept, { recursive: true, force: true });
  }
});

test('source preparation failure uses its own error code and preserves the destination', () => {
  const mockDir = fs.mkdtempSync(path.join(suiteDir, 'mock-source-failure.'));
  const realFfmpeg = commandPath('ffmpeg');
  makeExecutable(path.join(mockDir, 'ffmpeg'), `#!/bin/sh
for argument do
  case "$argument" in
    *source-f*.y4m)
      echo 'forced source preparation failure' >&2
      exit 1
      ;;
  esac
done
exec "${realFfmpeg}" "$@"
`);
  const output = path.join(suiteDir, 'source-failure.gif');
  fs.writeFileSync(output, 'existing output\n');
  const result = runScript(['--json', inputWithSpaces, output], {
    PATH: `${mockDir}:${process.env.PATH}`,
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stderr);
  assert.equal(report.error.code, 'source_prepare_failed');
  assert.match(report.error.condition, /8 FPS/);
  assert.match(report.error.condition, /forced source preparation failure/);
  assert.ok(report.error.remedy);
  assert.equal(fs.readFileSync(output, 'utf8'), 'existing output\n');
});

test('candidate and VMAF worker failures include stderr and a safe remedy in one JSON object', () => {
  for (const entry of [
    {
      command: 'gifski',
      code: 'candidate_encode_failed',
      diagnostic: 'forced candidate | failure',
      executable: commandPath('gifski'),
      match: '*',
    },
    {
      command: 'ffmpeg',
      code: 'vmaf_failed',
      diagnostic: 'forced VMAF | failure',
      executable: commandPath('ffmpeg'),
      match: '*libvmaf*',
    },
  ]) {
    const mockDir = fs.mkdtempSync(path.join(suiteDir, `mock-${entry.code}.`));
    const script = entry.command === 'gifski' ? `#!/bin/sh
case "$1" in
  --version|--help) exec "${entry.executable}" "$@" ;;
esac
printf '%s\n%s\n' '${entry.diagnostic}' 'second diagnostic line' >&2
exit 1
` : `#!/bin/sh
for argument do
  case "$argument" in
    ${entry.match})
      printf '%s\n%s\n' '${entry.diagnostic}' 'second diagnostic line' >&2
      exit 1
      ;;
  esac
done
exec "${entry.executable}" "$@"
`;
    makeExecutable(path.join(mockDir, entry.command), script);
    const output = path.join(suiteDir, `${entry.code}.gif`);
    fs.writeFileSync(output, 'existing output\n');
    const result = runScript(['--json', inputWithSpaces, output], {
      PATH: `${mockDir}:${process.env.PATH}`,
    });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stderr);
    assert.equal(report.error.code, entry.code);
    assert.match(report.error.condition, new RegExp(entry.diagnostic.replace('|', '\\|')));
    assert.match(report.error.condition, /second diagnostic line/);
    assert.ok(report.error.remedy);
    assert.equal(fs.readFileSync(output, 'utf8'), 'existing output\n');
  }
});

test('successful regeneration without an output file reports regeneration_failed cleanly', () => {
  const mockDir = fs.mkdtempSync(path.join(suiteDir, 'mock-regeneration-missing.'));
  const realGifski = commandPath('gifski');
  makeExecutable(path.join(mockDir, 'gifski'), `#!/bin/sh
case "$1" in
  --version|--help) exec "${realGifski}" "$@" ;;
esac
output=''
previous=''
for argument do
  if [ "$previous" = '--output' ]; then output=$argument; fi
  previous=$argument
done
case "$output" in
  *winner-regenerated.gif) exit 0 ;;
esac
exec "${realGifski}" "$@"
`);
  const output = path.join(suiteDir, 'regeneration-missing.gif');
  fs.writeFileSync(output, 'existing output\n');
  const result = runScript(['--json', inputWithSpaces, output], {
    PATH: `${mockDir}:${process.env.PATH}`,
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stderr);
  assert.equal(report.error.code, 'regeneration_failed');
  assert.match(report.error.condition, /did not create the regenerated winner/);
  assert.ok(report.error.remedy);
  assert.doesNotMatch(result.stderr, /wc:/);
  assert.equal(fs.readFileSync(output, 'utf8'), 'existing output\n');
  assert.equal(
    fs.readdirSync(suiteDir).some((name) => name.startsWith('.mov-to-gif-gifski-output.')),
    false,
  );
});

test('publication errors include captured stderr and preserve the destination', () => {
  for (const { command, diagnostic } of [
    { command: 'cp', diagnostic: 'forced cp publication failure' },
    { command: 'mv', diagnostic: 'forced mv publication failure' },
  ]) {
    const mockDir = fs.mkdtempSync(path.join(suiteDir, `mock-${command}-failure.`));
    makeExecutable(path.join(mockDir, command), `#!/bin/sh\necho '${diagnostic}' >&2\nexit 1\n`);
    const outputDir = fs.mkdtempSync(path.join(suiteDir, `${command}-publication.`));
    const output = path.join(outputDir, 'output.gif');
    fs.writeFileSync(output, 'existing output\n');
    const result = runScript(['--json', inputWithSpaces, output], {
      PATH: `${mockDir}:${process.env.PATH}`,
    });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stderr);
    assert.equal(report.error.code, 'publication_failed');
    assert.match(report.error.condition, new RegExp(diagnostic));
    assert.ok(report.error.remedy);
    assert.equal(fs.readFileSync(output, 'utf8'), 'existing output\n');
    assert.equal(
      fs.readdirSync(outputDir).some((name) => name.startsWith('.mov-to-gif-gifski-output.')),
      false,
    );
  }
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
  let childExited = false;
  const exitPromise = new Promise((resolve) => child.on('exit', (code) => {
    childExited = true;
    resolve(code);
  }));

  try {
    let workDir;
    let activePids = [];
    const deadline = Date.now() + 20000;
    let sourcePreparationStarted = false;
    while (Date.now() < deadline && !(activePids.length === 1 && sourcePreparationStarted)) {
      activePids = [];
      const dirs = fs.readdirSync(interruptTmp)
        .filter((name) => name.startsWith('mov-to-gif-gifski.'));
      if (dirs.length > 0) {
        workDir = path.join(interruptTmp, dirs[0]);
        const pidFiles = fs.readdirSync(workDir)
          .filter((name) => name.startsWith('active-child-'));
        if (pidFiles.length > 0) {
          activePids = fs.readFileSync(path.join(workDir, pidFiles[0]), 'utf8')
            .trim().split('\n').filter(Boolean).map(Number);
        }
        sourcePreparationStarted = fs.existsSync(path.join(workDir, 'source-f20.y4m'));
      }
      if (!(activePids.length === 1 && sourcePreparationStarted)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.equal(activePids.length, 1, `did not observe one active child\n${stderr}`);
    assert.equal(sourcePreparationStarted, true, `source preparation did not start\n${stderr}`);
    for (const pid of activePids) {
      assert.doesNotThrow(() => process.kill(pid, 0));
    }

    child.kill(signal);
    const status = await exitPromise;
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
  } finally {
    if (!childExited) {
      child.kill('SIGKILL');
      await exitPromise;
    }
    fs.rmSync(interruptTmp, { recursive: true, force: true });
  }
}

test('SIGINT reaps the active child and preserves the destination', async () => {
  await verifyInterruption('SIGINT', 130);
});

test('SIGTERM reaps the active child and preserves the destination', async () => {
  await verifyInterruption('SIGTERM', 143);
});

test('SIGHUP reaps the active child and preserves the destination', async () => {
  await verifyInterruption('SIGHUP', 129);
});
