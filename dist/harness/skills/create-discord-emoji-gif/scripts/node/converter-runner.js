'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProcessManager } = require('./process-manager');
const shared = require('./shared');

async function runConverter({
  argv,
  env,
  backend,
  defaultScriptName,
  workPrefix,
  convert,
}) {
  let parsed = { json: argv.includes('--json') };
  let state;
  let manager;
  let uninstall;
  let ready;
  let payload;
  let failure;
  let cleanupFailures = [];
  try {
    const scriptName = path.basename(process.argv[1] || defaultScriptName);
    parsed = shared.parseArguments(argv, scriptName);
    shared.validateNodeVersion();
    if (parsed.help) {
      process.stdout.write(shared.usage(backend, scriptName));
      return 0;
    }
    const config = shared.readConfiguration(env, backend);
    if (parsed.positional[0]) shared.validateInput(parsed.positional[0]);
    manager = new ProcessManager();
    uninstall = manager.installSignalHandlers(() => {});
    const preflight = backend === 'gifski'
      ? await shared.checkGifskiPreflight(manager, process.platform, env)
      : await shared.checkGifsiclePreflight(manager, process.platform, env);
    const preflightFailure = shared.preflightError(preflight);
    if (preflightFailure) throw preflightFailure;
    let warnings = [];
    if (parsed.positional[0]) warnings = await shared.inspectInput(manager, preflight.commands, parsed.positional[0]);
    if (parsed.preflight) {
      ready = { preflight, warnings };
    } else {
      const outputState = shared.validateOutput(parsed.positional[0], parsed.positional[1], config.gifSize);
      shared.emitWarnings(warnings, parsed.json);
      let workDir;
      try {
        workDir = fs.mkdtempSync(path.join(path.resolve(env.TMPDIR || os.tmpdir()), workPrefix));
      } catch {
        throw new shared.StartupError('work_directory_unusable', `could not create a work directory under ${env.TMPDIR || os.tmpdir()}`, 'set TMPDIR to a writable local directory and try again');
      }
      state = { ...outputState, input: parsed.positional[0], inputPath: path.resolve(parsed.positional[0]), config, manager, commands: preflight.commands, workDir, outputTemp: '', json: parsed.json, scriptName };

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
  const signalExit = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[manager?.interruptionSignal];
  if (signalExit) {
    if (cleanupFailures.length) shared.emitError(new shared.RunError('interrupted', `interrupted by ${manager.interruptionSignal}`, 'remove the reported temporary paths', { cleanupFailures }), parsed.json);
    return signalExit;
  }
  if (failure) {
    if (cleanupFailures.length) failure.cleanupFailures = cleanupFailures;
    shared.emitError(failure, parsed.json || failure.json);
    return failure.exitCode || 1;
  }
  if (ready) shared.emitPreflightReady(ready.preflight, ready.warnings, parsed.json);
  else {
    if (cleanupFailures.length) payload.cleanupFailures = cleanupFailures;
    shared.emitResult(payload, parsed.json);
  }
  return cleanupFailures.length ? 1 : 0;
}

module.exports = { runConverter };
