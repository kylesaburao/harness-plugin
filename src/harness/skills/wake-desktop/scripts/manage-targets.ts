#!/usr/bin/env node
'use strict';
import { StartupError, checkNodeVersion, reportError, configPath, configError,
  validateName, validateTarget, validateRegistry, loadConfig, selectTarget, saveConfig, errorDetails } from './target-config.js';
import type { WakeRegistry } from './target-config.js';

type CommandName = 'register' | 'update' | 'rename' | 'remove' | 'list';
interface CommonOptions { help?: true; json?: true; preflight?: true }
interface RawOptions extends CommonOptions { name?: string; ip?: string; mac?: string; 'new-name'?: string; replace?: true }
type RawCommand = RawOptions & { command: CommandName | undefined };
export type ManageTargetCommand = CommonOptions & (
  | { command: 'register'; name: string; ip: string; mac: string; replace?: true }
  | ({ command: 'update'; name: string } & ({ ip: string; mac?: string } | { ip?: string; mac: string }))
  | { command: 'rename'; name: string; 'new-name': string }
  | { command: 'remove'; name: string }
  | { command: 'list'; name?: never }
);
type HelpCommand = RawCommand & { help: true };
export type TargetOperationResult = { configPath: string } & (
  | { status: 'listed'; targets: Array<{ name: string; ip: string; mac: string }>; changed?: never }
  | { status: 'registered' | 'updated'; changed: boolean; name: string; target: { ip: string; mac: string } }
  | { status: 'renamed'; changed: boolean; name: string; newName: string }
  | { status: 'removed'; changed: true; name: string }
);
type TargetReport = TargetOperationResult | { status: 'ready'; configPath: string; operation: CommandName };

const COMMANDS: Record<CommandName, readonly string[]> = {
  register: ['name', 'ip', 'mac', 'replace'],
  update: ['name', 'ip', 'mac'],
  rename: ['name', 'new-name'],
  remove: ['name'],
  list: [],
};
const USAGE = `Usage: manage-targets.js COMMAND [OPTIONS]

Commands:
  register --name NAME --ip HOST --mac MAC [--replace]
  update   --name NAME [--ip HOST] [--mac MAC] (at least one address)
  rename   --name NAME --new-name NAME
  remove   --name NAME
  list

Every command accepts --help, --json, and --preflight.
Value options also accept --flag=value. Names are exact and case-sensitive.
Registering identical addresses, unchanged updates, and same-name renames are no-ops.
--replace permits registration to replace existing addresses, preserving other properties.
Preflight validates without writing or networking, but cannot promise write access.
Configuration: ${configPath()}
Exit status: 0 success, 2 validation/read failure, 1 persistence failure.`;

function usage(condition: string): never {
  throw new StartupError('usage_error', condition, 'run manage-targets.js --help');
}
function parseArguments(argv: string[]): ManageTargetCommand | HelpCommand {
  const options: RawOptions = {};
  let command: CommandName | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i]!;
    if (argument === '--help' || argument === '--json' || argument === '--preflight') {
      if (argument === '--help') options.help = true;
      else if (argument === '--json') options.json = true;
      else options.preflight = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      if (command !== undefined || !isCommandName(argument)) usage(`unknown command or argument: ${argument}`);
      command = argument;
      continue;
    }
    const equals = argument.indexOf('=');
    const key = argument.slice(2, equals < 0 ? undefined : equals);
    if (key === 'replace' && equals < 0) { options.replace = true; continue; }
    if (key !== 'name' && key !== 'new-name' && key !== 'ip' && key !== 'mac') usage(`unknown option: ${argument}`);
    if (Object.hasOwn(options, key)) usage(`duplicate option: --${key}`);
    const value = equals < 0 ? argv[++i] : argument.slice(equals + 1);
    if (value === undefined || (equals < 0 && value.startsWith('-'))) usage(`--${key} requires a value`);
    options[key] = value;
  }
  if (options.help) return { command, ...options, help: true };
  const parsed = { command, ...options };
  validateCommand(parsed);
  return parsed;
}

function isCommandName(value: string): value is CommandName { return Object.hasOwn(COMMANDS, value); }

// These are the existing parser checks. Their postcondition describes only
// the command-specific fields established here, before saved state is read.
function validateCommand(options: RawCommand): asserts options is ManageTargetCommand {
  const { command } = options;
  if (!command) usage('a command is required');
  for (const key of Object.keys(options)) {
    if (!['command', 'json', 'preflight'].includes(key) && !COMMANDS[command].includes(key)) usage(`--${key} is not accepted by ${command}`);
  }
  const required: Array<'name' | 'ip' | 'mac' | 'new-name'> = command === 'register' ? ['name', 'ip', 'mac']
    : command === 'rename' ? ['name', 'new-name'] : command === 'list' ? [] : ['name'];
  for (const key of required) if (!Object.hasOwn(options, key)) usage(`${command} requires --${key}`);
  if (command === 'update' && !Object.hasOwn(options, 'ip') && !Object.hasOwn(options, 'mac')) usage('update requires --ip or --mac');
  for (const key of ['name', 'new-name'] as const) if (Object.hasOwn(options, key)) validateName(options[key]);
  // Validate supplied addresses before checking runtime or reading saved state.
  if (Object.hasOwn(options, 'ip') || Object.hasOwn(options, 'mac')) {
    validateTarget(options.name, { ip: 'desktop.local', mac: '00:00:00:00:00:01',
      ...(Object.hasOwn(options, 'ip') ? { ip: options.ip } : {}),
      ...(Object.hasOwn(options, 'mac') ? { mac: options.mac } : {}) });
  }
}

function applyOperation(config: WakeRegistry, options: ManageTargetCommand): TargetOperationResult {
  const { command, name } = options;
  const targets = config.targets;
  const result = { configPath: configPath() };
  if (command === 'list') return { status: 'listed', ...result,
    targets: Object.keys(targets).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
      .map(name => ({ name, ip: targets[name]!.ip, mac: targets[name]!.mac })) };
  const exists = Object.hasOwn(targets, name);
  const old = command === 'register' ? (exists ? targets[name] : undefined) : selectTarget(config, name);
  let changed;
  if (command === 'register' || command === 'update') {
    const target = { ...old,
      ...(Object.hasOwn(options, 'ip') ? { ip: options.ip } : {}),
      ...(Object.hasOwn(options, 'mac') ? { mac: options.mac } : {}) };
    validateTarget(name, target);
    changed = !old || old.ip !== target.ip || old.mac !== target.mac;
    if (command === 'register' && exists && changed && !options.replace) {
      throw configError('target_exists', `target ${JSON.stringify(name)} already has different addresses`,
        `repeat registration for ${JSON.stringify(name)} with --replace only when replacement is authorized`);
    }
    // Define an own property even for names such as __proto__.
    Object.defineProperty(targets, name, { value: target, enumerable: true, writable: true, configurable: true });
    return { status: command === 'register' ? 'registered' : 'updated', ...result, changed, name,
      target: { ip: target.ip, mac: target.mac } };
  }
  if (command === 'rename') {
    const newName = options['new-name'];
    changed = name !== newName;
    if (changed) {
      if (Object.hasOwn(targets, newName)) throw configError('target_exists', `rename destination ${JSON.stringify(newName)} already exists (source ${JSON.stringify(name)})`,
        'choose an unoccupied --new-name');
      Object.defineProperty(targets, newName, { value: old, enumerable: true, writable: true, configurable: true });
      delete targets[name];
    }
    return { status: 'renamed', ...result, changed, name, newName };
  }
  delete targets[name];
  return { status: 'removed', ...result, changed: true, name };
}

function report(json: boolean, result: TargetReport) {
  if (json) { process.stdout.write(`${JSON.stringify(result)}\n`); return; }
  const facts = Object.entries(result).filter(([key]) => key !== 'status')
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  process.stdout.write(`${result.status.toUpperCase()}\n${facts}\n`);
}
function isHelp(options: ManageTargetCommand | HelpCommand): options is HelpCommand { return options.help === true; }

function main(argv: string[]) {
  const json = argv.includes('--json');
  try {
    const options = parseArguments(argv);
    if (isHelp(options)) { process.stdout.write(`${USAGE}\n`); return 0; }
    checkNodeVersion();
    const config = loadConfig();
    const result = applyOperation(config, options);
    validateRegistry(config);
    if (options.preflight) report(json, { status: 'ready', configPath: configPath(), operation: options.command });
    else {
      if (result.changed) saveConfig(config);
      report(json, result);
    }
    return 0;
  } catch (error) {
    reportError(json, error);
    return errorDetails(error).code === 'target_config_write_failed' ? 1 : 2;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
export { parseArguments, applyOperation };
