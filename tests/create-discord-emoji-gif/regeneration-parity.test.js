'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skillDir, temporaryDirectory, makeExecutable, runEntrypoint } = require('./test-helpers');

const runners = [
  { name: 'Bash', command: '/bin/bash', file: 'scripts/bash/mov-to-gif-gifski.sh' },
  { name: 'Node', command: process.execPath, file: 'scripts/node/mov-to-gif-gifski.js' },
];
const directory = temporaryDirectory('regeneration-parity.');
const input = path.join(directory, 'input.mkv');
const baseEnv = {
  MAX_BYTES: '1000000',
  GIF_SIZE: '64',
  MIN_FPS: '8',
  MAX_FPS: '8',
  MIN_QUALITY: '80',
  MAX_QUALITY: '80',
  JOBS: '1',
};

function commandPath(name) {
  const result = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test.before(() => {
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=8:duration=0.5', '-an', '-c:v', 'ffv1', input], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
});
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

const cases = [
  {
    name: 'winner source failure',
    command: 'ffmpeg',
    condition: 'winner source preparation failed: forced winner source failure',
    remedy: 'fix the reported ffmpeg decode or filter error, then run the same conversion again',
    wrapper(real) {
      return `#!/bin/sh
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
exec "${real}" "$@"
`;
    },
  },
  {
    name: 'winner encode failure',
    command: 'gifski',
    condition: 'winner regeneration failed: forced winner encode failure',
    remedy: 'fix the reported gifski error, then run the same conversion again',
    wrapper(real) {
      return `#!/bin/sh
case "$1" in --version|--help) exec "${real}" "$@" ;; esac
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
exec "${real}" "$@"
`;
    },
  },
  {
    name: 'missing regenerated output',
    command: 'gifski',
    condition: 'gifski reported success but did not create the regenerated winner',
    remedy: 'repair or reinstall gifski, then run the same conversion again',
    wrapper(real) {
      return `#!/bin/sh
case "$1" in --version|--help) exec "${real}" "$@" ;; esac
previous=''
output=''
for argument do
  if [ "$previous" = '--output' ]; then output=$argument; fi
  previous=$argument
done
case "$output" in *winner-regenerated.gif) exit 0 ;; esac
exec "${real}" "$@"
`;
    },
  },
];

for (const entry of cases) {
  test(`Node and Bash report matching regeneration_failed diagnostics for ${entry.name}`, () => {
    const reports = [];
    for (const runner of runners) {
      const mockDir = fs.mkdtempSync(path.join(directory, `${runner.name}-${entry.command}.`));
      makeExecutable(path.join(mockDir, entry.command), entry.wrapper(commandPath(entry.command)));
      const outputDir = fs.mkdtempSync(path.join(directory, `${runner.name}-output.`));
      const output = path.join(outputDir, 'output.gif');
      const counter = path.join(mockDir, 'counter');
      fs.writeFileSync(output, 'existing destination\n');
      const result = runEntrypoint(runner.command, path.join(skillDir, runner.file), ['--json', input, output], {
        ...baseEnv,
        PATH: `${mockDir}:${process.env.PATH}`,
        TEST_COUNTER: counter,
      });
      assert.equal(result.status, 1, `${runner.name}: ${result.stderr}`);
      const report = JSON.parse(result.stderr).error;
      assert.equal(report.code, 'regeneration_failed');
      assert.equal(report.condition, entry.condition);
      assert.equal(report.remedy, entry.remedy);
      assert.equal(fs.readFileSync(output, 'utf8'), 'existing destination\n');
      assert.equal(fs.readdirSync(outputDir).some(name => name.startsWith('.mov-to-gif-gifski-output.')), false);
      reports.push(report);
    }
    assert.deepEqual(reports[0], reports[1]);
  });
}
