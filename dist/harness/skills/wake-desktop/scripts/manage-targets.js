#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArguments = parseArguments;
exports.applyOperation = applyOperation;
const target_config_js_1 = require("./target-config.js");
const COMMANDS = {
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
Configuration: ${(0, target_config_js_1.configPath)()}
Exit status: 0 success, 2 validation/read failure, 1 persistence failure.`;
function usage(condition) {
    throw new target_config_js_1.StartupError('usage_error', condition, 'run manage-targets.js --help');
}
function parseArguments(argv) {
    const options = {};
    let command;
    for (let i = 0; i < argv.length; i += 1) {
        const argument = argv[i];
        if (argument === '--help' || argument === '--json' || argument === '--preflight') {
            if (argument === '--help')
                options.help = true;
            else if (argument === '--json')
                options.json = true;
            else
                options.preflight = true;
            continue;
        }
        if (!argument.startsWith('--')) {
            if (command !== undefined || !isCommandName(argument))
                usage(`unknown command or argument: ${argument}`);
            command = argument;
            continue;
        }
        const equals = argument.indexOf('=');
        const key = argument.slice(2, equals < 0 ? undefined : equals);
        if (key === 'replace' && equals < 0) {
            options.replace = true;
            continue;
        }
        if (key !== 'name' && key !== 'new-name' && key !== 'ip' && key !== 'mac')
            usage(`unknown option: ${argument}`);
        if (Object.hasOwn(options, key))
            usage(`duplicate option: --${key}`);
        const value = equals < 0 ? argv[++i] : argument.slice(equals + 1);
        if (value === undefined || (equals < 0 && value.startsWith('-')))
            usage(`--${key} requires a value`);
        options[key] = value;
    }
    if (options.help)
        return { command, ...options, help: true };
    const parsed = { command, ...options };
    validateCommand(parsed);
    return parsed;
}
function isCommandName(value) { return Object.hasOwn(COMMANDS, value); }
// These are the existing parser checks. Their postcondition describes only
// the command-specific fields established here, before saved state is read.
function validateCommand(options) {
    const { command } = options;
    if (!command)
        usage('a command is required');
    for (const key of Object.keys(options)) {
        if (!['command', 'json', 'preflight'].includes(key) && !COMMANDS[command].includes(key))
            usage(`--${key} is not accepted by ${command}`);
    }
    const required = command === 'register' ? ['name', 'ip', 'mac']
        : command === 'rename' ? ['name', 'new-name'] : command === 'list' ? [] : ['name'];
    for (const key of required)
        if (!Object.hasOwn(options, key))
            usage(`${command} requires --${key}`);
    if (command === 'update' && !Object.hasOwn(options, 'ip') && !Object.hasOwn(options, 'mac'))
        usage('update requires --ip or --mac');
    for (const key of ['name', 'new-name'])
        if (Object.hasOwn(options, key))
            (0, target_config_js_1.validateName)(options[key]);
    // Validate supplied addresses before checking runtime or reading saved state.
    if (Object.hasOwn(options, 'ip') || Object.hasOwn(options, 'mac')) {
        (0, target_config_js_1.validateTarget)(options.name, { ip: 'desktop.local', mac: '00:00:00:00:00:01',
            ...(Object.hasOwn(options, 'ip') ? { ip: options.ip } : {}),
            ...(Object.hasOwn(options, 'mac') ? { mac: options.mac } : {}) });
    }
}
function applyOperation(config, options) {
    const { command, name } = options;
    const targets = config.targets;
    const result = { configPath: (0, target_config_js_1.configPath)() };
    if (command === 'list')
        return { status: 'listed', ...result,
            targets: Object.keys(targets).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
                .map(name => ({ name, ip: targets[name].ip, mac: targets[name].mac })) };
    const exists = Object.hasOwn(targets, name);
    const old = command === 'register' ? (exists ? targets[name] : undefined) : (0, target_config_js_1.selectTarget)(config, name);
    let changed;
    if (command === 'register' || command === 'update') {
        const target = { ...old,
            ...(Object.hasOwn(options, 'ip') ? { ip: options.ip } : {}),
            ...(Object.hasOwn(options, 'mac') ? { mac: options.mac } : {}) };
        (0, target_config_js_1.validateTarget)(name, target);
        changed = !old || old.ip !== target.ip || old.mac !== target.mac;
        if (command === 'register' && exists && changed && !options.replace) {
            throw (0, target_config_js_1.configError)('target_exists', `target ${JSON.stringify(name)} already has different addresses`, `repeat registration for ${JSON.stringify(name)} with --replace only when replacement is authorized`);
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
            if (Object.hasOwn(targets, newName))
                throw (0, target_config_js_1.configError)('target_exists', `rename destination ${JSON.stringify(newName)} already exists (source ${JSON.stringify(name)})`, 'choose an unoccupied --new-name');
            Object.defineProperty(targets, newName, { value: old, enumerable: true, writable: true, configurable: true });
            delete targets[name];
        }
        return { status: 'renamed', ...result, changed, name, newName };
    }
    delete targets[name];
    return { status: 'removed', ...result, changed: true, name };
}
function report(json, result) {
    if (json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    const facts = Object.entries(result).filter(([key]) => key !== 'status')
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
    process.stdout.write(`${result.status.toUpperCase()}\n${facts}\n`);
}
function isHelp(options) { return options.help === true; }
function main(argv) {
    const json = argv.includes('--json');
    try {
        const options = parseArguments(argv);
        if (isHelp(options)) {
            process.stdout.write(`${USAGE}\n`);
            return 0;
        }
        (0, target_config_js_1.checkNodeVersion)();
        const release = options.preflight || options.command === 'list' ? undefined : (0, target_config_js_1.acquireConfigLock)();
        let saved = false;
        let failure;
        let result;
        try {
            const config = (0, target_config_js_1.loadConfig)();
            result = applyOperation(config, options);
            (0, target_config_js_1.validateRegistry)(config);
            if (!options.preflight && result.changed) {
                (0, target_config_js_1.saveConfig)(config);
                saved = true;
            }
        }
        catch (error) {
            failure = error;
            throw error;
        }
        finally {
            release?.(saved, failure);
        }
        if (options.preflight)
            report(json, { status: 'ready', configPath: (0, target_config_js_1.configPath)(), operation: options.command });
        else
            report(json, result);
        return 0;
    }
    catch (error) {
        (0, target_config_js_1.reportError)(json, error);
        return ['target_config_write_failed', 'target_config_lock_cleanup_failed'].includes((0, target_config_js_1.errorDetails)(error).code || '') ? 1 : 2;
    }
}
if (require.main === module)
    process.exitCode = main(process.argv.slice(2));
