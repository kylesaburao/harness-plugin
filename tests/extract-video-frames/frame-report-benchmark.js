'use strict';
// Run each count in a separate process. The producer's memory is excluded.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const [mode, countText, modulePath] = process.argv.slice(2);
const count = Number(countText);
if (mode === 'produce') {
  fs.writeSync(1, '{"frames":[');
  for (let i = 0; i < count; i++) fs.writeSync(1, (i ? ',' : '') + JSON.stringify({ best_effort_timestamp: String(i * 1001), duration: '1001', color_range: 'tv', color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709', pix_fmt: 'yuv420p', side_data_list: [{ note: 'synthetic nested metadata' }] }));
  fs.writeSync(1, ']}');
} else {
  (async () => {
    const subject = require(modulePath ? path.resolve(modulePath) : require.resolve('../../plugins/harness/skills/extract-video-frames/scripts/extract-video-frames.js'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-benchmark-'));
    const spool = path.join(root, 'frames.json');
    try {
      const manager = new subject.ProcessManager();
      const color = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' };
      const options = { start: null, end: null, timeBase: '1/30000' };
      const start = performance.now();
      const result = await manager.run(process.execPath, [__filename, 'produce', countText], mode === 'spool' ? { stdoutFile: spool } : {});
      if (result.code !== 0 || result.stderr) throw Error(JSON.stringify(result));
      const collected = performance.now();
      const bytes = mode === 'spool' ? fs.statSync(spool).size : Buffer.byteLength(result.stdout);
      const timing = mode === 'spool' ? await subject.analyzeFrameSpool(spool, color, options) : subject.analyzePresentedFrames(JSON.parse(result.stdout), color, options);
      const end = performance.now();
      console.log(JSON.stringify({ mode, count, reportBytes: bytes, peakRssBytes: process.resourceUsage().maxRSS * 1024, processAndCollectionMs: collected - start, parseAndAnalysisMs: end - collected, wallMs: end - start, timing }, (_, v) => typeof v === 'bigint' ? v.toString() : v));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
