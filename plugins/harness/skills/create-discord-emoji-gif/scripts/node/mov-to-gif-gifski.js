#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProcessManager } = require('./process-manager');
const shared = require('./shared');

function calculateGifskiWorkers(config) {
  return Math.min(config.maxFps - config.minFps + 1, Math.max(1, Math.floor(config.jobs / 2)));
}
function calculateRayonThreads(config, workers = calculateGifskiWorkers(config)) {
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
  const result = await state.manager.runOwned('vmaf-reference', state.commands.ffmpeg, ['-v', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', '-i', state.input, '-map', '0:v:0', '-vf', `scale=${state.config.gifSize}:${state.config.gifSize}:flags=lanczos,fps=24,setpts=PTS-STARTPTS`, '-an', '-sn', '-dn', '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuv420p', '-color_range', 'pc', '-f', 'matroska', target], { stderr: 'capture' });
  if (result.code !== 0) throw new shared.RunError('reference_failed', `could not prepare the VMAF reference${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, 'fix the ffmpeg decode or filter error, then run again');
}

async function prepareSourceCache(state, fps, suffix = '', failure = {}) {
  const target = path.join(state.workDir, `${suffix || 'source'}-f${fps}.y4m`);
  fs.rmSync(target, { force: true });
  const result = await state.manager.runOwned(`source-f${fps}${suffix}`, state.commands.ffmpeg, ['-v', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', '-i', state.input, '-map', '0:v:0', '-vf', `fps=${fps},scale=${state.config.gifSize}:${state.config.gifSize}:flags=lanczos,format=yuv444p,setpts=PTS-STARTPTS`, '-an', '-sn', '-dn', '-c:v', 'rawvideo', '-pix_fmt', 'yuv444p', '-f', 'yuv4mpegpipe', '-y', target], { stderr: 'capture' });
  if (result.code !== 0) throw new shared.RunError(failure.code || 'source_prepare_failed', `${failure.condition || `could not prepare the source cache for ${fps} FPS`}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, failure.remedy || 'fix the reported ffmpeg decode or filter error, then run the same conversion again');
  return target;
}

async function encodeCandidate(state, fps, candidate, source, target, task, failure = {}) {
  fs.rmSync(target, { force: true });
  const env = { ...process.env, RAYON_NUM_THREADS: String(state.rayonThreads) };
  const result = await state.manager.runOwned(task, state.commands.gifski, ['--quiet', '--fps', String(fps), '--width', String(state.config.gifSize), '--height', String(state.config.gifSize), '--quality', String(candidate.quality), '--motion-quality', String(candidate.motionQuality), '--lossy-quality', String(candidate.lossyQuality), '--repeat', '0', '--output', target, '-'], { stdin: { path: source }, stderr: 'capture', env });
  if (result.code !== 0) throw new shared.RunError(failure.code || 'candidate_encode_failed', `${failure.condition || `candidate encode failed for ${task}`}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, failure.remedy || 'fix the reported gifski error, then run the same conversion again');
  if (!fs.existsSync(target)) throw new shared.RunError(failure.code || 'candidate_encode_failed', failure.missingCondition || `gifski reported success but did not create ${task}`, failure.missingRemedy || 'repair or reinstall gifski, then run the same conversion again');
}

async function searchFps(state, fps) {
  const source = await prepareSourceCache(state, fps);
  const results = [];
  const seen = new Set();
  let anchor;
  const evaluate = async candidate => {
    const identity = `${candidate.quality}|${candidate.motionQuality}|${candidate.lossyQuality}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    const stem = `f${fps}-q${candidate.quality}-m${candidate.motionQuality}-l${candidate.lossyQuality}`;
    const target = path.join(state.workDir, `${stem}.gif`);
    await encodeCandidate(state, fps, candidate, source, target, stem);
    const bytes = fs.statSync(target).size;
    let fit = false;
    if (bytes < state.config.maxBytes) {
      const score = await shared.scoreCandidate(state.manager, state.commands, state.workDir, target, stem);
      results.push({ ...candidate, fps, bytes, score, digest: shared.sha256File(target) });
      fit = true;
    }
    if (!state.config.keepWork) fs.rmSync(target, { force: true });
    return fit;
  };
  const coarse = candidateSequence(state.config);
  for (const candidate of coarse) if (await evaluate(candidate) && anchor === undefined) anchor = candidate.quality;
  anchor ??= state.config.minQuality;
  for (const candidate of candidateSequence(state.config, anchor).slice(coarse.length)) await evaluate(candidate);
  if (!state.config.keepWork) fs.rmSync(source, { force: true });
  return results;
}

async function regenerateWinner(state, winner) {
  const source = await prepareSourceCache(state, winner.fps, 'winner-source', {
    code: 'regeneration_failed',
    condition: 'winner source preparation failed',
    remedy: 'fix the reported ffmpeg decode or filter error, then run the same conversion again',
  });
  const target = path.join(state.workDir, 'winner-regenerated.gif');
  await encodeCandidate(state, winner.fps, winner, source, target, 'winner-regenerated', {
    code: 'regeneration_failed',
    condition: 'winner regeneration failed',
    remedy: 'fix the reported gifski error, then run the same conversion again',
    missingCondition: 'gifski reported success but did not create the regenerated winner',
    missingRemedy: 'repair or reinstall gifski, then run the same conversion again',
  });
  const digest = shared.sha256File(target);
  if (digest !== winner.digest) throw new shared.RunError('regeneration_mismatch', `winner regeneration digest mismatch: recorded ${winner.digest}, regenerated ${digest}`, 'reinstall the reviewed gifski version or inspect source-cache determinism before retrying');
  return target;
}

async function convert(state) {
  if (!state.json) process.stderr.write(`Searching ${state.config.minFps}-${state.config.maxFps} FPS, gifski quality ${state.config.minQuality}-${state.config.maxQuality} under ${state.config.maxBytes} bytes at ${state.config.gifSize}x${state.config.gifSize} with ${state.workers} encoder workers and ${state.rayonThreads} gifski threads each...\n`);
  await prepareReference(state);
  const fpsValues = Array.from({ length: state.config.maxFps - state.config.minFps + 1 }, (_, i) => state.config.minFps + i);
  const groups = await state.manager.runOldestBounded(fpsValues, state.workers, fps => searchFps(state, fps));
  const winner = selectWinner(groups.flat());
  if (!winner) throw new shared.RunError('no_candidate', `no candidate fit below ${state.config.maxBytes} bytes`, 'increase MAX_BYTES, reduce GIF_SIZE or the FPS range, or lower MIN_QUALITY');
  const regenerated = await regenerateWinner(state, winner);
  const verified = await shared.publishVerified(regenerated, state.output, 'mov-to-gif-gifski', temporary => shared.verifyFinalGif(state.manager, state.commands, temporary, { size: state.config.gifSize, maxBytes: state.config.maxBytes, digest: winner.digest }), temporary => { state.outputTemp = temporary; });
  shared.emitResult(`${winner.fps} FPS, quality ${winner.quality}, motion quality ${winner.motionQuality}, lossy quality ${winner.lossyQuality}, VMAF ${winner.score}`, state.output, verified);
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let parsed = { json: argv.includes('--json') };
  let state;
  try {
    shared.validateNodeVersion();
    parsed = shared.parseArguments(argv, path.basename(process.argv[1] || 'mov-to-gif-gifski.js'));
    if (parsed.help) { process.stdout.write(shared.usage('gifski', path.basename(process.argv[1]))); return 0; }
    const config = shared.readConfiguration(env, 'gifski');
    if (parsed.positional[0]) shared.validateInput(parsed.positional[0]);
    const manager = new ProcessManager();
    const preflight = await shared.checkGifskiPreflight(manager, process.platform, env);
    const preflightFailure = shared.preflightError(preflight);
    if (preflightFailure) throw preflightFailure;
    let warnings = [];
    if (parsed.positional[0]) warnings = await shared.inspectInput(manager, preflight.commands, parsed.positional[0]);
    if (parsed.preflight) { shared.emitPreflightReady(preflight, warnings, parsed.json); return 0; }
    const outputState = shared.validateOutput(parsed.positional[0], parsed.positional[1], config.gifSize);
    shared.emitWarnings(warnings, parsed.json);
    let workDir;
    try { workDir = fs.mkdtempSync(path.join(env.TMPDIR || os.tmpdir(), 'mov-to-gif-gifski.')); } catch { throw new shared.StartupError('work_directory_unusable', `could not create a work directory under ${env.TMPDIR || os.tmpdir()}`, 'set TMPDIR to a writable local directory and try again'); }
    state = { ...outputState, input: parsed.positional[0], config, manager, commands: preflight.commands, workDir, outputTemp: '', json: parsed.json };
    state.workers = calculateGifskiWorkers(config);
    state.rayonThreads = calculateRayonThreads(config, state.workers);
    const uninstall = manager.installSignalHandlers((_signal, exitCode) => {
      shared.cleanupArtifacts(state);
      process.exit(exitCode);
    });
    try { await convert(state); } finally { uninstall(); }
    shared.cleanupArtifacts(state);
    return 0;
  } catch (error) {
    if (state) {
      try { await state.manager.cancel('SIGTERM'); } catch {}
      shared.cleanupArtifacts(state);
    }
    shared.emitError(error, parsed.json || error.json);
    return error.exitCode || 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { calculateGifskiWorkers, calculateRayonThreads, candidateSequence, selectWinner, prepareReference, prepareSourceCache, encodeCandidate, regenerateWinner, main };
