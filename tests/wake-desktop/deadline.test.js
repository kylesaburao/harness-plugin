'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForHost } = require(require('../helpers/plugin-paths').artifactPath('skills/wake-desktop/scripts/wake-desktop.js'));

// Virtual monotonic time avoids timing tolerances in the scheduling contract.
// Each reply is a boolean (ok) or a full ping result object; the last reply
// and the last duration repeat for any further probes.
function clockHarness({ durations, replies, sleepOverrun = 0 }) {
  let now = 0;
  const probes = [];
  const ping = async (_, budget) => {
    const index = probes.length;
    probes.push({ start: now, budget });
    now += durations[Math.min(index, durations.length - 1)];
    const reply = replies[Math.min(index, replies.length - 1)];
    return typeof reply === 'boolean' ? { ok: reply } : reply;
  };
  const sleep = async (delay) => { now += delay + sleepOverrun; };
  return {
    probes,
    wait: (seconds) => waitForHost({ mac: 'a1:b2:c3:d4:e5:f6', ip: 'desktop.invalid', timeoutSeconds: seconds },
      { now: () => now, ping, sleep }),
  };
}

const exited = (code) => ({ ok: false, exitError: new Error(`ping exited with ${code}`) });

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

test('unresolved-name exits (iputils 2, macOS 68) keep polling until the host answers', async () => {
  const h = clockHarness({ durations: [100], replies: [exited(2), exited(68), exited(2), true] });
  assert.equal(await h.wait(10), 3.1);
  assert.deepEqual(h.probes.map((probe) => probe.start), [0, 1000, 2000, 3000]);
});
test('signal-terminated probes are treated as not reachable yet', async () => {
  const h = clockHarness({ durations: [100], replies: [exited('SIGTERM'), true] });
  assert.equal(await h.wait(5), 1.1);
});
test('a name that never resolves times out as host_unreachable, not probe_unusable', async () => {
  const h = clockHarness({ durations: [100], replies: [exited(2)] });
  await assert.rejects(h.wait(3), { code: 'host_unreachable' });
  assert.equal(h.probes.length, 3);
});
test('a ping that cannot be spawned stays fatal', async () => {
  const missing = Object.assign(new Error('spawn ping ENOENT'), { code: 'ENOENT' });
  const h = clockHarness({ durations: [0], replies: [{ ok: false, error: missing }] });
  await assert.rejects(h.wait(5), { code: 'command_missing' });
  assert.equal(h.probes.length, 1);

  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const d = clockHarness({ durations: [0], replies: [{ ok: false, error: denied }] });
  await assert.rejects(d.wait(5), { code: 'probe_unusable' });
});
