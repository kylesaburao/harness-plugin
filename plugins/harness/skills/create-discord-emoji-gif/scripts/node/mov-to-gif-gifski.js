#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runConverter } = require('./converter-runner');
const shared = require('./shared');

function calculateGifskiWorkers(config, candidateCount) {
  return Math.min(candidateCount, Math.max(1, Math.floor(config.jobs / 2)));
}
function calculateRayonThreads(config, workers) {
  return Math.min(8, Math.max(2, Math.floor(config.jobs / workers)));
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function candidateSequence(config, anchor) {
  const seen = new Set();
  const candidates = [];
  const add = (quality, motionQuality, lossyQuality) => {
    const candidate = { quality, motionQuality, lossyQuality };
    const identity = `${quality}|${motionQuality}|${lossyQuality}`;
    if (!seen.has(identity)) { seen.add(identity); candidates.push(candidate); }
  };
  let level = config.maxQuality;
  while (true) {
    add(level, level, level);
    if (level === config.minQuality) break;
    level = Math.max(config.minQuality, level - 10);
  }
  if (anchor !== undefined) {
    for (const offset of [-10, -5, 0, 5, 10]) {
      level = clamp(anchor + offset, config.minQuality, config.maxQuality);
      add(level, level, level);
      add(clamp(level + 10, config.minQuality, config.maxQuality), clamp(level - 5, config.minQuality, config.maxQuality), clamp(level - 5, config.minQuality, config.maxQuality));
      add(clamp(level - 5, config.minQuality, config.maxQuality), clamp(level + 10, config.minQuality, config.maxQuality), clamp(level - 5, config.minQuality, config.maxQuality));
      add(clamp(level - 5, config.minQuality, config.maxQuality), clamp(level - 5, config.minQuality, config.maxQuality), clamp(level + 10, config.minQuality, config.maxQuality));
    }
  }
  return candidates;
}

function selectWinner(results) {
  return [...results].sort((a, b) => Number(b.score) - Number(a.score) || b.fps - a.fps || b.quality - a.quality || b.motionQuality - a.motionQuality || b.lossyQuality - a.lossyQuality || a.bytes - b.bytes)[0];
}

async function prepareReference(state) {
  const target = path.join(state.workDir, 'vmaf-reference.mkv');
  const result = await state.manager.runOwned('vmaf-reference', state.commands.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-threads', '1', '-filter_threads', '1', '-i', state.inputPath, '-map', '0:v:0', '-vf', `scale=${state.config.gifSize}:${state.config.gifSize}:flags=lanczos,fps=24,setpts=PTS-STARTPTS`, '-an', '-sn', '-dn', '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuv420p', '-color_range', 'pc', '-f', 'matroska', target], { stderr: 'capture' });
  if (shared.mediaFailed(result)) throw shared.subprocessError('reference_failed', `could not prepare the VMAF reference${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'fix the ffmpeg decode or filter error, then run again', 'vmaf-reference', result);
}

async function prepareSourceCaches(state) {
  const args = ['-v', 'error', '-xerror', '-nostdin', '-threads', '1', '-filter_threads', '1', '-i', state.inputPath];
  for (let fps = state.config.minFps; fps <= state.config.maxFps; fps += 1) {
    const target = path.join(state.workDir, `source-f${fps}.y4m`);
    fs.rmSync(target, { force: true });
    args.push('-map', '0:v:0', '-vf', `fps=${fps},scale=${state.config.gifSize}:${state.config.gifSize}:flags=lanczos,format=yuv444p,setpts=PTS-STARTPTS`, '-an', '-sn', '-dn', '-c:v', 'rawvideo', '-pix_fmt', 'yuv444p', '-f', 'yuv4mpegpipe', '-y', target);
  }
  const result = await state.manager.runOwned('source-caches', state.commands.ffmpeg, args, { stderr: 'capture' });
  if (shared.mediaFailed(result)) throw shared.subprocessError('source_prepare_failed', `could not prepare the source caches${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'fix the reported ffmpeg decode or filter error, then run the same conversion again', 'source-caches', result);
}

async function encodeCandidate(state, fps, candidate, source, target, task) {
  fs.rmSync(target, { force: true });
  const env = { ...process.env, RAYON_NUM_THREADS: String(state.rayonThreads) };
  const result = await state.manager.runOwned(task, state.commands.gifski, ['--quiet', '--fps', String(fps), '--width', String(state.config.gifSize), '--height', String(state.config.gifSize), '--quality', String(candidate.quality), '--motion-quality', String(candidate.motionQuality), '--lossy-quality', String(candidate.lossyQuality), '--repeat', '0', '--output', target, '-'], { stdin: { path: source }, stderr: 'capture', env });
  if (result.code !== 0) throw shared.subprocessError('candidate_encode_failed', `candidate encode failed for ${task}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'fix the reported gifski error, then run the same conversion again', task, result);
  if (!fs.existsSync(target)) throw new shared.RunError('candidate_encode_failed', `gifski reported success but did not create ${task}`, 'repair or reinstall gifski, then run the same conversion again');
}

async function evaluateCandidate(state, { fps, candidate }) {
  const source = path.join(state.workDir, `source-f${fps}.y4m`);
  const stem = `f${fps}-q${candidate.quality}-m${candidate.motionQuality}-l${candidate.lossyQuality}`;
  const target = path.join(state.workDir, `${stem}.gif`);
  await encodeCandidate(state, fps, candidate, source, target, stem);
  const bytes = fs.statSync(target).size;
  let fit = false;
  if (bytes < state.config.maxBytes) {
    const digest = shared.sha256File(target);
    const score = await state.scoreCandidate(target, stem, fps, digest);
    const completed = { ...candidate, fps, bytes, score, path: target, digest };
    const previous = state.bestCandidate;
    state.bestCandidate = selectWinner(previous ? [previous, completed] : [completed]);
    if (!state.config.keepWork && previous && previous !== state.bestCandidate) fs.rmSync(previous.path, { force: true });
    fit = true;
  }
  if (!state.config.keepWork && target !== state.bestCandidate?.path) fs.rmSync(target, { force: true });
  return fit;
}

async function evaluateWave(state, candidates, wave) {
  if (!candidates.length) return [];
  const workers = calculateGifskiWorkers(state.config, candidates.length);
  state.rayonThreads = calculateRayonThreads(state.config, workers);
  if (!state.json) process.stderr.write(`Evaluating ${wave} wave with ${workers} candidate workers and ${state.rayonThreads} gifski threads each...\n`);
  return state.manager.runOldestBounded(candidates, workers, item => evaluateCandidate(state, item));
}

async function convert(state) {
  if (!state.json) process.stderr.write(`Searching ${state.config.minFps}-${state.config.maxFps} FPS, gifski quality ${state.config.minQuality}-${state.config.maxQuality} under ${state.config.maxBytes} bytes at ${state.config.gifSize}x${state.config.gifSize}...\n`);
  await state.manager.runOldestBounded([prepareReference, prepareSourceCaches], state.config.jobs, prepare => prepare(state));
  state.referenceFrames = await shared.referenceFrameCount(state);
  state.scoreCandidate = shared.createCandidateScorer(state);
  const fpsValues = Array.from({ length: state.config.maxFps - state.config.minFps + 1 }, (_, i) => state.config.minFps + i);
  state.bestCandidate = undefined;
  const coarse = candidateSequence(state.config);
  const coarseTasks = fpsValues.flatMap(fps => coarse.map(candidate => ({ fps, candidate })));
  const fits = await evaluateWave(state, coarseTasks, 'coarse');
  const refinement = fpsValues.flatMap((fps, index) => {
    // Results retain submission order, so completion speed cannot choose the anchor.
    const anchor = coarse.find((candidate, offset) => fits[index * coarse.length + offset])?.quality ?? state.config.minQuality;
    return candidateSequence(state.config, anchor).slice(coarse.length).map(candidate => ({ fps, candidate }));
  });
  await evaluateWave(state, refinement, 'refinement');
  if (!state.config.keepWork) for (const fps of fpsValues) fs.rmSync(path.join(state.workDir, `source-f${fps}.y4m`), { force: true });
  const winner = state.bestCandidate;
  if (!winner) throw new shared.RunError('no_candidate', `no candidate fit below ${state.config.maxBytes} bytes`, 'increase MAX_BYTES, reduce GIF_SIZE or the FPS range, or lower MIN_QUALITY');
  const verified = await shared.publishVerified(winner.path, state.output, 'mov-to-gif-gifski', temporary => shared.verifyFinalGif(state.manager, state.commands, temporary, { size: state.config.gifSize, maxBytes: state.config.maxBytes, bytes: winner.bytes, digest: winner.digest, referenceFrames: state.referenceFrames, fps: winner.fps }), temporary => { state.outputTemp = temporary; });
  const payload = shared.resultPayload({ script: state.scriptName, backend: 'gifski', input: state.input, output: state.output, config: state.config, winner, verified });
  return payload;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  return runConverter({
    argv,
    env,
    backend: 'gifski',
    defaultScriptName: 'mov-to-gif-gifski.js',
    workPrefix: 'mov-to-gif-gifski.',
    convert,
  });
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { calculateGifskiWorkers, calculateRayonThreads, candidateSequence, selectWinner };
