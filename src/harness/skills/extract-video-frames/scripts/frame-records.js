'use strict';
const fs = require('node:fs');

// The selected ffprobe JSON envelope, with at most one frame retained at a time.
async function* frameRecords(filename, { highWaterMark = 64 * 1024, assertRunning = () => {} } = {}) {
  const input = fs.createReadStream(filename, { highWaterMark, encoding: 'utf8' });
  const prefix = '{"frames":[';
  let phase = 'prefix', prefixIndex = 0, depth = 0, quoted = false, escaped = false;
  let parts = [];
  try {
    for await (const chunk of input) {
      assertRunning();
      let start = phase === 'object' ? 0 : -1;
      for (let index = 0; index < chunk.length; index++) {
        const c = chunk[index];
        if (phase === 'object') {
          if (quoted) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') quoted = false;
          } else if (c === '"') quoted = true;
          else if (c === '{') depth++;
          else if (c === '}' && --depth === 0) {
            parts.push(chunk.slice(start, index + 1));
            const record = JSON.parse(parts.join(''));
            parts = [];
            phase = 'separator';
            start = -1;
            yield record;
          }
          continue;
        }
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
          if (phase === 'prefix' && prefixIndex >= 2 && prefixIndex <= 8) throw new SyntaxError('whitespace inside JSON key');
          continue;
        }
        if (phase === 'prefix') {
          if (prefixIndex === 1 && c === '}') { phase = 'done'; continue; }
          if (c !== prefix[prefixIndex++]) throw new SyntaxError('unexpected ffprobe JSON envelope');
          if (prefixIndex === prefix.length) phase = 'first';
        } else if (phase === 'first' || phase === 'next') {
          if (c === '{') { phase = 'object'; depth = 1; start = index; }
          else if (c === ']' && phase === 'first') phase = 'root-end';
          else throw new SyntaxError('expected a frame object');
        } else if (phase === 'separator') {
          if (c === ',') phase = 'next';
          else if (c === ']') phase = 'root-end';
          else throw new SyntaxError('expected comma or end of frames');
        } else if (phase === 'root-end') {
          if (c !== '}') throw new SyntaxError('unexpected ffprobe JSON root suffix');
          phase = 'done';
        } else throw new SyntaxError('trailing data after ffprobe JSON');
      }
      if (start !== -1) parts.push(chunk.slice(start));
    }
    assertRunning();
    if (phase !== 'done') throw new SyntaxError('truncated ffprobe frame JSON');
  } finally {
    input.destroy();
    if (!input.closed) await new Promise(resolve => input.once('close', resolve));
  }
}
module.exports = { frameRecords };
