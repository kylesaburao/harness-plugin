'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.StartupError = void 0;
exports.errorDetails = errorDetails;
exports.isValidIpv4 = isValidIpv4;
exports.nodeVersionAtLeast = nodeVersionAtLeast;
exports.reportError = reportError;
exports.isValidMac = isValidMac;
exports.isValidHost = isValidHost;
exports.checkNodeVersion = checkNodeVersion;
exports.configPath = configPath;
exports.configError = configError;
exports.validName = validName;
exports.validateName = validateName;
exports.validateTarget = validateTarget;
exports.validateRegistry = validateRegistry;
exports.loadConfig = loadConfig;
exports.selectTarget = selectTarget;
exports.loadTarget = loadTarget;
exports.acquireConfigLock = acquireConfigLock;
exports.saveConfig = saveConfig;
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { randomUUID } = crypto;
function errorDetails(error) {
    const value = isObject(error) ? error : {};
    return { code: typeof value.code === 'string' ? value.code : undefined, condition: typeof value.condition === 'string' ? value.condition : undefined, message: typeof value.message === 'string' ? value.message : undefined, remedy: typeof value.remedy === 'string' ? value.remedy : undefined };
}
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
exports.StartupError = StartupError;
function isValidIpv4(value) {
    const match = IPV4_PATTERN.exec(value);
    if (!match)
        return false;
    return match.slice(1).every((part) => {
        if (part.length > 1 && part.startsWith('0'))
            return false;
        return Number(part) <= 255;
    });
}
function nodeVersionAtLeast(version, minimum) {
    const parts = version.replace(/^v/, '').split('.').map(Number);
    for (let index = 0; index < minimum.length; index += 1) {
        const part = parts[index] || 0;
        if (part > minimum[index])
            return true;
        if (part < minimum[index])
            return false;
    }
    return true;
}
function reportError(json, error) {
    const details = errorDetails(error);
    const body = {
        code: details.code || 'internal_error',
        condition: details.condition || details.message || String(error),
        remedy: details.remedy || 'run with --help and report this diagnostic if valid arguments still fail',
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
        throw new StartupError('node_version_unsupported', `Node.js 26.0.0 or newer is required, running ${process.version}`, 'install Node.js 26.0.0 or newer');
    }
}
function configPath() { return path.join(os.homedir(), '.harness-plugin', 'wake-desktop', 'config.json'); }
function configError(code, condition, remedy = `correct the configuration at ${configPath()} while preserving existing targets`) {
    return new StartupError(code, `${configPath()}: ${condition}`, remedy);
}
function validName(name) { return typeof name === 'string' && name.length > 0 && name.trim() === name; }
function validateName(name) {
    if (!validName(name))
        throw configError('target_config_invalid', `invalid target name ${JSON.stringify(name)}`);
}
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validateTarget(name, target) {
    validateName(name);
    if (!isObject(target) || !isValidHost(target.ip) || !isValidMac(target.mac)) {
        throw configError('target_config_invalid', `target ${JSON.stringify(name)} requires a valid string ip and mac`);
    }
}
function validateRegistry(config, full = true) {
    assertRegistry(config, full);
    return config;
}
function assertRegistry(config, full) {
    if (!isObject(config))
        throw configError('target_config_invalid', 'root must be an object');
    if (config.schema_version !== 1)
        throw configError('target_config_version_unsupported', `unsupported schema_version ${JSON.stringify(config.schema_version)}, expected numeric 1`);
    if (!isObject(config.targets))
        throw configError('target_config_invalid', 'targets must be an object');
    if (full)
        for (const [name, target] of Object.entries(config.targets))
            validateTarget(name, target);
}
function loadConfig({ missingAllowed = true, full = true } = {}) {
    let raw;
    try {
        raw = fs.readFileSync(configPath(), 'utf8');
    }
    catch (error) {
        if (errorDetails(error).code === 'ENOENT') {
            if (missingAllowed)
                return { schema_version: 1, targets: {} };
            throw configError('target_config_missing', 'configuration does not exist', 'register the requested target with manage-targets.js register --name NAME --ip HOST --mac MAC');
        }
        throw configError('target_config_unreadable', `cannot read configuration: ${errorDetails(error).message}`, `restore read access to ${configPath()}`);
    }
    let config;
    try {
        config = JSON.parse(raw);
    }
    catch (error) {
        throw configError('target_config_invalid', `invalid JSON: ${errorDetails(error).message}`);
    }
    return validateRegistry(config, full);
}
function selectTarget(config, name) {
    validateName(name);
    if (!Object.hasOwn(config.targets, name))
        throw configError('target_unknown', `unknown target ${JSON.stringify(name)}`, 'run manage-targets.js list --json to find registered names');
    const target = config.targets[name];
    validateTarget(name, target);
    return target;
}
function loadTarget(name) {
    try {
        return selectTarget(loadConfig({ missingAllowed: false, full: false }), name);
    }
    catch (error) {
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
// The management CLI owns the transaction, including the read before mutation.
function acquireConfigLock() {
    const lock = `${configPath()}.lock`;
    const recovery = `confirm no target configuration mutation is running, then run rmdir -- '${lock.replaceAll("'", "'\\''")}'`;
    let identity;
    try {
        fs.mkdirSync(path.dirname(lock), { recursive: true });
    }
    catch (error) {
        throw new StartupError('target_config_lock_failed', `${lock}: cannot prepare configuration directory: ${errorDetails(error).message}`, recovery);
    }
    try {
        fs.mkdirSync(lock);
    }
    catch (error) {
        const busy = errorDetails(error).code === 'EEXIST';
        throw new StartupError(busy ? 'target_config_busy' : 'target_config_lock_failed', `${lock}: ${busy ? 'another mutation holds the configuration lock' : `cannot acquire configuration lock: ${errorDetails(error).message}`}`, recovery);
    }
    try {
        identity = fs.lstatSync(lock);
    }
    catch (error) {
        // Without an identity it is unsafe to remove this directory.
        throw new StartupError('target_config_lock_cleanup_failed', `${lock}: cannot establish acquired lock ownership: ${errorDetails(error).message}`, recovery);
    }
    return (saved, operationFailure) => {
        try {
            const current = fs.lstatSync(lock);
            if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
                throw new Error('configuration lock ownership changed');
            }
            fs.rmdirSync(lock);
        }
        catch (error) {
            const previous = operationFailure === undefined ? ''
                : `; operation also failed: ${errorDetails(operationFailure).code || 'internal_error'}: ${errorDetails(operationFailure).condition || errorDetails(operationFailure).message || String(operationFailure)}`;
            throw new StartupError('target_config_lock_cleanup_failed', `${lock}: ${saved ? 'configuration was saved; ' : ''}cannot release configuration lock: ${errorDetails(error).message}${previous}`, recovery);
        }
    };
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
        try {
            fs.writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temporary, destination);
    }
    catch (error) {
        let cleanup = '';
        if (staged) {
            try {
                fs.unlinkSync(temporary);
            }
            catch (failure) {
                cleanup = `; temporary cleanup failed at ${temporary}: ${errorDetails(failure).message}`;
            }
        }
        throw configError('target_config_write_failed', `cannot publish configuration: ${errorDetails(error).message}${cleanup}`, `restore write access to ${path.dirname(destination)} and retry the command`);
    }
}
