'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const skillRequire = createRequire(path.resolve(__dirname, '../../plugins/harness/skills/wake-desktop/scripts/wake-desktop.js'));
const source = readFileSync(path.join(__dirname,
  '../../plugins/harness/skills/wake-desktop/scripts/wake-desktop.js'), 'utf8');

// Virtual monotonic time avoids timing tolerances in the scheduling contract.
function clockHarness({ durations, replies, sleepOverrun = 0 }) {
  let now = 0;
  const probes = [];
  const context = vm.createContext({
    require: (name) => name === 'node:perf_hooks' ? { performance: { now: () => now } } : skillRequire(name),
    module: { exports: {} }, process, Buffer, setTimeout, clearTimeout,
    Date: { now: () => { throw new Error('wall clock must not be used'); } },
    probe: async (_, budget) => {
      const index = probes.length;
      probes.push({ start: now, budget });
      now += durations[index];
      return { ok: replies[index] };
    },
    pause: async (delay) => { now += delay + sleepOverrun; },
  });
  vm.runInContext(source, context);
  vm.runInContext('runPing = probe; sleep = pause;', context);
  return { probes, wait: (seconds) => context.module.exports.waitForHost({ ip: 'desktop.invalid', timeoutSeconds: seconds }) };
}

test('monotonic probe starts are one second apart without adding probe duration', async () => {
  const h = clockHarness({ durations: [200, 200], replies: [false, true] });
  assert.equal(await h.wait(3), 1.2);
  assert.deepEqual(h.probes, [{ start: 0, budget: 1000 }, { start: 1000, budget: 1000 }]);
});
test('a delayed start uses only the remaining deadline and rejects success at expiry', async () => {
  const h = clockHarness({ durations: [200, 750], replies: [false, true], sleepOverrun: 250 });
  await assert.rejects(h.wait(2), { code: 'host_unreachable' });
  assert.deepEqual(h.probes, [{ start: 0, budget: 1000 }, { start: 1250, budget: 750 }]);
});
test('deadline checked before a new probe even when the scheduler wakes late', async () => {
  const h = clockHarness({ durations: [200], replies: [false], sleepOverrun: 1000 });
  await assert.rejects(h.wait(2), { code: 'host_unreachable' });
  assert.equal(h.probes.length, 1);
});
test('overlong probes never overlap or accept a late success', async () => {
  const h = clockHarness({ durations: [1100, 1000], replies: [false, true] });
  await assert.rejects(h.wait(2), { code: 'host_unreachable' });
  assert.deepEqual(h.probes, [{ start: 0, budget: 1000 }, { start: 1100, budget: 900 }]);
});
