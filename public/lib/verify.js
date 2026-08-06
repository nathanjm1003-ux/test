// Verify local files against a torrent's SHA-1 piece hashes.
//
// This is what makes reading the .torrent worth doing: it proves the audio you
// are about to play really is the content the torrent describes, bit for bit,
// and pinpoints which files are incomplete or corrupt.
//
// Reads go through a block cache rather than straight to the file. Torrents
// often use 16-64KB pieces, so a 1GB download is tens of thousands of pieces;
// slicing the file once per piece turns into tens of thousands of round trips.
// Verification walks the content in order, so pulling a few MB at a time and
// serving pieces out of that collapses the read count by orders of magnitude.

import { sha1, bytesEqual } from './hash.js';
import { pieceHash, pieceLengthAt } from './torrent.js';

export const PIECE_PENDING = 0;
export const PIECE_OK = 1;
export const PIECE_BAD = 2;
export const PIECE_MISSING = 3;

/** Bytes pulled from a file per read. */
const BLOCK_BYTES = 4 << 20;

/** Sequential reader that serves small reads out of one buffered block. */
export class BlockReader {
  constructor(blob, blockBytes = BLOCK_BYTES) {
    this.blob = blob;
    this.blockBytes = blockBytes;
    this.block = null;
    this.blockStart = 0;
    this.reads = 0;
  }

  /**
   * @param {number} offset byte offset within the file
   * @param {number} length
   * @returns {Promise<Uint8Array>} may be a view into the cached block
   */
  async read(offset, length) {
    if (length <= 0) return new Uint8Array(0);
    const end = offset + length;
    if (this.block && offset >= this.blockStart && end <= this.blockStart + this.block.length) {
      return this.block.subarray(offset - this.blockStart, end - this.blockStart);
    }

    const size = Math.max(this.blockBytes, length);
    const stop = Math.min(this.blob.size, offset + size);
    this.block = new Uint8Array(await this.blob.slice(offset, stop).arrayBuffer());
    this.blockStart = offset;
    this.reads++;
    return this.block.subarray(0, Math.min(length, this.block.length));
  }

  release() {
    this.block = null;
  }
}

/** Files (by torrent index) whose byte range overlaps `[start, end)`. */
function filesOverlapping(files, start, end) {
  const out = [];
  for (const file of files) {
    if (file.length === 0) continue;
    if (file.offset >= end) break; // files are ordered by offset
    if (file.endOffset > start) out.push(file);
  }
  return out;
}

/**
 * @param {import('./torrent.js').Torrent} torrent
 * @param {Map<number, Blob>} sources torrent file index -> Blob/File
 * @param {{onProgress?: (p: {piece:number, pieceCount:number, ok:number, bad:number,
 *                           missing:number, bytesRead:number, bytesPerSecond:number,
 *                           secondsRemaining:number}) => void,
 *          signal?: AbortSignal, blockBytes?: number}} [options]
 */
export async function verifyTorrent(torrent, sources, options = {}) {
  const { onProgress, signal, blockBytes } = options;
  if (!torrent.hasPieceHashes) {
    throw new Error('this torrent carries no v1 piece hashes, so its contents cannot be verified');
  }

  const pieces = new Uint8Array(torrent.pieceCount).fill(PIECE_PENDING);
  let ok = 0;
  let bad = 0;
  let missing = 0;
  let verifiedBytes = 0;
  let bytesRead = 0;
  let lastReport = 0;
  const startedAt = Date.now();

  // One buffered reader per file, dropped as soon as the walk passes it, so a
  // large multi-file torrent never holds more than a couple of blocks at once.
  const readers = new Map();
  const readerFor = (file) => {
    let reader = readers.get(file.index);
    if (!reader) {
      reader = new BlockReader(sources.get(file.index), blockBytes);
      readers.set(file.index, reader);
    }
    return reader;
  };

  let buffer = new Uint8Array(torrent.pieceLength);

  for (let index = 0; index < torrent.pieceCount; index++) {
    if (signal?.aborted) throw new DOMException('verification cancelled', 'AbortError');

    const start = index * torrent.pieceLength;
    const length = pieceLengthAt(torrent, index);
    const end = start + length;
    const overlapping = filesOverlapping(torrent.files, start, end);

    // A piece can only be checked when every file it spans is present.
    const complete = overlapping.every((file) => sources.has(file.index) || file.isPad);
    if (!complete) {
      pieces[index] = PIECE_MISSING;
      missing++;
    } else {
      const view = length === buffer.length ? buffer : buffer.subarray(0, length);
      view.fill(0);
      for (const file of overlapping) {
        if (!sources.has(file.index)) continue; // pad file with no source: leave the gap zeroed
        const from = Math.max(start, file.offset);
        const to = Math.min(end, file.endOffset);
        const chunk = await readerFor(file).read(from - file.offset, to - from);
        view.set(chunk, from - start);
        bytesRead += chunk.length;
      }
      if (bytesEqual(await sha1(view), pieceHash(torrent, index))) {
        pieces[index] = PIECE_OK;
        ok++;
        verifiedBytes += length;
      } else {
        pieces[index] = PIECE_BAD;
        bad++;
      }
    }

    // Release readers for files entirely behind the walk.
    for (const [fileIndex, reader] of readers) {
      const file = torrent.files[fileIndex];
      if (file && file.endOffset <= end) {
        reader.release();
        readers.delete(fileIndex);
      }
    }

    // Throttle progress reporting; a large torrent is tens of thousands of pieces.
    const now = Date.now();
    if (onProgress && (now - lastReport > 100 || index === torrent.pieceCount - 1)) {
      lastReport = now;
      const elapsed = Math.max(0.001, (now - startedAt) / 1000);
      const bytesPerSecond = bytesRead / elapsed;
      const remainingBytes = Math.max(0, torrent.totalLength - end);
      onProgress({
        piece: index + 1,
        pieceCount: torrent.pieceCount,
        ok,
        bad,
        missing,
        bytesRead,
        bytesPerSecond,
        secondsRemaining: bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : 0,
      });
    }
  }

  for (const reader of readers.values()) reader.release();
  buffer = null;

  return { pieces, ok, bad, missing, verifiedBytes, files: deriveFileStatus(torrent, pieces, sources) };
}

/**
 * Turn per-piece results into per-file results.
 *
 * A file that shares a boundary piece with a neighbour can be failed by that
 * neighbour, so a failure confined to shared pieces is reported separately
 * rather than blamed on the file outright.
 */
export function deriveFileStatus(torrent, pieces, sources) {
  const status = new Map();

  for (const file of torrent.files) {
    if (file.isPad) continue;
    if (!sources.has(file.index)) {
      status.set(file.index, { status: 'missing', ok: 0, total: 0, sharedFailureOnly: false });
      continue;
    }
    if (file.length === 0) {
      status.set(file.index, { status: 'complete', ok: 0, total: 0, sharedFailureOnly: false });
      continue;
    }

    let okCount = 0;
    let failures = 0;
    let exclusiveFailures = 0;
    const total = file.lastPiece - file.firstPiece + 1;

    for (let index = file.firstPiece; index <= file.lastPiece; index++) {
      if (pieces[index] === PIECE_OK) {
        okCount++;
        continue;
      }
      if (pieces[index] === PIECE_PENDING) continue;
      failures++;
      const start = index * torrent.pieceLength;
      const end = start + pieceLengthAt(torrent, index);
      const shared = filesOverlapping(torrent.files, start, end).some(
        (other) => other.index !== file.index && !other.isPad,
      );
      if (!shared) exclusiveFailures++;
    }

    let state = 'complete';
    if (failures > 0) state = okCount > 0 ? 'partial' : 'corrupt';
    status.set(file.index, {
      status: state,
      ok: okCount,
      total,
      sharedFailureOnly: failures > 0 && exclusiveFailures === 0,
    });
  }

  return status;
}
