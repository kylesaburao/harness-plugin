'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  repoRoot,
  skillDir,
  temporaryDirectory,
  makeExecutable,
  runEntrypoint,
} = require('./test-helpers');

const REPO_ROOT = repoRoot;
const SCRIPT = path.join(skillDir, 'scripts/node/mov-to-gif-gifski.js');
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

const suiteDir = temporaryDirectory('mov-to-gif-gifski-tests.');
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
  return runEntrypoint(process.execPath, SCRIPT, args, { ...BASE_ENV, ...env });
}

function commandPath(command) {
  for (const directory of process.env.PATH.split(path.delimiter)) {
    const candidate = path.join(directory, command);
    try {
      if (fs.statSync(candidate).isFile() && (fs.statSync(candidate).mode & 0o111)) return candidate;
    } catch {}
  }
  assert.fail(`required command not found: ${command}`);
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
  assert.match(result.stdout, /Usage: mov-to-gif-gifski\.js/);
  assert.match(result.stdout, /MIN_QUALITY[\s\S]*MAX_QUALITY/);
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
  assert.match(skill, /must be installed and stop there/);
  assert.match(skill, /fall through to\s+gifsicle only for/);
  assert.match(skill, /fall through only from gifski `no_candidate`/);
  assert.match(skill, /For an explicit backend comparison, dispatch both entrypoints/);
  assert.match(skill, /`min\(FPS count, max\(1, floor\(JOBS \/ 2\)\)\)`/);
  assert.match(skill, /`RAYON_NUM_THREADS = clamp\(floor\(JOBS \/ encoder workers\), 2, 8\)`/);
  assert.match(skill, /not run any further command against the input or the output/);
  assert.match(skill, /confirmed the digest after the atomic rename/);

  const agentMetadata = fs.readFileSync(path.join(
    REPO_ROOT,
    'plugins/harness/skills/create-discord-emoji-gif/agents/openai.yaml',
  ), 'utf8');
  assert.match(agentMetadata, /display_name: "Discord Emoji GIF"/);
  assert.match(agentMetadata, /\$create-discord-emoji-gif/);
});

test('usage and configuration failures exit 2 with stable codes', () => {
  const cases = [
    { args: [], env: {}, code: 'usage_error' },
    { args: ['--unknown'], env: {}, code: 'usage_error' },
    { args: [inputWithSpaces], env: { MAX_BYTES: '0' }, code: 'config_invalid' },
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
  const jsonLine = result.stderr.split('\n').find(line => line.startsWith('{'));
  assert.equal(JSON.parse(jsonLine).error.code, 'no_candidate');
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

test('KEEP_WORK retains deterministic candidates and caches', () => {
  const output = path.join(suiteDir, 'kept-work.gif');
  const result = runScript([inputWithSpaces, output], { KEEP_WORK: '1' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const kept = result.stderr.match(/^Kept work directory: (.+)$/m)?.[1];
  assert.ok(kept, result.stderr);
  try {
    const names = fs.readdirSync(kept);
    assert.ok(names.includes('f8-q80-m80-l80.gif'));
    assert.ok(names.includes('source-f8.y4m'));
    assert.ok(names.includes('vmaf-reference.mkv'));
    assert.ok(names.includes('winner-regenerated.gif'));
    const y4mHeader = fs.readFileSync(path.join(kept, 'source-f8.y4m'))
      .subarray(0, 200).toString('ascii').split('\n')[0];
    assert.match(y4mHeader, / C444(?: |$)/);
    verifyGif(output, 100000);
  } finally {
    fs.rmSync(kept, { recursive: true, force: true });
  }
});

test('the default quality ladder behaviorally reaches quality 1', () => {
  const output = path.join(suiteDir, 'default-quality-floor.gif');
  const qualityLog = path.join(suiteDir, 'quality-floor.log');
  const mockDir = fs.mkdtempSync(path.join(suiteDir, 'mock-quality-floor.'));
  const realGifski = commandPath('gifski');
  makeExecutable(path.join(mockDir, 'gifski'), `#!/bin/sh
case "$1" in
  --version|--help) exec "${realGifski}" "$@" ;;
esac
printf '%s\\n' "$*" >> "$QUALITY_LOG"
exec "${realGifski}" "$@"
`);
  const env = {
    MAX_BYTES: '1',
    KEEP_WORK: '1',
    MIN_QUALITY: undefined,
    MAX_QUALITY: undefined,
    QUALITY_LOG: qualityLog,
    PATH: `${mockDir}:${process.env.PATH}`,
  };
  const result = runScript(['--json', inputWithSpaces, output], env);
  assert.equal(result.status, 1, result.stderr);
  const jsonLine = result.stderr.split('\n').find(line => line.startsWith('{'));
  assert.equal(JSON.parse(jsonLine).error.code, 'no_candidate');
  const kept = result.stderr.match(/^Kept work directory: (.+)$/m)?.[1];
  assert.ok(kept, result.stderr);
  try {
    const calls = fs.readFileSync(qualityLog, 'utf8');
    assert.match(calls, /--quality 1(?: |$)/, 'default coarse ladder did not reach quality 1');
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
  const child = spawn(process.execPath, [SCRIPT, longInput, output], {
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

test('real quality range retains candidates and selects a production winner', () => {
  const output = path.join(suiteDir, 'real-range.gif');
  const mockDir = fs.mkdtempSync(path.join(suiteDir, 'mock-winner-scoring.'));
  const realFfmpeg = commandPath('ffmpeg');
  makeExecutable(path.join(mockDir, 'ffmpeg'), `#!/bin/sh
case "$*" in
  *libvmaf*)
    candidate=''
    previous=''
    for argument do
      if [ "$previous" = '-i' ]; then candidate=$argument; fi
      previous=$argument
    done
    case "$candidate" in
      *f8-q80-m80-l80.gif) score=99 ;;
      *f8-q90-m90-l90.gif) score=95 ;;
      *f8-q100-m100-l100.gif) score=90 ;;
      *) score=80 ;;
    esac
    printf 'VMAF score: %s\\n' "$score" >&2
    exit 0
    ;;
esac
exec "${realFfmpeg}" "$@"
`);
  const result = runScript(['--json', inputWithSpaces, output], {
    MIN_FPS: '8',
    MAX_FPS: '8',
    MIN_QUALITY: '60',
    MAX_QUALITY: '100',
    MAX_BYTES: '1000000',
    KEEP_WORK: '1',
    PATH: `${mockDir}:${process.env.PATH}`,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const kept = result.stderr.match(/^Kept work directory: (.+)$/m)?.[1];
  assert.ok(kept, result.stderr);
  try {
    const payload = JSON.parse(result.stdout).result;
    const names = fs.readdirSync(kept).filter(name => /^f8-q\d+-m\d+-l\d+[.]gif$/.test(name));
    assert.ok(names.length > 1, `expected multiple candidate files, got ${names.length}`);
    assert.deepEqual(payload.parameters, { quality: 80, motionQuality: 80, lossyQuality: 80 });
    assert.equal(payload.vmaf, '99');
    assert.ok(names.includes('f8-q80-m80-l80.gif'));
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

test('winner source failure reports regeneration_failed and preserves the destination', () => {
  const mockDir = fs.mkdtempSync(path.join(suiteDir, 'mock-winner-source-failure.'));
  const outputDir = fs.mkdtempSync(path.join(suiteDir, 'winner-source-output.'));
  const output = path.join(outputDir, 'output.gif');
  const counter = path.join(mockDir, 'counter');
  const realFfmpeg = commandPath('ffmpeg');
  makeExecutable(path.join(mockDir, 'ffmpeg'), `#!/bin/sh
for argument do
  case "$argument" in
    *source-f8.y4m)
      count=0
      if [ -f "$TEST_COUNTER" ]; then read count < "$TEST_COUNTER"; fi
      count=$((count + 1))
      printf '%s\\n' "$count" > "$TEST_COUNTER"
      if [ "$count" -eq 2 ]; then
        printf 'forced winner source failure\\n' >&2
        exit 1
      fi
      ;;
  esac
done
exec "${realFfmpeg}" "$@"
`);
  fs.writeFileSync(output, 'existing destination\n');
  const result = runScript(['--json', inputWithSpaces, output], {
    PATH: `${mockDir}:${process.env.PATH}`, TEST_COUNTER: counter,
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stderr).error;
  assert.equal(report.code, 'regeneration_failed');
  assert.equal(report.condition, 'winner source preparation failed: forced winner source failure');
  assert.equal(report.remedy, 'fix the reported ffmpeg decode or filter error, then run the same conversion again');
  assert.equal(fs.readFileSync(output, 'utf8'), 'existing destination\n');
  assert.equal(fs.readdirSync(outputDir).some(name => name.startsWith('.mov-to-gif-gifski-output.')), false);
});

test('winner encode failure reports regeneration_failed and preserves the destination', () => {
  const mockDir = fs.mkdtempSync(path.join(suiteDir, 'mock-winner-encode-failure.'));
  const outputDir = fs.mkdtempSync(path.join(suiteDir, 'winner-encode-output.'));
  const output = path.join(outputDir, 'output.gif');
  const realGifski = commandPath('gifski');
  makeExecutable(path.join(mockDir, 'gifski'), `#!/bin/sh
case "$1" in --version|--help) exec "${realGifski}" "$@" ;; esac
previous=''
output=''
for argument do
  if [ "$previous" = '--output' ]; then output=$argument; fi
  previous=$argument
done
case "$output" in
  *winner-regenerated.gif)
    printf 'forced winner encode failure\\n' >&2
    exit 1
    ;;
esac
exec "${realGifski}" "$@"
`);
  fs.writeFileSync(output, 'existing destination\n');
  const result = runScript(['--json', inputWithSpaces, output], { PATH: `${mockDir}:${process.env.PATH}` });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stderr).error;
  assert.equal(report.code, 'regeneration_failed');
  assert.equal(report.condition, 'winner regeneration failed: forced winner encode failure');
  assert.equal(report.remedy, 'fix the reported gifski error, then run the same conversion again');
  assert.equal(fs.readFileSync(output, 'utf8'), 'existing destination\n');
  assert.equal(fs.readdirSync(outputDir).some(name => name.startsWith('.mov-to-gif-gifski-output.')), false);
});

test('atomic publication failure preserves the destination', () => {
  const outputDir = fs.mkdtempSync(path.join(suiteDir, 'publication-failure.'));
  const output = path.join(outputDir, 'output.gif');
  fs.writeFileSync(output, 'existing output\n');
  const preload = path.join(outputDir, 'force-publication-failure.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs');
if (process.argv[1] && process.argv[1].endsWith('mov-to-gif-gifski.js')) {
  const originalRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === ${JSON.stringify(output)}) {
      const error = new Error('forced atomic publication failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(source, destination);
  };
}
`);
  try {
    const result = runScript(['--json', inputWithSpaces, output], {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim(),
    });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stderr);
    assert.equal(report.error.code, 'publication_failed');
    assert.match(report.error.condition, /forced atomic publication failure/);
    assert.ok(report.error.remedy);
    assert.equal(fs.readFileSync(output, 'utf8'), 'existing output\n');
    assert.equal(
      fs.readdirSync(outputDir).some((name) => name.startsWith('.mov-to-gif-gifski-output.')),
      false,
    );
  } finally {
    fs.rmSync(preload, { force: true });
  }
});

async function verifyInterruption(signal, expectedStatus) {
  const signalName = signal.toLowerCase();
  const output = path.join(suiteDir, `interrupted-${signalName}.gif`);
  fs.writeFileSync(output, 'existing output\n');
  const interruptTmp = fs.mkdtempSync(path.join(suiteDir, `interrupt-${signalName}.`));
  const mockDir = fs.mkdtempSync(path.join(suiteDir, `mock-interrupt-${signalName}.`));
  const mediaPidFile = path.join(mockDir, 'media.pid');
  const realFfmpeg = commandPath('ffmpeg');
  makeExecutable(path.join(mockDir, 'ffmpeg'), `#!/bin/sh
for argument do
  case "$argument" in
    *source-f*.y4m)
      printf '%s\\n' "$$" > "$MEDIA_PID_FILE"
      sleep 30
      ;;
  esac
done
exec "${realFfmpeg}" "$@"
`);
  const child = spawn(process.execPath, [SCRIPT, longInput, output], {
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
      PATH: `${mockDir}:${process.env.PATH}`,
      MEDIA_PID_FILE: mediaPidFile,
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
        if (fs.existsSync(mediaPidFile)) {
          const mediaPid = Number(fs.readFileSync(mediaPidFile, 'utf8').trim());
          try { process.kill(mediaPid, 0); activePids = [mediaPid]; } catch {}
          sourcePreparationStarted = activePids.length === 1;
        }
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

    for (const pid of activePids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
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

test('SIGTERM reaps the active child and preserves the destination', async () => {
  await verifyInterruption('SIGTERM', 143);
});
