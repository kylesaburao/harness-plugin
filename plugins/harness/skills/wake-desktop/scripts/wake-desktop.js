#!/usr/bin/env node
'use strict';

const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { performance } = require('node:perf_hooks');

// Exit status contract, shared with the other scripts in this plugin:
//   0  the host is online, or the packet was sent with --no-wait
//   2  could not start: bad usage, missing dependency, invalid configuration
//   1  failure after a packet was sent
const EXIT = Object.freeze({
  OK: 0,
  UNREACHABLE: 1,
  CANNOT_START: 2,
});

const { StartupError, isValidIpv4, isValidMac, isValidHost, nodeVersionAtLeast,
  checkNodeVersion, reportError, loadTarget } = require('./target-config');
const BROADCAST_ADDRESS = '255.255.255.255';
const WOL_PORTS = Object.freeze([9, 7]);
const MAGIC_PACKET_BYTES = 102;
const DEFAULT_TIMEOUT_SECONDS = 120;
const PROBE_INTERVAL_MS = 1000;
const PROBE_TIMEOUT_SECONDS = 1;
const USAGE = `Usage: wake-desktop.js [OPTIONS]

Sends a Wake-on-LAN magic packet, then waits for the host to answer a ping.

Options:
      --target NAME      Use an exactly matching saved target
  -m, --mac MAC          Target MAC address, for example a1:b2:c3:d4:e5:f6
  -i, --ip HOST          Target IPv4 address or hostname to probe
  -t, --timeout SECONDS  How long to wait for the host (default ${DEFAULT_TIMEOUT_SECONDS})
      --no-wait          Send the packet and exit without waiting
      --preflight        Check the environment and arguments, send nothing, exit
      --json             Report the result and any error as JSON
  -h, --help             Print this message

Environment fallbacks, used when the matching flag is absent:
  Named targets ignore MAC_ADDRESS and IP_ADDRESS.
  MAC_ADDRESS, IP_ADDRESS, TIMEOUT

Exit status: 0 online or packet sent, 2 cannot start, 1 failure after sending.`;

function parseArguments(argv, env = {}) {
  const options = {
    target: null,
    mac: null,
    ip: null,
    timeout: null,
    wait: true,
    preflightOnly: false,
    json: false,
    help: false,
  };
  const takesValue = new Map([
    ['--target', 'target'],
    ['--mac', 'mac'],
    ['-m', 'mac'],
    ['--ip', 'ip'],
    ['-i', 'ip'],
    ['--timeout', 'timeout'],
    ['-t', 'timeout'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (takesValue.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new StartupError(
          'usage_error',
          `${argument} requires a value`,
          'run with --help to see the accepted options',
        );
      }
      options[takesValue.get(argument)] = value;
      index += 1;
      continue;
    }
    const equalsIndex = argument.indexOf('=');
    if (argument.startsWith('--') && equalsIndex > 2) {
      const flag = argument.slice(0, equalsIndex);
      if (takesValue.has(flag)) {
        options[takesValue.get(flag)] = argument.slice(equalsIndex + 1);
        continue;
      }
    }
    switch (argument) {
      case '--no-wait':
        options.wait = false;
        break;
      case '--preflight':
        options.preflightOnly = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new StartupError(
          'usage_error',
          `unknown argument: ${argument}`,
          'run with --help to see the accepted options',
        );
    }
  }

  // Explicit flags win over environment fallbacks.
  if (options.target === null && options.mac === null && env.MAC_ADDRESS !== undefined) options.mac = env.MAC_ADDRESS;
  if (options.target === null && options.ip === null && env.IP_ADDRESS !== undefined) options.ip = env.IP_ADDRESS;
  if (options.timeout === null && env.TIMEOUT !== undefined) options.timeout = env.TIMEOUT;
  return options;
}

function validateConfiguration(options) {
  const missing = [];
  if (!options.mac) missing.push('MAC address (--mac or MAC_ADDRESS)');
  if (!options.ip) missing.push('target host (--ip or IP_ADDRESS)');
  if (missing.length > 0) {
    throw new StartupError(
      'config_missing',
      `no ${missing.join(' and no ')}`,
      'pass --mac a1:b2:c3:d4:e5:f6 --ip 192.168.1.50, or set MAC_ADDRESS and IP_ADDRESS',
    );
  }
  if (!isValidMac(options.mac)) {
    throw new StartupError(
      'config_invalid',
      `MAC address is not six hex pairs separated by ':' or '-': ${options.mac}`,
      'pass a MAC address such as a1:b2:c3:d4:e5:f6',
    );
  }
  const hostIsValid = isValidHost(options.ip);
  if (!hostIsValid) {
    throw new StartupError(
      'config_invalid',
      `target host is neither an IPv4 address nor a hostname: ${options.ip}`,
      'pass an address such as 192.168.1.50, or a resolvable hostname',
    );
  }

  const rawTimeout = options.timeout === null ? String(DEFAULT_TIMEOUT_SECONDS) : String(options.timeout);
  if (!/^[1-9][0-9]*$/.test(rawTimeout) ||
      !Number.isSafeInteger(Number(rawTimeout)) ||
      !Number.isSafeInteger(Number(rawTimeout) * 1000)) {
    throw new StartupError(
      'config_invalid',
      `timeout must be positive whole seconds with safe integer seconds and milliseconds, got '${rawTimeout}'`,
      'pass --timeout 120, or unset TIMEOUT to take the default',
    );
  }

  return {
    mac: options.mac,
    ip: options.ip,
    timeoutSeconds: Number(rawTimeout),
  };
}

function buildMagicPacket(mac) {
  const bytes = Buffer.from(mac.replace(/[:-]/g, ''), 'hex');
  if (bytes.length !== 6) {
    throw new StartupError(
      'config_invalid',
      `MAC address did not decode to six bytes: ${mac}`,
      'pass a MAC address such as a1:b2:c3:d4:e5:f6',
    );
  }
  const packet = Buffer.alloc(MAGIC_PACKET_BYTES, 0xff);
  for (let repeat = 0; repeat < 16; repeat += 1) {
    bytes.copy(packet, 6 + repeat * bytes.length);
  }
  return packet;
}

function pingArguments(host) {
  // -W is the reply timeout on both platforms, but macOS counts milliseconds
  // where Linux counts seconds.
  const wait = os.platform() === 'darwin'
    ? String(PROBE_TIMEOUT_SECONDS * 1000)
    : String(PROBE_TIMEOUT_SECONDS);
  return ['-c', '1', '-W', wait, host];
}

// The process deadline also bounds DNS lookup and ping implementations whose
// own -W option does not bound the entire command.
function runPing(host, timeoutMs = PROBE_INTERVAL_MS) {
  return new Promise((resolve) => {
    let child;
    let timer;
    let settled = false;
    let expired = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn('ping', pingArguments(host), { stdio: 'ignore' });
      child.once('error', (error) => finish({ error, ok: false }));
      child.once('close', (code, signal) => {
        if (expired) finish({ ok: false });
        else if (signal || (code !== 0 && code !== 1 && !(os.platform() === 'darwin' && code === 2))) {
          finish({ error: new Error(`ping exited with ${signal || code}`), ok: false });
        } else finish({ ok: code === 0 });
      });
      timer = setTimeout(() => {
        expired = true;
        try {
          child.kill('SIGKILL');
        } catch (error) {
          finish({ error, ok: false });
        }
      }, timeoutMs);
    } catch (error) {
      finish({ error, ok: false });
    }
  });
}

function probeError(result) {
  return new StartupError(
    result.error?.code === 'ENOENT' ? 'command_missing' : 'probe_unusable',
    result.error ? `ping could not run: ${result.error.message}` : 'ping could not reach 127.0.0.1',
    'make ping available on PATH with ICMP permission (macOS: /sbin/ping, Linux: install iputils-ping), or use --no-wait',
  );
}

async function checkEnvironment(options) {
  checkNodeVersion();
  if (!['darwin', 'linux'].includes(os.platform())) {
    throw new StartupError('platform_unsupported', `unsupported platform: ${os.platform()}`,
      'run on macOS or Linux on the target LAN');
  }
  if (options.wait) {
    const result = await runPing('127.0.0.1');
    if (!result.ok) throw probeError(result);
  }
}

// One socket preparation path for preflight and dispatch. Keep the error
// listener through close so late events cannot become uncaught exceptions.
function broadcast(packet, onSent = () => {}) {
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    let successes = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      try {
        if (socket) socket.close();
      } catch (closeError) {
        // A failed bind can leave a socket that is already stopped.
        if (closeError.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') error = closeError;
      }
      if (error) reject(new StartupError('broadcast_unavailable',
        `UDP broadcast failed: ${error.message}`,
        'run on the target LAN with UDP broadcast permitted'));
      else resolve();
    };
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('error', (error) => finish(successes ? null : error));
      socket.bind(0, () => {
        if (settled) return;
        try {
          socket.setBroadcast(true);
          if (!packet) return finish();
          let remaining = WOL_PORTS.length;
          for (const port of WOL_PORTS) {
            let completed = false;
            const sent = (error) => {
              if (completed || settled) return;
              completed = true;
              if (!error) {
                successes += 1;
                onSent();
              }
              remaining -= 1;
              if (!remaining) finish(successes ? null : error);
            };
            try {
              socket.send(packet, 0, packet.length, port, BROADCAST_ADDRESS, sent);
            } catch (error) {
              sent(error);
            }
          }
        } catch (error) {
          finish(error);
        }
      });
    } catch (error) {
      finish(error);
    }
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHost(config) {
  const start = performance.now();
  const deadline = start + config.timeoutSeconds * 1000;
  while (performance.now() < deadline) {
    const probeStart = performance.now();
    const remaining = deadline - probeStart;
    if (remaining <= 0) break;
    const result = await runPing(config.ip, Math.min(PROBE_INTERVAL_MS, remaining));
    const now = performance.now();
    if (now >= deadline) break;
    if (result.error) throw probeError(result);
    if (result.ok) return Math.round((now - start) / 100) / 10;
    const delay = Math.min(probeStart + PROBE_INTERVAL_MS, deadline) - now;
    if (delay > 0) await sleep(delay);
  }
  throw new StartupError('host_unreachable',
    `${config.ip} did not answer within ${config.timeoutSeconds} seconds of the magic packet`,
    'check target Wake-on-LAN firmware and network settings, the broadcast domain, and ICMP access. Stop without retrying');
}

function report(json, payload) {
  const lines = {
    ready: `READY: can send a wake packet to ${payload.mac}`,
    'packet-sent': `Magic packet sent to ${payload.mac}`,
    online: `${payload.ip} is now online (took ${payload.waitedSeconds} seconds)`,
  };
  process.stdout.write(`${json ? JSON.stringify(payload) : lines[payload.status]}\n`);
}

async function main(argv, env) {
  let sent = false;
  const json = argv.includes('--json');
  try {
    const options = parseArguments(argv, env);
    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.OK;
    }
    if (options.target !== null) {
      const saved = loadTarget(options.target);
      if (options.mac === null) options.mac = saved.mac;
      if (options.ip === null) options.ip = saved.ip;
    }
    const config = validateConfiguration(options);
    const named = options.target === null ? {} : { target: options.target };
    await checkEnvironment(options);
    await broadcast(options.preflightOnly ? null : buildMagicPacket(config.mac), () => { sent = true; });
    if (options.preflightOnly) {
      report(json, { status: 'ready', ...config, ...named });
    } else {
      const waitedSeconds = options.wait ? await waitForHost(config) : 0;
      report(json, { status: options.wait ? 'online' : 'packet-sent',
        mac: config.mac, ip: config.ip, waitedSeconds, ...named });
    }
    return EXIT.OK;
  } catch (error) {
    reportError(json, error);
    return sent ? EXIT.UNREACHABLE : EXIT.CANNOT_START;
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; });
}

module.exports = {
  EXIT, StartupError, buildMagicPacket, isValidIpv4, nodeVersionAtLeast,
  parseArguments, validateConfiguration, waitForHost,
};
