#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProcessManager } = require('./process-manager');
const shared = require('./shared');

const DITHER_GRAPH = '[0:v]split=4[source2][source3][source4][source5];[1:v]split=4[palette2][palette3][palette4][palette5];[source2][palette2]paletteuse=dither=bayer:bayer_scale=2:diff_mode=rectangle[dither2];[source3][palette3]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[dither3];[source4][palette4]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[dither4];[source5][palette5]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[dither5]';

function candidateTasks(config) {
  const tasks = [];
  for (let fps = config.minFps; fps <= config.maxFps; fps += 1) for (let colors = 4; colors <= 256; colors += 1) tasks.push({ fps, colors });
  return tasks;
}
function selectWinner(results) {
  return [...results].sort((a, b) => Number(b.score) - Number(a.score) || b.fps - a.fps || b.colors - a.colors || a.dither - b.dither)[0];
}

async function checked(state, task, command, args, options, code, condition, remedy) {
  const result = await state.manager.runOwned(task, command, args, { ...options, stderr: 'capture' });
  if (result.code !== 0) throw new shared.RunError(code, `${condition}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`, remedy);
  return result;
}

async function prepareReference(state) {
  await checked(state, 'vmaf-reference', state.commands.ffmpeg, ['-v', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', '-i', state.input, '-vf', `scale=${state.config.gifSize}:${state.config.gifSize}:flags=lanczos,fps=24`, '-an', '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuv420p', '-color_range', 'pc', '-f', 'matroska', path.join(state.workDir, 'vmaf-reference.mkv')], {}, 'reference_failed', 'could not prepare the VMAF reference', 'fix the reported ffmpeg decode or filter error, then run again');
}

async function prepareScaledSource(state, fps, suffix = '') {
  const target = path.join(state.workDir, `${suffix || 'source'}-f${fps}.nut`);
  await checked(state, `source-f${fps}${suffix}`, state.commands.ffmpeg, ['-v', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', '-i', state.input, '-vf', `fps=${fps},scale=${state.config.gifSize}:${state.config.gifSize}:flags=lanczos,format=bgra`, '-an', '-c:v', 'rawvideo', '-pix_fmt', 'bgra', '-f', 'nut', target], {}, 'source_prepare_failed', `could not prepare the source cache for ${fps} FPS`, 'fix the reported ffmpeg decode or filter error, then run the same conversion again');
  return target;
}

async function generatePalette(state, fps, colors, source, palette, task) {
  await checked(state, `${task}-palette`, state.commands.ffmpeg, ['-v', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', '-i', source, '-vf', `palettegen=max_colors=${colors}:stats_mode=diff`, '-frames:v', '1', '-c:v', 'png', '-f', 'image2', '-update', '1', '-y', palette], {}, 'candidate_encode_failed', `palette generation failed for ${task}`, 'fix the reported ffmpeg error, then run the same conversion again');
}

async function generateFourRaw(state, fps, colors, source, palette, task) {
  const outputs = [2, 3, 4, 5].map(dither => path.join(state.workDir, `raw-f${fps}-c${colors}-d${dither}.gif`));
  const args = ['-v', 'error', '-nostdin', '-threads', '1', '-filter_complex_threads', '1', '-i', source, '-i', palette, '-filter_complex', DITHER_GRAPH];
  for (let index = 0; index < outputs.length; index += 1) args.push('-map', `[dither${index + 2}]`, '-an', '-loop', '0', '-c:v', 'gif', '-f', 'gif', '-y', outputs[index]);
  await checked(state, `${task}-four-dithers`, state.commands.ffmpeg, args, {}, 'candidate_encode_failed', `candidate encode failed for ${task}`, 'fix the reported ffmpeg error, then run the same conversion again');
  return outputs;
}

async function optimize(state, raw, target, task) {
  await checked(state, `${task}-optimize`, state.commands.gifsicle, ['-O3', raw, '-o', target], {}, 'candidate_encode_failed', `gifsicle optimization failed for ${task}`, 'fix the reported gifsicle error, then run the same conversion again');
}

async function evaluateColorTask(state, item) {
  const { fps, colors } = item;
  const task = `candidate-f${fps}-c${colors}`;
  const source = path.join(state.workDir, `source-f${fps}.nut`);
  const palette = path.join(state.workDir, `palette-f${fps}-c${colors}.png`);
  try {
    await generatePalette(state, fps, colors, source, palette, task);
    const raws = await generateFourRaw(state, fps, colors, source, palette, task);
    const results = [];
    for (let dither = 2; dither <= 5; dither += 1) {
      const raw = raws[dither - 2];
      const target = path.join(state.workDir, `f${fps}-c${colors}-d${dither}.gif`);
      await optimize(state, raw, target, `f${fps}-c${colors}-d${dither}`);
      fs.rmSync(raw, { force: true });
      const bytes = fs.statSync(target).size;
      if (bytes < state.config.maxBytes) {
        const score = await shared.scoreCandidate(state.manager, state.commands, state.workDir, target, `f${fps}-c${colors}-d${dither}`);
        results.push({ fps, colors, dither, bytes, score });
      }
      if (!state.config.keepWork) fs.rmSync(target, { force: true });
    }
    if (!state.config.keepWork) fs.rmSync(palette, { force: true });
    return results;
  } catch (error) {
    throw new shared.RunError('worker_failed', `worker failed: ${task}: ${error.condition || error.message}`, error.remedy || 'run the conversion again and inspect the reported worker failure');
  }
}

async function regenerateWinner(state, winner) {
  const source = await prepareScaledSource(state, winner.fps, 'winner-source');
  const palette = path.join(state.workDir, `winner-palette-f${winner.fps}-c${winner.colors}.png`);
  const raw = path.join(state.workDir, `winner-raw-f${winner.fps}-c${winner.colors}-d${winner.dither}.gif`);
  const target = path.join(state.workDir, 'winner-regenerated.gif');
  await generatePalette(state, winner.fps, winner.colors, source, palette, 'winner');
  await checked(state, 'winner-gif', state.commands.ffmpeg, ['-v', 'error', '-nostdin', '-threads', '1', '-filter_complex_threads', '1', '-i', source, '-i', palette, '-filter_complex', `[0:v][1:v]paletteuse=dither=bayer:bayer_scale=${winner.dither}:diff_mode=rectangle`, '-an', '-loop', '0', '-c:v', 'gif', '-f', 'gif', '-y', raw], {}, 'regeneration_failed', 'winner GIF regeneration failed', 'fix the reported ffmpeg error, then run the same conversion again');
  await checked(state, 'winner-optimize', state.commands.gifsicle, ['-O3', raw, '-o', target], {}, 'regeneration_failed', 'winner optimization failed', 'fix the reported gifsicle error, then run the same conversion again');
  const bytes = fs.statSync(target).size;
  if (bytes !== winner.bytes) throw new shared.RunError('regeneration_mismatch', `winner regeneration size mismatch: recorded ${winner.bytes}, regenerated ${bytes}`, 'run the same conversion again and inspect encoder determinism');
  const score = await shared.scoreCandidate(state.manager, state.commands, state.workDir, target, 'winner-regenerated');
  if (score !== winner.score) throw new shared.RunError('regeneration_mismatch', `winner regeneration VMAF mismatch: recorded ${winner.score}, regenerated ${score}`, 'run the same conversion again and inspect encoder determinism');
  return target;
}

async function convert(state) {
  if (!state.json) process.stderr.write(`Searching ${state.config.minFps}-${state.config.maxFps} FPS, 4-256 colors, dithers 2-5 under ${state.config.maxBytes} bytes at ${state.config.gifSize}x${state.config.gifSize} with ${state.config.jobs} workers...\n`);
  const preparation = [{ kind: 'reference' }, ...Array.from({ length: state.config.maxFps - state.config.minFps + 1 }, (_, index) => ({ kind: 'source', fps: state.config.minFps + index }))];
  await state.manager.runOldestBounded(preparation, state.config.jobs, item => item.kind === 'reference' ? prepareReference(state) : prepareScaledSource(state, item.fps));
  const groups = await state.manager.runOldestBounded(candidateTasks(state.config), state.config.jobs, item => evaluateColorTask(state, item));
  const winner = selectWinner(groups.flat());
  if (!winner) throw new shared.RunError('no_candidate', `no candidate fit below ${state.config.maxBytes} bytes`, 'increase MAX_BYTES, reduce GIF_SIZE, or reduce the FPS range');
  const regenerated = await regenerateWinner(state, winner);
  const verified = await shared.publishVerified(regenerated, state.output, 'mov-to-gif', temporary => shared.verifyFinalGif(state.manager, state.commands, temporary, { size: state.config.gifSize, maxBytes: state.config.maxBytes, bytes: winner.bytes, score: winner.score, workDir: state.workDir }), temporary => { state.outputTemp = temporary; });
  shared.emitResult(`${winner.fps} FPS, ${winner.colors} colors, dither ${winner.dither}, VMAF ${winner.score}`, state.output, verified);
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let parsed = { json: argv.includes('--json') };
  let state;
  try {
    shared.validateNodeVersion();
    parsed = shared.parseArguments(argv, path.basename(process.argv[1] || 'mov-to-gif.js'));
    if (parsed.help) { process.stdout.write(shared.usage('gifsicle', path.basename(process.argv[1]))); return 0; }
    const config = shared.readConfiguration(env, 'gifsicle');
    if (parsed.positional[0]) shared.validateInput(parsed.positional[0]);
    const manager = new ProcessManager();
    const preflight = await shared.checkGifsiclePreflight(manager, process.platform, env);
    const preflightFailure = shared.preflightError(preflight);
    if (preflightFailure) throw preflightFailure;
    let warnings = [];
    if (parsed.positional[0]) warnings = await shared.inspectInput(manager, preflight.commands, parsed.positional[0]);
    if (parsed.preflight) { shared.emitPreflightReady(preflight, warnings, parsed.json); return 0; }
    const outputState = shared.validateOutput(parsed.positional[0], parsed.positional[1], config.gifSize);
    shared.emitWarnings(warnings, parsed.json);
    let workDir;
    try { workDir = fs.mkdtempSync(path.join(env.TMPDIR || os.tmpdir(), 'mov-to-gif.')); } catch { throw new shared.StartupError('work_directory_unusable', `could not create a work directory under ${env.TMPDIR || os.tmpdir()}`, 'set TMPDIR to a writable local directory and try again'); }
    state = { ...outputState, input: parsed.positional[0], config, manager, commands: preflight.commands, workDir, outputTemp: '', json: parsed.json };
    const uninstall = manager.installSignalHandlers((_signal, exitCode) => { shared.cleanupArtifacts(state); process.exit(exitCode); });
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
module.exports = { DITHER_GRAPH, candidateTasks, selectWinner, prepareReference, prepareScaledSource, evaluateColorTask, regenerateWinner, main };
