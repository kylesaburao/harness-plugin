'use strict';

export interface GifLoop { mode: 'infinite'; repeatCount: number; extension: string }
interface LoopDeclaration { repeatCount: number; extension: string }
interface GifBlockVisitor {
  loop?: (declaration: LoopDeclaration) => void;
  graphicControl?: (payload: Buffer) => void;
}

// Walk framing only. FFprobe remains responsible for image decodability.
// Each caller supplies its own policy for the blocks it reads.
function walkGifBlocks(buffer: Buffer, subject: string, visitor: GifBlockVisitor) {
  let offset = 0;
  const fail: (condition: string) => never = condition => { throw new Error(`invalid GIF ${subject}: ${condition}`); };
  const take = (length: number) => {
    if (offset + length > buffer.length) fail('truncated block');
    const start = offset;
    offset += length;
    return buffer.subarray(start, offset);
  };
  const byte = () => take(1)[0]!;
  const subBlocks = () => {
    for (let size = byte(); size !== 0; size = byte()) take(size);
  };
  const colorTable = (packed: number) => { if (packed & 0x80) take(3 * (2 ** ((packed & 7) + 1))); };
  const header = take(6).toString('latin1');
  if (header !== 'GIF87a' && header !== 'GIF89a') fail('unsupported header');
  colorTable(take(7)[4]!);
  while (offset < buffer.length) {
    const sentinel = byte();
    if (sentinel === 0x3b) {
      if (offset !== buffer.length) fail('data after trailer');
      return;
    }
    if (sentinel === 0x2c) {
      colorTable(take(9)[8]!);
      byte(); // LZW minimum code size, decoded by FFprobe.
      subBlocks();
    } else if (sentinel === 0x21) {
      const label = byte();
      if (label === 0xf9) {
        const size = byte();
        if (size === 0) continue;
        const payload = take(size); // Read before the optional call, which would skip its argument.
        visitor.graphicControl?.(payload);
        subBlocks();
        continue;
      }
      if (label !== 0xff) { subBlocks(); continue; }
      if (byte() !== 11) fail('application identifier block must contain 11 bytes');
      const extension = take(11).toString('latin1');
      if (extension !== 'NETSCAPE2.0' && extension !== 'ANIMEXTS1.0') { subBlocks(); continue; }
      if (byte() !== 3) fail('loop control payload must contain three bytes');
      const control = take(3);
      if (control[0] !== 1) fail('unsupported loop control subcode');
      const repeatCount = control.readUInt16LE(1);
      if (byte() !== 0) fail('ambiguous loop control payload or missing terminator');
      visitor.loop?.({ repeatCount, extension });
    } else {
      fail(`unexpected block sentinel ${sentinel}`);
    }
  }
  fail('missing trailer');
}

function inspectGifLoop(buffer: Buffer): GifLoop {
  let loop: LoopDeclaration | undefined;
  walkGifBlocks(buffer, 'looping', {
    loop: declaration => {
      if (loop && loop.repeatCount !== declaration.repeatCount) throw new Error('invalid GIF looping: conflicting loop declarations');
      // Compatible duplicates retain the first recognized declaration deterministically.
      loop ||= declaration;
    },
  });
  if (!loop) throw new Error('invalid GIF looping: missing supported loop declaration');
  if (loop.repeatCount !== 0) throw new Error(`invalid GIF looping: finite repetition count ${loop.repeatCount}`);
  return { mode: 'infinite', ...loop };
}

// Total display time as FFmpeg's GIF demuxer reports it in format=duration:
// it sums every Graphic Control Extension delay, reads a zero delay as its
// 10-centisecond default, and ignores a control block whose size is not 4 bytes.
// Verified against ffprobe 9.0.2.
function gifDurationCentiseconds(buffer: Buffer) {
  let total = 0;
  walkGifBlocks(buffer, 'timing', {
    graphicControl: payload => {
      if (payload.length !== 4) return;
      const delay = payload.readUInt16LE(1);
      total += delay === 0 ? 10 : delay;
    },
  });
  return total;
}

export { inspectGifLoop, gifDurationCentiseconds };
