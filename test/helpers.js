// Test helpers: build real .torrent bytes with genuine SHA-1 piece hashes.

import { readFile } from 'node:fs/promises';
import { encode } from '../public/lib/bencode.js';
import { sha1 } from '../public/lib/hash.js';

export function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Deterministic pseudo-random bytes, so failures are reproducible. */
export function pseudoBytes(length, seed = 1) {
  const out = new Uint8Array(length);
  let value = seed >>> 0;
  for (let i = 0; i < length; i++) {
    value = (value * 1664525 + 1013904223) >>> 0;
    out[i] = (value >>> 24) & 0xff;
  }
  return out;
}

/**
 * Build a .torrent describing the supplied files.
 * @param {{name?: string, pieceLength?: number, single?: boolean,
 *          files: Array<{path: string[], data: Uint8Array}>,
 *          info?: object, root?: object}} spec
 */
export async function makeTorrentBytes(spec) {
  const { name = 'test torrent', pieceLength = 64, single = false, files } = spec;
  const content = concatBytes(files.map((file) => file.data));

  const hashes = [];
  for (let offset = 0; offset < content.length; offset += pieceLength) {
    hashes.push(await sha1(content.subarray(offset, Math.min(offset + pieceLength, content.length))));
  }
  const pieces = concatBytes(hashes);

  const info = single
    ? {
        name: files[0].path.join('/'),
        'piece length': pieceLength,
        pieces,
        length: files[0].data.length,
        ...(spec.info ?? {}),
      }
    : {
        name,
        'piece length': pieceLength,
        pieces,
        files: files.map((file) => ({ length: file.data.length, path: file.path })),
        ...(spec.info ?? {}),
      };

  const root = {
    announce: 'http://tracker.example/announce',
    'created by': 'unit tests',
    info,
    ...(spec.root ?? {}),
  };

  return { bytes: encode(root), info, content, pieceCount: hashes.length };
}

/** Blobs keyed by torrent file index, ready to hand to verifyTorrent. */
export function sourcesFrom(torrent, files) {
  const sources = new Map();
  torrent.files.forEach((entry, index) => {
    const match = files[index];
    if (match) sources.set(entry.index, new Blob([match.data]));
  });
  return sources;
}

/** Load the WSOLA core, which is a classic script rather than a module. */
export async function loadWsola() {
  const source = await readFile(new URL('../public/lib/wsola-core.js', import.meta.url), 'utf8');
  return new Function(`${source}\nreturn WsolaStretcher;`)();
}

/** Render a stretcher to completion, returning channel 0. */
export function renderAll(stretcher, limitFrames = 48000 * 60) {
  const block = 128;
  const scratch = Array.from({ length: stretcher.channels }, () => new Float32Array(block));
  const parts = [];
  let total = 0;

  while (!stretcher.finished && total < limitFrames) {
    const produced = stretcher.pull(scratch, block);
    if (produced > 0) {
      parts.push(scratch[0].slice(0, produced));
      total += produced;
    }
    if (produced === 0) break;
  }
  return concatFloats(parts, total);
}

function concatFloats(parts, total) {
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Sine wave, for tests that need a signal with a known frequency. */
export function sine(frequency, seconds, sampleRate = 48000, amplitude = 0.5) {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return out;
}

/** Zero crossings per sample — a cheap proxy for pitch on a simple signal. */
export function zeroCrossingRate(samples) {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] <= 0 && samples[i] > 0) crossings++;
    else if (samples[i - 1] >= 0 && samples[i] < 0) crossings++;
  }
  return crossings / samples.length;
}

export function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}
