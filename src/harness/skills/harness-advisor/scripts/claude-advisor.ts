#!/usr/bin/env node
'use strict';
import fs = require('node:fs');
import path = require('node:path');
import os = require('node:os');
import childProcess = require('node:child_process');
const { spawnSync } = childProcess;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type ClaudeEffort = typeof EFFORTS[number];
export type ClaudeAdvisorOptions = { 'native-absent': true; model: string; 'reasoning-effort': ClaudeEffort; prompt: string; workspace?: string; json?: boolean; preflight?: boolean; help?: false };
type ParsedOptions = Record<string, string | boolean | undefined>;
type HelpOptions = ParsedOptions & { help: true };
export interface ClaudeInvocation { command: string; args: string[]; env: NodeJS.ProcessEnv }
interface AdvisorReport { model: string; reasoning_effort: ClaudeEffort; mechanism: 'claude-cli'; context_mode: 'fresh'; tools: string[]; runtime_controls: 'unverified'; workspace?: string }
export interface AdvisorPreflightReport extends AdvisorReport { status: 'preflight_passed'; checks: string[]; runtime_controls: 'unverified' }
export interface AdvisorConsultationReport extends AdvisorReport { status: 'consulted'; advice: string; model_usage: unknown; usage: unknown; observations?: Observation[] }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function effort(value: unknown): value is ClaudeEffort { return EFFORTS.some(item => item === value); }
function details(error: unknown) {
  const value = record(error) ? error : {};
  return { code: typeof value.code === 'string' ? value.code : undefined, condition: typeof value.condition === 'string' ? value.condition : undefined, message: typeof value.message === 'string' ? value.message : undefined, remedy: typeof value.remedy === 'string' ? value.remedy : undefined };
}
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const HELP = `node ${quote(__filename)} --help`;
const USAGE = `Usage: claude-advisor.js --native-absent --model MODEL --reasoning-effort LEVEL --prompt FILE [--workspace ABSOLUTE_DIRECTORY] [--json] [--preflight]
One separate Claude fallback consultation. Omit --workspace for tool-free advice. Uses the canonical Advisor contract.
--native-absent attests the PARENT session lacks native Advisor, not that native execution failed.
MODEL is the host alias or exact callable ID resolved by the primary for this call.
--preflight checks prompt, contract, and CLI availability, not authentication, model access, or runtime enforcement. --help prints usage.
Exit: 0 success, 2 cannot start, 1 consultation failed. No automatic retries.`;
function fail(code: string, condition: string, remedy = HELP): never { throw Object.assign(new Error(condition), { code, condition, remedy }); }
export function parseArguments(argv: string[]): ClaudeAdvisorOptions | HelpOptions {
  const options: ParsedOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!.slice(2);
    if (!argv[i]!.startsWith('--') || !['native-absent', 'model', 'reasoning-effort', 'prompt', 'workspace', 'json', 'preflight', 'help'].includes(key) || Object.hasOwn(options, key)) fail('usage_error', `Unknown or duplicate argument: ${argv[i]}`);
    if (['model', 'reasoning-effort', 'prompt', 'workspace'].includes(key)) {
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
export function invocation(options: Pick<ClaudeAdvisorOptions, 'model' | 'reasoning-effort' | 'workspace'>, contract: string, env: NodeJS.ProcessEnv = process.env): ClaudeInvocation {
  // No shell interpolation. Controls apply only to this isolated consultation.
  const childEnv: NodeJS.ProcessEnv = { ...env, CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' };
  delete childEnv.CLAUDECODE; // This intentional separate print session does not share the parent transcript.
  return { command: 'claude', args: ['-p', '--system-prompt', contract, '--setting-sources', '', '--model', options.model,
    '--effort', options['reasoning-effort'], '--tools', options.workspace ? 'Read,Glob,Grep' : '', '--disallowedTools', 'mcp__*',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk',
    '--settings', JSON.stringify({ disableAllHooks: true, fallbackModel: [], switchModelsOnFlag: false,
      ...(options.workspace ? { permissions: { additionalDirectories: [options.workspace] } } : {}) }),
    '--disable-slash-commands', '--no-session-persistence', '--output-format', options.workspace ? 'stream-json' : 'json',
    ...(options.workspace ? ['--restricted', '--safe-mode', '--verbose', '--no-chrome'] : [])],
  env: childEnv };
}
export function validateWorkspace(workspace: string): string {
  if (!path.isAbsolute(workspace)) fail('workspace_invalid', '--workspace must be an absolute directory');
  try {
    const canonical = fs.realpathSync(workspace);
    if (!fs.statSync(canonical).isDirectory()) throw new Error('Not a directory');
    fs.accessSync(canonical, fs.constants.R_OK | fs.constants.X_OK);
    return canonical;
  } catch { fail('workspace_invalid', `Workspace is not an existing readable directory: ${workspace}`); }
}
export interface Observation {
  tool: string;
  path: string | null;
  outcome: 'read' | 'discovery' | 'failed' | 'unconfirmed';
  completeness?: 'complete' | 'partial';
  start_line?: number;
  lines?: number;
}
// Parse only host envelopes, never source text or the Advisor's claims. The caller
// bounds the complete transport at 8 MiB, as on the evidence-only route.
export function parseInspection(output: string, workspace: string): { response: Record<string, unknown>; observations: Observation[] } {
  const pending = new Map<string, { tool: string; input: Record<string, unknown>; session: unknown }>();
  const seen = new Set<string>();
  const observations: Observation[] = [];
  let response: Record<string, unknown> | undefined;
  let session: string | undefined;
  const invalid = () => fail('advisor_response_invalid', 'Claude inspection stream is malformed, incomplete, or inconsistent');
  for (const line of output.split('\n').filter(line => line.trim())) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { invalid(); }
    if (!record(event) || typeof event.type !== 'string' || response) invalid();
    const e = event as Record<string, unknown>;
    if (typeof e.session_id === 'string') {
      if (session && session !== e.session_id) invalid();
      session = e.session_id;
    }
    if (e.type === 'result') { response = e; continue; }
    if (e.type !== 'assistant' && e.type !== 'user') continue;
    if (e.parent_tool_use_id !== null || !record(e.message) || !Array.isArray(e.message.content)) continue;
    const blocks = e.message.content.filter(record);
    if (e.type === 'assistant') {
      if (e.error || e.aborted) invalid();
      for (const block of blocks) if (block.type === 'tool_use') {
        if (typeof block.id !== 'string' || seen.has(block.id) || typeof block.name !== 'string' || !record(block.input)) invalid();
        const id = block.id as string;
        seen.add(id);
        pending.set(id, { tool: block.name as string, input: block.input as Record<string, unknown>, session: e.session_id });
      }
      continue;
    }
    const results = blocks.filter(block => block.type === 'tool_result');
    for (const block of results) {
      if (typeof block.tool_use_id !== 'string' || !pending.has(block.tool_use_id)) invalid();
      const id = block.tool_use_id as string;
      const call = pending.get(id)!;
      pending.delete(id);
      const rawPath = call.input.file_path ?? call.input.path;
      const observed: Observation = { tool: call.tool, path: typeof rawPath === 'string' ? rawPath : null, outcome: 'unconfirmed' };
      observations.push(observed);
      if (block.is_error !== undefined && typeof block.is_error !== 'boolean') invalid();
      if (block.is_error === true) { observed.outcome = 'failed'; continue; }
      // Metadata cannot be assigned to one call when an envelope contains several results.
      const data = results.length === 1 && record(e.tool_use_result) ? e.tool_use_result : undefined;
      if (!data || typeof call.session !== 'string' || call.session !== e.session_id || typeof e.session_id !== 'string' || !['Read', 'Glob', 'Grep'].includes(call.tool)) continue;
      if (call.tool === 'Read' && data.type === 'text' && record(data.file)) {
        const file = data.file;
        if (typeof file.filePath !== 'string' || !path.isAbsolute(file.filePath) || typeof file.content !== 'string' ||
            ![file.startLine, file.numLines, file.totalLines].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) continue;
        if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath) || path.normalize(rawPath) !== path.normalize(file.filePath) ||
            (file.startLine as number) < 1 || (file.numLines as number) > (file.totalLines as number) ||
            (file.truncatedByTokenCap !== undefined && typeof file.truncatedByTokenCap !== 'boolean')) continue;
        const relative = path.relative(workspace, file.filePath);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
        observed.path = file.filePath;
        observed.outcome = 'read';
        observed.start_line = file.startLine as number;
        observed.lines = file.numLines as number;
        observed.completeness = file.truncatedByTokenCap === true || observed.start_line > 1 || observed.lines < (file.totalLines as number) ? 'partial' : 'complete';
      } else if ((call.tool === 'Glob' || call.tool === 'Grep') && Array.isArray(data.filenames) && data.filenames.every(p => typeof p === 'string') && typeof data.numFiles === 'number') {
        observed.outcome = 'discovery';
        if (call.tool === 'Glob' && typeof data.truncated === 'boolean') observed.completeness = data.truncated || data.countIsComplete === false ? 'partial' : 'complete';
        if (call.tool === 'Grep' && typeof data.totalLines === 'number' && typeof data.numLines === 'number') observed.completeness = data.numLines < data.totalLines || (typeof data.appliedOffset === 'number' && data.appliedOffset > 0) ? 'partial' : 'complete';
        // Searches orient inspection. They never count as a material source read.
      }
    }
  }
  if (!response || typeof response.session_id !== 'string') invalid();
  if (response!.is_error !== false || response!.subtype !== 'success')
    fail('advisor_execution_failed', `Claude inspection returned an unsuccessful result: ${JSON.stringify(response!.errors ?? response!.subtype)}`);
  for (const call of pending.values()) observations.push({ tool: call.tool, path: null, outcome: 'unconfirmed' });
  return { response: response!, observations };
}
function main(argv: string[]) {
  const json = argv.includes('--json');
  let started = false;
  let workingDirectory: string | undefined;
  try {
    const options = parseArguments(argv);
    if (options.help) { process.stdout.write(json ? `${JSON.stringify({ usage: USAGE })}\n` : `${USAGE}\n`); return 0; }
    if (options.workspace !== undefined) options.workspace = validateWorkspace(options.workspace);
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
    if (options.workspace) {
      const version = /^([0-9]+)\.([0-9]+)\.([0-9]+)\b/.exec(probe.stdout.trim());
      if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) === 1 && Number(version[3]) < 248) || (Number(version[1]) === 2 && Number(version[2]) < 1))
        fail('inspection_controls_unavailable', 'Workspace inspection requires documented restricted-mode support (Claude Code 2.1.248+) and safe mode. CLI version is unsupported or unrecognized.', 'Use a supported Claude Code CLI, or prepare an explicitly evidence-only consultation without --workspace.');
    }
    const common: AdvisorReport = { model: options.model, reasoning_effort: options['reasoning-effort'], mechanism: 'claude-cli', context_mode: 'fresh', tools: options.workspace ? ['Read', 'Glob', 'Grep'] : [], runtime_controls: 'unverified', ...(options.workspace ? { workspace: options.workspace } : {}) };
    let report: AdvisorPreflightReport | AdvisorConsultationReport;
    if (options.preflight) {
      report = { ...common, status: 'preflight_passed', checks: ['prompt_readable_nonempty', 'advisor_contract_readable_nonempty', 'cli_version_command_succeeded'], runtime_controls: 'unverified' };
    }
    else {
      started = true;
      workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-advisor-'));
      const result = spawnSync(call.command, call.args, { input: prompt, encoding: 'utf8', env: call.env, cwd: workingDirectory, maxBuffer: 8 * 1024 * 1024 });
      if (result.error || result.status !== 0) fail('advisor_execution_failed', `Claude Advisor ${options.model} failed: ${result.error?.message || result.stderr || (options.workspace ? 'inspection process failed' : result.stdout)}`);
      let response: unknown;
      let observations: Observation[] | undefined;
      if (options.workspace) {
        const parsed = parseInspection(result.stdout, options.workspace);
        response = parsed.response;
        observations = parsed.observations;
      } else try { response = JSON.parse(result.stdout); } catch { fail('advisor_response_invalid', 'Claude did not return a JSON result'); }
      // Preserve the existing null-envelope diagnosis while narrowing external data.
      if (response === null) throw new TypeError("Cannot read properties of null (reading 'is_error')");
      if (!record(response) || response.is_error || typeof response.result !== 'string' || !response.result.trim()) fail('advisor_execution_failed', `Claude Advisor ${options.model} returned no successful guidance: ${options.workspace ? 'inspection result was unsuccessful or empty' : result.stdout}`);
      report = { ...common, status: 'consulted', advice: response.result, model_usage: response.modelUsage ?? null, usage: response.usage ?? null, ...(observations ? { observations } : {}) };
    }
    if (workingDirectory) {
      fs.rmSync(workingDirectory, { recursive: true, force: true });
      workingDirectory = undefined;
    }
    process.stdout.write(json ? `${JSON.stringify(report)}\n` : `Report:\n${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const errorDetails = details(error);
    const diagnosis = { code: errorDetails.code || 'advisor_failed', condition: errorDetails.condition || errorDetails.message, remedy: errorDetails.remedy || HELP };
    if (workingDirectory) {
      try { fs.rmSync(workingDirectory, { recursive: true, force: true }); }
      catch {
        diagnosis.condition = `${diagnosis.condition}. Cleanup failed, invocation directory retained: ${workingDirectory}`;
        diagnosis.remedy = `rm -rf -- ${quote(workingDirectory)}`;
      }
    }
    process.stderr.write(json ? `${JSON.stringify({ error: diagnosis })}\n` : `ERROR [${diagnosis.code}]: ${diagnosis.condition}\nRemedy: ${diagnosis.remedy}\n`);
    return started ? 1 : 2;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
