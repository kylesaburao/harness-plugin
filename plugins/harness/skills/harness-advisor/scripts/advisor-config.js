#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FAMILIES = ['luna', 'terra', 'sol', 'astra', 'haiku', 'sonnet', 'opus', 'fable'];
const BUILTIN = {
  codex: { luna: 'astra', terra: 'astra', sol: 'astra', astra: 'astra' },
  claude: { haiku: 'opus', sonnet: 'opus', opus: 'opus', fable: 'fable' },
};
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const COMMANDS = {
  show: [], resolve: ['host', 'primary', 'advisor', 'reasoning-effort'],
  'set-default': ['host', 'advisor', 'reasoning-effort'], 'clear-default': ['host'],
  'set-route': ['host', 'primary', 'advisor', 'reasoning-effort'], 'remove-route': ['host', 'primary'],
};
const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
const HELP = `node ${quote(__filename)} --help`;
const USAGE = `Usage: advisor-config.js COMMAND [OPTIONS]
show
resolve --host codex|claude --primary FAMILY [--advisor FAMILY] [--reasoning-effort LEVEL]
set-default --host HOST --advisor FAMILY [--reasoning-effort LEVEL]
clear-default --host HOST
set-route --host HOST --primary FAMILY --advisor FAMILY [--reasoning-effort LEVEL]
remove-route --host HOST --primary FAMILY
Every command accepts --help, --json, --preflight. Missing config uses built-ins.
resolve concerns Harness routing only, never Claude native detection.
Families: ${FAMILIES.join(', ')}. Exact model IDs are invocation details.
Exit: 0 success, 2 cannot start, 1 write failed.`;

function fail(code, condition, remedy = HELP) { throw Object.assign(new Error(condition), { code, condition, remedy }); }
function configPath(home = os.homedir()) { return path.join(home, '.harness-plugin/harness-advisor/config.json'); }
function emptyConfig() { return { schema_version: 1, defaults: [], routes: [] }; }
function validateEntry(entry, route, code = 'config_invalid') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Object.hasOwn(BUILTIN, entry.host) ||
      !FAMILIES.includes(entry.advisor) || (route && !FAMILIES.includes(entry.primary)) ||
      (entry.reasoning_effort !== undefined && !EFFORTS.includes(entry.reasoning_effort))) {
    fail(code, 'Expected supported host, semantic model families, and a supported reasoning_effort');
  }
  const keys = ['host', 'advisor', 'reasoning_effort', ...(route ? ['primary'] : [])];
  if (Object.keys(entry).some(key => !keys.includes(key))) fail(code, 'Unsupported routing entry field');
}
function validateConfig(config) {
  if (!config || config.schema_version !== 1) fail('config_version_unsupported', 'Advisor config requires schema_version 1');
  if (!Array.isArray(config.defaults) || !Array.isArray(config.routes) ||
      Object.keys(config).some(key => !['schema_version', 'defaults', 'routes'].includes(key))) fail('config_invalid', 'Expected schema_version, defaults[], routes[]');
  for (const [key, route] of [['defaults', false], ['routes', true]]) {
    const seen = new Set();
    for (const entry of config[key]) {
      validateEntry(entry, route);
      const id = `${entry.host}:${route ? entry.primary : ''}`;
      if (seen.has(id)) fail('config_invalid', `Duplicate ${key} entry: ${id}`);
      seen.add(id);
    }
  }
  return config;
}
function readConfig(file) {
  try { return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyConfig();
    if (error.condition) { error.condition += ` in ${file}`; throw error; }
    fail('config_read_failed', `Cannot read Advisor config ${file}: ${error.message}`, `\${EDITOR:-vi} ${quote(file)}`);
  }
}
function resolve(config, host, primary, advisor, effort) {
  validateConfig(config);
  if (!Object.hasOwn(BUILTIN, host) || !FAMILIES.includes(primary) ||
      (advisor !== undefined && !FAMILIES.includes(advisor)) || (effort !== undefined && !EFFORTS.includes(effort))) fail('usage_error', 'Invalid host, primary, advisor, or reasoning effort');
  let selected, source;
  if (advisor) { selected = { advisor, reasoning_effort: effort }; source = 'explicit-user'; }
  else if ((selected = config.routes.find(r => r.host === host && r.primary === primary))) source = 'user-route';
  else if ((selected = config.defaults.find(r => r.host === host))) source = 'user-default';
  else if (Object.hasOwn(BUILTIN[host], primary)) { selected = { advisor: BUILTIN[host][primary] }; source = 'built-in'; }
  else fail('route_unresolved', `No Harness route for ${host}:${primary}`, `node ${quote(__filename)} set-default --host ${host} --advisor ${host === 'codex' ? 'astra' : 'opus'}`);
  return { host, primary_family: primary, advisor_family: selected.advisor,
    reasoning_effort: effort ?? selected.reasoning_effort ?? 'high', route_source: source,
    consultation_mode: primary === selected.advisor ? 'fresh-review' : 'escalation' };
}
function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--help', '--json', '--preflight'].includes(arg)) { options[arg.slice(2)] = true; continue; }
    if (!arg.startsWith('--')) {
      if (options.command || !Object.hasOwn(COMMANDS, arg)) fail('usage_error', `Unknown command or argument: ${arg}`);
      options.command = arg; continue;
    }
    const key = arg.slice(2);
    if (!['host', 'primary', 'advisor', 'reasoning-effort'].includes(key) || Object.hasOwn(options, key)) fail('usage_error', `Unknown or duplicate argument: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) fail('usage_error', `${arg} requires a value`);
    options[key] = value;
  }
  if (options.help) return options;
  if (!options.command) fail('usage_error', 'A command is required');
  for (const key of Object.keys(options)) if (!['command', 'json', 'preflight'].includes(key) && !COMMANDS[options.command].includes(key)) fail('usage_error', `--${key} is not accepted by ${options.command}`);
  for (const key of COMMANDS[options.command]) {
    if (key === 'reasoning-effort' || (options.command === 'resolve' && key === 'advisor')) continue;
    if (!options[key]) fail('usage_error', `--${key} is required`);
  }
  if ((options.host && !Object.hasOwn(BUILTIN, options.host)) ||
      ['primary', 'advisor'].some(key => options[key] && !FAMILIES.includes(options[key])) ||
      (options['reasoning-effort'] && !EFFORTS.includes(options['reasoning-effort']))) fail('usage_error', 'Unsupported host, family, or reasoning effort');
  return options;
}
function applyOperation(config, options) {
  const next = structuredClone(config);
  const route = options.command.endsWith('route');
  const key = route ? 'routes' : 'defaults';
  const matches = entry => entry.host === options.host && (!route || entry.primary === options.primary);
  const old = next[key].find(matches);
  next[key] = next[key].filter(entry => !matches(entry));
  if (options.command.startsWith('set-')) next[key].push({ host: options.host,
    ...(route ? { primary: options.primary } : {}), advisor: options.advisor,
    ...((options['reasoning-effort'] ?? old?.reasoning_effort) ? { reasoning_effort: options['reasoning-effort'] ?? old.reasoning_effort } : {}) });
  return validateConfig(next);
}
function serialize(config) {
  const canonical = { schema_version: 1 };
  for (const key of ['defaults', 'routes']) canonical[key] = config[key].map(entry => ({ host: entry.host,
    ...(key === 'routes' ? { primary: entry.primary } : {}), advisor: entry.advisor,
    ...(entry.reasoning_effort === undefined ? {} : { reasoning_effort: entry.reasoning_effort }) }))
    .sort((a, b) => `${a.host}:${a.primary ?? ''}`.localeCompare(`${b.host}:${b.primary ?? ''}`, 'en'));
  return `${JSON.stringify(canonical, null, 2)}\n`;
}
function saveConfig(file, config) {
  validateConfig(config);
  let stage;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stage = fs.mkdtempSync(path.join(path.dirname(file), '.config-stage-'));
    const temporary = path.join(stage, 'config.json');
    fs.writeFileSync(temporary, serialize(config), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (stage) fs.rmSync(stage, { recursive: true, force: true }); }
}
function withMutationLock(file, mutate) {
  const lock = `${file}.lock`;
  const recovery = `After confirming no advisor-config mutation is running, run: rmdir ${quote(lock)}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(lock);
  }
  catch (error) {
    if (error.code === 'EEXIST') fail('config_busy', `Advisor mutation lock exists at ${lock}. Retry after the writer finishes. Interrupted writers require manual recovery.`, recovery);
    fail('config_lock_failed', `Cannot acquire ${lock}: ${error.message}`);
  }
  let result, failure;
  try { result = mutate(); } catch (error) { failure = error; }
  try { fs.rmdirSync(lock); }
  catch (error) {
    fail('config_lock_cleanup_failed', `Cannot remove ${lock}: ${error.message}. ${failure ? `Operation failed: ${failure.message}` : 'Operation completed and configuration may already be published.'}`, recovery);
  }
  if (failure) throw failure;
  return result;
}
function main(argv) {
  const json = argv.includes('--json');
  let writing = false;
  try {
    const options = parseArguments(argv);
    if (options.help) { process.stdout.write(json ? `${JSON.stringify({ usage: USAGE })}\n` : `${USAGE}\n`); return 0; }
    if (Number(process.versions.node.split('.')[0]) < 22) fail('node_unsupported', 'Node.js 22.0.0 or newer is required', 'nvm install 22');
    const file = configPath();
    let report;
    if (options.command === 'show') report = { config: readConfig(file) };
    else if (options.command === 'resolve') report = resolve(readConfig(file), options.host, options.primary, options.advisor, options['reasoning-effort']);
    else {
      const mutate = () => {
        const config = readConfig(file);
        const next = applyOperation(config, options);
        const changed = serialize(config) !== serialize(next);
        if (changed && !options.preflight) { writing = true; saveConfig(file, next); }
        return { changed, config: next };
      };
      report = options.preflight ? mutate() : withMutationLock(file, mutate);
    }
    report = { status: options.preflight ? 'preflight_passed' : 'ok', config_path: file, ...report };
    process.stdout.write(json ? `${JSON.stringify(report)}\n` : `Report:\n${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const diagnosis = { code: error.condition ? error.code : writing ? 'config_write_failed' : 'config_read_failed', condition: error.condition || error.message, remedy: error.remedy || HELP };
    process.stderr.write(json ? `${JSON.stringify({ error: diagnosis })}\n` : `ERROR [${diagnosis.code}]: ${diagnosis.condition}\nRemedy: ${diagnosis.remedy}\n`);
    return writing ? 1 : 2;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { FAMILIES, EFFORTS, BUILTIN, emptyConfig, validateConfig, resolve, parseArguments, applyOperation, serialize, configPath, main };
