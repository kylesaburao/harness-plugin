'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { performance } = require('node:perf_hooks');

const keys = ['passed', 'failed', 'skipped', 'cancelled', 'todo'];
const counts = () => Object.fromEntries(keys.map(key => [key, 0]));
const seconds = ms => `${(ms / 1000).toFixed(3)}s`;
const countText = value => keys.map(key => `${value[key]} ${key}`).join(', ');
const signalStatus = signal => 128 + (os.constants.signals[signal] || 0);
const childStatus = result => result.signal ? signalStatus(result.signal) : (result.status ?? 1);

async function runGate({ root, prerequisites, groups, fullSearch, python, excluded = [], concurrency = os.availableParallelism() }, {
  stdout = process.stdout, stderr = process.stderr, signals = process,
} = {}) {
  root = fs.realpathSync(root);
  const started = performance.now();
  const records = new Map(Object.keys(groups).map(name => [name, { name, counts: counts(), status: 'Unrun', start: null, end: null }]));
  records.set('write-asd-ste100', { name: 'write-asd-ste100', counts: counts(), status: 'Unrun', start: null, end: null });
  for (const name of excluded) records.set(name, { name, counts: counts(), status: 'Excluded', start: null, end: null });
  const fileGroups = new Map(Object.entries(groups).flatMap(([group, files]) => files.map(file => [path.resolve(root, file), group])));
  const summaries = new Set();
  const fileStarts = new Map();
  const timings = [];
  const failures = [];
  const stages = prerequisites.map(spec => ({ ...spec, status: 'Unrun', duration: 0 }));
  const children = new Set();
  let interrupted = 0;
  let escalation;
  const kill = (child, signal) => {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
  };
  const handlers = ['SIGHUP', 'SIGINT', 'SIGTERM'].map(signal => {
    const handler = () => {
      if (interrupted) return;
      interrupted = signalStatus(signal);
      for (const child of children) kill(child, signal);
      escalation = setTimeout(() => { for (const child of children) kill(child, 'SIGKILL'); }, 2000);
      escalation.unref();
    };
    signals.on(signal, handler);
    return [signal, handler];
  });
  function touch(record) {
    record.start ??= performance.now();
    record.end = performance.now();
    if (record.status === 'Unrun') record.status = 'Passed';
  }
  function event({ type, data }) {
    const record = records.get(type === 'python:test' ? 'write-asd-ste100' : fileGroups.get(path.resolve(root, data.file || '.')));
    if (['test:stdout', 'test:stderr', 'test:diagnostic'].includes(type)) {
      (type === 'test:stderr' ? stderr : stdout).write(data.message.endsWith('\n') ? data.message : `${data.message}\n`);
    }
    if (!record) return;
    const wrapper = data.file && (data.name === path.relative(root, data.file) || data.name === data.file);
    if (type === 'test:dequeue' && wrapper) {
      fileStarts.set(data.file, performance.now());
      touch(record);
    }
    if (type === 'test:complete' && wrapper) {
      const start = fileStarts.get(data.file) ?? performance.now() - data.details.duration_ms;
      record.start = record.start === null ? start : Math.min(record.start, start);
      record.end = Math.max(record.end ?? 0, start + data.details.duration_ms);
      if (record.status === 'Unrun') record.status = 'Passed';
    }
    if (type === 'test:summary') {
      // Only file summaries count. Cumulative summaries and wrapper events do not.
      if (summaries.has(data.file)) return;
      summaries.add(data.file);
      for (const key of keys) record.counts[key] += data.counts[key];
      if (!data.success) record.status = 'Failed';
    }
    if (type === 'python:test') {
      touch(record);
      record.counts[data.outcome] += 1;
      if (data.outcome === 'failed') record.status = 'Failed';
      timings.push({ ...data, group: record.name });
      if (data.outcome === 'failed') failures.push(`${data.file}:${data.line} ${data.name}`);
    }
    if (type === 'test:pass' || type === 'test:fail') {
      const outcome = data.skip ? 'Skipped' : data.todo ? 'Todo' : type === 'test:pass' ? 'Passed' : 'Failed';
      stdout.write(`${outcome}: ${record.name} / ${data.name} (${seconds(data.details.duration_ms)})\n`);
      if (data.details.type !== 'suite' && data.name !== path.relative(root, data.file) && data.name !== data.file) {
        timings.push({ ...data, duration_ms: data.details.duration_ms, group: record.name });
      }
      if (outcome === 'Failed') {
        record.status = 'Failed';
        failures.push(`${data.file}:${data.line || 1} ${data.name}`);
        stderr.write(`${data.details.error}\n`);
      }
    }
  }
  async function execute(spec, structured = false) {
    return new Promise(resolve => {
      let error;
      let child;
      try {
        // A fresh process group lets interruption reach test children as well.
        child = spawn(spec.command, spec.args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
      } catch (cause) { resolve({ status: null, error: cause }); return; }
      children.add(child);
      child.on('error', cause => { error = cause; });
      child.stderr.on('data', chunk => stderr.write(chunk));
      const lines = structured ? readline.createInterface({ input: child.stdout }) : null;
      if (lines) lines.on('line', line => {
        try { event(JSON.parse(line)); }
        catch (cause) { error = cause; stderr.write(`Invalid test event: ${line}\n${cause.message}\n`); }
      });
      else child.stdout.on('data', chunk => stdout.write(chunk));
      child.on('close', (status, signal) => {
        children.delete(child);
        if (error) stderr.write(`ERROR [COMMAND_FAILED]: ${error.message}\n`);
        resolve({ status: error ? null : status, signal, error });
      });
    });
  }
  async function node(files) {
    if (!files.length || interrupted) return;
    const result = await execute({ command: process.execPath, args: ['--test', `--test-concurrency=${concurrency}`, `--test-reporter=${path.join(__dirname, 'node-test-reporter.js')}`, ...files] }, true);
    for (const file of files) {
      const absolute = path.resolve(root, file);
      const record = records.get(fileGroups.get(absolute));
      if (!summaries.has(absolute)) {
        if (interrupted && !fileStarts.has(absolute)) continue;
        touch(record);
        record.status = interrupted ? 'Cancelled' : 'Failed';
        record.counts[interrupted ? 'cancelled' : 'failed'] += 1;
        failures.push(`${file}: no completed file summary${result.error ? ` (${result.error.message})` : ''}`);
      }
    }
    if (childStatus(result) && !interrupted && ![...records.values()].some(record => record.status === 'Failed')) {
      failures.push(`Node test process exited ${childStatus(result)}`);
    }
  }
  let status = 0;
  try {
    for (const stage of stages) {
      if (interrupted) break;
      stdout.write(`\n==> ${stage.label}\n`);
      const start = performance.now();
      const result = await execute(stage);
      stage.duration = performance.now() - start;
      status = childStatus(result);
      stage.status = status ? 'Failed' : 'Passed';
      if (status) { failures.push(`${stage.label}: exited ${status}${result.error ? ` (${result.error.message})` : ''}`); break; }
    }
    if (!status && !interrupted) {
      const pythonRecord = records.get('write-asd-ste100');
      touch(pythonRecord);
      const pythonWork = execute(python, true).then(result => {
        touch(pythonRecord);
        if (childStatus(result)) {
          pythonRecord.status = interrupted ? 'Cancelled' : 'Failed';
          failures.push(`write-asd-ste100: Python process exited ${childStatus(result)}`);
        }
      });
      await node(fullSearch ? [fullSearch] : []);
      await node(Object.values(groups).flat().filter(file => file !== fullSearch));
      await pythonWork;
    }
  } catch (error) {
    status = 1;
    failures.push(error.stack);
  } finally {
    clearTimeout(escalation);
    for (const [signal, handler] of handlers) signals.removeListener(signal, handler);
  }
  status = interrupted || status || (failures.length || [...records.values()].some(record => record.status === 'Failed') ? 1 : 0);
  stdout.write(`\n================ TEST GATE: ${status ? 'FAILED' : 'PASSED'} ================\n`);
  stdout.write(`Wall time: ${seconds(performance.now() - started)} | Node pool: ${concurrency} | full-search JOBS: ${fullSearch ? concurrency : 'not scheduled'} | retained scenarios: ${Math.max(1, Math.floor(concurrency / 4))} | Python: 1\n`);
  stdout.write('Prerequisites:\n');
  for (const stage of stages) stdout.write(`  ${stage.status} | ${stage.label} | ${seconds(stage.duration)}\n`);
  stdout.write('Groups (elapsed spans overlap, do not sum):\n');
  const aggregate = counts();
  for (const record of records.values()) {
    for (const key of keys) aggregate[key] += record.counts[key];
    stdout.write(`  ${record.status} | ${record.name} | ${countText(record.counts)} | ${record.start === null ? 'not run' : seconds(record.end - record.start)}\n`);
  }
  stdout.write(`Aggregate: ${countText(aggregate)}\nExcluded groups are omitted by option. Unrun groups never started. Skipped tests are reported by the test frameworks.\n`);
  stdout.write('Five slowest tests:\n');
  for (const item of timings.sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 5)) stdout.write(`  ${seconds(item.duration_ms)} | ${item.group} / ${item.name} | ${item.file}:${item.line || 1}\n`);
  stdout.write('Failures:\n');
  for (const failure of failures) stdout.write(`  ${failure}\n`);
  if (!failures.length) stdout.write('  None\n');
  return status;
}

module.exports = { runGate, childStatus };
