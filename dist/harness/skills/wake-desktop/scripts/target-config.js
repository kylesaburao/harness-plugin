'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAC_PATTERN = /^([0-9A-Fa-f]{2})([:-])(?:[0-9A-Fa-f]{2}\2){4}[0-9A-Fa-f]{2}$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

class StartupError extends Error {
  constructor(code, condition, remedy) {
    super(condition);
    this.name = 'StartupError';
    this.code = code;
    this.condition = condition;
    this.remedy = remedy;
  }
}

function isValidIpv4(value) {
  const match = IPV4_PATTERN.exec(value);
  if (!match) return false;
  return match.slice(1).every((part) => {
    if (part.length > 1 && part.startsWith('0')) return false;
    return Number(part) <= 255;
  });
}

function nodeVersionAtLeast(version, minimum) {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const part = parts[index] || 0;
    if (part > minimum[index]) return true;
    if (part < minimum[index]) return false;
  }
  return true;
}

function reportError(json, error) {
  const body = {
    code: error.code || 'internal_error',
    condition: error.condition || error.message || String(error),
    remedy: error.remedy || 'run with --help and report this diagnostic if valid arguments still fail',
  };
  process.stderr.write(json ? `${JSON.stringify({ error: body })}\n`
    : `ERROR [${body.code}]: ${body.condition}\nRemedy: ${body.remedy}\n`);
}


function isValidMac(value) { return typeof value === 'string' && MAC_PATTERN.test(value); }
function isValidHost(value) {
  return typeof value === 'string' && (/^[0-9.]+$/.test(value) ? isValidIpv4(value) : HOSTNAME_PATTERN.test(value));
}
function checkNodeVersion() {
  if (!nodeVersionAtLeast(process.version, [26, 0, 0])) {
    throw new StartupError('node_version_unsupported',
      `Node.js 26.0.0 or newer is required, running ${process.version}`,
      'install Node.js 26.0.0 or newer');
  }
}
function configPath() { return path.join(os.homedir(), '.harness-plugin', 'wake-desktop', 'config.json'); }
function configError(code, condition, remedy = `correct the configuration at ${configPath()} while preserving existing targets`) {
  return new StartupError(code, `${configPath()}: ${condition}`, remedy);
}
function validName(name) { return typeof name === 'string' && name.length > 0 && name.trim() === name; }
function validateName(name) {
  if (!validName(name)) throw configError('target_config_invalid', `invalid target name ${JSON.stringify(name)}`);
}
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validateTarget(name, target) {
  validateName(name);
  if (!isObject(target) || !isValidHost(target.ip) || !isValidMac(target.mac)) {
    throw configError('target_config_invalid', `target ${JSON.stringify(name)} requires a valid string ip and mac`);
  }
}
function validateRegistry(config, full = true) {
  if (!isObject(config)) throw configError('target_config_invalid', 'root must be an object');
  if (config.schema_version !== 1) throw configError('target_config_version_unsupported',
    `unsupported schema_version ${JSON.stringify(config.schema_version)}, expected numeric 1`);
  if (!isObject(config.targets)) throw configError('target_config_invalid', 'targets must be an object');
  if (full) for (const [name, target] of Object.entries(config.targets)) validateTarget(name, target);
  return config;
}
function loadConfig({ missingAllowed = true, full = true } = {}) {
  let raw;
  try { raw = fs.readFileSync(configPath(), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') {
      if (missingAllowed) return { schema_version: 1, targets: {} };
      throw configError('target_config_missing', 'configuration does not exist', 'register the requested target with manage-targets.js register --name NAME --ip HOST --mac MAC');
    }
    throw configError('target_config_unreadable', `cannot read configuration: ${error.message}`,
      `restore read access to ${configPath()}`);
  }
  let config;
  try { config = JSON.parse(raw); }
  catch (error) { throw configError('target_config_invalid', `invalid JSON: ${error.message}`); }
  return validateRegistry(config, full);
}
function selectTarget(config, name) {
  validateName(name);
  if (!Object.hasOwn(config.targets, name)) throw configError('target_unknown', `unknown target ${JSON.stringify(name)}`,
    'run manage-targets.js list --json to find registered names');
  validateTarget(name, config.targets[name]);
  return config.targets[name];
}
function loadTarget(name) {
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
function saveConfig(config) {
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
      catch (failure) { cleanup = `; temporary cleanup failed at ${temporary}: ${failure.message}`; }
    }
    throw configError('target_config_write_failed', `cannot publish configuration: ${error.message}${cleanup}`,
      `restore write access to ${path.dirname(destination)} and retry the command`);
  }
}
module.exports = { StartupError, isValidIpv4, isValidMac, isValidHost, nodeVersionAtLeast,
  checkNodeVersion, reportError, configPath, configError, validName, validateName,
  validateTarget, validateRegistry, loadConfig, selectTarget, loadTarget, saveConfig };
