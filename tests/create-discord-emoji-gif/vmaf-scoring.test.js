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

function scorerFixture(t, keepWork = false) {
  const shared = require('../../plugins/harness/skills/create-discord-emoji-gif/scripts/node/shared');
  const workDir = temporaryDirectory('score-reuse.');
  t.after(() => fs.rmSync(workDir, { recursive:true, force:true }));
  const calls = [];
  let release;
  let failure;
  const manager = { cancelling:false, runOwned: async (task, command, args) => {
    calls.push(task);
    if (task.endsWith('-vmaf')) {
      if (release) await release;
      if (failure) throw failure;
      assert.ok(fs.existsSync(args[args.lastIndexOf('-i') + 1]), 'first candidate must survive scoring');
      const name = /log_path=([^;]+)/.exec(args[args.indexOf('-lavfi') + 1])[1];
      fs.writeFileSync(path.join(workDir,name), JSON.stringify({ frames: Array(12).fill({}), pooled_metrics:{ vmaf:{ mean:91.25 } } }));
      return { code:0, signal:null, stderr:'' };
    }
    return { code:0, signal:null, stderr:'', stdout:'0.5' };
  } };
  const state = { manager, commands:{ ffmpeg:'ffmpeg',ffprobe:'ffprobe' }, workDir, referenceFrames:12, config:{ keepWork } };
  const file = (name, content='same') => { const p=path.join(workDir,name); fs.writeFileSync(p,content); return p; };
  return { state, calls, file, scorer:() => shared.createCandidateScorer(state), digest:shared.sha256File,
    delay: promise => { release=promise; }, fail: error => { failure=error; } };
}

test('identical concurrent candidates share scoring and hits survive original-file deletion', async t => {
  const f=scorerFixture(t); const score=f.scorer();
  const a=f.file('a.gif'), b=f.file('b.gif');
  let release; f.delay(new Promise(r=>release=r));
  const first=score(a,'first',6,f.digest(a));
  const second=score(b,'second',6,f.digest(b));
  assert.equal(f.calls.length,1);
  release();
  assert.deepEqual(await Promise.all([first,second]),['91.250000','91.250000']);
  assert.equal(f.calls.length,2);
  fs.rmSync(a);
  assert.equal(await score(b,'later',6,f.digest(b)),'91.250000');
  assert.equal(f.calls.length,2);
  await score(b,'fps',8,f.digest(b));
  await score(f.file('different.gif','different'),'bytes',6,f.digest(path.join(f.state.workDir,'different.gif')));
  await f.scorer()(b,'context',6,f.digest(b));
  assert.equal(f.calls.length,8);
});

test('shared failures retain original evidence and rejected entries are removed', async t => {
  const f=scorerFixture(t); const score=f.scorer(); const a=f.file('a.gif');
  const error=Object.assign(new Error('original'),{ task:'first',childExitCode:7,stderr:'failure' });
  let release; f.delay(new Promise(r=>release=r)); f.fail(error);
  const requests=[score(a,'one',6,f.digest(a)),score(a,'two',6,f.digest(a))];
  release();
  const settled=await Promise.allSettled(requests);
  for (const result of settled) assert.equal(result.reason,error);
  f.fail(null);
  assert.equal(await score(a,'retry-by-caller',6,f.digest(a)),'91.250000');
  assert.equal(f.calls.length,3);
});

test('cancellation rejects waiting duplicates and subsequent cache hits', async t => {
  const f=scorerFixture(t); const score=f.scorer(); const a=f.file('a.gif');
  let release; f.delay(new Promise(r=>release=r));
  const pending=[score(a,'one',6,f.digest(a)),score(a,'two',6,f.digest(a))];
  f.state.manager.cancelling=true; release();
  for (const result of await Promise.allSettled(pending)) assert.equal(result.reason.code,'cancelled');
  await assert.rejects(score(a,'hit',6,f.digest(a)),{ code:'cancelled' });
  assert.equal(f.calls.length,2);
});

test('KEEP_WORK scores every candidate and keeps independent reports', async t => {
  const f=scorerFixture(t,true); const score=f.scorer(); const a=f.file('a.gif');
  await Promise.all([score(a,'one',6,f.digest(a)),score(a,'two',6,f.digest(a))]);
  assert.equal(f.calls.length,4);
  assert.equal(fs.readdirSync(f.state.workDir).filter(name=>name.startsWith('vmaf-')).length,2);
  assert.ok(fs.existsSync(a));
});
