const fs = require('node:fs');
const path = require('node:path');
const lock = path.join(process.env.HOME, '.harness-plugin/wake-desktop/config.json.lock');
const mode = process.env.LOCK_TEST_MODE;
const mkdir = fs.mkdirSync, rmdir = fs.rmdirSync, lstat = fs.lstatSync;
fs.mkdirSync = function(file, ...args) {
  if (file === lock && mode === 'acquire-fail') throw new Error('injected acquisition failure');
  return mkdir.call(this, file, ...args);
};
let acquired = false;
fs.lstatSync = function(file, ...args) {
  const stat = lstat.call(this, file, ...args);
  if (file === lock) {
    if (!acquired) {
      acquired = true;
      if (mode === 'hold') {
        fs.writeFileSync(process.env.LOCK_TEST_READY, 'ready');
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(process.env.LOCK_TEST_RELEASE)) {
          if (Date.now() > deadline) throw new Error('barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
    } else if (mode === 'ownership') {
      fs.renameSync(lock, `${lock}.original`);
      mkdir(lock);
      return lstat(lock);
    }
  }
  return stat;
};
fs.rmdirSync = function(file, ...args) {
  if (file === lock && mode === 'release-fail') throw new Error('injected release failure');
  return rmdir.call(this, file, ...args);
};
