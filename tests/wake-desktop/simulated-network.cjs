'use strict';
// Loaded only by test subprocesses. No UDP socket or real ping is created.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const dgram = require('node:dgram');
const cp = require('node:child_process');
const os = require('node:os');
const realSpawn = cp.spawn;
const scenario = process.env.WAKE_SCENARIO;
const trace = [];
const record = (event, details = {}) => trace.push({ event, time: performance.now(), ...details });
process.on('exit', () => fs.writeFileSync(process.env.WAKE_TRACE, JSON.stringify(trace)));
if (scenario === 'platform') os.platform = () => 'win32';
if (scenario === 'old-node') Object.defineProperty(process, 'version', { value: 'v25.9.9' });
dgram.createSocket = () => {
  record('socket');
  if (scenario === 'create') throw new Error('create failed');
  const socket = new EventEmitter();
  socket.bind = (_, callback) => {
    if (scenario === 'bind') throw new Error('bind failed');
    queueMicrotask(() => scenario === 'socket-error'
      ? socket.emit('error', new Error('socket failed')) : callback());
  };
  socket.setBroadcast = () => {
    record('broadcast');
    if (scenario === 'broadcast') throw new Error('setBroadcast failed');
  };
  socket.close = () => {
    record('close');
    if (scenario === 'late-socket-error') queueMicrotask(() => socket.emit('error', new Error('late error')));
    if (scenario === 'close') throw new Error('close failed');
    if (scenario === 'socket-error') {
      const error = new Error('not running');
      error.code = 'ERR_SOCKET_DGRAM_NOT_RUNNING';
      throw error;
    }
  };
  socket.send = (packet, offset, length, port, address, callback) => {
    record('send', { hex: packet.toString('hex'), offset, length, port, address });
    if (scenario === 'send-throw') throw new Error('send failed');
    queueMicrotask(() => {
      const failed = scenario === 'both-fail' || scenario === `fail-${port}`;
      callback(failed ? new Error('send failed') : null);
      if (scenario === 'duplicate') callback(new Error('duplicate callback'));
    });
  };
  return socket;
};
cp.spawn = (_, args) => {
  const host = args.at(-1);
  record('ping', { host });
  if (scenario === 'missing' || (scenario === 'target-error' && host !== '127.0.0.1')) {
    const error = new Error('missing ping');
    error.code = 'ENOENT';
    throw error;
  }
  if (scenario === 'hang' && host !== '127.0.0.1') {
    const child = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const kill = child.kill.bind(child);
    child.kill = (signal) => { record('kill', { signal }); return kill(signal); };
    child.on('close', () => record('reaped'));
    return child;
  }
  const child = new EventEmitter();
  if (scenario === 'spawn-error') {
    queueMicrotask(() => {
      child.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));
      child.emit('close', -1);
    });
    return child;
  }
  let timer;
  child.kill = () => {
    record('kill');
    clearTimeout(timer);
    queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    return true;
  };
  const target = host !== '127.0.0.1';
  const delay = target && scenario === 'late' ? 1100 : 0;
  timer = setTimeout(() => child.emit('close',
    scenario === 'loopback-fail' ? 1 : 0), delay);
  return child;
};

// Filesystem failure injection is scoped to target configuration publication.
if (scenario === 'mkdir-fail') fs.mkdirSync = () => { throw new Error('mkdir failed'); };
if (scenario === 'rename-fail') fs.renameSync = () => { throw new Error('rename failed'); };
if (scenario === 'write-fail') {
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (typeof file === 'number') {
      write(file, 'partial');
      throw new Error('staging write failed');
    }
    return write(file, ...args);
  };
}
