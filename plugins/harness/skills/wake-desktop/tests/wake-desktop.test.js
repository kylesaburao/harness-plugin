'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMagicPacket,
  isValidIpv4,
  nodeVersionAtLeast,
  parseArguments,
  validateConfiguration,
} = require('../scripts/wake-desktop.js');

const MAC = 'a1:b2:c3:d4:e5:f6';

function startupCode(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

test('flags populate every option', () => {
  const options = parseArguments(['--mac', MAC, '--ip', '192.168.1.50', '--timeout', '30', '--json', '--no-wait']);
  assert.equal(options.mac, MAC);
  assert.equal(options.ip, '192.168.1.50');
  assert.equal(options.timeout, '30');
  assert.equal(options.json, true);
  assert.equal(options.wait, false);
});

test('short flags and --flag=value are accepted', () => {
  const options = parseArguments(['-m', MAC, '-i', 'desktop.local', '--timeout=45']);
  assert.equal(options.mac, MAC);
  assert.equal(options.ip, 'desktop.local');
  assert.equal(options.timeout, '45');
});

test('the environment fills in only what the flags left out', () => {
  const env = { MAC_ADDRESS: '00:00:00:00:00:01', IP_ADDRESS: '10.0.0.1', TIMEOUT: '99' };
  const options = parseArguments(['--mac', MAC], env);
  assert.equal(options.mac, MAC, 'the flag wins over MAC_ADDRESS');
  assert.equal(options.ip, '10.0.0.1');
  assert.equal(options.timeout, '99');
});

test('an unknown argument is a usage error', () => {
  assert.equal(startupCode(() => parseArguments(['--bogus'])), 'usage_error');
});

test('a flag without a value is a usage error', () => {
  assert.equal(startupCode(() => parseArguments(['--mac'])), 'usage_error');
  assert.equal(startupCode(() => parseArguments(['--mac', '--ip', '10.0.0.1'])), 'usage_error');
});

test('missing configuration reports config_missing', () => {
  assert.equal(startupCode(() => validateConfiguration(parseArguments([]))), 'config_missing');
  assert.equal(startupCode(() => validateConfiguration(parseArguments(['--mac', MAC]))), 'config_missing');
});

test('malformed input reports config_invalid', () => {
  const cases = [
    ['--mac', 'not-a-mac', '--ip', '10.0.0.1'],
    ['--mac', 'a1:b2:c3:d4:e5', '--ip', '10.0.0.1'],
    ['--mac', 'a1-b2:c3:d4:e5:f6', '--ip', '10.0.0.1'],
    ['--mac', MAC, '--ip', '10.0.0.256'],
    ['--mac', MAC, '--ip', '10.0.0.1.5'],
    ['--mac', MAC, '--ip', '10.0.0.1', '--timeout', '0'],
    ['--mac', MAC, '--ip', '10.0.0.1', '--timeout', 'soon'],
  ];
  for (const argv of cases) {
    assert.equal(startupCode(() => validateConfiguration(parseArguments(argv))), 'config_invalid', argv.join(' '));
  }
});

test('valid configuration normalizes the timeout', () => {
  const withDefault = validateConfiguration(parseArguments(['--mac', MAC, '--ip', '10.0.0.1']));
  assert.equal(withDefault.timeoutSeconds, 120);
  const explicit = validateConfiguration(parseArguments(['--mac', MAC, '--ip', '10.0.0.1', '--timeout', '5']));
  assert.equal(explicit.timeoutSeconds, 5);
});

test('hyphen-separated MAC addresses and hostnames are accepted', () => {
  const config = validateConfiguration(parseArguments(['--mac', 'A1-B2-C3-D4-E5-F6', '--ip', 'desk-1.lan']));
  assert.equal(config.mac, 'A1-B2-C3-D4-E5-F6');
  assert.equal(config.ip, 'desk-1.lan');
});

test('isValidIpv4 rejects out-of-range and zero-padded octets', () => {
  assert.equal(isValidIpv4('192.168.1.50'), true);
  assert.equal(isValidIpv4('0.0.0.0'), true);
  assert.equal(isValidIpv4('192.168.1.256'), false);
  assert.equal(isValidIpv4('192.168.01.5'), false);
});

test('the magic packet is 6 sync bytes then the MAC sixteen times', () => {
  const packet = buildMagicPacket(MAC);
  assert.equal(packet.length, 102);
  assert.deepEqual([...packet.subarray(0, 6)], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const mac = [0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6];
  for (let repeat = 0; repeat < 16; repeat += 1) {
    const start = 6 + repeat * 6;
    assert.deepEqual([...packet.subarray(start, start + 6)], mac, `repetition ${repeat}`);
  }
});

test('the magic packet ignores separator style and case', () => {
  assert.deepEqual(buildMagicPacket('A1-B2-C3-D4-E5-F6'), buildMagicPacket(MAC));
});

test('nodeVersionAtLeast compares release components', () => {
  assert.equal(nodeVersionAtLeast('v20.6.0', [20, 6, 0]), true);
  assert.equal(nodeVersionAtLeast('v22.0.0', [20, 6, 0]), true);
  assert.equal(nodeVersionAtLeast('v20.5.9', [20, 6, 0]), false);
  assert.equal(nodeVersionAtLeast('v18.20.4', [20, 6, 0]), false);
});
