'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { temporaryDirectory } = require('./test-helpers');
const { ProcessManager } = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/process-manager');
const { scoreCandidate } = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/shared');

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('small VMAF inputs produce stable scores under concurrent scoring', async () => {
  const directory = temporaryDirectory('gif-vmaf.');
  try {
    const reference = path.join(directory, 'vmaf-reference.mkv');
    const candidate = path.join(directory, 'candidate.gif');
    ffmpeg(['-f', 'lavfi', '-i', 'color=red:size=32x24:rate=8:duration=0.5,drawbox=x=0:y=0:w=8:h=8:color=white:t=fill:enable=lt(n\\,2)', '-vf', 'scale=32:32:flags=lanczos,fps=24', '-c:v', 'ffv1', '-pix_fmt', 'yuv420p', '-color_range', 'pc', reference]);
    ffmpeg(['-i', reference, '-vf', 'fps=8', candidate]);
    const manager = new ProcessManager();
    const scores = [];
    // All subprocesses settle before fixture cleanup, including a signalled child.
    for (let batch = 0; batch < 4; batch += 1) {
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
        scoreCandidate(manager, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, directory, candidate, `batch-${batch}-${index}`, 12, 8)));
      for (const result of results) {
        assert.equal(result.status, 'fulfilled', result.reason?.condition);
        scores.push(result.value);
      }
    }
    assert.equal(new Set(scores).size, 1, JSON.stringify(scores));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
