'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skillDir, temporaryDirectory, runEntrypoint } = require('./test-helpers');

const runners = [
  { name: 'Node gifski', command: process.execPath, file: 'scripts/node/mov-to-gif-gifski.js', backend: 'gifski' },
  { name: 'Node gifsicle', command: process.execPath, file: 'scripts/node/mov-to-gif.js', backend: 'gifsicle' },
];
const cliDirectory = temporaryDirectory('real-cli-contract.');
const cliInput = path.join(cliDirectory, 'fixture.mkv');

test.after(() => fs.rmSync(cliDirectory, { recursive: true, force: true }));

function prepareRealCli(t, runner) {
  const preflight = runEntrypoint(runner.command, path.join(skillDir, runner.file), ['--preflight', '--json']);
  if (preflight.status !== 0) {
    const report = JSON.parse(preflight.stderr).error;
    t.skip(`environment not ready: ${report.condition}`);
    return false;
  }
  if (!fs.existsSync(cliInput)) {
    const generated = spawnSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=6:duration=0.5',
      '-an', '-c:v', 'ffv1', cliInput,
    ], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
  }
  return true;
}

function expectedHelp(backend, basename) {
  const quality = backend === 'gifski' ? '  MIN_QUALITY    Minimum gifski quality (default: 1, maximum: 100)\n  MAX_QUALITY    Maximum gifski quality (default: 100, maximum: 100)\n' : '';
  const maxFpsMaximum = backend === 'gifski' ? 100 : 9007199254740991;
  return `Usage: ${basename} [OPTIONS] INPUT_VIDEO [OUTPUT.gif]\n\nOptions:\n  --preflight [INPUT_VIDEO]\n                  Check the environment and optional input, convert nothing, then exit\n  --json          Report readiness and errors as JSON\n  --help, -h      Print this message\n  --              Stop option parsing\n\nEnvironment:\n  MAX_BYTES       Strict byte ceiling (default: 256000, maximum: 9007199254740991)\n  GIF_SIZE        Square width and height (default: 128, maximum: 9007199254740991)\n  MIN_FPS         Minimum frame rate (default: 15, maximum: 9007199254740991)\n  MAX_FPS         Maximum frame rate (default: 24, maximum: ${maxFpsMaximum})\n  JOBS            Parallel work limit (default: logical CPUs minus 2, minimum 1, maximum: 9007199254740991)\n${quality}  KEEP_WORK       Keep the work directory when set to 1 (default: unset)\n\nAll positive integers have an exact-value ceiling of 9007199254740991.\n\nExit status:\n  0    Success or passed preflight\n  1    Conversion work started and failed\n  2    Work did not start\n  129  SIGHUP\n  130  SIGINT\n  143  SIGTERM\n`;
}

test('both Node entrypoints satisfy the exact help and exit-status contract for --help and -h', () => {
  for (const runner of runners) {
    const script = path.join(skillDir, runner.file);
    for (const flag of ['--help', '-h']) {
      const result = runEntrypoint(runner.command, script, [flag]);
      assert.equal(result.status, 0, `${runner.name}: ${result.stderr}`);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, expectedHelp(runner.backend, path.basename(script)));
    }
  }
});

test('both Node entrypoints reject missing conversion arguments with a JSON error', () => {
  for (const runner of runners) {
    const result = runEntrypoint(runner.command, path.join(skillDir, runner.file), ['--json']);
    assert.equal(result.status, 2, runner.name);
    assert.equal(JSON.parse(result.stderr).error.code, 'usage_error');
    assert.equal(result.stdout, '');
  }
});

test('both Node entrypoints accept the exact integer boundary and reject larger values before work', () => {
  const directory = temporaryDirectory('integer-boundary.');
  const input = path.join(directory, 'input.mp4');
  const missingTmp = path.join(directory, 'missing-tmp');
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=2:duration=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  try {
    for (const runner of runners) {
      const script = path.join(skillDir, runner.file);
      const accepted = runEntrypoint(runner.command, script, [input, path.join(directory, `${runner.name}.gif`)], {
        MAX_BYTES: '9007199254740991', TMPDIR: missingTmp,
      });
      assert.equal(accepted.status, 2, `${runner.name}: ${accepted.stderr}`);
      assert.equal(JSON.parse(runEntrypoint(runner.command, script, ['--json', input, path.join(directory, `${runner.name}.json.gif`)], {
        MAX_BYTES: '9007199254740991', TMPDIR: missingTmp,
      }).stderr).error.code, 'work_directory_unusable');
      for (const rejected of ['9007199254740992', '9007199254740993']) {
        const result = runEntrypoint(runner.command, script, ['--json', input, path.join(directory, `${runner.name}.${rejected}.gif`)], { MAX_BYTES: rejected, TMPDIR: missingTmp });
        assert.equal(result.status, 2, `${runner.name}: ${result.stderr}`);
        assert.equal(JSON.parse(result.stderr).error.code, 'config_invalid');
      }
    }
    assert.equal(fs.existsSync(missingTmp), false);
    assert.deepEqual(fs.readdirSync(directory), ['input.mp4']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const runner of runners) {
  test(`${runner.name} publishes a complete stable JSON result`, { timeout: 120000 }, t => {
    if (!prepareRealCli(t, runner)) return;
    const output = path.join(cliDirectory, `${runner.backend}.gif`);
    const maxBytes = 1000000;
    const result = runEntrypoint(runner.command, path.join(skillDir, runner.file), ['--json', cliInput, output], {
      MAX_BYTES: String(maxBytes), GIF_SIZE: '64', MIN_FPS: '6', MAX_FPS: '6', JOBS: '2',
      ...(runner.backend === 'gifski' ? { MIN_QUALITY: '80', MAX_QUALITY: '80' } : {}),
    });
    assert.equal(result.status, 0, `${runner.name}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout).result;
    assert.equal(payload.status, 'verified');
    assert.equal(payload.backend, runner.backend);
    assert.equal(payload.input, cliInput);
    assert.equal(payload.output, output);
    assert.equal(payload.dimensions, '64x64');
    assert.equal(payload.width, 64);
    assert.equal(payload.height, 64);
    assert.equal(typeof payload.bytes, 'number');
    assert.ok(Number.isInteger(payload.bytes));
    assert.match(payload.sha256, /^[0-9a-f]{64}$/);
    assert.match(payload.vmaf, /^-?[0-9]+(?:\.[0-9]+)?$/);
    assert.ok(Array.isArray(payload.checks));
    assert.ok(payload.checks.length > 0);
    assert.ok(payload.checks.every(check => typeof check.name === 'string' && check.status === 'pass'));
    assert.equal(fs.existsSync(output), true);
    assert.ok(payload.bytes < maxBytes);
  });
}

test('Node gifsicle removes its work directory when KEEP_WORK=1', { timeout: 120000 }, t => {
  const runner = runners.find(candidate => candidate.backend === 'gifsicle');
  if (!prepareRealCli(t, runner)) return;
  const temporaryRoot = temporaryDirectory('gifsicle-keep-work-cleanup.');
  const output = path.join(cliDirectory, 'gifsicle-keep-work-cleanup.gif');
  try {
    const result = runEntrypoint(runner.command, path.join(skillDir, runner.file), ['--json', cliInput, output], {
      MAX_BYTES: '1000000', GIF_SIZE: '64', MIN_FPS: '6', MAX_FPS: '6', JOBS: '2',
      KEEP_WORK: '1', TMPDIR: temporaryRoot,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(fs.readdirSync(temporaryRoot), []);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
