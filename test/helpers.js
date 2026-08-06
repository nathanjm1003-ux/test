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

/**
 * Build a WAV file in memory.
 * @param {{frames?:number, channels?:number, bitsPerSample?:number, sampleRate?:number,
 *          format?:number, extensible?:boolean, fill?:(frame:number, channel:number)=>number,
 *          extraChunks?:Array<{id:string, size:number}>}} [options]
 */
export function makeWavBytes(options = {}) {
  const {
    frames = 100,
    channels = 2,
    bitsPerSample = 16,
    sampleRate = 44100,
    format = 1,
    extensible = false,
    fill = () => 0,
    extraChunks = [],
  } = options;

  const bytesPerSample = bitsPerSample >> 3;
  const blockAlign = bytesPerSample * channels;
  const dataSize = frames * blockAlign;
  const fmtSize = extensible ? 40 : 16;
  const extraSize = extraChunks.reduce((sum, chunk) => sum + 8 + chunk.size + (chunk.size % 2), 0);
  const buffer = new ArrayBuffer(12 + 8 + fmtSize + extraSize + 8 + dataSize);
  const view = new DataView(buffer);

  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  ascii(8, 'WAVE');

  let at = 12;
  ascii(at, 'fmt ');
  view.setUint32(at + 4, fmtSize, true);
  view.setUint16(at + 8, extensible ? 0xfffe : format, true);
  view.setUint16(at + 10, channels, true);
  view.setUint32(at + 12, sampleRate, true);
  view.setUint32(at + 16, sampleRate * blockAlign, true);
  view.setUint16(at + 20, blockAlign, true);
  view.setUint16(at + 22, bitsPerSample, true);
  if (extensible) {
    view.setUint16(at + 24, 22, true); // cbSize
    view.setUint16(at + 26, bitsPerSample, true);
    view.setUint32(at + 28, 3, true); // channel mask
    view.setUint16(at + 32, format, true); // SubFormat GUID starts with the real tag
  }
  at += 8 + fmtSize;

  for (const chunk of extraChunks) {
    ascii(at, chunk.id);
    view.setUint32(at + 4, chunk.size, true);
    at += 8 + chunk.size + (chunk.size % 2);
  }

  ascii(at, 'data');
  view.setUint32(at + 4, dataSize, true);
  at += 8;

  const clamp = (value) => Math.max(-1, Math.min(1, value));
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const value = clamp(fill(frame, channel));
      const offset = at + frame * blockAlign + channel * bytesPerSample;
      if (format === 3) {
        if (bitsPerSample === 64) view.setFloat64(offset, value, true);
        else view.setFloat32(offset, value, true);
      } else if (bitsPerSample === 8) {
        view.setUint8(offset, Math.max(0, Math.min(255, Math.round(value * 128) + 128)));
      } else if (bitsPerSample === 16) {
        view.setInt16(offset, Math.round(value * 32767), true);
      } else if (bitsPerSample === 24) {
        const sample = Math.round(value * 8388607);
        view.setUint8(offset, sample & 0xff);
        view.setUint8(offset + 1, (sample >> 8) & 0xff);
        view.setUint8(offset + 2, (sample >> 16) & 0xff);
      } else if (bitsPerSample === 32) {
        view.setInt32(offset, Math.round(value * 2147483647), true);
      }
    }
  }

  return new Uint8Array(buffer);
}

export function wavBlob(options) {
  return new Blob([makeWavBytes(options)]);
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
