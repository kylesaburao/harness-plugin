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
    const dependency = path.join(skill, 'node_modules/archiver');
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(dependency, 'package.json'), '{"main":"index.js","type":"commonjs"}');
    fs.writeFileSync(path.join(dependency, 'index.js'), `throw new ${failure}('loader fixture failed');`);
    for (const name of ['source', 'target']) fs.mkdirSync(path.join(root, name));
    const config = path.join(root, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ sourceDirectory: './source', outputDirectory: './output', targetDirectories: ['./target'] }));
    for (const preflight of [true, false]) {
      const result = spawnSync(process.execPath, [path.join(skill, 'scripts/backup.js'),
        ...(preflight ? ['--preflight'] : []), ...(json ? ['--json'] : []), config], { encoding: 'utf8', timeout: 5000 });
      assert.ifError(result.error);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      if (json) {
        const { error } = JSON.parse(result.stderr);
        assert.deepEqual(Object.keys(error).sort(), ['code', 'condition', 'remedy']);
        assert.equal(error.code, 'dependency_load_failed');
        for (const value of Object.values(error)) assert.equal(typeof value, 'string');
        assert.match(error.condition, /loader fixture failed/);
        assert.ok(error.remedy.includes("installed skill'\\''s path'"));
      } else assert.match(result.stderr, /^ERROR \[dependency_load_failed\]: .*loader fixture failed\nRemedy: npm install .+\n$/);
      assert.equal(fs.existsSync(path.join(root, 'output')), false);
      assert.deepEqual(fs.readdirSync(path.join(root, 'target')), []);
    }
  });
}
