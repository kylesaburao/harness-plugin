#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
const HELP = `node ${quote(__filename)} --help`;
const USAGE = `Usage: claude-advisor.js --native-absent --model MODEL --reasoning-effort LEVEL --prompt FILE [--json] [--preflight]
One separate, tool-free Claude fallback consultation. Uses the canonical Advisor contract.
--native-absent attests the PARENT session lacks native Advisor, not that native execution failed.
MODEL is the host alias or exact callable ID resolved by the primary for this call.
--preflight checks prompt, contract, and CLI availability, not authentication, model access, or runtime enforcement. --help prints usage.
Exit: 0 success, 2 cannot start, 1 consultation failed. No automatic retries.`;
function fail(code, condition, remedy = HELP) { throw Object.assign(new Error(condition), { code, condition, remedy }); }
function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !['native-absent', 'model', 'reasoning-effort', 'prompt', 'json', 'preflight', 'help'].includes(key) || Object.hasOwn(options, key)) fail('usage_error', `Unknown or duplicate argument: ${argv[i]}`);
    if (['model', 'reasoning-effort', 'prompt'].includes(key)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) fail('usage_error', `--${key} requires a value`);
      options[key] = value;
    } else options[key] = true;
  }
  if (options.help) return options;
  for (const key of ['native-absent', 'model', 'reasoning-effort', 'prompt']) if (!options[key]) fail('usage_error', `--${key} is required`);
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(options['reasoning-effort'])) fail('usage_error', 'Unsupported reasoning effort');
  return options;
}
function invocation(options, contract, env = process.env) {
  // No shell interpolation. Controls apply only to this isolated consultation.
  const childEnv = { ...env, CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' };
  delete childEnv.CLAUDECODE; // This intentional separate print session does not share the parent transcript.
  return { command: 'claude', args: ['-p', '--system-prompt', contract, '--setting-sources', '', '--model', options.model,
    '--effort', options['reasoning-effort'], '--tools', '', '--disallowedTools', 'mcp__*',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk',
    '--settings', '{"disableAllHooks":true,"fallbackModel":[],"switchModelsOnFlag":false}',
    '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json'],
  env: childEnv };
}
function main(argv) {
  const json = argv.includes('--json');
  let started = false;
  let workingDirectory;
  try {
    const options = parseArguments(argv);
    if (options.help) { process.stdout.write(json ? `${JSON.stringify({ usage: USAGE })}\n` : `${USAGE}\n`); return 0; }
    if (Number(process.versions.node.split('.')[0]) < 22) fail('node_unsupported', 'Node.js 22.0.0 or newer is required', 'nvm install 22');
    let prompt;
    try { prompt = fs.readFileSync(options.prompt, 'utf8'); }
    catch (error) { fail('input_read_failed', `Cannot read ${path.resolve(options.prompt)}: ${error.message}`); }
    if (!prompt.trim()) fail('input_invalid', 'Advisor prompt is empty');
    const contractFile = path.resolve(__dirname, '../references/contract.md');
    let contract;
    try { contract = fs.readFileSync(contractFile, 'utf8'); } catch { /* Report reinstall remedy below. */ }
    if (!contract?.trim()) fail('advisor_contract_unavailable', `Advisor contract is missing, unreadable, or empty at ${contractFile}`,
      'Reinstall the Harness plugin through your host plugin manager.');
    const call = invocation(options, contract);
    const probe = spawnSync(call.command, ['--version'], { encoding: 'utf8', timeout: 15000, env: call.env });
    if (probe.error || probe.status !== 0) fail('claude_unavailable', `Claude CLI unavailable: ${probe.error?.message || probe.stderr}`, 'claude --version');
    const report = { model: options.model, reasoning_effort: options['reasoning-effort'], mechanism: 'claude-cli', context_mode: 'fresh', tools: [] };
    if (options.preflight) {
      report.status = 'preflight_passed';
      report.checks = ['prompt_readable_nonempty', 'advisor_contract_readable_nonempty', 'cli_version_command_succeeded'];
      report.runtime_controls = 'unverified';
    }
    else {
      started = true;
      workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-advisor-'));
      const result = spawnSync(call.command, call.args, { input: prompt, encoding: 'utf8', env: call.env, cwd: workingDirectory, maxBuffer: 8 * 1024 * 1024 });
      if (result.error || result.status !== 0) fail('advisor_execution_failed', `Claude Advisor ${options.model} failed: ${result.error?.message || result.stderr || result.stdout}`);
      let response;
      try { response = JSON.parse(result.stdout); } catch { fail('advisor_response_invalid', 'Claude did not return a JSON result'); }
      if (response.is_error || typeof response.result !== 'string' || !response.result.trim()) fail('advisor_execution_failed', `Claude Advisor ${options.model} returned no successful guidance: ${result.stdout}`);
      report.status = 'consulted';
      report.advice = response.result;
      report.model_usage = response.modelUsage ?? null;
      report.usage = response.usage ?? null;
    }
    process.stdout.write(json ? `${JSON.stringify(report)}\n` : `Report:\n${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const diagnosis = { code: error.code || 'advisor_failed', condition: error.condition || error.message, remedy: error.remedy || HELP };
    process.stderr.write(json ? `${JSON.stringify({ error: diagnosis })}\n` : `ERROR [${diagnosis.code}]: ${diagnosis.condition}\nRemedy: ${diagnosis.remedy}\n`);
    return started ? 1 : 2;
  } finally {
    if (workingDirectory) fs.rmSync(workingDirectory, { recursive: true, force: true });
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parseArguments, invocation };
