'use strict';

// Walk framing only. FFprobe remains responsible for image decodability.
function inspectGifLoop(buffer) {
  let offset = 0;
  const fail = condition => { throw new Error(`invalid GIF looping: ${condition}`); };
  const take = length => {
    if (offset + length > buffer.length) fail('truncated block');
    const start = offset;
    offset += length;
    return buffer.subarray(start, offset);
  };
  const byte = () => take(1)[0];
  const subBlocks = () => {
    for (let size = byte(); size !== 0; size = byte()) take(size);
  };
  const colorTable = packed => { if (packed & 0x80) take(3 * (2 ** ((packed & 7) + 1))); };
  const header = take(6).toString('latin1');
  if (header !== 'GIF87a' && header !== 'GIF89a') fail('unsupported header');
  colorTable(take(7)[4]);
  let loop;
  while (offset < buffer.length) {
    const sentinel = byte();
    if (sentinel === 0x3b) {
      if (offset !== buffer.length) fail('data after trailer');
      if (!loop) fail('missing supported loop declaration');
      if (loop.repeatCount !== 0) fail(`finite repetition count ${loop.repeatCount}`);
      return { mode: 'infinite', ...loop };
    }
    if (sentinel === 0x2c) {
      colorTable(take(9)[8]);
      byte(); // LZW minimum code size, decoded by FFprobe.
      subBlocks();
    } else if (sentinel === 0x21) {
      const label = byte();
      if (label !== 0xff) { subBlocks(); continue; }
      if (byte() !== 11) fail('application identifier block must contain 11 bytes');
      const extension = take(11).toString('latin1');
      if (extension !== 'NETSCAPE2.0' && extension !== 'ANIMEXTS1.0') { subBlocks(); continue; }
      if (byte() !== 3) fail('loop control payload must contain three bytes');
      const control = take(3);
      if (control[0] !== 1) fail('unsupported loop control subcode');
      const repeatCount = control.readUInt16LE(1);
      if (byte() !== 0) fail('ambiguous loop control payload or missing terminator');
      if (loop && loop.repeatCount !== repeatCount) fail('conflicting loop declarations');
      // Compatible duplicates retain the first recognized declaration deterministically.
      loop ||= { repeatCount, extension };
    } else {
      fail(`unexpected block sentinel ${sentinel}`);
    }
  }
  fail('missing trailer');
}

module.exports = { inspectGifLoop };
