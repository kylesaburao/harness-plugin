'use strict';

import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { ProcessManager } from './process-manager.js';
import shared = require('./shared.js');
import type { GifBackend, ToolchainPreflight } from './preflight.js';
import type { CleanupFailure } from './errors.js';
interface ConverterOptions<B extends GifBackend> { argv: string[]; env: NodeJS.ProcessEnv; backend: B; defaultScriptName: string; workPrefix: string; convert: (state: shared.ConverterState<B>) => Promise<shared.GifResult> }

async function runConverter<B extends GifBackend>({
  argv,
  env,
  backend,
  defaultScriptName,
  workPrefix,
  convert,
}: ConverterOptions<B>) {
  let parsed: { json: boolean; help?: boolean; positional?: string[]; preflight?: boolean } = { json: argv.includes('--json') };
  let state: shared.ConverterState<B> | undefined;
  let manager: ProcessManager | undefined;
  let uninstall: (() => void) | undefined;
  let ready: { preflight: ToolchainPreflight; warnings: shared.GifWarning[] } | undefined;
  let payload: shared.GifResult | undefined;
  let failure: unknown;
  let cleanupFailures: CleanupFailure[] = [];
  try {
    const scriptName = path.basename(process.argv[1] || defaultScriptName);
    const argumentsParsed = shared.parseArguments(argv, scriptName);
    parsed = argumentsParsed;
    shared.validateNodeVersion();
    if (parsed.help) {
      process.stdout.write(shared.usage(backend, scriptName));
      return 0;
    }
    const config = shared.readConfiguration(env, backend);
    if (argumentsParsed.positional[0]) shared.validateInput(argumentsParsed.positional[0]);
    manager = new ProcessManager();
    uninstall = manager.installSignalHandlers(() => {});
    const preflight = backend === 'gifski'
      ? await shared.checkGifskiPreflight(manager, process.platform, env)
      : await shared.checkGifsiclePreflight(manager, process.platform, env);
    const preflightFailure = shared.preflightError(preflight);
    if (preflightFailure) throw preflightFailure;
    const commands = shared.requireReadyCommands(preflight, backend);
    let warnings: shared.GifWarning[] = [];
    if (argumentsParsed.positional[0]) warnings = await shared.inspectInput(manager, commands, argumentsParsed.positional[0]);
    if (argumentsParsed.preflight) {
      ready = { preflight, warnings };
    } else {
      const outputState = shared.validateOutput(argumentsParsed.positional[0]!, argumentsParsed.positional[1], config.gifSize);
      shared.emitWarnings(warnings, parsed.json);
      let workDir;
      try {
        workDir = fs.mkdtempSync(path.join(path.resolve(env.TMPDIR || os.tmpdir()), workPrefix));
      } catch {
        throw new shared.StartupError('work_directory_unusable', `could not create a work directory under ${env.TMPDIR || os.tmpdir()}`, 'set TMPDIR to a writable local directory and try again');
      }
      state = { ...outputState, input: argumentsParsed.positional[0]!, inputPath: path.resolve(argumentsParsed.positional[0]!), config, manager, commands, workDir, outputTemp: '', json: parsed.json, scriptName };

      payload = await convert(state);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (manager && (failure || manager.cancelling)) await manager.cancel(manager.cancelSignal || 'SIGTERM');
    } catch (error) {
      failure ||= error;
    } finally {
      try {
        if (state) cleanupFailures = shared.cleanupArtifacts(state);
      } catch (error) {
        failure ||= error;
      } finally {
        if (uninstall) uninstall();
      }
    }
  }
  const interruptionSignal = manager?.interruptionSignal;
  const signalExit = interruptionSignal && { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[interruptionSignal];
  if (signalExit) {
    if (cleanupFailures.length) shared.emitError(new shared.RunError('interrupted', `interrupted by ${interruptionSignal}`, 'remove the reported temporary paths', { cleanupFailures }), parsed.json);
    return signalExit;
  }
  if (failure) {
    if (cleanupFailures.length && failure !== null && typeof failure === 'object') Object.assign(failure, { cleanupFailures });
    shared.emitError(failure, parsed.json || Boolean(shared.fieldsOf(failure).json));
    const exitCode = shared.fieldsOf(failure).exitCode;
    return typeof exitCode === 'number' && exitCode ? exitCode : 1;
  }
  if (ready) shared.emitPreflightReady(ready.preflight, ready.warnings, parsed.json);
  else {
    if (cleanupFailures.length) payload!.cleanupFailures = cleanupFailures;
    shared.emitResult(payload!, parsed.json);
  }
  return cleanupFailures.length ? 1 : 0;
}

export { runConverter };
