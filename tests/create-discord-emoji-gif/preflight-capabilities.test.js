'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { skillDir, temporaryDirectory, makeExecutable, runEntrypoint } = require('./test-helpers');

const gifski = { name: 'Node gifski', command: process.execPath, file: 'scripts/node/mov-to-gif-gifski.js' };
const gifsicle = { name: 'Node gifsicle', command: process.execPath, file: 'scripts/node/mov-to-gif.js' };
const mac = process.platform === 'darwin';
const gifskiRemedy = process.platform === 'darwin' ? 'brew install gifski' : 'cargo install gifski, or install the prebuilt binary from https://gif.ski';
const gifsicleRemedy = process.platform === 'darwin' ? 'brew install gifsicle' : 'sudo apt install gifsicle';
const ffmpegReinstall = mac ? 'brew reinstall ffmpeg' : 'reinstall ffmpeg from your package manager or a static build';
const ffprobeUpgrade = mac ? 'brew upgrade ffmpeg' : 'install an ffprobe build that includes it';
const gifskiReinstall = mac ? 'brew reinstall gifski' : 'reinstall gifski, for example with cargo install gifski or the prebuilt binary from https://gif.ski';
const gifskiUpgrade = mac ? 'brew upgrade gifski' : 'upgrade gifski, for example with cargo install gifski or the prebuilt binary from https://gif.ski';
const gifsicleReinstall = mac ? 'brew reinstall gifsicle' : 'reinstall gifsicle from your package manager';
const gifsicleUpgrade = mac ? 'brew upgrade gifsicle' : 'upgrade gifsicle from your package manager';
const missingFfmpegForGifski = mac ? 'brew install ffmpeg' : 'sudo apt install ffmpeg (or use a build with libvmaf if the VMAF filter check fails)';
const missingFfmpegForGifsicle = mac ? 'brew install ffmpeg' : 'sudo apt install ffmpeg';

function runWithFake(runner, name, contents) {
  const directory = temporaryDirectory(`preflight-${name}.`);
  makeExecutable(path.join(directory, name), contents);
  try {
    return runEntrypoint(runner.command, path.join(skillDir, runner.file), ['--preflight', '--json'], {
      PATH: `${directory}:${process.env.PATH}`,
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function failures(result) {
  assert.equal(result.status, 2, result.stderr);
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.code, 'preflight_failed');
  assert.ok(Array.isArray(error.failures));
  assert.ok(error.failures.every(failure => failure.code && failure.condition && failure.remedy));
  return error.failures;
}

function failuresWithCode(result, code) {
  return failures(result).filter(failure => failure.code === code).map(({ code: failureCode, condition, remedy }) => ({ code: failureCode, condition, remedy }));
}

test('Node gifski reports shared ffmpeg and ffprobe preflight failures with stable JSON details', () => {
  assert.deepEqual(failuresWithCode(runWithFake(gifski, 'ffmpeg', '#!/bin/sh\nexit 1\n'), 'ffmpeg_probe_failed'), [
    { code: 'ffmpeg_probe_failed', condition: 'ffmpeg could not report its available filters', remedy: ffmpegReinstall },
    { code: 'ffmpeg_probe_failed', condition: 'ffmpeg could not report its available encoders', remedy: ffmpegReinstall },
    { code: 'ffmpeg_probe_failed', condition: 'ffmpeg could not report its available decoders', remedy: ffmpegReinstall },
    { code: 'ffmpeg_probe_failed', condition: 'ffmpeg could not report its available muxers', remedy: ffmpegReinstall },
    { code: 'ffmpeg_probe_failed', condition: 'ffmpeg could not report its available demuxers', remedy: ffmpegReinstall },
  ]);

  assert.deepEqual(failuresWithCode(runWithFake(gifski, 'ffprobe', '#!/bin/sh\nexit 1\n'), 'ffprobe_probe_failed'), [
    { code: 'ffprobe_probe_failed', condition: 'ffprobe is present but could not report its program version', remedy: ffmpegReinstall },
    { code: 'ffprobe_probe_failed', condition: 'ffprobe is present but could not report its options', remedy: ffmpegReinstall },
  ]);
});

test('Node gifski reports every missing ffprobe option', () => {
  const fake = `#!/bin/sh
case "$*" in
  *-show_program_version*) printf '{"program_version":{}}\\n' ;;
  *'-h full'*) printf '%s\\n' '-of' ;;
  *) exit 1 ;;
esac
`;
  assert.deepEqual(failuresWithCode(runWithFake(gifski, 'ffprobe', fake), 'ffprobe_capability_missing'), [
    { code: 'ffprobe_capability_missing', condition: 'ffprobe is missing required option: -select_streams', remedy: ffprobeUpgrade },
    { code: 'ffprobe_capability_missing', condition: 'ffprobe is missing required option: -show_entries', remedy: ffprobeUpgrade },
    { code: 'ffprobe_capability_missing', condition: 'ffprobe is missing required option: -count_frames', remedy: ffprobeUpgrade },
  ]);
});

test('Node gifski reports missing, unusable, and incomplete gifski capabilities', () => {
  const missing = failures(runEntrypoint(gifski.command, path.join(skillDir, gifski.file), ['--preflight', '--json'], { PATH: '' }));
  assert.deepEqual(missing, [
    { code: 'command_missing', condition: 'required command not found: ffmpeg', remedy: missingFfmpegForGifski },
    { code: 'command_missing', condition: 'required command not found: ffprobe', remedy: missingFfmpegForGifski },
    { code: 'command_missing', condition: 'required command not found: gifski', remedy: gifskiRemedy },
  ]);

  assert.deepEqual(failuresWithCode(runWithFake(gifski, 'gifski', '#!/bin/sh\nexit 1\n'), 'gifski_probe_failed'), [
    { code: 'gifski_probe_failed', condition: 'gifski is present but could not report its version', remedy: gifskiReinstall },
    { code: 'gifski_probe_failed', condition: 'gifski is present but could not report its options', remedy: gifskiReinstall },
  ]);

  assert.deepEqual(failuresWithCode(runWithFake(gifski, 'gifski', `#!/bin/sh
case "$1" in
  --version) printf 'gifski fake\\n' ;;
  --help) printf '%s\\n' '--fps' ;;
  *) exit 1 ;;
esac
`), 'gifski_capability_missing'), [
    { code: 'gifski_capability_missing', condition: 'gifski is missing required option: --width', remedy: gifskiUpgrade },
    { code: 'gifski_capability_missing', condition: 'gifski is missing required option: --height', remedy: gifskiUpgrade },
    { code: 'gifski_capability_missing', condition: 'gifski is missing required option: --quality', remedy: gifskiUpgrade },
    { code: 'gifski_capability_missing', condition: 'gifski is missing required option: --motion-quality', remedy: gifskiUpgrade },
    { code: 'gifski_capability_missing', condition: 'gifski is missing required option: --lossy-quality', remedy: gifskiUpgrade },
    { code: 'gifski_capability_missing', condition: 'gifski is missing required option: --repeat', remedy: gifskiUpgrade },
    { code: 'gifski_capability_missing', condition: 'gifski is missing required option: --quiet', remedy: gifskiUpgrade },
    { code: 'gifski_capability_missing', condition: 'gifski is missing required option: --output', remedy: gifskiUpgrade },
  ]);
});

test('Node gifsicle reports missing, unusable, and incomplete gifsicle capabilities', () => {
  const missing = failures(runEntrypoint(gifsicle.command, path.join(skillDir, gifsicle.file), ['--preflight', '--json'], { PATH: '' }));
  assert.deepEqual(missing, [
    { code: 'command_missing', condition: 'required command not found: ffmpeg', remedy: missingFfmpegForGifsicle },
    { code: 'command_missing', condition: 'required command not found: ffprobe', remedy: missingFfmpegForGifsicle },
    { code: 'command_missing', condition: 'required command not found: gifsicle', remedy: gifsicleRemedy },
  ]);

  assert.deepEqual(failuresWithCode(runWithFake(gifsicle, 'gifsicle', '#!/bin/sh\nexit 1\n'), 'gifsicle_probe_failed'), [
    { code: 'gifsicle_probe_failed', condition: 'gifsicle is present but could not report its version', remedy: gifsicleReinstall },
    { code: 'gifsicle_probe_failed', condition: 'gifsicle is present but could not report its options', remedy: gifsicleReinstall },
  ]);

  assert.deepEqual(failuresWithCode(runWithFake(gifsicle, 'gifsicle', `#!/bin/sh
case "$1" in
  --version) printf 'gifsicle fake\\n' ;;
  --help) printf '%s\\n' '--output=FILE' ;;
  *) exit 1 ;;
esac
`), 'gifsicle_capability_missing'), [
    { code: 'gifsicle_capability_missing', condition: 'gifsicle is missing required option: --optimize', remedy: gifsicleUpgrade },
  ]);
});
