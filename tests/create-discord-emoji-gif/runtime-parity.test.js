'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skillDir, temporaryDirectory, makeExecutable, runEntrypoint } = require('./test-helpers');

const runners = [
  { name: 'Bash gifski', command: '/bin/bash', file: 'scripts/bash/mov-to-gif-gifski.sh' },
  { name: 'Node gifski', command: process.execPath, file: 'scripts/node/mov-to-gif-gifski.js' },
  { name: 'Bash gifsicle', command: '/bin/bash', file: 'scripts/bash/mov-to-gif.sh' },
  { name: 'Node gifsicle', command: process.execPath, file: 'scripts/node/mov-to-gif.js' },
];
const parityDirectory = temporaryDirectory('real-runtime-parity.');
const parityInput = path.join(parityDirectory, 'fixture.mkv');

test.after(() => fs.rmSync(parityDirectory, { recursive: true, force: true }));

function listingHas(command, flag, capability) {
  const result = spawnSync(command, ['-hide_banner', flag], { encoding: 'utf8' });
  return result.status === 0 && (result.stdout + result.stderr).split(/\r?\n/).some(line => line.trim().split(/\s+/)[1]?.split(',').includes(capability));
}

function prepareRealParity(t, backend) {
  if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).error?.code === 'ENOENT') {
    t.skip('unavailable command: ffmpeg');
    return false;
  }
  for (const [flag, kind, capability] of [['-filters', 'filter', 'testsrc2'], ['-encoders', 'encoder', 'ffv1']]) {
    if (!listingHas('ffmpeg', flag, capability)) {
      t.skip(`unavailable FFmpeg capability: ${kind} ${capability}`);
      return false;
    }
  }
  const bashRunner = runners.find(runner => runner.name === `Bash ${backend}`);
  const preflight = runEntrypoint(bashRunner.command, path.join(skillDir, bashRunner.file), ['--preflight', '--json']);
  if (preflight.status !== 0) {
    const report = JSON.parse(preflight.stderr);
    const unavailable = report.error.failures?.find(failure => failure.code === 'command_missing' || failure.code === 'ffmpeg_capability_missing');
    if (unavailable?.code === 'command_missing') {
      t.skip(`unavailable command: ${unavailable.condition.replace('required command not found: ', '')}`);
      return false;
    }
    if (unavailable) {
      t.skip(`unavailable FFmpeg capability: ${unavailable.condition.replace('ffmpeg is missing required ', '')}`);
      return false;
    }
    assert.fail(`preflight failed: ${preflight.stderr}`);
  }
  if (!fs.existsSync(parityInput)) {
    const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=6:duration=0.5', '-an', '-c:v', 'ffv1', parityInput], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
  }
  return true;
}

function compareRealBackend(t, backend) {
  if (!prepareRealParity(t, backend)) return;
  const selectedRunners = runners.filter(runner => runner.name.endsWith(backend));
  const environment = {
    MAX_BYTES: '1000000',
    GIF_SIZE: '64',
    MIN_FPS: '6',
    MAX_FPS: '6',
    JOBS: '2',
    ...(backend === 'gifski' ? { MIN_QUALITY: '80', MAX_QUALITY: '80' } : {}),
  };
  const runs = selectedRunners.map(runner => {
    const output = path.join(parityDirectory, `${runner.name.replaceAll(' ', '-')}.gif`);
    const result = runEntrypoint(runner.command, path.join(skillDir, runner.file), [parityInput, output], environment);
    assert.equal(result.status, 0, `${runner.name}: ${result.stderr}`);
    return { runner, output, result };
  });
  const selected = runs.map(run => run.result.stdout.split('\n').find(line => line.startsWith('Selected:')));
  const verified = runs.map(run => run.result.stdout.split('\n').find(line => line.startsWith('Verified:')));
  assert.equal(selected[0], selected[1]);
  assert.equal(verified[0], verified[1]);
  assert.deepEqual(fs.readFileSync(runs[0].output), fs.readFileSync(runs[1].output));
}

function expectedHelp(backend, basename) {
  const quality = backend === 'gifski' ? '  MIN_QUALITY    Minimum gifski quality (default: 1, maximum: 100)\n  MAX_QUALITY    Maximum gifski quality (default: 100, maximum: 100)\n' : '';
  const maxFpsMaximum = backend === 'gifski' ? 100 : 9007199254740991;
  return `Usage: ${basename} [OPTIONS] INPUT_VIDEO [OUTPUT.gif]\n\nOptions:\n  --preflight [INPUT_VIDEO]\n                  Check the environment and optional input, convert nothing, then exit\n  --json          Report readiness and errors as JSON\n  --help, -h      Print this message\n  --              Stop option parsing\n\nEnvironment:\n  MAX_BYTES       Strict byte ceiling (default: 256000, maximum: 9007199254740991)\n  GIF_SIZE        Square width and height (default: 128, maximum: 9007199254740991)\n  MIN_FPS         Minimum frame rate (default: 15, maximum: 9007199254740991)\n  MAX_FPS         Maximum frame rate (default: 24, maximum: ${maxFpsMaximum})\n  JOBS            Parallel work limit (default: logical CPUs minus 2, minimum 1, maximum: 9007199254740991)\n${quality}  KEEP_WORK       Keep the work directory when set to 1 (default: unset)\n\nAll positive integers have an exact-value ceiling of 9007199254740991.\n\nExit status:\n  0    Success or passed preflight\n  1    Conversion work started and failed\n  2    Work did not start\n  129  SIGHUP\n  130  SIGINT\n  143  SIGTERM\n`;
}

test('all four direct entrypoints satisfy the exact help contract for --help and -h', () => {
  for (const runner of runners) {
    const script = path.join(skillDir, runner.file);
    for (const flag of ['--help', '-h']) {
      const result = runEntrypoint(runner.command, script, [flag]);
      assert.equal(result.status, 0, `${runner.name}: ${result.stderr}`);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, expectedHelp(runner.name.includes('gifski') ? 'gifski' : 'gifsicle', path.basename(script)));
    }
  }
});

test('all four direct entrypoints reject missing conversion arguments', () => {
  for (const runner of runners) {
    const result = runEntrypoint(runner.command, path.join(skillDir, runner.file), ['--json']);
    assert.equal(result.status, 2, runner.name);
    assert.equal(JSON.parse(result.stderr).error.code, 'usage_error');
    assert.equal(result.stdout, '');
  }
});

test('all four direct entrypoints accept the exact integer boundary and reject larger values before work', () => {
  const directory = temporaryDirectory('integer-boundary.');
  const input = path.join(directory, 'input.mp4');
  const missingTmp = path.join(directory, 'missing-tmp');
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=2:duration=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  try {
    for (const runner of runners) {
      const script = path.join(skillDir, runner.file);
      const accepted = runEntrypoint(runner.command, script, [input, path.join(directory, `${runner.name}.gif`)], {
        MAX_BYTES: '9007199254740991',
        TMPDIR: missingTmp,
      });
      assert.equal(accepted.status, 2, `${runner.name}: ${accepted.stderr}`);
      assert.equal(JSON.parse(runEntrypoint(runner.command, script, ['--json', input, path.join(directory, `${runner.name}.json.gif`)], {
        MAX_BYTES: '9007199254740991',
        TMPDIR: missingTmp,
      }).stderr).error.code, 'work_directory_unusable');
      for (const rejected of ['9007199254740992', '9007199254740993']) {
        const result = runEntrypoint(runner.command, script, ['--json', input, path.join(directory, `${runner.name}.${rejected}.gif`)], {
          MAX_BYTES: rejected,
          TMPDIR: missingTmp,
        });
        assert.equal(result.status, 2, `${runner.name}: ${result.stderr}`);
        assert.equal(JSON.parse(result.stderr).error.code, 'config_invalid');
      }
    }
    assert.equal(fs.existsSync(missingTmp), false);
    assert.deepEqual(fs.readdirSync(directory), ['input.mp4']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('real gifski parity', { timeout: 120000 }, t => compareRealBackend(t, 'gifski'));
test('real gifsicle parity', { timeout: 300000 }, t => compareRealBackend(t, 'gifsicle'));

test('Bash gifsicle rejects a non-GIF codec before atomic publication', { timeout: 180000 }, t => {
  if (!prepareRealParity(t, 'gifsicle')) return;
  const mockDir = fs.mkdtempSync(path.join(parityDirectory, 'codec-mock.'));
  const realFfprobe = spawnSync('/bin/sh', ['-c', 'command -v ffprobe'], { encoding: 'utf8' }).stdout.trim();
  makeExecutable(path.join(mockDir, 'ffprobe'), `#!/bin/sh
codec_query=0
temporary=0
for argument do
  case "$argument" in
    stream=codec_name,codec_type) codec_query=1 ;;
    *.mov-to-gif-output.*) temporary=1 ;;
  esac
done
if [ "$codec_query" -eq 1 ] && [ "$temporary" -eq 1 ]; then
  printf 'png|video\\n'
  exit 0
fi
exec "${realFfprobe}" "$@"
`);
  const outputDir = fs.mkdtempSync(path.join(parityDirectory, 'codec-output.'));
  const output = path.join(outputDir, 'output.gif');
  fs.writeFileSync(output, 'existing destination\n');
  const runner = runners.find(candidate => candidate.name === 'Bash gifsicle');
  const result = runEntrypoint(runner.command, path.join(skillDir, runner.file), [parityInput, output], {
    MAX_BYTES: '1000000', GIF_SIZE: '64', MIN_FPS: '6', MAX_FPS: '6', JOBS: '2',
    PATH: `${mockDir}:${process.env.PATH}`,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /ERROR \[verification_failed\]: verification failed, expected a GIF video stream, got png\|video/);
  assert.equal(fs.readFileSync(output, 'utf8'), 'existing destination\n');
  assert.equal(fs.readdirSync(outputDir).some(name => name.startsWith('.mov-to-gif-output.')), false);
});
