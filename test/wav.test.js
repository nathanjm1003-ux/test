import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWavHeader, WavSource, looksLikeWav } from '../public/lib/sources/wav.js';
import { makeWavBytes, wavBlob } from './helpers.js';

test('parses a 16-bit stereo header', async () => {
  const header = await parseWavHeader(wavBlob({ frames: 100, channels: 2, bitsPerSample: 16 }));
  assert.equal(header.channels, 2);
  assert.equal(header.sampleRate, 44100);
  assert.equal(header.bitsPerSample, 16);
  assert.equal(header.blockAlign, 4);
  assert.equal(header.totalFrames, 100);
  assert.equal(header.dataOffset, 44);
});

test('skips chunks it does not care about', async () => {
  // Real files carry LIST/INFO metadata between fmt and data.
  const blob = wavBlob({ frames: 50, extraChunks: [{ id: 'LIST', size: 26 }] });
  const header = await parseWavHeader(blob);
  assert.equal(header.totalFrames, 50);
  assert.equal(header.dataOffset, 44 + 8 + 26);
});

test('reads the real format out of WAVE_FORMAT_EXTENSIBLE', async () => {
  const header = await parseWavHeader(wavBlob({ frames: 10, extensible: true }));
  assert.equal(header.format, 1); // PCM, from the subformat GUID
  assert.equal(header.channels, 2);
});

test('recognises WAV without reading the audio', async () => {
  assert.equal(await looksLikeWav(wavBlob({ frames: 10 })), true);
  assert.equal(await looksLikeWav(new Blob([new Uint8Array(64)])), false);
  assert.equal(await looksLikeWav(new Blob([new TextEncoder().encode('ID3\x04not audio')])), false);
});

test('rejects files it cannot address exactly', async () => {
  await assert.rejects(() => parseWavHeader(new Blob([new Uint8Array(4)])), /too short/);
  await assert.rejects(() => parseWavHeader(new Blob([new Uint8Array(64)])), /not a RIFF/);
  // ADPCM and friends are compressed, so byte offsets do not map to frames.
  await assert.rejects(() => parseWavHeader(wavBlob({ frames: 10, format: 0x0011 })), /unsupported WAV encoding/);
});

test('reads exact sample values at an arbitrary offset', async () => {
  // A ramp makes every frame individually identifiable.
  const frames = 1000;
  const blob = wavBlob({ frames, channels: 1, bitsPerSample: 16, fill: (i) => (i / frames) * 2 - 1 });
  const source = await WavSource.open(blob);

  assert.equal(source.streaming, true);
  assert.equal(source.totalFrames, frames);
  assert.equal(source.channels, 1);

  const [channel] = await source.readFrames(500, 4);
  for (let i = 0; i < 4; i++) {
    const expected = ((500 + i) / frames) * 2 - 1;
    assert.ok(Math.abs(channel[i] - expected) < 1e-4, `frame ${500 + i}: ${channel[i]} vs ${expected}`);
  }
});

test('seeking to a window costs one read of that window only', async () => {
  // The point of streaming: reading near the end must not touch the start.
  const frames = 1_000_000;
  const blob = wavBlob({ frames, channels: 2, bitsPerSample: 16, fill: (i) => Math.sin(i / 50) });
  const source = await WavSource.open(blob);

  let bytesRead = 0;
  const realSlice = blob.slice.bind(blob);
  source.blob = {
    size: blob.size,
    slice: (from, to) => {
      bytesRead += to - from;
      return realSlice(from, to);
    },
  };

  await source.readFrames(900_000, 48_000);
  assert.ok(bytesRead <= 48_000 * 4 + 16, `read ${bytesRead} bytes for a 48k-frame window`);
});

test('zero-pads past the end instead of running short', async () => {
  const source = await WavSource.open(wavBlob({ frames: 100, channels: 2, fill: () => 0.5 }));
  const channels = await source.readFrames(90, 32);

  assert.equal(channels[0].length, 32);
  assert.ok(Math.abs(channels[0][0] - 0.5) < 1e-3);
  assert.equal(channels[0][10], 0); // frame 100 onwards does not exist
  assert.equal(channels[0][31], 0);
});

test('reads before the start without shifting the data', async () => {
  const source = await WavSource.open(wavBlob({ frames: 100, channels: 1, fill: () => 0.25 }));
  const [channel] = await source.readFrames(-10, 20);
  assert.equal(channel[0], 0); // frame -10 does not exist
  assert.equal(channel[9], 0);
  assert.ok(Math.abs(channel[10] - 0.25) < 1e-3); // frame 0 lands in the right slot
});

test('handles every PCM width it claims to', async () => {
  for (const bits of [8, 16, 24, 32]) {
    const source = await WavSource.open(wavBlob({ frames: 64, channels: 1, bitsPerSample: bits, fill: () => 0.5 }));
    const [channel] = await source.readFrames(0, 8);
    const tolerance = bits === 8 ? 0.01 : 1e-3;
    assert.ok(Math.abs(channel[0] - 0.5) < tolerance, `${bits}-bit read ${channel[0]}`);
  }
});

test('handles 32-bit float samples', async () => {
  const source = await WavSource.open(
    wavBlob({ frames: 64, channels: 1, bitsPerSample: 32, format: 3, fill: () => -0.75 }),
  );
  const [channel] = await source.readFrames(0, 4);
  assert.ok(Math.abs(channel[0] + 0.75) < 1e-6);
});

test('keeps stereo channels separate', async () => {
  const blob = wavBlob({
    frames: 128,
    channels: 2,
    bitsPerSample: 16,
    fill: (frame, channel) => (channel === 0 ? 0.5 : -0.5),
  });
  const source = await WavSource.open(blob);
  const [left, right] = await source.readFrames(0, 16);
  assert.ok(Math.abs(left[0] - 0.5) < 1e-3);
  assert.ok(Math.abs(right[0] + 0.5) < 1e-3);
});

test('ignores channels beyond stereo in a multichannel file', async () => {
  const source = await WavSource.open(wavBlob({ frames: 64, channels: 6, bitsPerSample: 16, fill: () => 0.5 }));
  assert.equal(source.sourceChannels, 6);
  assert.equal(source.channels, 2);
  const channels = await source.readFrames(0, 8);
  assert.equal(channels.length, 2);
});

test('reports duration from the header, at the file\'s own rate', async () => {
  const source = await WavSource.open(wavBlob({ frames: 88200, sampleRate: 44100, channels: 2 }));
  assert.equal(source.sampleRate, 44100);
  assert.ok(Math.abs(source.duration - 2) < 1e-6);
});

test('a data chunk with a placeholder size falls back to the file length', async () => {
  // Streamed WAVs are written before the length is known.
  const bytes = makeWavBytes({ frames: 100, channels: 1, bitsPerSample: 16 });
  new DataView(bytes.buffer).setUint32(40, 0xffffffff, true);
  const header = await parseWavHeader(new Blob([bytes]));
  assert.equal(header.totalFrames, 100);
});
