#!/usr/bin/env node
'use strict';
// Full production searches. Instrumentation is confined to separate diagnostic runs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const [baselineRoot, evidenceArg, modeFlag] = process.argv.slice(2);
const diagnosticsOnly = modeFlag === '--diagnostics-only';
if (modeFlag && !diagnosticsOnly) throw new Error('Unknown measurement mode');
if (!baselineRoot || !evidenceArg) throw new Error('Usage: benchmark-score-reuse.js BASELINE_ROOT EVIDENCE_DIRECTORY');
const evidence = path.resolve(evidenceArg);
fs.mkdirSync(evidence, { recursive:true });
const repo = path.resolve(__dirname,'../..');
const relative = 'plugins/harness/skills/create-discord-emoji-gif/scripts/node';
const roots = { baseline:path.resolve(baselineRoot), current:repo };
const output = path.join(evidence,'benchmark.gif');
const work = path.join(evidence,'gif-work');
fs.mkdirSync(work,{ recursive:true });
const median = a => [...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
const report = diagnosticsOnly ? JSON.parse(fs.readFileSync(path.join(evidence,'score-reuse.json'))) : { node:process.version, platform:process.platform, cpus:os.availableParallelism(), memoryBytes:os.totalmem(), warmups:1, pairs:3, jobs:8, workloads:[] };
function save() { fs.writeFileSync(path.join(evidence,'score-reuse.json'),JSON.stringify(report,null,2)); }
function instrument(root, label) {
  const file = path.join(evidence,`diagnostic-${label}.cjs`);
  const data = path.join(evidence,`diagnostic-${label}.json`);
  fs.writeFileSync(file, `
const fs=require('node:fs');
const shared=require(${JSON.stringify(path.join(root,relative,'shared'))});
const {ProcessManager}=require(${JSON.stringify(path.join(root,relative,'process-manager'))});
let evaluations=0,candidateEvaluations=0,vmaf=0,duration=0;const keys=new Set();
const record=(file,fps,digest)=>{evaluations++;keys.add(JSON.stringify([fps,digest||shared.sha256File(file)]));};
if(shared.createCandidateScorer){const original=shared.createCandidateScorer;shared.createCandidateScorer=state=>{const score=original(state);return(file,task,fps,digest)=>{record(file,fps,digest);return score(file,task,fps,digest);};};}
else {const original=shared.scoreCandidate;shared.scoreCandidate=(...args)=>{record(args[3],args[6]);return original(...args);};}
const run=ProcessManager.prototype.runOwned;
ProcessManager.prototype.runOwned=function(task,...args){if(/^f[0-9]+-(?:c[0-9]+-d[0-9]+-optimize|q[0-9]+-m[0-9]+-l[0-9]+)$/.test(task))candidateEvaluations++;if(task.endsWith('-vmaf'))vmaf++;if(/^f[0-9].* duration$/.test(task))duration++;return run.call(this,task,...args);};
process.on('exit',()=>fs.writeFileSync(${JSON.stringify(data)},JSON.stringify({candidateEvaluations,evaluations,uniqueKeys:keys.size,vmaf,duration})));
`);
  return { file,data };
}
async function run(root, backend, input, config, diagnostic) {
  const entry=path.join(root,relative,backend==='gifski'?'mov-to-gif-gifski.js':'mov-to-gif.js');
  const started=performance.now();
  const child=spawn(process.execPath,[...(diagnostic?['--require',diagnostic.file]:[]),entry,'--json',input,output], { env:{...process.env,...config,TMPDIR:work,JOBS:'8'}, stdio:['ignore','pipe','pipe'] });
  let stdout='',stderr='',peakRssKiB=0,measurementError;
  child.stdout.on('data',chunk=>stdout+=chunk); child.stderr.on('data',chunk=>stderr+=chunk);
  const timer=diagnostic?setInterval(()=>{
    const ps=spawnSync('ps',['-axo','pid=,ppid=,rss='],{encoding:'utf8'});
    if(ps.status!==0){measurementError=ps.stderr||'ps failed';return;}
    const rows=ps.stdout.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
    const ids=new Set([child.pid]);let changed=true;
    while(changed){changed=false;for(const [pid,ppid] of rows)if(ids.has(ppid)&&!ids.has(pid)){ids.add(pid);changed=true;}}
    peakRssKiB=Math.max(peakRssKiB,rows.reduce((sum,[pid,,rss])=>sum+(ids.has(pid)?rss:0),0));
  },100):null;
  const status=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearInterval(timer));
  const seconds=(performance.now()-started)/1000;
  assert.equal(status.code,0,stderr);
  if(diagnostic){assert.equal(measurementError,undefined);assert.ok(peakRssKiB>0,'process-tree RSS was not sampled');}
  return {result:JSON.parse(stdout),seconds,...(diagnostic?{...JSON.parse(fs.readFileSync(diagnostic.data)),peakRssKiB}: {})};
}
(async()=>{
for(const workload of ['two-color','detailed-motion']) {
  const input=path.join(evidence,`${workload}.mkv`);
  const filter=workload==='two-color'?'color=red:size=64x64:rate=6:duration=0.5,drawbox=x=0:y=0:w=16:h=16:color=white:t=fill:enable=lt(n\\,2)':'testsrc2=size=640x360:rate=30:duration=3';
  const generated=diagnosticsOnly?{status:0}:spawnSync('ffmpeg',['-v','error','-y','-f','lavfi','-i',filter,'-c:v','ffv1',input],{encoding:'utf8'});
  assert.equal(generated.status,0,generated.stderr);
  const config={ GIF_SIZE:workload==='two-color'?'64':'128',MIN_FPS:workload==='two-color'?'6':'15',MAX_FPS:workload==='two-color'?'6':'24',MAX_BYTES:workload==='two-color'?'1000000':'256000',MIN_QUALITY:'1',MAX_QUALITY:'100',KEEP_WORK:'0' };
  for(const backend of ['gifsicle','gifski']) {
    const record=diagnosticsOnly?report.workloads.find(item=>item.workload===workload&&item.backend===backend):{workload,synthetic:true,backend,filter,config,samples:{baseline:[],current:[]},diagnostics:{}};
    if(diagnosticsOnly && !record?.result) continue;
    if(!diagnosticsOnly)report.workloads.push(record);save();
    let expected=diagnosticsOnly?record.result:undefined;
    if(!diagnosticsOnly) for(let pair=-1;pair<3;pair++) {
      for(const mode of pair%2===0?['baseline','current']:['current','baseline']) {
        const trial=await run(roots[mode],backend,input,config);
        expected??=trial.result;assert.deepEqual(trial.result,expected);
        if(pair>=0)record.samples[mode].push(trial.seconds);
        save();console.log(`${workload} ${backend} ${pair<0?'warmup':pair+1} ${mode}: ${trial.seconds.toFixed(3)}s`);
      }
    }
    record.result=expected;
    record.medians=Object.fromEntries(Object.entries(record.samples).map(([key,values])=>[key,median(values)]));
    record.savingSeconds=record.medians.baseline-record.medians.current;
    for(const mode of ['baseline','current']) {
      const diagnostic=instrument(roots[mode],`${workload}-${backend}-${mode}`);
      const measured=await run(roots[mode],backend,input,config,diagnostic);
      assert.deepEqual(measured.result,expected);delete measured.result;record.diagnostics[mode]=measured;save();
    }
    // KEEP_WORK has a separate equivalence pair and no expected performance gain.
    if(!diagnosticsOnly) {
    record.keepWork={};
    for(const mode of ['baseline','current']) {
      const trial=await run(roots[mode],backend,input,{...config,KEEP_WORK:'1'});
      assert.deepEqual(trial.result,expected);record.keepWork[mode]=trial.seconds;
      fs.rmSync(work,{recursive:true,force:true});fs.mkdirSync(work);
    }
    }
    assert.equal(record.diagnostics.baseline.candidateEvaluations,record.diagnostics.current.candidateEvaluations);
    assert.equal(record.diagnostics.baseline.evaluations,record.diagnostics.current.evaluations);
    assert.equal(record.diagnostics.baseline.uniqueKeys,record.diagnostics.current.uniqueKeys);
    save();console.log(`Completed ${workload} ${backend}`);
  }
}
})().catch(error=>{console.error(error);process.exitCode=1;});
