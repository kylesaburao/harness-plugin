'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { skillDir, temporaryDirectory, makeExecutable, runEntrypoint } = require('./test-helpers');

const runners = [
  { name: 'Bash gifski', command: '/bin/bash', file: 'scripts/bash/mov-to-gif-gifski.sh' },
  { name: 'Node gifski', command: process.execPath, file: 'scripts/node/mov-to-gif-gifski.js' },
  { name: 'Bash gifsicle', command: '/bin/bash', file: 'scripts/bash/mov-to-gif.sh' },
  { name: 'Node gifsicle', command: process.execPath, file: 'scripts/node/mov-to-gif.js' },
];

function runWithFake(runner, name, contents) {
  const directory = temporaryDirectory(`preflight-${name}.`);
  makeExecutable(path.join(directory, name), contents);
  try {
    return runEntrypoint(runner.command, path.join(skillDir, runner.file), ['--preflight', '--json'], {
      PATH: `${directory}:${process.env.PATH}`,
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

for (const runner of runners) {
  test(`${runner.name} reports an unusable ffprobe executable`, () => {
    const result = runWithFake(runner, 'ffprobe', '#!/bin/sh\nexit 1\n');
    assert.equal(result.status, 2, result.stderr);
    const failures = JSON.parse(result.stderr).error.failures.filter(failure => failure.code === 'ffprobe_probe_failed');
    assert.deepEqual(failures.map(({ code, condition }) => ({ code, condition })), [
      { code: 'ffprobe_probe_failed', condition: 'ffprobe is present but could not report its program version' },
      { code: 'ffprobe_probe_failed', condition: 'ffprobe is present but could not report its options' },
    ]);
    assert.ok(failures.every(failure => failure.remedy));
  });

  test(`${runner.name} reports every missing ffprobe option`, () => {
    const fake = `#!/bin/sh
case "$*" in
  *-show_program_version*) printf '{"program_version":{}}\\n' ;;
  *'-h full'*) printf '%s\\n' '-of' ;;
  *) exit 1 ;;
esac
`;
    const result = runWithFake(runner, 'ffprobe', fake);
    assert.equal(result.status, 2, result.stderr);
    const failures = JSON.parse(result.stderr).error.failures.filter(failure => failure.code === 'ffprobe_capability_missing');
    assert.deepEqual(failures.map(failure => failure.condition), [
      'ffprobe is missing required option: -select_streams',
      'ffprobe is missing required option: -show_entries',
      'ffprobe is missing required option: -count_frames',
    ]);
    assert.ok(failures.every(failure => failure.remedy));
  });
}

for (const runner of runners.filter(runner => runner.name.includes('gifsicle'))) {
  test(`${runner.name} reports an unusable gifsicle executable`, () => {
    const result = runWithFake(runner, 'gifsicle', '#!/bin/sh\nexit 1\n');
    assert.equal(result.status, 2, result.stderr);
    const failures = JSON.parse(result.stderr).error.failures.filter(failure => failure.code === 'gifsicle_probe_failed');
    assert.deepEqual(failures.map(failure => failure.condition), [
      'gifsicle is present but could not report its version',
      'gifsicle is present but could not report its options',
    ]);
  });

  test(`${runner.name} reports a missing gifsicle optimization option`, () => {
    const fake = `#!/bin/sh
case "$1" in
  --version) printf 'gifsicle fake\\n' ;;
  --help) printf '%s\\n' '--output=FILE' ;;
  *) exit 1 ;;
esac
`;
    const result = runWithFake(runner, 'gifsicle', fake);
    assert.equal(result.status, 2, result.stderr);
    const failures = JSON.parse(result.stderr).error.failures.filter(failure => failure.code === 'gifsicle_capability_missing');
    assert.deepEqual(failures.map(failure => failure.condition), [
      'gifsicle is missing required option: --optimize',
    ]);
    assert.ok(failures[0].remedy);
  });
}

test('Node and Bash emit byte-equivalent shared-tool preflight diagnoses', () => {
  const ffprobe = `#!/bin/sh
case "$*" in
  *-show_program_version*) exit 1 ;;
  *'-h full'*) printf '%s\\n' '-of' ;;
  *) exit 1 ;;
esac
`;
  const ffprobeReports = runners.filter(runner => runner.name.includes('gifski')).map(runner => {
    const result = runWithFake(runner, 'ffprobe', ffprobe);
    return JSON.parse(result.stderr).error.failures.filter(failure => failure.code.startsWith('ffprobe_'));
  });
  assert.deepEqual(ffprobeReports[0], ffprobeReports[1]);

  const gifsicle = `#!/bin/sh
case "$1" in
  --version) exit 1 ;;
  --help) printf '%s\\n' '--output=FILE' ;;
  *) exit 1 ;;
esac
`;
  const gifsicleReports = runners.filter(runner => runner.name.includes('gifsicle')).map(runner => {
    const result = runWithFake(runner, 'gifsicle', gifsicle);
    return JSON.parse(result.stderr).error.failures.filter(failure => failure.code.startsWith('gifsicle_'));
  });
  assert.deepEqual(gifsicleReports[0], gifsicleReports[1]);
});
