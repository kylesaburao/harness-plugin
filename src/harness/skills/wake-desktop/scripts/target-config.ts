'use strict';
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import crypto = require('node:crypto');
const { randomUUID } = crypto;

export interface WakeTarget extends Record<string, unknown> { ip: string; mac: string }
export interface RawWakeRegistry extends Record<string, unknown> { schema_version: 1; targets: Record<string, unknown> }
export interface WakeRegistry extends RawWakeRegistry { targets: Record<string, WakeTarget> }
export function errorDetails(error: unknown) {
  const value = isObject(error) ? error : {};
  return { code: typeof value.code === 'string' ? value.code : undefined, condition: typeof value.condition === 'string' ? value.condition : undefined, message: typeof value.message === 'string' ? value.message : undefined, remedy: typeof value.remedy === 'string' ? value.remedy : undefined };
}

const MAC_PATTERN = /^([0-9A-Fa-f]{2})([:-])(?:[0-9A-Fa-f]{2}\2){4}[0-9A-Fa-f]{2}$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export class StartupError extends Error {
  declare code: string;
  declare condition: string;
  declare remedy: string;
  constructor(code: string, condition: string, remedy: string) {
    super(condition);
    this.name = 'StartupError';
    this.code = code;
    this.condition = condition;
    this.remedy = remedy;
  }
}

export function isValidIpv4(value: string): boolean {
  const match = IPV4_PATTERN.exec(value);
  if (!match) return false;
  return match.slice(1).every((part) => {
    if (part.length > 1 && part.startsWith('0')) return false;
    return Number(part) <= 255;
  });
}

export function nodeVersionAtLeast(version: string, minimum: readonly number[]): boolean {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const part = parts[index] || 0;
    if (part > minimum[index]!) return true;
    if (part < minimum[index]!) return false;
  }
  return true;
}

export function reportError(json: boolean, error: unknown) {
  const details = errorDetails(error);
  const body = {
    code: details.code || 'internal_error',
    condition: details.condition || details.message || String(error),
    remedy: details.remedy || 'run with --help and report this diagnostic if valid arguments still fail',
  };
  process.stderr.write(json ? `${JSON.stringify({ error: body })}\n`
    : `ERROR [${body.code}]: ${body.condition}\nRemedy: ${body.remedy}\n`);
}


export function isValidMac(value: unknown): value is string { return typeof value === 'string' && MAC_PATTERN.test(value); }
export function isValidHost(value: unknown): value is string {
  return typeof value === 'string' && (/^[0-9.]+$/.test(value) ? isValidIpv4(value) : HOSTNAME_PATTERN.test(value));
}
export function checkNodeVersion() {
  if (!nodeVersionAtLeast(process.version, [26, 0, 0])) {
    throw new StartupError('node_version_unsupported',
      `Node.js 26.0.0 or newer is required, running ${process.version}`,
      'install Node.js 26.0.0 or newer');
  }
}
export function configPath() { return path.join(os.homedir(), '.harness-plugin', 'wake-desktop', 'config.json'); }
export function configError(code: string, condition: string, remedy = `correct the configuration at ${configPath()} while preserving existing targets`) {
  return new StartupError(code, `${configPath()}: ${condition}`, remedy);
}
export function validName(name: unknown): name is string { return typeof name === 'string' && name.length > 0 && name.trim() === name; }
export function validateName(name: unknown): asserts name is string {
  if (!validName(name)) throw configError('target_config_invalid', `invalid target name ${JSON.stringify(name)}`);
}
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function validateTarget(name: unknown, target: unknown): asserts target is WakeTarget {
  validateName(name);
  if (!isObject(target) || !isValidHost(target.ip) || !isValidMac(target.mac)) {
    throw configError('target_config_invalid', `target ${JSON.stringify(name)} requires a valid string ip and mac`);
  }
}
export function validateRegistry(config: unknown, full?: true): WakeRegistry;
export function validateRegistry(config: unknown, full: false): RawWakeRegistry;
export function validateRegistry(config: unknown, full: boolean): RawWakeRegistry;
export function validateRegistry(config: unknown, full = true): RawWakeRegistry {
  assertRegistry(config, full);
  return config;
}
function assertRegistry(config: unknown, full: boolean): asserts config is RawWakeRegistry {
  if (!isObject(config)) throw configError('target_config_invalid', 'root must be an object');
  if (config.schema_version !== 1) throw configError('target_config_version_unsupported',
    `unsupported schema_version ${JSON.stringify(config.schema_version)}, expected numeric 1`);
  if (!isObject(config.targets)) throw configError('target_config_invalid', 'targets must be an object');
  if (full) for (const [name, target] of Object.entries(config.targets)) validateTarget(name, target);
}
export function loadConfig(options?: { missingAllowed?: boolean; full?: true }): WakeRegistry;
export function loadConfig(options: { missingAllowed?: boolean; full: false }): RawWakeRegistry;
export function loadConfig({ missingAllowed = true, full = true }: { missingAllowed?: boolean; full?: boolean } = {}): RawWakeRegistry {
  let raw;
  try { raw = fs.readFileSync(configPath(), 'utf8'); }
  catch (error) {
    if (errorDetails(error).code === 'ENOENT') {
      if (missingAllowed) return { schema_version: 1, targets: {} };
      throw configError('target_config_missing', 'configuration does not exist', 'register the requested target with manage-targets.js register --name NAME --ip HOST --mac MAC');
    }
    throw configError('target_config_unreadable', `cannot read configuration: ${errorDetails(error).message}`,
      `restore read access to ${configPath()}`);
  }
  let config: unknown;
  try { config = JSON.parse(raw); }
  catch (error) { throw configError('target_config_invalid', `invalid JSON: ${errorDetails(error).message}`); }
  return validateRegistry(config, full);
}
export function selectTarget(config: RawWakeRegistry, name: unknown): WakeTarget {
  validateName(name);
  if (!Object.hasOwn(config.targets, name)) throw configError('target_unknown', `unknown target ${JSON.stringify(name)}`,
    'run manage-targets.js list --json to find registered names');
  const target = config.targets[name];
  validateTarget(name, target);
  return target;
}
export function loadTarget(name: string): WakeTarget {
  try {
    return selectTarget(loadConfig({ missingAllowed: false, full: false }), name);
  } catch (error) {
    if (error instanceof StartupError) {
      error.condition += ` (requested target ${JSON.stringify(name)})`;
      if (error.code === 'target_config_missing') {
        const quotedName = `'${name.replaceAll("'", "'\\''")}'`;
        error.remedy = `register the requested target with manage-targets.js register --name=${quotedName} --ip HOST --mac MAC`;
      }
    }
    throw error;
  }
}
export function saveConfig(config: unknown) {
  validateRegistry(config);
  const destination = configPath();
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let staged = false;
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const fd = fs.openSync(temporary, 'wx');
    staged = true;
    try { fs.writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
  } catch (error) {
    let cleanup = '';
    if (staged) {
      try { fs.unlinkSync(temporary); }
      catch (failure) { cleanup = `; temporary cleanup failed at ${temporary}: ${errorDetails(failure).message}`; }
    }
    throw configError('target_config_write_failed', `cannot publish configuration: ${errorDetails(error).message}${cleanup}`,
      `restore write access to ${path.dirname(destination)} and retry the command`);
  }
}
