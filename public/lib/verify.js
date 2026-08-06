// Verify local files against a torrent's SHA-1 piece hashes.
//
// This is what makes reading the .torrent worth doing: it proves the audio you
// are about to play really is the content the torrent describes, bit for bit,
// and pinpoints which files are incomplete or corrupt.

import { sha1, bytesEqual } from './hash.js';
import { pieceHash, pieceLengthAt } from './torrent.js';

export const PIECE_PENDING = 0;
export const PIECE_OK = 1;
export const PIECE_BAD = 2;
export const PIECE_MISSING = 3;

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
 * @param {{onProgress?: (p: {piece:number, pieceCount:number, ok:number, bad:number, missing:number}) => void,
 *          signal?: AbortSignal}} [options]
 */
export async function verifyTorrent(torrent, sources, options = {}) {
  const { onProgress, signal } = options;
  if (!torrent.hasPieceHashes) {
    throw new Error('this torrent carries no v1 piece hashes, so its contents cannot be verified');
  }

  const pieces = new Uint8Array(torrent.pieceCount).fill(PIECE_PENDING);
  let ok = 0;
  let bad = 0;
  let missing = 0;
  let verifiedBytes = 0;
  let lastReport = 0;

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
      const buffer = new Uint8Array(length);
      for (const file of overlapping) {
        const from = Math.max(start, file.offset);
        const to = Math.min(end, file.endOffset);
        const blob = sources.get(file.index);
        if (!blob) continue; // pad file with no source: leave the gap zeroed
        const slice = blob.slice(from - file.offset, to - file.offset);
        buffer.set(new Uint8Array(await slice.arrayBuffer()), from - start);
      }
      if (bytesEqual(await sha1(buffer), pieceHash(torrent, index))) {
        pieces[index] = PIECE_OK;
        ok++;
        verifiedBytes += length;
      } else {
        pieces[index] = PIECE_BAD;
        bad++;
      }
    }

    // Throttle progress reporting; hashing a large torrent is thousands of pieces.
    const now = Date.now();
    if (onProgress && (now - lastReport > 100 || index === torrent.pieceCount - 1)) {
      lastReport = now;
      onProgress({ piece: index + 1, pieceCount: torrent.pieceCount, ok, bad, missing });
    }
  }

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
