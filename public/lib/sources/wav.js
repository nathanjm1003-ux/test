// Streaming WAV reader.
//
// Uncompressed audio is exactly addressable: frame N lives at a known byte
// offset, so any window can be read straight off disk without decoding anything
// before it. That makes file size irrelevant — a 1GB WAV streams in the same
// few tens of MB as a 5MB one, which is what lets the time-stretching engine
// reach 10x on files far too large to decode whole.
//
// Compressed formats have no such property: you cannot know where frame N is
// without walking the container, which is why they take the decode-it-all path
// in decoded.js instead.

const FORMAT_PCM = 0x0001;
const FORMAT_FLOAT = 0x0003;
const FORMAT_EXTENSIBLE = 0xfffe;

function chunkId(view, offset = 0) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Read a WAV file's header without reading its audio.
 * @param {Blob} blob
 * @returns {Promise<{sampleRate:number, channels:number, bitsPerSample:number,
 *                    format:number, blockAlign:number, dataOffset:number,
 *                    dataLength:number, totalFrames:number}>}
 */
export async function parseWavHeader(blob) {
  if (blob.size < 12) throw new Error('file is too short to be a WAV');
  const riff = new DataView(await blob.slice(0, 12).arrayBuffer());
  if (chunkId(riff, 0) !== 'RIFF' || chunkId(riff, 8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }

  let offset = 12;
  let fmt = null;
  let dataOffset = 0;
  let dataLength = 0;

  // Walk the chunk list. Chunks are 8-byte headers plus a payload padded to an
  // even length; we only read the headers and the small fmt payload.
  while (offset + 8 <= blob.size) {
    const header = new DataView(await blob.slice(offset, offset + 8).arrayBuffer());
    const id = chunkId(header, 0);
    const size = header.getUint32(4, true);

    if (id === 'fmt ') {
      const body = new DataView(await blob.slice(offset + 8, offset + 8 + Math.min(size, 40)).arrayBuffer());
      let format = body.getUint16(0, true);
      const channels = body.getUint16(2, true);
      const sampleRate = body.getUint32(4, true);
      const blockAlign = body.getUint16(12, true);
      const bitsPerSample = body.getUint16(14, true);
      // WAVE_FORMAT_EXTENSIBLE hides the real format in a GUID whose first two
      // bytes are the format tag.
      if (format === FORMAT_EXTENSIBLE && body.byteLength >= 26) format = body.getUint16(24, true);
      fmt = { format, channels, sampleRate, blockAlign, bitsPerSample };
    } else if (id === 'data') {
      dataOffset = offset + 8;
      // Streamed WAVs sometimes carry a placeholder size; trust the file.
      const available = blob.size - dataOffset;
      dataLength = size === 0 || size === 0xffffffff ? available : Math.min(size, available);
      break;
    }

    if (size === 0) break;
    offset += 8 + size + (size % 2);
  }

  if (!fmt) throw new Error('WAV file has no "fmt " chunk');
  if (!dataOffset) throw new Error('WAV file has no "data" chunk');
  if (fmt.format !== FORMAT_PCM && fmt.format !== FORMAT_FLOAT) {
    throw new Error(`unsupported WAV encoding (format tag ${fmt.format}); only PCM and float are stored raw`);
  }
  if (!fmt.channels || !fmt.sampleRate) throw new Error('WAV header is missing channel or rate information');

  const bytesPerSample = fmt.bitsPerSample >> 3;
  const blockAlign = fmt.blockAlign || bytesPerSample * fmt.channels;
  if (!blockAlign) throw new Error('WAV header has no usable block alignment');

  return {
    ...fmt,
    blockAlign,
    dataOffset,
    dataLength,
    totalFrames: Math.floor(dataLength / blockAlign),
  };
}

/** Convert one interleaved sample to the -1..1 range. */
function readerFor(format, bitsPerSample) {
  if (format === FORMAT_FLOAT) {
    if (bitsPerSample === 32) return (view, at) => view.getFloat32(at, true);
    if (bitsPerSample === 64) return (view, at) => view.getFloat64(at, true);
    throw new Error(`unsupported float width ${bitsPerSample}`);
  }
  switch (bitsPerSample) {
    case 8:
      // 8-bit WAV is unsigned, centred on 128.
      return (view, at) => (view.getUint8(at) - 128) / 128;
    case 16:
      return (view, at) => view.getInt16(at, true) / 32768;
    case 24:
      return (view, at) => {
        const value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
        return value / 8388608;
      };
    case 32:
      return (view, at) => view.getInt32(at, true) / 2147483648;
    default:
      throw new Error(`unsupported PCM bit depth ${bitsPerSample}`);
  }
}

export class WavSource {
  /**
   * @param {Blob} blob
   * @param {Awaited<ReturnType<typeof parseWavHeader>>} header
   */
  constructor(blob, header) {
    this.kind = 'wav';
    this.streaming = true;
    this.blob = blob;
    this.header = header;
    this.sampleRate = header.sampleRate;
    // We render stereo; extra channels in a multichannel file are ignored.
    this.channels = Math.min(header.channels, 2);
    this.sourceChannels = header.channels;
    this.totalFrames = header.totalFrames;
    this.duration = header.totalFrames / header.sampleRate;
    this.bytesPerSample = header.bitsPerSample >> 3;
    this.read = readerFor(header.format, header.bitsPerSample);
  }

  static async open(blob) {
    return new WavSource(blob, await parseWavHeader(blob));
  }

  /**
   * Read `frameCount` frames starting at `startFrame`, zero-padded past the end.
   * @returns {Promise<Float32Array[]>}
   */
  async readFrames(startFrame, frameCount) {
    const out = Array.from({ length: this.channels }, () => new Float32Array(frameCount));
    const start = Math.max(0, startFrame);
    const end = Math.min(this.totalFrames, start + frameCount);
    if (end <= start) return out;

    const { dataOffset, blockAlign } = this.header;
    const from = dataOffset + start * blockAlign;
    const to = dataOffset + end * blockAlign;
    const view = new DataView(await this.blob.slice(from, to).arrayBuffer());

    const frames = Math.min(end - start, Math.floor(view.byteLength / blockAlign));
    const skew = start - startFrame; // where these frames land in the output
    for (let ch = 0; ch < this.channels; ch++) {
      const target = out[ch];
      const base = ch * this.bytesPerSample;
      for (let i = 0; i < frames; i++) {
        target[i + skew] = this.read(view, i * blockAlign + base);
      }
    }
    return out;
  }

  close() {
    this.blob = null;
  }
}

/** Cheap sniff so we can pick a strategy before committing to a parse. */
export async function looksLikeWav(blob) {
  if (blob.size < 12) return false;
  const view = new DataView(await blob.slice(0, 12).arrayBuffer());
  return chunkId(view, 0) === 'RIFF' && chunkId(view, 8) === 'WAVE';
}
