// Whole-file decode, for compressed formats.
//
// `decodeAudioData` is all-or-nothing: it needs the entire compressed file in
// memory and hands back the entire decoded result. There is no way to ask it for
// "just the audio between 40 and 70 seconds" without a container demuxer, so
// this path is bounded by a memory budget rather than by file size.
//
// Once decoded, it still serves windows like any other source, so the worklet
// never receives a second full copy of the audio.

/** Float32 PCM is 4 bytes per sample per channel; assume stereo when guessing. */
export function estimateDecodedBytes(durationSeconds, sampleRate, channels = 2) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return Infinity;
  return Math.round(durationSeconds * sampleRate * channels * 4);
}

export class TooLargeToDecodeError extends Error {
  constructor(estimatedBytes, budgetBytes) {
    super('this track is too large to decode into memory');
    this.name = 'TooLargeToDecodeError';
    this.estimatedBytes = estimatedBytes;
    this.budgetBytes = budgetBytes;
  }
}

export class DecodedSource {
  /** @param {AudioBuffer} buffer */
  constructor(buffer) {
    this.kind = 'decoded';
    this.streaming = false;
    this.buffer = buffer;
    this.sampleRate = buffer.sampleRate;
    this.channels = Math.min(buffer.numberOfChannels, 2);
    this.totalFrames = buffer.length;
    this.duration = buffer.duration;
    this.decodedBytes = buffer.length * this.channels * 4;
  }

  /**
   * @param {Blob} blob
   * @param {BaseAudioContext} context
   * @param {{durationHint?: number, budgetBytes?: number}} [options]
   */
  static async open(blob, context, options = {}) {
    const { durationHint, budgetBytes = Infinity } = options;
    const estimate = estimateDecodedBytes(durationHint, context.sampleRate);
    if (estimate > budgetBytes) throw new TooLargeToDecodeError(estimate, budgetBytes);

    const bytes = await blob.arrayBuffer();
    return new DecodedSource(await context.decodeAudioData(bytes));
  }

  async readFrames(startFrame, frameCount) {
    const out = Array.from({ length: this.channels }, () => new Float32Array(frameCount));
    const start = Math.max(0, startFrame);
    const end = Math.min(this.totalFrames, start + frameCount);
    if (end <= start) return out;

    const skew = start - startFrame;
    for (let ch = 0; ch < this.channels; ch++) {
      out[ch].set(this.buffer.getChannelData(ch).subarray(start, end), skew);
    }
    return out;
  }

  close() {
    this.buffer = null;
  }
}
