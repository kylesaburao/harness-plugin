'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const helper = path.join(repoRoot, 'scripts/setup-node');
const mockFunction = `nvm() {
  printf 'install:%s:%s:%s\n' "$#" "$*" "$PWD" >> "$BOOTSTRAP_LOG"
  if [ "\${INSTALL_STATUS:-0}" != 0 ]; then return "$INSTALL_STATUS"; fi
  IFS= read -r BOOTSTRAP_VERSION < .nvmrc
  export BOOTSTRAP_VERSION
}
`;

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-node-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'checkout with spaces');
  const bin = path.join(directory, 'bin');
  const nvm = path.join(directory, 'explicit nvm');
  for (const name of [path.join(root, 'scripts'), bin, nvm]) fs.mkdirSync(name, { recursive: true });
  const script = path.join(root, 'scripts/setup-node');
  fs.copyFileSync(helper, script);
  fs.writeFileSync(path.join(root, '.nvmrc'), '24\n');
  // A caller's version file must not redirect installation away from the checkout.
  fs.writeFileSync(path.join(directory, '.nvmrc'), '18\n');
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/bash
printf 'node:%s\n' "$*" >> "$BOOTSTRAP_LOG"
if [ "\${NODE_STATUS:-0}" != 0 ]; then exit "$NODE_STATUS"; fi
printf 'v%s.0.0\n' "\${BOOTSTRAP_VERSION:-system}"
`, { mode: 0o755 });
  const log = path.join(directory, 'events');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('BASH_FUNC_') || key.startsWith('NVM_') ||
      ['BASH_ENV', 'ENV', 'XDG_CONFIG_HOME', 'BOOTSTRAP_VERSION', 'INSTALL_STATUS', 'NODE_STATUS'].includes(key)) delete env[key];
  }
  Object.assign(env, { PATH: `${bin}:/usr/bin:/bin`, NVM_DIR: nvm, BOOTSTRAP_LOG: log });
  function initialize(destination = nvm, content = `printf 'source:%s:%s\n' "$#" "$*" >> "$BOOTSTRAP_LOG"\n${mockFunction}`) {
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'nvm.sh'), content);
  }
  function run(args = [], overrides = {}, shell = 'exec "$@"') {
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', shell, '_', script, ...args], {
      cwd: directory, env: { ...env, ...overrides }, encoding: 'utf8',
    });
    assert.ifError(result.error);
    const events = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    return { ...result, events };
  }
  return { root, directory, nvm, bin, env, initialize, run };
}

test('an inherited nvm function takes precedence over filesystem discovery', t => {
  const f = fixture(t);
  f.initialize(f.nvm, 'exit 91\n');
  const result = f.run([], {}, `${mockFunction}\nexport -f nvm\nexec "$@"`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, [`install:1:install:${f.root}`, 'node:--version']);
  assert.match(result.stdout, /v24\.0\.0/);
});

test('explicit unsourced nvm uses the checkout version from outside a path containing spaces', t => {
  const f = fixture(t);
  f.initialize();
  const xdg = path.join(f.directory, 'xdg');
  f.initialize(path.join(xdg, 'nvm'), 'exit 92\n');
  const result = f.run([], { XDG_CONFIG_HOME: xdg });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, ['source:1:--no-use', `install:1:install:${f.root}`, 'node:--version']);
  assert.match(result.stdout, /v24\.0\.0/);
  assert.match(result.stdout, /To activate in your terminal, load nvm, then run: cd .* && nvm use/);
});

test('XDG discovery loads conventional nvm when NVM_DIR is unset', t => {
  const f = fixture(t);
  const xdg = path.join(f.directory, 'xdg with spaces');
  f.initialize(path.join(xdg, 'nvm'));
  const result = f.run([], { NVM_DIR: undefined, XDG_CONFIG_HOME: xdg });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, ['source:1:--no-use', `install:1:install:${f.root}`, 'node:--version']);
});

test('missing nvm fails despite an available system Node', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR \[NVM_NOT_FOUND\]/);
  assert.match(result.stderr, /Remedy: install nvm manually/);
  assert.deepEqual(result.events, []);
});

test('initialization that does not define nvm fails clearly', t => {
  const f = fixture(t);
  f.initialize(f.nvm, 'printf "source-only\\n" >> "$BOOTSTRAP_LOG"\n');
  const result = f.run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /NVM_NOT_FOUND/);
  assert.deepEqual(result.events, ['source-only']);
});

test('initialization failure propagates without installation or version reporting', t => {
  const f = fixture(t);
  f.initialize(f.nvm, `${mockFunction}\nreturn 37\n`);
  const result = f.run();
  assert.equal(result.status, 37);
  assert.deepEqual(result.events, []);
});

test('installation failure propagates exactly and never invokes Node afterward', t => {
  const f = fixture(t);
  f.initialize();
  const result = f.run([], { INSTALL_STATUS: '43' });
  assert.equal(result.status, 43);
  assert.deepEqual(result.events, ['source:1:--no-use', `install:1:install:${f.root}`]);
  assert.doesNotMatch(result.stdout, /To activate|v.*\.0\.0/);
});

test('version-report failure remains a failure without activation advice', t => {
  const f = fixture(t);
  f.initialize();
  const result = f.run([], { NODE_STATUS: '47' });
  assert.equal(result.status, 47);
  assert.equal(result.events.at(-1), 'node:--version');
  assert.doesNotMatch(result.stdout, /To activate/);
});

for (const missing of [true, false]) {
  test(`${missing ? 'missing' : 'empty'} .nvmrc fails before initializing nvm`, t => {
    const f = fixture(t);
    f.initialize();
    if (missing) fs.unlinkSync(path.join(f.root, '.nvmrc'));
    else fs.writeFileSync(path.join(f.root, '.nvmrc'), '');
    const result = f.run();
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ERROR \[NVMRC_MISSING\]/);
    assert.deepEqual(result.events, []);
  });
}

test('help and invalid arguments do no initialization or installation', t => {
  const f = fixture(t);
  f.initialize(f.nvm, 'exit 99\n');
  fs.unlinkSync(path.join(f.root, '.nvmrc'));
  for (const args of [['--help'], ['-h'], ['--unknown'], ['--help', 'extra'], [''], ['install']]) {
    const result = f.run(args);
    const help = args.length === 1 && ['--help', '-h'].includes(args[0]);
    assert.equal(result.status, help ? 0 : 2, result.stderr);
    assert.match(help ? result.stdout : result.stderr, help ? /Usage: \.\/scripts\/setup-node/ : /ERROR \[INVALID_ARGUMENTS\]/);
    assert.deepEqual(result.events, []);
  }
});

test('executing the helper preserves the parent shell directory and environment', t => {
  const f = fixture(t);
  f.initialize();
  const result = f.run([], {}, `before_path=$PATH
before_directory=$PWD
before_nvm=$NVM_DIR
"$@" || exit "$?"
[ "$PATH" = "$before_path" ] && [ "$PWD" = "$before_directory" ] && [ "$NVM_DIR" = "$before_nvm" ] && [ -z "\${BOOTSTRAP_VERSION:-}" ]
`);
  assert.equal(result.status, 0, result.stderr);
});

test('repository runtime declarations agree and bootstrap retains executable mode', () => {
  assert.equal(fs.readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8'), '26\n');
  assert.equal(fs.statSync(path.join(repoRoot, '.nvmrc')).mode & 0o111, 0);
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.engines.node, '26.x');
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
  assert.equal(pkg.private, true);
  const docker = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
  assert.deepEqual([...docker.matchAll(/^FROM node:([^\s]+)/gm)].map(match => match[1]), ['26-trixie', '26-trixie']);
  assert.equal(fs.statSync(helper).mode & 0o777, 0o755);
});
