import fs = require('node:fs');
import fsp = require('node:fs/promises');
import os = require('node:os');
import path = require('node:path');
import crypto = require('node:crypto');

export interface BackupConfiguration {
  sourceDirectory: string;
  outputDirectory?: string;
  targetDirectories: string[];
}
export interface ValidatedDirectory {
  label: string;
  configuredPath: string;
  canonicalPath: string;
  identity: string;
}
export interface BackupTarget { directory: ValidatedDirectory; destination: string; action: string }
export interface BackupPlan {
  source: ValidatedDirectory;
  output: ValidatedDirectory & { createdDuringPreflight: boolean };
  targets: ValidatedDirectory[];
  filename: string;
  archivePath: string;
  archiveExists: boolean;
  retainArchive: boolean;
  previewTargets: BackupTarget[];
  copyTargets: BackupTarget[];
}
const MAX_FILENAME_BYTES = 255;
function errorDetails(error: unknown): { code?: unknown; message?: unknown } {
  return isObject(error) ? error : {};
}

function resolveConfigPath(value: string, configDirectory: string) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(configDirectory, value);
}

function comparablePath(value: string) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(parent: string, child: string) {
  const relative = path.relative(comparablePath(parent), comparablePath(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function identityOf(details: Pick<fs.BigIntStats, 'dev' | 'ino'>) {
  return `${details.dev}:${details.ino}`;
}

async function validateDirectory(configuredPath: string, label: string, accessMode: number): Promise<ValidatedDirectory> {
  let canonicalPath;
  let details;
  try {
    canonicalPath = await fsp.realpath(configuredPath);
    details = await fsp.stat(canonicalPath, { bigint: true });
  } catch (error) {
    throw new Error(`${label} does not exist or cannot be accessed: ${configuredPath} (${errorDetails(error).code || errorDetails(error).message})`);
  }
  if (!details.isDirectory()) {
    throw new Error(`${label} must be a directory: ${configuredPath}`);
  }
  try {
    await fsp.access(canonicalPath, accessMode);
  } catch (error) {
    const requirement = accessMode & fs.constants.W_OK && accessMode & fs.constants.R_OK
      ? 'readable, writable, and searchable so stale temporary files can be removed and files can be created and renamed'
      : accessMode & fs.constants.W_OK
        ? 'writable and searchable so files can be created and renamed'
      : 'readable and searchable so its contents can be enumerated';
    throw new Error(`${label} must be ${requirement}: ${configuredPath} (${errorDetails(error).code || errorDetails(error).message})`);
  }
  return {
    label,
    configuredPath,
    canonicalPath,
    identity: identityOf(details),
  };
}

async function inspectProspectiveDirectory(configuredPath: string, label: string) {
  try {
    return { exists: true, canonicalPath: await fsp.realpath(configuredPath) };
  } catch (error) {
    if (errorDetails(error).code !== 'ENOENT') {
      throw new Error(`${label} cannot be created or accessed: ${configuredPath} (${errorDetails(error).code || errorDetails(error).message})`);
    }
  }

  const missingComponents = [];
  let ancestor = configuredPath;
  while (true) {
    missingComponents.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
    try {
      const canonicalAncestor = await fsp.realpath(ancestor);
      return {
        exists: false,
        canonicalPath: path.join(canonicalAncestor, ...missingComponents),
      };
    } catch (error) {
      if (errorDetails(error).code !== 'ENOENT') {
        throw new Error(`${label} cannot be created or accessed: ${configuredPath} (${errorDetails(error).code || errorDetails(error).message})`);
      }
    }
  }
}

function assertOutputOutsideSource(source: ValidatedDirectory, outputPath: string, configuredPath: string) {
  if (isWithin(source.canonicalPath, outputPath)) {
    throw new Error(`outputDirectory must not resolve to sourceDirectory or one of its subdirectories: ${configuredPath} -> ${outputPath}`);
  }
}

async function validateOutputDirectory(configuredPath: string, source: ValidatedDirectory) {
  const prospective = await inspectProspectiveDirectory(configuredPath, 'outputDirectory');
  assertOutputOutsideSource(source, prospective.canonicalPath, configuredPath);

  if (prospective.exists) {
    let details;
    try {
      details = await fsp.stat(prospective.canonicalPath);
    } catch (error) {
      throw new Error(`outputDirectory cannot be accessed: ${configuredPath} (${errorDetails(error).code || errorDetails(error).message})`);
    }
    if (!details.isDirectory()) {
      throw new Error(`outputDirectory conflicts with an existing non-directory: ${configuredPath} (EEXIST)`);
    }
  } else {
    try {
      await fsp.mkdir(configuredPath, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new Error(`Cannot create outputDirectory: ${configuredPath} (${errorDetails(error).code || errorDetails(error).message})`);
    }
  }

  const output = await validateDirectory(
    configuredPath,
    'outputDirectory',
    fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
  );
  assertOutputOutsideSource(source, output.canonicalPath, configuredPath);
  return { ...output, createdDuringPreflight: !prospective.exists };
}

export async function assertDirectoryUnchanged(directory: ValidatedDirectory) {
  let canonicalPath;
  let details;
  try {
    canonicalPath = await fsp.realpath(directory.configuredPath);
    details = await fsp.stat(canonicalPath, { bigint: true });
  } catch (error) {
    throw new Error(`${directory.label} changed or became inaccessible after validation: ${directory.configuredPath} (${errorDetails(error).code || errorDetails(error).message})`);
  }
  if (!details.isDirectory() || comparablePath(canonicalPath) !== comparablePath(directory.canonicalPath) ||
      identityOf(details) !== directory.identity) {
    throw new Error(`${directory.label} no longer identifies the directory validated earlier: ${directory.configuredPath}`);
  }
}

function safeFolderName(folderName: string) {
  const safe = folderName.replaceAll(' ', '-').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/[. ]+$/g, '');
  return safe || 'Backup';
}

function truncateUtf8(value: string, maximumBytes: number) {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function backupFilename(sourceDirectory: string, now = new Date()) {
  const month = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(now);
  const day = String(now.getDate()).padStart(2, '0');
  const year = String(now.getFullYear());
  const name = safeFolderName(path.basename(sourceDirectory));
  const suffix = `_Backup_${month}${day}${year}.zip`;
  const candidate = `${name}${suffix}`;
  if (Buffer.byteLength(candidate) <= MAX_FILENAME_BYTES) return candidate;

  const digest = crypto.createHash('sha256').update(name).digest('hex').slice(0, 12);
  const marker = `-${digest}`;
  const prefixBudget = MAX_FILENAME_BYTES - Buffer.byteLength(marker) - Buffer.byteLength(suffix);
  return `${truncateUtf8(name, prefixBudget)}${marker}${suffix}`;
}

async function pathKind(destination: string, label: string) {
  try {
    const details = await fsp.stat(destination);
    if (details.isDirectory()) throw new Error(`${label} exists but is a directory: ${destination}`);
    return true;
  } catch (error) {
    if (errorDetails(error).code === 'ENOENT') return false;
    throw error;
  }
}

export async function readAndValidate(configPath: string, now = new Date()): Promise<BackupPlan> {
  let contents;
  try {
    contents = await fsp.readFile(configPath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read configuration file ${configPath}: ${errorDetails(error).code || errorDetails(error).message}`);
  }

  let config: unknown;
  try {
    config = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Configuration file contains invalid JSON: ${errorDetails(error).message}`);
  }
  validateConfiguration(config);

  const configDirectory = path.dirname(configPath);
  const sourceConfigured = resolveConfigPath(config.sourceDirectory, configDirectory);
  const outputConfigured = config.outputDirectory
    ? resolveConfigPath(config.outputDirectory, configDirectory)
    : os.tmpdir();
  const targetConfigured = config.targetDirectories.map((directory) => resolveConfigPath(directory, configDirectory));
  const source = await validateDirectory(sourceConfigured, 'sourceDirectory', fs.constants.R_OK | fs.constants.X_OK);
  const output = await validateOutputDirectory(outputConfigured, source);
  const targets = await Promise.all(targetConfigured.map((directory, index) =>
    validateDirectory(directory, `targetDirectories[${index}]`, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK)));

  for (const target of targets) {
    if (isWithin(source.canonicalPath, target.canonicalPath)) {
      throw new Error(`${target.label} must not resolve to sourceDirectory or one of its subdirectories: ${target.configuredPath} -> ${target.canonicalPath}`);
    }
  }

  const filename = backupFilename(source.canonicalPath, now);
  const archivePath = path.join(output.canonicalPath, filename);
  const retainArchive = targets.some((target) => target.identity === output.identity);
  const archiveExists = retainArchive ? await pathKind(archivePath, 'Archive output path') : false;
  const seen = new Map([[output.identity, 'outputDirectory']]);
  const previewTargets = [];
  const copyTargets = [];
  for (const target of targets) {
    const destination = path.join(target.canonicalPath, filename);
    const sharedWith = seen.get(target.identity);
    if (sharedWith) {
      previewTargets.push({ directory: target, destination, action: `shared with ${sharedWith}; no additional copy` });
      continue;
    }
    seen.set(target.identity, target.label);
    const exists = await pathKind(destination, 'Destination');
    const item = { directory: target, destination, action: exists ? 'will be overwritten' : 'will be created' };
    previewTargets.push(item);
    copyTargets.push(item);
  }

  return { source, output, targets, filename, archivePath, archiveExists, retainArchive, previewTargets, copyTargets };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validateConfiguration(config: unknown): asserts config is BackupConfiguration {
  if (!isObject(config)) {
    throw new Error('Configuration must be a JSON object.');
  }
  if (typeof config.sourceDirectory !== 'string' || !config.sourceDirectory.trim()) {
    throw new Error('"sourceDirectory" is required and must be a non-empty string.');
  }
  if (!Array.isArray(config.targetDirectories) || config.targetDirectories.length === 0 ||
      config.targetDirectories.some((directory) => typeof directory !== 'string' || !directory.trim())) {
    throw new Error('"targetDirectories" is required and must be a non-empty array of non-empty strings.');
  }
  if (config.outputDirectory !== undefined && (typeof config.outputDirectory !== 'string' || !config.outputDirectory.trim())) {
    throw new Error('"outputDirectory", when provided, must be a non-empty string.');
  }

}
