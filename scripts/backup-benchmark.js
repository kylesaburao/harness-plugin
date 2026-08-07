#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const archiver = require('archiver');

const {
  OperationContext,
  backupFilenamePattern,
  copyAtomically,
  createArchive,
  measureDirectoryStorage,
} = require('../src/backup/backup');

const SCRIPT = path.resolve(__dirname, '../src/backup/backup.js');
const LOCATION_TYPES = new Set(['local-ssd', 'external-disk', 'google-drive']);

function usage() {
  console.error('Usage: node scripts/backup-benchmark.js <manifest.json> <results.json>');
}

function elapsedMilliseconds(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function cpuMilliseconds(usage) {
  return (usage.user + usage.system) / 1_000;
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { exitCode, stdout, stderr };
}

function deterministicPayload(bytes, seed) {
  const payload = Buffer.alloc(bytes);
  const repeated = Buffer.from(JSON.stringify({ event: 'backup-benchmark', value: 'representative text and metadata' }) + '\n');
  for (let offset = 0; offset < Math.floor(bytes / 2); offset += repeated.length) {
    repeated.copy(payload, offset, 0, Math.min(repeated.length, Math.floor(bytes / 2) - offset));
  }
  let state = seed >>> 0;
  for (let offset = Math.floor(bytes / 2); offset < bytes; offset += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    payload[offset] = state & 0xff;
  }
  return payload;
}

async function createCorpus(directory, corpus) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  for (let index = 0; index < corpus.fileCount; index += 1) {
    await fsp.writeFile(
      path.join(directory, `payload-${String(index).padStart(4, '0')}.bin`),
      deterministicPayload(corpus.bytesPerFile, index + 1),
      { mode: 0o600 },
    );
  }
}

async function directoryDetails(directory, label) {
  const canonicalPath = await fsp.realpath(directory);
  const details = await fsp.stat(canonicalPath, { bigint: true });
  return { label, configuredPath: directory, canonicalPath, identity: `${details.dev}:${details.ino}` };
}

async function timedMeasurement(directory, concurrency) {
  const start = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  const value = await measureDirectoryStorage(directory, backupFilenamePattern(), { concurrency });
  return {
    concurrency,
    wallMs: elapsedMilliseconds(start),
    cpuMs: cpuMilliseconds(process.cpuUsage(cpuStart)),
    totalBytes: value.totalBytes.toString(),
    backupBytes: value.backupBytes.toString(),
    backupCount: value.backupCount,
  };
}

async function compressionTrial(sourceDirectory, targetDirectory, level) {
  const archivePath = path.join(targetDirectory, `.compression-level-${level}-${crypto.randomUUID()}.zip`);
  const context = new OperationContext();
  const start = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  await createArchive(sourceDirectory, archivePath, context, {
    archiveFactory: (format) => archiver(format, { zlib: { level } }),
  });
  const wallMs = elapsedMilliseconds(start);
  const cpuMs = cpuMilliseconds(process.cpuUsage(cpuStart));
  const archiveBytes = (await fsp.stat(archivePath)).size;
  const zipTest = await run('unzip', ['-tqq', archivePath]);
  await fsp.rm(archivePath, { force: true });
  context.untrack(archivePath);
  if (zipTest.exitCode !== 0) throw new Error(`Compression level ${level} produced an invalid ZIP.`);
  return { level, wallMs, cpuMs, archiveBytes, zipValid: true };
}

function parsePortableTime(stderr) {
  const read = (label) => Number(stderr.match(new RegExp(`^${label}\\s+([0-9.]+)$`, 'm'))?.[1]);
  const userSeconds = read('user');
  const systemSeconds = read('sys');
  return {
    cpuMs: Number.isFinite(userSeconds) && Number.isFinite(systemSeconds)
      ? (userSeconds + systemSeconds) * 1_000
      : null,
  };
}

async function runPair(source, target, runRoot) {
  const pairId = `${source.name}-to-${target.name}`.replace(/[^a-z0-9._-]/gi, '-');
  const targetDirectory = path.join(target.workspace, `target-${crypto.randomUUID()}`);
  await fsp.mkdir(targetDirectory, { mode: 0o700 });
  const configPath = path.join(runRoot, `${pairId}.json`);
  const lockPath = path.join(runRoot, `${pairId}.lock`);
  await fsp.writeFile(configPath, JSON.stringify({
    sourceDirectory: source.sourceDirectory,
    outputDirectory: targetDirectory,
    targetDirectories: [targetDirectory],
  }));

  const start = process.hrtime.bigint();
  const timed = await run('/usr/bin/time', ['-p', process.execPath, SCRIPT, configPath], {
    env: { ...process.env, BACKUP_LOCK_PATH: lockPath },
    input: 'yes\n',
  });
  const cliWallMs = elapsedMilliseconds(start);
  if (timed.exitCode !== 0) {
    throw new Error(`${pairId} failed with exit ${timed.exitCode}: ${timed.stderr.trim()}`);
  }
  const entries = await fsp.readdir(targetDirectory);
  const archiveName = entries.find((entry) => entry.endsWith('.zip'));
  if (!archiveName) throw new Error(`${pairId} did not produce a ZIP archive.`);
  const archivePath = path.join(targetDirectory, archiveName);
  const archiveDetails = await fsp.stat(archivePath);
  const zipTest = await run('unzip', ['-tqq', archivePath]);
  if (zipTest.exitCode !== 0) throw new Error(`${pairId} produced an invalid ZIP: ${zipTest.stderr.trim()}`);
  const measuredDirectory = await directoryDetails(targetDirectory, target.name);
  const compressionTrials = [
    await compressionTrial(source.sourceDirectory, targetDirectory, 6),
    await compressionTrial(source.sourceDirectory, targetDirectory, 9),
  ];

  return {
    source: source.name,
    sourceType: source.type,
    target: target.name,
    targetType: target.type,
    sourceHydration: source.hydration,
    cliWallMs,
    cpuMs: parsePortableTime(timed.stderr).cpuMs,
    archiveBytes: archiveDetails.size,
    archiveMode: process.platform === 'win32' ? null : (archiveDetails.mode & 0o777).toString(8).padStart(4, '0'),
    zipValid: true,
    compressionTrials,
    uploadObservation: target.type === 'google-drive'
      ? { completedAfterCliMs: null, method: 'not observable by the CLI; record provider confirmation manually' }
      : { completedAfterCliMs: 0, method: 'local filesystem completion' },
    metadataMeasurements: [
      await timedMeasurement(measuredDirectory, 1),
      await timedMeasurement(measuredDirectory, 8),
    ],
  };
}

async function copyTrial(archivePath, targets, parallel) {
  const trialTargets = [];
  for (const target of targets) {
    const directoryPath = path.join(target.workspace, `copy-trial-${parallel ? 'parallel' : 'serial'}-${crypto.randomUUID()}`);
    await fsp.mkdir(directoryPath, { mode: 0o700 });
    const directory = await directoryDetails(directoryPath, target.name);
    trialTargets.push({
      root: directoryPath,
      target: { directory, destination: path.join(directoryPath, 'benchmark.zip') },
    });
  }
  const context = new OperationContext();
  const start = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  try {
    if (parallel) {
      await Promise.all(trialTargets.map(({ target }) => copyAtomically(archivePath, target, context)));
    } else {
      for (const { target } of trialTargets) await copyAtomically(archivePath, target, context);
    }
    return { wallMs: elapsedMilliseconds(start), cpuMs: cpuMilliseconds(process.cpuUsage(cpuStart)) };
  } finally {
    await Promise.allSettled(trialTargets.map(({ root }) => fsp.rm(root, { recursive: true, force: true })));
    await context.cleanup();
  }
}

async function evaluateParallelCopies(source, targets, runRoot) {
  if (targets.length < 2) return null;
  const archivePath = path.join(runRoot, `copy-source-${crypto.randomUUID()}.zip`);
  const context = new OperationContext();
  await createArchive(source.sourceDirectory, archivePath, context);
  try {
    const serial = await copyTrial(archivePath, targets, false);
    const parallel = await copyTrial(archivePath, targets, true);
    const improvementPercent = ((serial.wallMs - parallel.wallMs) / serial.wallMs) * 100;
    return {
      source: source.name,
      targets: targets.map((target) => ({ name: target.name, type: target.type })),
      serial,
      parallel,
      improvementPercent,
      meaningfulBenefit: improvementPercent >= 10,
      decisionThresholdPercent: 10,
    };
  } finally {
    await fsp.rm(archivePath, { force: true });
    context.untrack(archivePath);
  }
}

async function validateManifest(manifest) {
  if (manifest.version !== 1) throw new Error('Manifest version must be 1.');
  if (!Array.isArray(manifest.locations) || manifest.locations.length === 0) {
    throw new Error('Manifest locations must be a non-empty array.');
  }
  for (const location of manifest.locations) {
    if (!location.name || !LOCATION_TYPES.has(location.type) || !path.isAbsolute(location.root)) {
      throw new Error('Each location requires a name, supported type, and absolute root.');
    }
    if (location.sourcePath !== undefined && !path.isAbsolute(location.sourcePath)) {
      throw new Error('location.sourcePath must be absolute when provided.');
    }
  }
  const corpus = manifest.corpus || {};
  if (!Number.isSafeInteger(corpus.fileCount) || corpus.fileCount < 1 ||
      !Number.isSafeInteger(corpus.bytesPerFile) || corpus.bytesPerFile < 1) {
    throw new Error('corpus.fileCount and corpus.bytesPerFile must be positive integers.');
  }
}

async function main() {
  if (process.argv.length !== 4) {
    usage();
    process.exitCode = 2;
    return;
  }
  const manifestPath = path.resolve(process.argv[2]);
  const resultsPath = path.resolve(process.argv[3]);
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await validateManifest(manifest);
  const runRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'backup-benchmark-run-'));
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: { platform: process.platform, release: os.release(), node: process.version },
    corpus: manifest.corpus,
    unavailableLocations: [],
    pairs: [],
    parallelCopyEvaluations: [],
    notes: [
      'Synthetic cloud corpora are generated and therefore cached. Use a pre-evicted corpus and mark hydration cold for a cold Google Drive trial.',
      'Google Drive upload completion is provider state and is not treated as complete at CLI return without a separate observation.',
    ],
  };
  const available = [];
  try {
    for (const location of manifest.locations) {
      try {
        const details = await fsp.stat(location.root);
        if (!details.isDirectory()) throw new Error('not a directory');
        await fsp.access(location.root, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
        const workspace = path.join(location.root, `.backup-benchmark-${crypto.randomUUID()}`);
        await fsp.mkdir(workspace, { mode: 0o700 });
        const sourceDirectory = location.sourcePath || path.join(workspace, 'source');
        if (location.sourcePath) {
          const sourceDetails = await fsp.stat(sourceDirectory);
          if (!sourceDetails.isDirectory()) throw new Error('sourcePath is not a directory');
        } else {
          await createCorpus(sourceDirectory, manifest.corpus);
        }
        available.push({
          ...location,
          workspace,
          sourceDirectory,
          hydration: location.hydration || (location.type === 'google-drive' ? 'generated-cached' : 'not-applicable'),
        });
      } catch (error) {
        result.unavailableLocations.push({ name: location.name, type: location.type, reason: error.code || error.message });
      }
    }
    for (const source of available) {
      for (const target of available) {
        result.pairs.push(await runPair(source, target, runRoot));
      }
      const evaluation = await evaluateParallelCopies(source, available, runRoot);
      if (evaluation) result.parallelCopyEvaluations.push(evaluation);
    }
    await fsp.writeFile(resultsPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  } finally {
    await Promise.allSettled(available.map((location) => fsp.rm(location.workspace, { recursive: true, force: true })));
    await fsp.rm(runRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
