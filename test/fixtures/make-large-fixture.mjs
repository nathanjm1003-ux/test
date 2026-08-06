// Generate a large WAV and its torrent, for testing behaviour at real file sizes.
//
//   node test/fixtures/make-large-fixture.mjs [outputDir] [megabytes]
//
// Both the audio and the piece hashes are produced in a single streaming pass,
// so making a 1GB fixture never holds a gigabyte in memory — the same property
// the app itself relies on.

import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { encode } from '../../public/lib/bencode.js';

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BITS = 16;
const BLOCK_ALIGN = (BITS >> 3) * CHANNELS;
const PIECE_LENGTH = 1 << 20; // 1 MiB

const outputDir = process.argv[2] ?? join(process.cwd(), 'fixtures');
const megabytes = Number(process.argv[3] ?? 1024);
const targetDataBytes = Math.floor((megabytes * 1024 * 1024) / BLOCK_ALIGN) * BLOCK_ALIGN;
const totalFrames = targetDataBytes / BLOCK_ALIGN;

await mkdir(outputDir, { recursive: true });
const name = `large tone ${megabytes}MB.wav`;
const wavPath = join(outputDir, name);

function wavHeader(dataSize) {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * BLOCK_ALIGN, 28);
  buffer.writeUInt16LE(BLOCK_ALIGN, 32);
  buffer.writeUInt16LE(BITS, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

/** Hash the stream as it is written, one torrent piece at a time. */
class PieceHasher {
  constructor(pieceLength) {
    this.pieceLength = pieceLength;
    this.hash = createHash('sha1');
    this.filled = 0;
    this.hashes = [];
  }

  update(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      const room = this.pieceLength - this.filled;
      const take = Math.min(room, chunk.length - offset);
      this.hash.update(chunk.subarray(offset, offset + take));
      this.filled += take;
      offset += take;
      if (this.filled === this.pieceLength) {
        this.hashes.push(this.hash.digest());
        this.hash = createHash('sha1');
        this.filled = 0;
      }
    }
  }

  finish() {
    if (this.filled > 0) this.hashes.push(this.hash.digest());
    return Buffer.concat(this.hashes);
  }
}

const hasher = new PieceHasher(PIECE_LENGTH);
const stream = createWriteStream(wavPath);

async function write(buffer) {
  hasher.update(buffer);
  if (!stream.write(buffer)) await once(stream, 'drain');
}

await write(wavHeader(targetDataBytes));

// A steady 440Hz tone. Position is verified exactly by the unit tests; here the
// signal only has to be real audio of a realistic size.
const CHUNK_FRAMES = 1 << 16;
const chunk = Buffer.alloc(CHUNK_FRAMES * BLOCK_ALIGN);
const startedAt = Date.now();

for (let frame = 0; frame < totalFrames; frame += CHUNK_FRAMES) {
  const frames = Math.min(CHUNK_FRAMES, totalFrames - frame);
  for (let i = 0; i < frames; i++) {
    const t = (frame + i) / SAMPLE_RATE;
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * t) * 0.4 * 32767);
    chunk.writeInt16LE(sample, i * BLOCK_ALIGN);
    chunk.writeInt16LE(Math.round(sample * 0.6), i * BLOCK_ALIGN + 2);
  }
  await write(chunk.subarray(0, frames * BLOCK_ALIGN));
}

stream.end();
await once(stream, 'finish');

const fileLength = 44 + targetDataBytes;
const torrent = encode({
  announce: 'http://tracker.invalid/announce',
  comment: 'Large fixture for testing behaviour at real file sizes.',
  'created by': 'torrent-audio-speed fixtures',
  'creation date': Math.floor(Date.now() / 1000),
  info: {
    name,
    'piece length': PIECE_LENGTH,
    pieces: new Uint8Array(hasher.finish()),
    length: fileLength,
  },
});

const torrentPath = join(outputDir, `${name}.torrent`);
await writeFile(torrentPath, torrent);

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Wrote ${wavPath}`);
console.log(`  ${(fileLength / 1e9).toFixed(2)} GB · ${(totalFrames / SAMPLE_RATE / 60).toFixed(1)} minutes of audio`);
console.log(`Wrote ${torrentPath}`);
console.log(`  ${Math.ceil(fileLength / PIECE_LENGTH)} pieces of ${PIECE_LENGTH / 1024} KiB · generated in ${seconds}s`);
