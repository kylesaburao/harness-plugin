'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { temporaryDirectory, skillDir, runEntrypoint } = require('./test-helpers');
const shared = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/shared');

// Limit only the test search. Preparation, encoders, scoring, and publication remain real.
function narrowSearch(directory) {
  const preload = path.join(directory, 'narrow.cjs');
  fs.writeFileSync(preload, `
const { ProcessManager } = require(${JSON.stringify(path.join(skillDir, 'scripts/node/process-manager'))});
const original = ProcessManager.prototype.runOldestBounded;
ProcessManager.prototype.runOldestBounded = function(items, jobs, worker) {
  return original.call(this, items.filter(item => !item.colors || item.colors <= 5), jobs, worker);
};
`);
  return preload;
}

for (const backend of ['gifski', 'gifsicle']) {
  test(`${backend} prepares the first video stream and publishes its retained candidate`, () => {
    const directory = temporaryDirectory('gif-streams.');
    try {
      const input = path.join(directory, 'two-streams.mkv');
      const output = path.join(directory, 'output.gif');
      const fixture = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:size=32x24:rate=8:duration=0.5,drawbox=x=0:y=0:w=8:h=8:color=white:t=fill:enable=lt(n\\,2)', '-f', 'lavfi', '-i', 'color=blue:size=96x64:rate=8:duration=0.5,drawbox=x=0:y=0:w=8:h=8:color=white:t=fill:enable=lt(n\\,2)', '-map', '0:v', '-map', '1:v', '-c:v', 'ffv1', '-disposition:v:0', '0', '-disposition:v:1', 'default', input], { encoding: 'utf8' });
      assert.equal(fixture.status, 0, fixture.stderr);
      const result = runEntrypoint(process.execPath, path.join(skillDir, 'scripts/node', backend === 'gifski' ? 'mov-to-gif-gifski.js' : 'mov-to-gif.js'), ['--json', input, output], {
        NODE_OPTIONS: `--require=${narrowSearch(directory)}`, TMPDIR: directory,
        KEEP_WORK: '1', GIF_SIZE: '32', MIN_FPS: '8', MAX_FPS: '8', MIN_QUALITY: '80', MAX_QUALITY: '80', JOBS: '2', MAX_BYTES: '100000',
      });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout).result;
      const kept = result.stderr.match(/^Kept work directory: (.+)$/m)?.[1];
      assert.ok(kept, result.stderr);
      for (const file of ['vmaf-reference.mkv', backend === 'gifski' ? 'source-f8.y4m' : 'source-f8.nut', output]) {
        const pixel = spawnSync('ffmpeg', ['-v', 'error', '-i', path.isAbsolute(file) ? file : path.join(kept, file), '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
        assert.equal(pixel.status, 0, pixel.stderr.toString());
        assert.ok(pixel.stdout[0] > 200 && pixel.stdout[2] < 50, `${file}: expected red, got ${[...pixel.stdout]}`);
      }
      const p = report.parameters;
      const selected = backend === 'gifski' ? `f${report.fps}-q${p.quality}-m${p.motionQuality}-l${p.lossyQuality}.gif` : `f${report.fps}-c${p.colors}-d${p.dither}.gif`;
      assert.equal(shared.sha256File(path.join(kept, selected)), report.sha256);
      assert.equal(shared.sha256File(output), report.sha256);
      assert.equal(fs.readdirSync(kept).some(name => name.startsWith('winner-')), false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const backend of ['gifski', 'gifsicle']) {
  for (const scenario of ['forward', 'reverse', 'keep', 'corrupt', 'missing', 'rename', 'no-candidate', 'interrupt']) {
    test(`${backend} retained-file lifecycle: ${scenario}`, () => {
      const directory = temporaryDirectory('gif-retention.');
      try {
        const input = path.join(directory, 'input.mkv');
        const output = path.join(directory, 'output.gif');
        const evidence = path.join(directory, 'evidence.json');
        const fixture = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=32x32:rate=8:duration=0.5', '-c:v', 'ffv1', input], { encoding: 'utf8' });
        assert.equal(fixture.status, 0, fixture.stderr);
        fs.writeFileSync(output, 'existing destination');
        const preload = narrowSearch(directory);
        fs.appendFileSync(preload, `
const fs = require('node:fs');
const path = require('node:path');
const shared = require(${JSON.stringify(path.join(skillDir, 'scripts/node/shared'))});
const backend = ${JSON.stringify(backend)};
const scenario = ${JSON.stringify(scenario)};
const scored = [];
const bounded = ProcessManager.prototype.runOldestBounded;
ProcessManager.prototype.runOldestBounded = function(items, jobs, worker) {
  const search = items.every(item => typeof item === 'number' || item.colors);
  return bounded.call(this, items, jobs, async item => {
    const key = typeof item === 'number' ? item : item.colors;
    if (search && key === (scenario === 'reverse' ? (backend === 'gifski' ? 8 : 4) : (backend === 'gifski' ? 9 : 5))) await new Promise(resolve => setTimeout(resolve, 300));
    return worker(item);
  });
};
// Deterministic scores isolate ordering from codec/toolchain variation.
shared.scoreCandidate = async (_manager, _commands, _work, file, task) => {
  if (task !== 'final') scored.push({ name: path.basename(file), digest: shared.sha256File(file) });
  if (scenario === 'interrupt' && scored.length === 2) process.kill(process.pid, 'SIGTERM');
  return '90';
};
const publish = shared.publishVerified;
shared.publishVerified = async (source, ...args) => {
  const candidates = fs.readdirSync(path.dirname(source)).filter(name => /^f[0-9].*\\.gif$/.test(name));
  fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ selected: path.basename(source), digest: shared.sha256File(source), candidates, scored }));
  if (scenario === 'corrupt') {
    const data = fs.readFileSync(source);
    data[4] = data[4] === 57 ? 55 : 57; // GIF89a and GIF87a both decode, but differ in digest.
    fs.writeFileSync(source, data);
  }
  if (scenario === 'missing') fs.rmSync(source);
  return publish(source, ...args);
};
if (scenario === 'rename') {
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === ${JSON.stringify(output)}) throw new Error('forced rename failure');
    return rename(source, destination);
  };
}
`);
        const result = runEntrypoint(process.execPath, path.join(skillDir, 'scripts/node', backend === 'gifski' ? 'mov-to-gif-gifski.js' : 'mov-to-gif.js'), ['--json', input, output], {
          NODE_OPTIONS: `--require=${preload}`, TMPDIR: directory,
          KEEP_WORK: scenario === 'keep' ? '1' : '0', GIF_SIZE: '32', MIN_FPS: '8', MAX_FPS: backend === 'gifski' ? '9' : '8', MIN_QUALITY: '70', MAX_QUALITY: '90', JOBS: '4', MAX_BYTES: scenario === 'no-candidate' ? '1' : '100000',
        });
        if (scenario === 'interrupt') {
          assert.equal(result.status, 143, result.stderr);
          assert.equal(fs.readFileSync(output, 'utf8'), 'existing destination');
        } else if (['corrupt', 'missing', 'rename', 'no-candidate'].includes(scenario)) {
          assert.equal(result.status, 1, result.stderr);
          const failure = JSON.parse(result.stderr).error;
          assert.equal(failure.code, scenario === 'corrupt' ? 'verification_failed' : scenario === 'no-candidate' ? 'no_candidate' : 'publication_failed');
          if (scenario === 'corrupt') assert.match(failure.condition, /digest does not match/);
          assert.equal(fs.readFileSync(output, 'utf8'), 'existing destination');
        } else {
          assert.equal(result.status, 0, result.stderr);
          const report = JSON.parse(result.stdout).result;
          const proof = JSON.parse(fs.readFileSync(evidence));
          assert.equal(report.sha256, proof.digest);
          assert.equal(shared.sha256File(output), proof.digest);
          assert.equal(proof.selected, backend === 'gifski' ? 'f9-q90-m90-l90.gif' : 'f8-c5-d2.gif');
          assert.equal(proof.scored.find(candidate => candidate.name === proof.selected).digest, proof.digest);
          assert.equal(new Set(proof.scored.map(candidate => candidate.name)).size, proof.scored.length);
          if (scenario === 'keep') assert.deepEqual(proof.candidates.sort(), proof.scored.map(candidate => candidate.name).sort());
          else assert.deepEqual(proof.candidates, [proof.selected]);
          if (backend === 'gifski') {
            const { candidateSequence } = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/mov-to-gif-gifski');
            for (const fps of [8, 9]) {
              assert.deepEqual(proof.scored.filter(candidate => candidate.name.startsWith(`f${fps}-`)).map(candidate => candidate.name), candidateSequence({ minQuality: 70, maxQuality: 90 }, 90).map(c => `f${fps}-q${c.quality}-m${c.motionQuality}-l${c.lossyQuality}.gif`));
            }
          }
          if (scenario !== 'keep') assert.match(proof.scored[0].name, new RegExp(backend === 'gifski' ? `^f${scenario === 'reverse' ? 9 : 8}-` : `-c${scenario === 'reverse' ? 5 : 4}-`));
        }
        assert.equal(fs.readdirSync(directory).some(name => name.startsWith('.mov-to-gif')), false);
        if (scenario !== 'keep') assert.equal(fs.readdirSync(directory).some(name => name.startsWith('mov-to-gif')), false);
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
  }
}
