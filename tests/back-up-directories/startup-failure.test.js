const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
for (const failure of ['SyntaxError', 'Error']) for (const json of [true, false]) {
  test(`installed dependency ${failure} produces complete ${json ? 'JSON' : 'plain'} startup failure`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-startup-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const skill = path.join(root, "installed skill's path");
    fs.cpSync(require('../helpers/plugin-paths').artifactPath('skills/back-up-directories'), skill,
      { recursive: true, filter: source => path.basename(source) !== 'node_modules' });
    // The skill resolves archiver only from the user-level dependency directory.
    const home = path.join(root, 'home');
    const dependency = path.join(home, '.harness-plugin/back-up-directories/node_modules/archiver');
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(dependency, 'package.json'), '{"main":"index.js","type":"commonjs"}');
    fs.writeFileSync(path.join(dependency, 'index.js'), `throw new ${failure}('loader fixture failed');`);
    for (const name of ['source', 'target']) fs.mkdirSync(path.join(root, name));
    const config = path.join(root, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ sourceDirectory: './source', outputDirectory: './output', targetDirectories: ['./target'] }));
    for (const preflight of [true, false]) {
      const result = spawnSync(process.execPath, [path.join(skill, 'scripts/backup.js'),
        ...(preflight ? ['--preflight'] : []), ...(json ? ['--json'] : []), config],
        { encoding: 'utf8', timeout: 5000, env: { ...process.env, HOME: home, NODE_PATH: '', NODE_OPTIONS: '' } });
      assert.ifError(result.error);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      if (json) {
        const { error } = JSON.parse(result.stderr);
        assert.deepEqual(Object.keys(error).sort(), ['code', 'condition', 'remedy']);
        assert.equal(error.code, 'dependency_load_failed');
        for (const value of Object.values(error)) assert.equal(typeof value, 'string');
        assert.match(error.condition, /loader fixture failed/);
        assert.ok(error.remedy.includes("installed skill'\\''s path/package-lock.json'"));
      } else assert.match(result.stderr, /^ERROR \[dependency_load_failed\]: .*loader fixture failed\nRemedy: mkdir -p .+ && npm ci --omit=dev --prefix .+\n$/);
      assert.equal(fs.existsSync(path.join(root, 'output')), false);
      assert.deepEqual(fs.readdirSync(path.join(root, 'target')), []);
    }
  });
}

// The dependency directory is the only place archiver may come from. A package
// beside the installed skill (the pre-relocation location), in a parent
// node_modules, on NODE_PATH, or in a global folder must not satisfy it.
test('archiver outside the user-level dependency directory is reported missing', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backup-resolver-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skill = path.join(root, 'installed skill');
  fs.cpSync(require('../helpers/plugin-paths').artifactPath('skills/back-up-directories'), skill,
    { recursive: true, filter: source => path.basename(source) !== 'node_modules' });
  const home = path.join(root, 'home');
  const dependencyRoot = path.join(home, '.harness-plugin/back-up-directories');
  const nodePath = path.join(root, 'node-path');
  const plant = directory => {
    const dependency = path.join(directory, 'archiver');
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(dependency, 'package.json'), '{"main":"index.js","type":"commonjs"}');
    fs.writeFileSync(path.join(dependency, 'index.js'), 'exports.ZipArchive = function ZipArchive() {};');
  };
  for (const directory of [path.join(skill, 'node_modules'), path.join(home, 'node_modules'),
    path.join(home, '.harness-plugin/node_modules'), path.join(home, '.node_modules'), nodePath]) plant(directory);
  fs.mkdirSync(path.join(dependencyRoot, 'node_modules'), { recursive: true });
  const preflight = () => spawnSync(process.execPath, [path.join(skill, 'scripts/backup.js'), '--preflight', '--json'],
    { encoding: 'utf8', timeout: 5000, env: { ...process.env, HOME: home, NODE_PATH: nodePath, NODE_OPTIONS: '' } });
  const missing = preflight();
  assert.ifError(missing.error);
  assert.equal(missing.status, 2, missing.stderr);
  const { error } = JSON.parse(missing.stderr);
  assert.equal(error.code, 'dependency_missing');
  assert.ok(error.condition.includes(path.join(dependencyRoot, 'node_modules')));
  assert.equal(error.remedy, `mkdir -p '${dependencyRoot}'`
    + ` && cp '${path.join(skill, 'package.json')}' '${path.join(skill, 'package-lock.json')}' '${dependencyRoot}'`
    + ` && npm ci --omit=dev --prefix '${dependencyRoot}'`);
  plant(path.join(dependencyRoot, 'node_modules'));
  const ready = preflight();
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).status, 'ready');
});
