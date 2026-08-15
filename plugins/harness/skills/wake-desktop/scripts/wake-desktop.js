#!/usr/bin/env node
'use strict';

const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const os = require('node:os');

// Exit status contract, shared with the other scripts in this plugin:
//   0  the host is online, or the packet was sent with --no-wait
//   2  could not start: bad usage, missing dependency, invalid configuration
//   1  the packet was sent and the host never answered
const EXIT = Object.freeze({
  OK: 0,
  UNREACHABLE: 1,
  CANNOT_START: 2,
});

const MINIMUM_NODE = [20, 6, 0];
const BROADCAST_ADDRESS = '255.255.255.255';
const WOL_PORTS = Object.freeze([9, 7]);
const MAGIC_PACKET_BYTES = 102;
const DEFAULT_TIMEOUT_SECONDS = 120;
const PROBE_INTERVAL_MS = 1000;
const PROBE_TIMEOUT_SECONDS = 1;
const MAC_PATTERN = /^([0-9A-Fa-f]{2})([:-])(?:[0-9A-Fa-f]{2}\2){4}[0-9A-Fa-f]{2}$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

const USAGE = `Usage: wake-desktop.js [OPTIONS]

Sends a Wake-on-LAN magic packet, then waits for the host to answer a ping.

Options:
  -m, --mac MAC          Target MAC address, for example a1:b2:c3:d4:e5:f6
  -i, --ip HOST          Target IPv4 address or hostname to probe
  -t, --timeout SECONDS  How long to wait for the host (default ${DEFAULT_TIMEOUT_SECONDS})
      --no-wait          Send the packet and exit without waiting
      --preflight        Check the environment and arguments, send nothing, exit
      --json             Report the result and any error as JSON
  -h, --help             Print this message

Environment fallbacks, used when the matching flag is absent:
  MAC_ADDRESS, IP_ADDRESS, TIMEOUT

Exit status: 0 online or packet sent, 2 cannot start, 1 host never answered.`;

class StartupError extends Error {
  constructor(code, condition, remedy) {
    super(condition);
    this.name = 'StartupError';
    this.code = code;
    this.condition = condition;
    this.remedy = remedy;
  }
}

function parseArguments(argv, env = {}) {
  const options = {
    mac: null,
    ip: null,
    timeout: null,
    wait: true,
    preflightOnly: false,
    json: false,
    help: false,
  };
  const takesValue = new Map([
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

  // Flags win over the environment so a .env file stays a default, not a lock.
  if (options.mac === null && env.MAC_ADDRESS) options.mac = env.MAC_ADDRESS;
  if (options.ip === null && env.IP_ADDRESS) options.ip = env.IP_ADDRESS;
  if (options.timeout === null && env.TIMEOUT) options.timeout = env.TIMEOUT;
  return options;
}

function isValidIpv4(value) {
  const match = IPV4_PATTERN.exec(value);
  if (!match) return false;
  return match.slice(1).every((part) => {
    if (part.length > 1 && part.startsWith('0')) return false;
    return Number(part) <= 255;
  });
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
  if (!MAC_PATTERN.test(options.mac)) {
    throw new StartupError(
      'config_invalid',
      `MAC address is not six hex pairs separated by ':' or '-': ${options.mac}`,
      'pass a MAC address such as a1:b2:c3:d4:e5:f6',
    );
  }
  // A digits-and-dots value is a mistyped address, not a hostname, even though
  // the hostname grammar would accept it.
  const looksNumeric = /^[0-9.]+$/.test(options.ip);
  const hostIsValid = looksNumeric ? isValidIpv4(options.ip) : HOSTNAME_PATTERN.test(options.ip);
  if (!hostIsValid) {
    throw new StartupError(
      'config_invalid',
      `target host is neither an IPv4 address nor a hostname: ${options.ip}`,
      'pass an address such as 192.168.1.50, or a resolvable hostname',
    );
  }

  const rawTimeout = options.timeout === null ? String(DEFAULT_TIMEOUT_SECONDS) : String(options.timeout);
  if (!/^[1-9][0-9]*$/.test(rawTimeout)) {
    throw new StartupError(
      'config_invalid',
      `timeout must be a positive whole number of seconds, got '${rawTimeout}'`,
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

function nodeVersionAtLeast(version, minimum) {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const part = parts[index] || 0;
    if (part > minimum[index]) return true;
    if (part < minimum[index]) return false;
  }
  return true;
}

function pingArguments(host) {
  // -W is the reply timeout on both platforms, but macOS counts milliseconds
  // where Linux counts seconds.
  const wait = os.platform() === 'darwin'
    ? String(PROBE_TIMEOUT_SECONDS * 1000)
    : String(PROBE_TIMEOUT_SECONDS);
  return ['-c', '1', '-W', wait, host];
}

// Resolves { spawned, ok } so a missing ping binary stays distinguishable from
// a ping that ran and could not reach the host.
function runPing(host) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ping', pingArguments(host), { stdio: 'ignore' });
    } catch {
      resolve({ spawned: false, ok: false });
      return;
    }
    child.on('error', () => resolve({ spawned: false, ok: false }));
    child.on('close', (code) => resolve({ spawned: true, ok: code === 0 }));
  });
}

async function isOnline(host) {
  const result = await runPing(host);
  return result.ok;
}

function canOpenBroadcastSocket() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.once('error', () => {
      socket.close(() => resolve(false));
    });
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        socket.close(() => resolve(true));
      } catch {
        socket.close(() => resolve(false));
      }
    });
  });
}

async function preflight(options) {
  if (!nodeVersionAtLeast(process.version, MINIMUM_NODE)) {
    throw new StartupError(
      'node_version_unsupported',
      `Node.js ${MINIMUM_NODE.join('.')} or newer is required, running ${process.version}`,
      'install Node.js 20.6.0 or newer',
    );
  }
  // Argument mistakes are checked before the environment, so a mistyped MAC is
  // never reported as a missing dependency.
  const config = validateConfiguration(options);

  // Probing loopback proves both that ping exists and that this process is
  // allowed to send ICMP, which containers routinely forbid.
  const loopback = await runPing('127.0.0.1');
  if (!loopback.spawned) {
    throw new StartupError(
      'command_missing',
      'the system ping command was not found, so the host cannot be probed',
      'install iputils-ping (Linux) or repair PATH so /sbin/ping is reachable (macOS)',
    );
  }
  if (!loopback.ok) {
    throw new StartupError(
      'probe_unusable',
      'ping could not reach 127.0.0.1, so it cannot tell whether the target is awake',
      'grant ICMP permission, for example run outside an unprivileged container or set net.ipv4.ping_group_range',
    );
  }
  if (!(await canOpenBroadcastSocket())) {
    throw new StartupError(
      'broadcast_unavailable',
      'a UDP broadcast socket could not be opened, so no magic packet can be sent',
      'run outside a network namespace that blocks broadcast, such as a container with host networking disabled',
    );
  }
  return config;
}

function sendMagicPacket(packet) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.once('error', (error) => {
      socket.close();
      reject(
        new StartupError(
          'broadcast_unavailable',
          `the magic packet could not be sent: ${error.message}`,
          'confirm this machine can send UDP broadcast on the target LAN',
        ),
      );
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      let remaining = WOL_PORTS.length;
      let failure = null;
      for (const port of WOL_PORTS) {
        socket.send(packet, 0, packet.length, port, BROADCAST_ADDRESS, (error) => {
          if (error) failure = error;
          remaining -= 1;
          if (remaining > 0) return;
          socket.close(() => {
            if (failure) {
              reject(
                new StartupError(
                  'broadcast_unavailable',
                  `the magic packet could not be sent: ${failure.message}`,
                  'confirm this machine can send UDP broadcast on the target LAN',
                ),
              );
              return;
            }
            resolve();
          });
        });
      }
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function report(json, payload) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  const lines = {
    'already-online': `${payload.ip} was already online`,
    'packet-sent': `Magic packet sent to ${payload.mac}`,
    online: `${payload.ip} is now online (took ${payload.waitedSeconds} seconds)`,
  };
  process.stdout.write(`${lines[payload.status]}\n`);
}

function reportError(json, error) {
  if (json) {
    const body = { error: { code: error.code, condition: error.condition, remedy: error.remedy } };
    process.stderr.write(`${JSON.stringify(body)}\n`);
    return;
  }
  process.stderr.write(`ERROR [${error.code}]: ${error.condition}\n`);
  if (error.remedy) process.stderr.write(`Remedy: ${error.remedy}\n`);
}

function progress(json, message) {
  if (!json) process.stderr.write(`${message}\n`);
}

async function main(argv, env) {
  let options;
  try {
    options = parseArguments(argv, env);
  } catch (error) {
    // --json may not have parsed yet, so look for it directly.
    reportError(argv.includes('--json'), error);
    return EXIT.CANNOT_START;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }

  let config;
  try {
    config = await preflight(options);
  } catch (error) {
    reportError(options.json, error);
    return EXIT.CANNOT_START;
  }

  if (options.preflightOnly) {
    if (options.json) {
      const body = {
        status: 'ready',
        mac: config.mac,
        ip: config.ip,
        timeoutSeconds: config.timeoutSeconds,
      };
      process.stdout.write(`${JSON.stringify(body)}\n`);
    } else {
      process.stdout.write(`READY: can wake ${config.mac} and probe ${config.ip}\n`);
    }
    return EXIT.OK;
  }

  progress(options.json, `Checking whether ${config.ip} (${config.mac}) is already online`);
  if (await isOnline(config.ip)) {
    report(options.json, { status: 'already-online', mac: config.mac, ip: config.ip, waitedSeconds: 0 });
    return EXIT.OK;
  }

  progress(options.json, `Sending magic packet to ${config.mac}`);
  try {
    await sendMagicPacket(buildMagicPacket(config.mac));
  } catch (error) {
    reportError(options.json, error);
    return EXIT.CANNOT_START;
  }

  if (!options.wait) {
    report(options.json, { status: 'packet-sent', mac: config.mac, ip: config.ip, waitedSeconds: 0 });
    return EXIT.OK;
  }

  progress(options.json, `Waiting up to ${config.timeoutSeconds} seconds for ${config.ip}`);
  const startTime = Date.now();
  const elapsed = () => Math.round((Date.now() - startTime) / 100) / 10;
  while (!(await isOnline(config.ip))) {
    if (elapsed() >= config.timeoutSeconds) {
      reportError(options.json, {
        code: 'host_unreachable',
        condition: `${config.ip} did not answer within ${config.timeoutSeconds} seconds of the magic packet`,
        remedy: 'confirm Wake-on-LAN is enabled in firmware, that this machine shares a broadcast domain with the target, and that the MAC address is the wake-capable interface',
      });
      return EXIT.UNREACHABLE;
    }
    await sleep(PROBE_INTERVAL_MS);
  }
  report(options.json, { status: 'online', mac: config.mac, ip: config.ip, waitedSeconds: elapsed() });
  return EXIT.OK;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`ERROR [internal_error]: ${error && error.stack ? error.stack : error}\n`);
      process.exitCode = EXIT.UNREACHABLE;
    },
  );
}

module.exports = {
  EXIT,
  StartupError,
  buildMagicPacket,
  isValidIpv4,
  nodeVersionAtLeast,
  parseArguments,
  validateConfiguration,
};
