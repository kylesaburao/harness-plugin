#!/usr/bin/env node
'use strict';

// Node 22+. No dependencies. Host integration only, no Advisor inference.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const START = '<!-- harness-plugin:capabilities:start -->';
const END = '<!-- harness-plugin:capabilities:end -->';
const SCRIPT = path.resolve(__filename);
const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
const HELP = `node ${quote(SCRIPT)} --help`;
const USAGE = `Usage: install.js --host codex|claude [--preflight] [--json]

Install or repair Harness user-level capability integration.
Installs activation instructions regardless of installation-time native availability.
Neither host CLI is required. Model availability is resolved only on invocation.
Uses CODEX_HOME or ~/.codex, CLAUDE_CONFIG_DIR or ~/.claude (absolute paths).
Does not edit host settings or Advisor routing.
--preflight validates and reports proposed files without writing.
--help prints this usage. Exit: 0 success, 2 cannot start, 1 write failure.`;

const CAPABILITIES = [{
  name: 'advisor',
  hosts: ['codex', 'claude'],
  instructions: {
    codex: `### Harness Advisor

Use the \`harness-advisor\` Skill for selective read-only reasoning escalation and
independent review. For substantial or difficult work, consider the Skill at
high-leverage decision points rather than during routine execution.
If the user explicitly asks for an advisor, second opinion, named Advisor model
family, or independent review, invoke the Skill. It defines routing, invocation
limits, context handling, cache-aware carryover, and Advisor execution.
`,
    claude: `### Harness Advisor

First determine whether this Claude session provides native Advisor: an active
Anthropic \`advisor\` server tool or session metadata identifying a configured
Managed Agents advisor is positive evidence. Host identity or saved settings alone
are not evidence. If status is unknown, establish it before using Harness fallback.
If native Advisor is available, use it and do not load, invoke, or otherwise use
the Harness \`harness-advisor\` Skill. Native Advisor owns the session's Advisor behavior,
including generic user requests. Native errors do not enable Harness fallback.
Only when native Advisor is unavailable, use the Harness \`harness-advisor\` Skill for
selective read-only reasoning escalation and independent review. Consider it at
consequential decisions, and invoke it for explicit advisor, second opinion,
named Advisor family, or independent review requests.
An explicit native-only request when native is absent must report unavailable.
Do not use both native Advisor and Harness Advisor to obtain additional review.
`,
  },
}];
function blockFor(host) {
  return `${START}\n## Harness capabilities\n\n${CAPABILITIES.filter(c => c.hosts.includes(host)).map(c => c.instructions[host]).join('\n')}${END}`;
}
const BLOCK = blockFor('codex');

class InstallError extends Error {
  constructor(code, condition, remedy = HELP) {
    super(condition);
    Object.assign(this, { code, condition, remedy });
  }
}
function fail(code, condition, remedy) { throw new InstallError(code, condition, remedy); }

function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!['--host', '--preflight', '--json', '--help'].includes(arg)) {
      fail('usage_error', `Unknown argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (Object.hasOwn(options, key)) fail('usage_error', `Duplicate argument: ${arg}`);
    if (key === 'host') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) fail('usage_error', `${arg} requires a value`);
      options[key] = value;
    } else options[key] = true;
  }
  if (options.host && !['codex', 'claude'].includes(options.host)) fail('usage_error', 'Unsupported --host value');
  if (!options.help && !options.host) fail('usage_error', '--host is required');
  return options;
}

function readOptional(file) {
  try {
    if (!fs.lstatSync(file).isFile()) fail('file_conflict', `Expected a regular file: ${file}`, `ls -ld ${quote(file)}`);
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof InstallError) throw error;
    fail('file_read_failed', `Cannot read ${file}: ${error.message}`, `ls -ld ${quote(file)}`);
  }
}

function managedText(original, block = BLOCK) {
  const text = original ?? '';
  const starts = text.split(START).length - 1;
  const ends = text.split(END).length - 1;
  if (!starts && !ends) return text + (text && !text.endsWith('\n') ? '\n\n' : text ? '\n' : '') + block + '\n';
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (starts !== 1 || ends !== 1 || start > end) fail('managed_block_conflict', 'Expected exactly one ordered Harness start/end marker pair');
  return text.slice(0, start) + block + text.slice(end + END.length);
}

function buildPlan(options, { env = process.env, home = os.homedir() } = {}) {
  const host = options.host;
  if (!['codex', 'claude'].includes(host)) fail('usage_error', 'Unsupported --host value');
  const variable = host === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  const hostHome = env[variable] || path.join(home, host === 'codex' ? '.codex' : '.claude');
  if (!path.isAbsolute(hostHome)) fail('host_home_invalid', `${variable} must be absolute: ${hostHome}`, `unset ${variable}`);
  const agentsFile = path.join(hostHome, host === 'codex' ? 'AGENTS.md' : 'CLAUDE.md');
  if (host === 'codex') {
    const override = path.join(hostHome, 'AGENTS.override.md');
    if (readOptional(override)?.trim()) fail('instructions_shadowed', `${override} shadows ${agentsFile}`, `\${EDITOR:-vi} ${quote(override)}`);
  }
  let instructions;
  const oldInstructions = readOptional(agentsFile);
  try { instructions = managedText(oldInstructions, blockFor(host)); }
  catch (error) { error.condition += ` in ${agentsFile}`; error.remedy = `\${EDITOR:-vi} ${quote(agentsFile)}`; throw error; }
  const files = [
    { path: agentsFile, before: oldInstructions, content: instructions },
  ];
  return { capability: 'advisor', host, status: 'adapter_ready', files,
    note: 'Start a new host session. Model access and effective invocation controls are checked at consultation time. Claude native availability never skips fallback installation.' };
}

function publish(file, published) {
  const directory = path.dirname(file.path);
  fs.mkdirSync(directory, { recursive: true });
  // Detect edits since planning before replacing either user-owned or managed text.
  if (readOptional(file.path) !== file.before) fail('file_changed', `File changed during installation: ${file.path}`);
  const stage = fs.mkdtempSync(path.join(directory, '.harness-stage-'));
  try {
    const temporary = path.join(stage, 'content');
    const mode = file.before === null ? 0o600 : fs.statSync(file.path).mode & 0o777;
    fs.writeFileSync(temporary, file.content, { mode });
    fs.renameSync(temporary, file.path);
    published.push(file.path);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

function main(argv) {
  const json = argv.includes('--json');
  const published = [];
  let started = false;
  try {
    const options = parseArguments(argv);
    if (options.help) { process.stdout.write(json ? `${JSON.stringify({ usage: USAGE })}\n` : `${USAGE}\n`); return 0; }
    if (Number(process.versions.node.split('.')[0]) < 22) fail('node_unsupported', 'Node.js 22.0.0 or newer is required', 'nvm install 22');
    const plan = buildPlan(options);
    const changes = plan.files.filter(file => file.before !== file.content);
    if (!options.preflight) for (const file of changes) {
      started = true;
      publish(file, published);
    }
    const report = { ...plan, status: options.preflight ? 'preflight_passed' : changes.length ? 'installed' : 'unchanged',
      files: plan.files.map(file => ({ path: file.path, changed: file.before !== file.content })),
      published, preflight: Boolean(options.preflight) };
    process.stdout.write(json ? `${JSON.stringify(report)}\n` : `Report:\n${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const diagnosis = { code: error.code || 'installation_failed', condition: error.condition || error.message, remedy: error.remedy || HELP };
    if (started) diagnosis.condition += `; already published: ${JSON.stringify(published)}. Rerun installation to repair.`;
    process.stderr.write(json ? `${JSON.stringify({ error: diagnosis })}\n` : `ERROR [${diagnosis.code}]: ${diagnosis.condition}\nRemedy: ${diagnosis.remedy}\n`);
    return started ? 1 : 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { START, END, BLOCK, managedText, blockFor, buildPlan, parseArguments };
