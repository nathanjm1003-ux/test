// Strategy selection for reading audio out of a file.
//
// Every source exposes the same shape, so the player and the worklet never care
// which one they got:
//
//   { kind, streaming, sampleRate, channels, totalFrames, duration,
//     readFrames(startFrame, frameCount) -> Promise<Float32Array[]>, close() }
//
// `streaming: true` means windows come off disk on demand and file size is not a
// constraint. `streaming: false` means the whole track had to be decoded into
// memory first, which is why those sources are budget-limited.
//
// Adding a format to the streaming side is a matter of implementing that
// interface — a frame-indexed MP3 or FLAC reader would slot in here without the
// player, the stretcher or the worklet changing at all.

import { WavSource, looksLikeWav } from './wav.js';
import { DecodedSource, TooLargeToDecodeError, estimateDecodedBytes } from './decoded.js';

export { TooLargeToDecodeError, estimateDecodedBytes, WavSource, DecodedSource };

/**
 * Default ceiling on decoded PCM held in memory. Roughly 45 minutes of stereo
 * at 48kHz. Beyond this, decoding is more likely to take the tab down than to
 * succeed, so we decline and say so instead.
 */
export const DEFAULT_BUDGET_BYTES = 1_000_000_000;

/**
 * @param {Blob} blob
 * @param {BaseAudioContext} context
 * @param {{durationHint?: number, budgetBytes?: number}} [options]
 */
/**
 * @param {Blob} blob
 * @param {(sampleRate?: number) => Promise<BaseAudioContext>} getContext
 *   Deferred because the right sample rate is only known once the source is
 *   identified: a streamed WAV wants a context at its own rate, while a decode
 *   has to happen in whatever context already exists.
 * @param {{durationHint?: number, budgetBytes?: number, preferStreaming?: boolean}} [options]
 */
export async function createAudioSource(blob, getContext, options = {}) {
  // Uncompressed audio is exactly addressable, so it streams regardless of size.
  if (options.preferStreaming !== false && (await looksLikeWav(blob))) {
    try {
      return await WavSource.open(blob);
    } catch {
      // Odd or exotic WAV (ADPCM, say). Fall through and let the browser decode it.
    }
  }
  return DecodedSource.open(blob, await getContext(), {
    budgetBytes: options.budgetBytes ?? DEFAULT_BUDGET_BYTES,
    durationHint: options.durationHint,
  });
}

/**
 * Whether a file can be time-stretched, and why not when it cannot. Checked
 * before committing to a decode so the UI can explain itself up front.
 * @param {Blob} blob
 * @param {{durationHint?: number, sampleRate: number, budgetBytes?: number}} options
 */
export async function inspectSource(blob, options) {
  const budgetBytes = options.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  if (options.preferStreaming !== false && (await looksLikeWav(blob))) {
    return { streaming: true, available: true, estimatedBytes: 0 };
  }
  const estimatedBytes = estimateDecodedBytes(options.durationHint, options.sampleRate);
  return {
    streaming: false,
    available: estimatedBytes <= budgetBytes,
    estimatedBytes,
    budgetBytes,
  };
}
