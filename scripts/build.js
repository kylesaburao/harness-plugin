#!/usr/bin/env node
'use strict';

// Development-only assembly. Publication is an in-place reconciliation because
// a dependency directory inside dist may be a mounted volume.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const transitional = new Set(require('./transitional-javascript.json'));
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
  if (transitional.has(relative)) return 'javascript';
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
  for (const allowed of transitional) if (!files.has(allowed)) throw new Error(`Remove stale transitional JavaScript entry: ${allowed}`);
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
  if (differences.length) throw new Error(`Publication verification failed:\n${differences.join('\n')}`);
}

function build(root, check = false) {
  directory(path.join(root, 'src'));
  directory(path.join(root, 'dist'));
  directory(path.join(root, '.build'));
  fs.mkdirSync(path.join(root, '.build'), { recursive: true });
  const lock = path.join(root, '.build/publication.lock');
  let locked = false;
  let stage;
  try {
    if (!check) {
      try { fs.mkdirSync(lock); locked = true; }
      catch (error) { if (error.code === 'EEXIST') throw new Error(`Build publication already locked: ${lock}. Confirm the other build stopped before removing the lock.`); throw error; }
    }
    stage = fs.mkdtempSync(path.join(root, '.build/stage-'));
    const candidate = assemble(root, stage);
    const destination = path.join(root, 'dist/harness');
    if (check) {
      const differences = compare(inventory(candidate), inventory(destination, { overlays: true, missing: true }));
      if (differences.length) throw new Error(`Distribution is stale:\n${differences.join('\n')}\nRemedy: npm run build`);
      validateArtifact(destination);
    } else reconcile(candidate, destination);
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    if (locked) fs.rmdirSync(lock);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== '--check')) { process.stderr.write('Usage: node scripts/build.js [--check]\n'); process.exitCode = 2; }
  else {
    try { build(path.resolve(__dirname, '..'), args.includes('--check')); process.stdout.write(`Distribution ${args.includes('--check') ? 'check' : 'build'} passed.\n`); }
    catch (error) { process.stderr.write(`ERROR [build_failed]: ${error.message}\n`); process.exitCode = 1; }
  }
}
module.exports = { build, assemble, inventory, validateArtifact, compare, reconcile, outputPath, classify };
