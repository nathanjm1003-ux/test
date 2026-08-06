// Generate a sample torrent and the audio it describes, so the app can be tried
// (and end-to-end tested) without hunting for real files.
//
//   node test/fixtures/make-fixtures.mjs [outputDir]
//
// Produces two playable WAV tracks and a .torrent whose piece hashes genuinely
// cover them, so "Verify against piece hashes" reports a clean result.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { encode } from '../../public/lib/bencode.js';
import { sha1 } from '../../public/lib/hash.js';

const SAMPLE_RATE = 44100;

/** 16-bit PCM WAV. */
function makeWav(seconds, frequency, { channels = 2, sampleRate = SAMPLE_RATE } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const blockAlign = channels * 2;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < frames; i++) {
    // A tone with a little vibrato and an envelope, so speed changes are
    // audible rather than a featureless drone.
    const t = i / sampleRate;
    const wobble = 1 + 0.02 * Math.sin(2 * Math.PI * 5 * t);
    const envelope = Math.min(1, t * 4, (seconds - t) * 4);
    const value = Math.sin(2 * Math.PI * frequency * wobble * t) * envelope * 0.4;
    const sample = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
    for (let ch = 0; ch < channels; ch++) {
      view.setInt16(44 + i * blockAlign + ch * 2, ch === 0 ? sample : Math.round(sample * 0.6), true);
    }
  }

  return new Uint8Array(buffer);
}

/**
 * A structurally valid MPEG-1 Layer III file that decodes to silence.
 *
 * There is no MP3 encoder in this project, but the compressed-audio path still
 * has to be testable — and it is the path with the interesting behaviour, since
 * compressed formats cannot stream and are memory-budgeted. Zeroed side info
 * means part2_3_length is 0 everywhere: no Huffman data, every spectral value
 * zero, so each frame is a legal frame of silence.
 */
function makeSilentMp3(seconds, { sampleRate = 44100 } = {}) {
  const FRAME_BYTES = 417; // floor(144 * 128000 / 44100), 128kbps
  const FRAME_SAMPLES = 1152;
  const frames = Math.max(1, Math.round((seconds * sampleRate) / FRAME_SAMPLES));
  const out = new Uint8Array(FRAME_BYTES * frames);
  for (let i = 0; i < frames; i++) {
    const at = i * FRAME_BYTES;
    out[at] = 0xff; // sync
    out[at + 1] = 0xfb; // sync | MPEG-1 | Layer III | no CRC
    out[at + 2] = 0x90; // 128kbps | 44100Hz | no padding
    out[at + 3] = 0xc0; // mono
  }
  return out;
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function buildTorrent(name, files, pieceLength) {
  const content = concat(files.map((file) => file.data));
  const hashes = [];
  for (let offset = 0; offset < content.length; offset += pieceLength) {
    hashes.push(await sha1(content.subarray(offset, Math.min(offset + pieceLength, content.length))));
  }

  return encode({
    announce: 'http://tracker.invalid/announce',
    'announce-list': [['http://tracker.invalid/announce'], ['udp://tracker2.invalid:6969']],
    comment: 'Sample torrent generated for local testing. Nothing here is shared with anyone.',
    'created by': 'torrent-audio-speed fixtures',
    'creation date': Math.floor(Date.now() / 1000),
    info: {
      name,
      'piece length': pieceLength,
      pieces: concat(hashes),
      files: files.map((file) => ({ length: file.data.length, path: file.path })),
    },
  });
}

const outputDir = process.argv[2] ?? join(process.cwd(), 'fixtures');
const albumDir = join(outputDir, 'sample album');
await mkdir(albumDir, { recursive: true });

const files = [
  { path: ['sample album', '01 - low tone.wav'], data: makeWav(6, 220) },
  { path: ['sample album', '02 - high tone.wav'], data: makeWav(4, 440) },
  { path: ['sample album', 'notes.txt'], data: new TextEncoder().encode('Generated fixture.\n') },
];

for (const file of files) {
  await writeFile(join(outputDir, ...file.path), file.data);
}

// A compressed file outside the album, for trying playback without a torrent
// and for exercising the decode path the streaming reader cannot serve.
const mp3Path = join(outputDir, 'sample.mp3');
await writeFile(mp3Path, makeSilentMp3(6));

const torrent = await buildTorrent('sample album', files, 16384);
const torrentPath = join(outputDir, 'sample album.torrent');
await writeFile(torrentPath, torrent);

console.log(`Wrote ${torrentPath}`);
for (const file of files) console.log(`Wrote ${join(outputDir, ...file.path)}`);
console.log(`Wrote ${mp3Path} (silent, for testing playback without a torrent)`);
console.log('\nStart the app with `npm start`, open the torrent, then attach the folder above.');
console.log('Or just drop sample.mp3 straight onto the page.');
