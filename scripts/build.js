#!/usr/bin/env node
'use strict';

// Repository-only assembly. Reconciliation stays in place because a selected
// artifact may contain mounted dependency/cache overlays.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  TARGETS,
  DEFAULT_TARGET,
  ArtifactArgumentError,
  validateTarget,
  artifactRoot,
  parseArtifactTarget,
  assertReleaseWriteIntent,
} = require('./artifact-paths');
const templates = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];
const assetExtensions = new Set(['.md', '.json', '.jsonl', '.yaml', '.yml', '.py', '.swift']);
const backupModules = 'skills/back-up-directories/node_modules';
const pythonCache = /^skills\/write-asd-ste100\/scripts\/__pycache__$/;
const mode = stat => stat.mode & 0o111 ? 0o755 : 0o644;
const exists = file => { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

function directory(file) {
  const stat = exists(file);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Expected a real directory: ${file}`);
}

function inventory(root, { overlays = false, missing = false } = {}) {
  directory(root);
  if (!exists(root)) {
    if (missing) return new Map();
    throw new Error(`Missing tree: ${root}`);
  }
  const files = new Map();
  const folded = new Map();
  function walk(relative) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const key = relative ? `${relative}/${name}` : name;
      const absolute = path.join(root, key);
      const stat = fs.lstatSync(absolute);
      const lower = key.normalize('NFC').toLowerCase();
      if (folded.has(lower)) throw new Error(`Case-colliding paths: ${folded.get(lower)} and ${key}`);
      folded.set(lower, key);
      if (stat.isSymbolicLink()) throw new Error(`Symlink is not permitted: ${absolute}`);
      if (overlays && (key === backupModules || pythonCache.test(key))) {
        if (!stat.isDirectory()) throw new Error(`Local overlay must be a directory: ${absolute}`);
        continue;
      }
      if (stat.isDirectory()) walk(key);
      else if (stat.isFile()) files.set(key, { absolute, mode: mode(stat) });
      else throw new Error(`Unsupported filesystem entry: ${absolute}`);
    }
  }
  walk('');
  return files;
}

function classify(relative) {
  if (relative.endsWith('.local.json')) throw new Error(`Local configuration is not distributable: ${relative}`);
  if (relative.split('/').some(part => ['node_modules', '__pycache__', 'tests', 'fixtures', 'benchmarks', 'evidence', '.git', '.build', '.venv', 'generated'].includes(part))) {
    throw new Error(`Development/local resource is not distributable: ${relative}`);
  }
  if (templates.includes(relative)) return 'template';
  if (/\.(?:ts|mts|cts)$/.test(relative)) return 'typescript';
  if (assetExtensions.has(path.extname(relative))) return 'asset';
  throw new Error(`Unclassified source resource: ${relative}`);
}

function outputPath(relative) {
  if (/\.d\.(?:ts|mts|cts)$/.test(relative)) return null;
  return relative.replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs').replace(/\.ts$/, '.js');
}

function validatePaths(files) {
  for (const relative of files.keys()) {
    if (relative.endsWith('.local.json')) throw new Error(`Forbidden local configuration: ${relative}`);
    if (/\.(?:js|mjs|cjs)$/.test(relative)) {
      if (!/^(?:shared\/node\/|skills\/[^/]+\/scripts\/)/.test(relative)) throw new Error(`Unexpected JavaScript: ${relative}`);
    } else if (!assetExtensions.has(path.extname(relative))) throw new Error(`Forbidden artifact file: ${relative}`);
    if (relative.split('/').some(part => ['node_modules', '__pycache__', 'tests', 'fixtures', 'benchmarks', 'evidence', '.git', '.build', '.venv', 'generated'].includes(part))) throw new Error(`Forbidden artifact path: ${relative}`);
  }
}

function validateArtifact(root) {
  const files = inventory(root, { overlays: true });
  validatePaths(files);
  const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
  const pkg = read('package.json');
  if (pkg.name !== 'harness' || pkg.type !== 'commonjs' || pkg.private !== true || !/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.engines || pkg.dependencies || pkg.devDependencies) throw new Error('Invalid plugin package/version boundary');
  for (const template of templates) {
    const manifest = read(template);
    if (manifest.name !== pkg.name || manifest.version !== pkg.version) throw new Error(`Manifest version/name mismatch: ${template}`);
  }
  if (read('.codex-plugin/plugin.json').skills !== './skills/') throw new Error('Invalid Codex skills scope');
  return files;
}

function compare(expected, actual) {
  const differences = [];
  for (const [name, entry] of expected) {
    const other = actual.get(name);
    if (!other) differences.push(`Missing: ${name}`);
    else {
      if (entry.mode !== other.mode) differences.push(`Mode: ${name}`);
      if (!fs.readFileSync(entry.absolute).equals(fs.readFileSync(other.absolute))) differences.push(`Modified: ${name}`);
    }
  }
  for (const name of actual.keys()) if (!expected.has(name)) differences.push(`Unexpected: ${name}`);
  return differences;
}

function assemble(root, stage) {
  const source = path.join(root, 'src/harness');
  const files = inventory(source);
  const destinations = new Map();
  for (const [relative, entry] of files) {
    const kind = classify(relative);
    const output = kind === 'typescript' ? outputPath(relative) : relative;
    if (output === null) continue;
    const folded = output.normalize('NFC').toLowerCase();
    if (destinations.has(folded)) throw new Error(`Output collision: ${relative} and ${destinations.get(folded).relative}`);
    destinations.set(folded, { relative, entry, kind, output });
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  for (const template of templates) {
    const data = JSON.parse(fs.readFileSync(path.join(source, template), 'utf8'));
    if (Object.hasOwn(data, 'version')) throw new Error(`Source manifest must not own a version: ${template}`);
  }
  if (!fs.existsSync(path.join(root, 'node_modules/.bin/tsc'))) throw new Error('Local TypeScript compiler missing. Run npm ci --include=dev');
  const compiled = path.join(stage, 'compiled');
  const result = spawnSync('npm', ['run', '--silent', 'compile', '--', '--outDir', compiled], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Compilation failed: ${result.error?.message || result.stdout + result.stderr}`);
  const emitted = inventory(path.join(compiled, 'harness'), { missing: true });
  const candidate = path.join(stage, 'candidate');
  fs.mkdirSync(candidate);
  const consumed = new Set();
  for (const { relative, entry, kind, output } of destinations.values()) {
    const target = path.join(candidate, output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (kind === 'template') {
      const data = JSON.parse(fs.readFileSync(entry.absolute, 'utf8'));
      fs.writeFileSync(target, `${JSON.stringify({ ...data, version: pkg.version }, null, 2)}\n`);
    } else {
      const input = kind === 'typescript' ? emitted.get(output)?.absolute : entry.absolute;
      if (!input) throw new Error(`Missing compiler output: ${output}`);
      fs.copyFileSync(input, target);
      if (kind === 'typescript') consumed.add(output);
      const sourceBytes = fs.readFileSync(entry.absolute);
      if (sourceBytes.subarray(0, 2).toString() === '#!' && !fs.readFileSync(target).subarray(0, 2).equals(sourceBytes.subarray(0, 2))) throw new Error(`Lost shebang: ${relative}`);
    }
    fs.chmodSync(target, entry.mode);
  }
  for (const output of emitted.keys()) if (!consumed.has(output)) throw new Error(`Unexpected compiler output: ${output}`);
  validateArtifact(candidate);
  return candidate;
}

function reconcile(candidate, destination) {
  const wanted = inventory(candidate);
  const current = inventory(destination, { overlays: true, missing: true });
  validatePaths(current);
  // Inspect every ancestor before any write so an unexpected file or link cannot
  // redirect publication. Existing regular files are owned by the generated tree.
  for (const name of wanted.keys()) {
    let parent = path.dirname(name);
    while (parent !== '.') { directory(path.join(destination, parent)); parent = path.dirname(parent); }
    const target = exists(path.join(destination, name));
    if (target && !target.isFile()) throw new Error(`Output is not a regular file: ${name}`);
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const [name, entry] of wanted) {
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(entry.absolute, target);
    fs.chmodSync(target, entry.mode);
  }
  for (const [name, entry] of current) if (!wanted.has(name)) fs.unlinkSync(entry.absolute);
  function prune(relative) {
    for (const entry of fs.readdirSync(path.join(destination, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (child === backupModules || pythonCache.test(child)) continue;
      if (entry.isDirectory()) {
        prune(child);
        if (!fs.readdirSync(path.join(destination, child)).length) fs.rmdirSync(path.join(destination, child));
      }
    }
  }
  prune('');
  const differences = compare(wanted, validateArtifact(destination));
  if (differences.length) throw new Error(`Artifact verification failed:\n${differences.join('\n')}`);
}

function validateBuildOptions(options)
{
  if (options === null || typeof options !== 'object' || Array.isArray(options))
  {
    throw new TypeError('build options must be an object');
  }
  const unexpected = Object.keys(options).filter(key => !['target', 'check'].includes(key));
  if (unexpected.length)
  {
    throw new TypeError(`unknown build option: ${unexpected[0]}`);
  }
  const target = validateTarget(options.target ?? DEFAULT_TARGET);
  const check = options.check ?? false;
  if (typeof check !== 'boolean')
  {
    throw new TypeError('build check option must be a boolean');
  }
  return { target, check };
}

function prepareBuildPaths(root, target)
{
  root = path.resolve(root);
  directory(root);
  directory(path.join(root, 'src'));
  const buildDirectory = path.join(root, '.build');
  directory(buildDirectory);
  fs.mkdirSync(buildDirectory, { recursive: true });

  const destination = artifactRoot(root, target);
  const source = path.join(root, 'src/harness');
  const otherTarget = target === 'development' ? 'distribution' : 'development';
  const otherDestination = artifactRoot(root, otherTarget);
  if (destination === source || destination === otherDestination)
  {
    throw new Error(`Invalid ${target} artifact destination: ${destination}`);
  }

  let ancestor = root;
  for (const component of TARGETS[target].split('/'))
  {
    ancestor = path.join(ancestor, component);
    directory(ancestor);
  }
  return { root, buildDirectory, destination };
}

function build(root, options = {})
{
  const { target, check } = validateBuildOptions(options);
  const paths = prepareBuildPaths(root, target);
  const lock = path.join(paths.buildDirectory, `${target}.lock`);
  let locked = false;
  let stage;
  try
  {
    if (!check)
    {
      try
      {
        fs.mkdirSync(lock);
        locked = true;
      }
      catch (error)
      {
        if (error.code === 'EEXIST')
        {
          throw new Error(`Artifact build already locked: ${lock}. Confirm the other build stopped before removing the lock.`);
        }
        throw error;
      }
    }
    stage = fs.mkdtempSync(path.join(paths.buildDirectory, `stage-${target}-`));
    const candidate = assemble(paths.root, stage);
    if (check)
    {
      const differences = compare(inventory(candidate), inventory(paths.destination, { overlays: true, missing: true }));
      if (differences.length)
      {
        const label = target === 'development' ? 'Development artifact' : 'Published distribution';
        const remedy = target === 'development'
          ? 'npm run build'
          : 'use the main-branch release workflow; do not rebuild tracked output locally';
        throw new Error(`${label} is stale:\n${differences.join('\n')}\nRemedy: ${remedy}`);
      }
      validateArtifact(paths.destination);
    }
    else
    {
      reconcile(candidate, paths.destination);
    }
  }
  finally
  {
    if (stage)
    {
      fs.rmSync(stage, { recursive: true, force: true });
    }
    if (locked)
    {
      fs.rmdirSync(lock);
    }
  }
}

const USAGE = `Usage: node scripts/build.js [--target development|distribution] [--check]

Build the development artifact by default. A distribution-writing build is reserved
for the main-branch release workflow. Check mode compares without repairing output.`;

function parseArguments(argv)
{
  const parsed = parseArtifactTarget(argv);
  let check = false;
  let help = false;
  for (const argument of parsed.remaining)
  {
    if (argument === '--check')
    {
      if (check)
      {
        throw new ArtifactArgumentError('DUPLICATE_CHECK', '--check was supplied more than once', 'supply --check once');
      }
      check = true;
    }
    else if (argument === '--help' || argument === '-h')
    {
      if (help)
      {
        throw new ArtifactArgumentError('DUPLICATE_HELP', 'help was supplied more than once', 'supply --help once');
      }
      help = true;
    }
    else
    {
      throw new ArtifactArgumentError('UNKNOWN_ARGUMENT', `unrecognized argument: ${argument}`, 'node scripts/build.js --help');
    }
  }
  if (help && (check || parsed.explicitTarget))
  {
    throw new ArtifactArgumentError('INVALID_ARGUMENTS', '--help cannot be combined with build options', 'node scripts/build.js --help');
  }
  return { target: parsed.target, check, help };
}

function main(argv, env = process.env)
{
  try
  {
    const options = parseArguments(argv);
    if (options.help)
    {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (options.target === 'distribution' && !options.check)
    {
      assertReleaseWriteIntent(env);
    }
    build(path.resolve(__dirname, '..'), { target: options.target, check: options.check });
    process.stdout.write(`${options.target === 'development' ? 'Development artifact' : 'Distribution'} ${options.check ? 'check' : 'build'} passed.\n`);
    return 0;
  }
  catch (error)
  {
    if (error instanceof ArtifactArgumentError)
    {
      process.stderr.write(`ERROR [${error.code}]: ${error.message}\nRemedy: ${error.remedy}\n`);
      return error.exitCode;
    }
    process.stderr.write(`ERROR [build_failed]: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module)
{
  process.exitCode = main(process.argv.slice(2));
}
module.exports = {
  build,
  assemble,
  inventory,
  validateArtifact,
  compare,
  reconcile,
  outputPath,
  classify,
  prepareBuildPaths,
  parseArguments,
  main,
};
