'use strict';

// Oracle: FFmpeg's own autorotate defines the correct display orientation. For every distinct
// orthogonal display matrix, the frame decoded with autorotate must be byte-identical to the frame
// decoded with -noautorotate and the filters chosen by displayTransform.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { displayTransform } = require(require('../helpers/plugin-paths').artifactPath('skills/extract-video-frames/scripts/media-model'));

function run(command, args) {
  return spawnSync(command, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
}

function skipReason() {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const probe = run(tool, ['-version']);
    if (probe.error || probe.status !== 0) return `${tool} is not on PATH`;
  }
  const help = run('ffmpeg', ['-hide_banner', '-h', 'full']);
  const text = help.stdout.toString();
  if (!['-display_rotation', '-display_hflip', '-display_vflip'].every(option => text.includes(option))) {
    return 'ffmpeg lacks -display_rotation/-display_hflip/-display_vflip (FFmpeg 6.0 or newer required)';
  }
  return null;
}

function checked(result, label) {
  assert.equal(result.status, 0, `${label} failed: ${result.error || result.stderr.toString()}`);
  return result.stdout;
}

function decodeFrame(file, filters) {
  const args = ['-hide_banner', '-v', 'error', '-nostdin'];
  if (filters) args.push('-noautorotate');
  args.push('-i', file, '-frames:v', '1');
  if (filters) args.push('-vf', filters.length ? filters.join(',') : 'null');
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  return checked(run('ffmpeg', args), `decode ${path.basename(file)}`);
}

// rotation, flips, and the normalized a,b,c,d matrix key ffprobe must report for that tagging.
const CASES = [
  [0, [], '1,0,0,1'],
  [90, [], '0,-1,1,0'],
  [270, [], '0,1,-1,0'],
  [180, [], '-1,0,0,-1'],
  [0, ['hflip'], '-1,0,0,1'],
  [0, ['vflip'], '1,0,0,-1'],
  [90, ['hflip'], '0,-1,-1,0'],
  [90, ['vflip'], '0,1,1,0'],
];

const reason = skipReason();

test('display transforms match FFmpeg autorotate for every orthogonal matrix', { skip: reason || false }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-oracle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'base.mov');
  // Non-square so that a wrong transpose cannot match by accident.
  checked(run('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=1', '-frames:v', '1', '-c:v', 'png', base]), 'generate base clip');
  const seen = new Set();
  for (const [rotation, flips, expectedKey] of CASES) {
    const name = `r${rotation}${flips.join('')}`;
    const tagged = path.join(root, `${name}.mov`);
    const flags = flips.map(flip => `-display_${flip}`);
    checked(run('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-display_rotation', String(rotation), ...flags, '-i', base, '-c', 'copy', tagged]), `tag ${name}`);
    const probe = JSON.parse(checked(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', tagged]), `probe ${name}`).toString());
    const stream = probe.streams[0];
    const transform = displayTransform(stream);
    if (expectedKey === '1,0,0,1') {
      assert.equal(transform.filters.length, 0, `${name}: identity must not add filters`);
    } else {
      assert.ok(transform.matrix, `${name}: ffprobe reported no display matrix`);
      const [a, b, , c, d] = transform.matrix;
      assert.equal([a, b, c, d].map(value => Math.round(value / 65536)).join(','), expectedKey, `${name}: unexpected matrix`);
      assert.ok(transform.filters.length > 0, `${name}: non-identity matrix produced no filters`);
    }
    seen.add(expectedKey);
    assert.ok(decodeFrame(tagged, null).equals(decodeFrame(tagged, transform.filters)), `${name}: ${transform.filters.join(',') || 'null'} differs from FFmpeg autorotate`);
  }
  assert.equal(seen.size, 8);
});
