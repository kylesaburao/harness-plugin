#!/usr/bin/env node
'use strict';
import fs = require('node:fs');
import path = require('node:path');
import os = require('node:os');
import childProcess = require('node:child_process');
const { spawnSync } = childProcess;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type ClaudeEffort = typeof EFFORTS[number];
export type ClaudeAdvisorOptions = { 'native-absent': true; model: string; 'reasoning-effort': ClaudeEffort; prompt: string; json?: boolean; preflight?: boolean; help?: false };
type ParsedOptions = Record<string, string | boolean | undefined>;
type HelpOptions = ParsedOptions & { help: true };
export interface ClaudeInvocation { command: string; args: string[]; env: NodeJS.ProcessEnv }
interface AdvisorReport { model: string; reasoning_effort: ClaudeEffort; mechanism: 'claude-cli'; context_mode: 'fresh'; tools: never[] }
export interface AdvisorPreflightReport extends AdvisorReport { status: 'preflight_passed'; checks: string[]; runtime_controls: 'unverified' }
export interface AdvisorConsultationReport extends AdvisorReport { status: 'consulted'; advice: string; model_usage: unknown; usage: unknown }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function effort(value: unknown): value is ClaudeEffort { return EFFORTS.some(item => item === value); }
function details(error: unknown) {
  const value = record(error) ? error : {};
  return { code: typeof value.code === 'string' ? value.code : undefined, condition: typeof value.condition === 'string' ? value.condition : undefined, message: typeof value.message === 'string' ? value.message : undefined, remedy: typeof value.remedy === 'string' ? value.remedy : undefined };
}
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const HELP = `node ${quote(__filename)} --help`;
const USAGE = `Usage: claude-advisor.js --native-absent --model MODEL --reasoning-effort LEVEL --prompt FILE [--json] [--preflight]
One separate, tool-free Claude fallback consultation. Uses the canonical Advisor contract.
--native-absent attests the PARENT session lacks native Advisor, not that native execution failed.
MODEL is the host alias or exact callable ID resolved by the primary for this call.
--preflight checks prompt, contract, and CLI availability, not authentication, model access, or runtime enforcement. --help prints usage.
Exit: 0 success, 2 cannot start, 1 consultation failed. No automatic retries.`;
function fail(code: string, condition: string, remedy = HELP): never { throw Object.assign(new Error(condition), { code, condition, remedy }); }
export function parseArguments(argv: string[]): ClaudeAdvisorOptions | HelpOptions {
  const options: ParsedOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!.slice(2);
    if (!argv[i]!.startsWith('--') || !['native-absent', 'model', 'reasoning-effort', 'prompt', 'json', 'preflight', 'help'].includes(key) || Object.hasOwn(options, key)) fail('usage_error', `Unknown or duplicate argument: ${argv[i]}`);
    if (['model', 'reasoning-effort', 'prompt'].includes(key)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) fail('usage_error', `--${key} requires a value`);
      options[key] = value;
    } else options[key] = true;
  }
  if (options.help) return { ...options, help: true };
  validateOptions(options);
  return options;
}
function validateOptions(options: ParsedOptions): asserts options is ClaudeAdvisorOptions {
  for (const key of ['native-absent', 'model', 'reasoning-effort', 'prompt']) if (!options[key]) fail('usage_error', `--${key} is required`);
  if (!effort(options['reasoning-effort'])) fail('usage_error', 'Unsupported reasoning effort');
}
export function invocation(options: Pick<ClaudeAdvisorOptions, 'model' | 'reasoning-effort'>, contract: string, env: NodeJS.ProcessEnv = process.env): ClaudeInvocation {
  // No shell interpolation. Controls apply only to this isolated consultation.
  const childEnv: NodeJS.ProcessEnv = { ...env, CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' };
  delete childEnv.CLAUDECODE; // This intentional separate print session does not share the parent transcript.
  return { command: 'claude', args: ['-p', '--system-prompt', contract, '--setting-sources', '', '--model', options.model,
    '--effort', options['reasoning-effort'], '--tools', '', '--disallowedTools', 'mcp__*',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk',
    '--settings', '{"disableAllHooks":true,"fallbackModel":[],"switchModelsOnFlag":false}',
    '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json'],
  env: childEnv };
}
function main(argv: string[]) {
  const json = argv.includes('--json');
  let started = false;
  let workingDirectory: string | undefined;
  try {
    const options = parseArguments(argv);
    if (options.help) { process.stdout.write(json ? `${JSON.stringify({ usage: USAGE })}\n` : `${USAGE}\n`); return 0; }
    if (Number(process.versions.node.split('.')[0]) < 22) fail('node_unsupported', 'Node.js 22.0.0 or newer is required', 'nvm install 22');
    let prompt;
    try { prompt = fs.readFileSync(options.prompt, 'utf8'); }
    catch (error) { fail('input_read_failed', `Cannot read ${path.resolve(options.prompt)}: ${details(error).message}`); }
    if (!prompt.trim()) fail('input_invalid', 'Advisor prompt is empty');
    const contractFile = path.resolve(__dirname, '../references/contract.md');
    let contract;
    try { contract = fs.readFileSync(contractFile, 'utf8'); } catch { /* Report reinstall remedy below. */ }
    if (!contract?.trim()) fail('advisor_contract_unavailable', `Advisor contract is missing, unreadable, or empty at ${contractFile}`,
      'Reinstall the Harness plugin through your host plugin manager.');
    const call = invocation(options, contract);
    const probe = spawnSync(call.command, ['--version'], { encoding: 'utf8', timeout: 15000, env: call.env });
    if (probe.error || probe.status !== 0) fail('claude_unavailable', `Claude CLI unavailable: ${probe.error?.message || probe.stderr}`, 'claude --version');
    const common: AdvisorReport = { model: options.model, reasoning_effort: options['reasoning-effort'], mechanism: 'claude-cli', context_mode: 'fresh', tools: [] };
    let report: AdvisorPreflightReport | AdvisorConsultationReport;
    if (options.preflight) {
      report = { ...common, status: 'preflight_passed', checks: ['prompt_readable_nonempty', 'advisor_contract_readable_nonempty', 'cli_version_command_succeeded'], runtime_controls: 'unverified' };
    }
    else {
      started = true;
      workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-advisor-'));
      const result = spawnSync(call.command, call.args, { input: prompt, encoding: 'utf8', env: call.env, cwd: workingDirectory, maxBuffer: 8 * 1024 * 1024 });
      if (result.error || result.status !== 0) fail('advisor_execution_failed', `Claude Advisor ${options.model} failed: ${result.error?.message || result.stderr || result.stdout}`);
      let response: unknown;
      try { response = JSON.parse(result.stdout); } catch { fail('advisor_response_invalid', 'Claude did not return a JSON result'); }
      // Preserve the existing null-envelope diagnosis while narrowing external data.
      if (response === null) throw new TypeError("Cannot read properties of null (reading 'is_error')");
      if (!record(response) || response.is_error || typeof response.result !== 'string' || !response.result.trim()) fail('advisor_execution_failed', `Claude Advisor ${options.model} returned no successful guidance: ${result.stdout}`);
      report = { ...common, status: 'consulted', advice: response.result, model_usage: response.modelUsage ?? null, usage: response.usage ?? null };
    }
    process.stdout.write(json ? `${JSON.stringify(report)}\n` : `Report:\n${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const errorDetails = details(error);
    const diagnosis = { code: errorDetails.code || 'advisor_failed', condition: errorDetails.condition || errorDetails.message, remedy: errorDetails.remedy || HELP };
    process.stderr.write(json ? `${JSON.stringify({ error: diagnosis })}\n` : `ERROR [${diagnosis.code}]: ${diagnosis.condition}\nRemedy: ${diagnosis.remedy}\n`);
    return started ? 1 : 2;
  } finally {
    if (workingDirectory) fs.rmSync(workingDirectory, { recursive: true, force: true });
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
