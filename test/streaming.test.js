// Large-file handling: the sliding window that lets the stretcher play a track
// far bigger than memory, and the block reader that keeps verification from
// making one tiny read per piece.

import test from 'node:test';
import assert from 'node:assert/strict';

import { BlockReader, verifyTorrent } from '../public/lib/verify.js';
import { parseTorrent } from '../public/lib/torrent.js';
import { loadWsola, renderAll, sine, zeroCrossingRate, makeTorrentBytes, pseudoBytes } from './helpers.js';

const SAMPLE_RATE = 8000; // low rate keeps these tests quick
const WsolaStretcher = await loadWsola();

/** Cut a window out of a whole track, zero-padded like a real source would. */
function windowFrom(channels, start, length) {
  return channels.map((data) => {
    const out = new Float32Array(length);
    const from = Math.max(0, start);
    const to = Math.min(data.length, start + length);
    if (to > from) out.set(data.subarray(from, to), from - start);
    return out;
  });
}

/**
 * Play a stretcher that is fed windows on demand, exactly as the player feeds
 * the worklet: supply up front, then top up whenever it runs dry.
 */
function renderStreaming(stretcher, channels, { windowFrames, prerollFrames }) {
  const block = 128;
  const scratch = Array.from({ length: stretcher.channels }, () => new Float32Array(block));
  const parts = [];
  let total = 0;
  let supplies = 0;

  const supply = () => {
    const start = Math.max(0, Math.round(stretcher.inPos) - prerollFrames);
    stretcher.setWindow(windowFrom(channels, start, windowFrames), start);
    supplies++;
  };

  supply();
  for (let guard = 0; guard < 200000 && !stretcher.finished; guard++) {
    const produced = stretcher.pull(scratch, block);
    if (produced > 0) {
      parts.push(scratch[0].slice(0, produced));
      total += produced;
    }
    if (stretcher.stalled) supply();
    else if (produced === 0) break;
  }

  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return { output: out, supplies };
}

test('a window covering the whole track behaves exactly like setInput', () => {
  const signal = sine(440, 1, SAMPLE_RATE);
  const whole = new WsolaStretcher({ sampleRate: SAMPLE_RATE });
  whole.setInput([signal], SAMPLE_RATE);

  const streamed = new WsolaStretcher({ sampleRate: SAMPLE_RATE });
  streamed.setStream({ totalFrames: signal.length, channels: 1, sampleRate: SAMPLE_RATE });
  streamed.setWindow([signal], 0);

  whole.setSpeed(4);
  streamed.setSpeed(4);
  assert.deepEqual([...renderAll(whole)], [...renderAll(streamed)]);
});

test('streaming in windows gives bit-identical output to holding the whole track', () => {
  // The invariant that makes large-file playback trustworthy: the listener
  // cannot tell whether the track was windowed or resident.
  const signal = sine(440, 30, SAMPLE_RATE); // 240k frames
  for (const speed of [1, 4, 10]) {
    const whole = new WsolaStretcher({ sampleRate: SAMPLE_RATE });
    whole.setInput([signal], SAMPLE_RATE);
    whole.setSpeed(speed);
    const expected = renderAll(whole);

    const streamed = new WsolaStretcher({ sampleRate: SAMPLE_RATE });
    streamed.setStream({ totalFrames: signal.length, channels: 1, sampleRate: SAMPLE_RATE });
    streamed.setSpeed(speed);
    const { output, supplies } = renderStreaming(streamed, [signal], {
      windowFrames: SAMPLE_RATE * 2, // 2-second windows over a 30-second track
      prerollFrames: 2048,
    });

    assert.equal(output.length, expected.length, `${speed}x: length differs`);
    for (let i = 0; i < expected.length; i++) {
      assert.equal(output[i], expected[i], `${speed}x: sample ${i} differs`);
    }
    assert.ok(supplies > 1, `${speed}x: expected several window refills, got ${supplies}`);
  }
});

test('a window far smaller than the track still preserves pitch at 10x', () => {
  const signal = sine(440, 20, SAMPLE_RATE);
  const stretcher = new WsolaStretcher({ sampleRate: SAMPLE_RATE });
  stretcher.setStream({ totalFrames: signal.length, channels: 1, sampleRate: SAMPLE_RATE });
  stretcher.setSpeed(10);

  const { output } = renderStreaming(stretcher, [signal], {
    windowFrames: SAMPLE_RATE / 2, // half a second in hand at a time
    prerollFrames: 1024,
  });

  const body = output.subarray(stretcher.hop, output.length - stretcher.hop);
  const drift = Math.abs(zeroCrossingRate(body) - zeroCrossingRate(signal)) / zeroCrossingRate(signal);
  assert.ok(drift < 0.1, `pitch drifted ${(drift * 100).toFixed(1)}% under a tiny window`);
});

test('reports the frame range it needs next', () => {
  const stretcher = new WsolaStretcher({ sampleRate: SAMPLE_RATE, searchRadius: 256, frameSize: 2048 });
  stretcher.setStream({ totalFrames: 100000, channels: 1, sampleRate: SAMPLE_RATE });
  stretcher.seekFrames(50000);

  assert.equal(stretcher.neededFrom, 50000 - 256);
  assert.equal(stretcher.neededTo, 50000 + 256 + 2048);

  // Clamped to the track at both ends.
  stretcher.seekFrames(0);
  assert.equal(stretcher.neededFrom, 0);
  stretcher.seekFrames(99999);
  assert.equal(stretcher.neededTo, 100000);
});

test('stalls instead of playing silence it cannot justify', () => {
  const signal = sine(440, 4, SAMPLE_RATE);
  const stretcher = new WsolaStretcher({ sampleRate: SAMPLE_RATE });
  stretcher.setStream({ totalFrames: signal.length, channels: 1, sampleRate: SAMPLE_RATE });
  stretcher.setSpeed(10);

  const scratch = [new Float32Array(128)];

  // No window at all: nothing to play, and it must not claim to be finished.
  assert.equal(stretcher.pull(scratch, 128), 0);
  assert.equal(stretcher.stalled, true);
  assert.equal(stretcher.finished, false);

  // Supply the window it asked for and it resumes.
  stretcher.setWindow(windowFrom([signal], 0, SAMPLE_RATE), 0);
  assert.ok(stretcher.pull(scratch, 128) > 0);
  assert.equal(stretcher.stalled, false);
});

test('a stale window after seeking stalls rather than playing the wrong audio', () => {
  const signal = sine(440, 10, SAMPLE_RATE);
  const stretcher = new WsolaStretcher({ sampleRate: SAMPLE_RATE });
  stretcher.setStream({ totalFrames: signal.length, channels: 1, sampleRate: SAMPLE_RATE });
  stretcher.setWindow(windowFrom([signal], 0, SAMPLE_RATE), 0);

  const scratch = [new Float32Array(128)];
  assert.ok(stretcher.pull(scratch, 128) > 0);

  stretcher.seekSeconds(8); // far outside the loaded window
  stretcher.pull(scratch, 128);
  assert.equal(stretcher.stalled, true);
  assert.ok(stretcher.neededFrom >= 8 * SAMPLE_RATE - 256);
});

test('covers() answers honestly about what the window holds', () => {
  const stretcher = new WsolaStretcher({ sampleRate: SAMPLE_RATE });
  stretcher.setStream({ totalFrames: 10000, channels: 1, sampleRate: SAMPLE_RATE });
  stretcher.setWindow([new Float32Array(1000)], 500);

  assert.equal(stretcher.windowStart, 500);
  assert.equal(stretcher.windowEnd, 1500);
  assert.equal(stretcher.covers(600, 1400), true);
  assert.equal(stretcher.covers(400, 1400), false);
  assert.equal(stretcher.covers(600, 1600), false);
});

test('memory stays flat as the track grows', () => {
  // A window-based stretcher allocates against the window, never the track, so
  // a hundredfold longer track must not cost a hundredfold more memory.
  const footprint = (totalFrames) => {
    const stretcher = new WsolaStretcher({ sampleRate: SAMPLE_RATE });
    stretcher.setStream({ totalFrames, channels: 2, sampleRate: SAMPLE_RATE });
    stretcher.setWindow([new Float32Array(8000), new Float32Array(8000)], 0);
    return (
      stretcher.queue.reduce((sum, q) => sum + q.length, 0) +
      stretcher.acc.reduce((sum, a) => sum + a.length, 0) +
      stretcher.window.reduce((sum, w) => sum + w.length, 0)
    );
  };
  assert.equal(footprint(8000), footprint(8000 * 100));
});

// ----------------------------------------------------------- block reader

test('serves many small reads out of one block', async () => {
  const data = pseudoBytes(1 << 20, 5);
  let slices = 0;
  const blob = new Blob([data]);
  const counted = {
    size: blob.size,
    slice: (from, to) => {
      slices++;
      return blob.slice(from, to);
    },
  };

  const reader = new BlockReader(counted, 64 << 10);
  for (let offset = 0; offset < 1 << 20; offset += 1024) {
    const chunk = await reader.read(offset, 1024);
    assert.equal(chunk[0], data[offset], `byte at ${offset}`);
  }

  // 1024 reads of 1KB across 1MB, served from 64KB blocks.
  assert.equal(slices, 16, `expected 16 block loads, made ${slices}`);
});

test('returns correct bytes across a block boundary', async () => {
  const data = pseudoBytes(4096, 9);
  const reader = new BlockReader(new Blob([data]), 1024);
  const chunk = await reader.read(1000, 100); // straddles the first boundary
  assert.deepEqual([...chunk], [...data.subarray(1000, 1100)]);
});

test('handles a read larger than the block size', async () => {
  const data = pseudoBytes(8192, 11);
  const reader = new BlockReader(new Blob([data]), 1024);
  const chunk = await reader.read(0, 4096);
  assert.deepEqual([...chunk], [...data.subarray(0, 4096)]);
});

test('clips at the end of the file instead of over-reading', async () => {
  const data = pseudoBytes(100, 13);
  const reader = new BlockReader(new Blob([data]), 1024);
  const chunk = await reader.read(60, 80); // only 40 bytes exist
  assert.equal(chunk.length, 40);
  assert.deepEqual([...chunk], [...data.subarray(60)]);
});

test('verification of a small-piece torrent collapses into a few reads', async () => {
  // The 1GB case in miniature: many pieces, one file. Without buffering this
  // would be one file read per piece.
  const data = pseudoBytes(512 * 1024, 21);
  const { bytes } = await makeTorrentBytes({
    single: true,
    pieceLength: 16384,
    files: [{ path: ['big.wav'], data }],
  });
  const torrent = await parseTorrent(bytes);
  assert.equal(torrent.pieceCount, 32);

  const blob = new Blob([data]);
  let slices = 0;
  const counted = {
    size: blob.size,
    slice: (from, to) => {
      slices++;
      return blob.slice(from, to);
    },
  };

  const result = await verifyTorrent(torrent, new Map([[0, counted]]), { blockBytes: 256 * 1024 });
  assert.equal(result.ok, 32);
  assert.equal(result.bad, 0);
  assert.equal(slices, 2, `32 pieces should need 2 block reads, made ${slices}`);
});
