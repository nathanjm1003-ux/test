import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTorrent } from '../public/lib/torrent.js';
import { verifyTorrent, PIECE_OK, PIECE_BAD, PIECE_MISSING } from '../public/lib/verify.js';
import { makeTorrentBytes, pseudoBytes } from './helpers.js';

/** A three-file torrent whose files deliberately straddle piece boundaries. */
async function fixture(pieceLength = 64) {
  const files = [
    { path: ['album', '01.mp3'], data: pseudoBytes(150, 11) },
    { path: ['album', '02.mp3'], data: pseudoBytes(90, 22) },
    { path: ['album', 'notes.txt'], data: pseudoBytes(40, 33) },
  ];
  const { bytes } = await makeTorrentBytes({ name: 'album', pieceLength, files });
  return { torrent: await parseTorrent(bytes), files };
}

function sourcesOf(files, overrides = {}) {
  const sources = new Map();
  files.forEach((file, index) => {
    if (overrides[index] === null) return;
    sources.set(index, new Blob([overrides[index] ?? file.data]));
  });
  return sources;
}

test('accepts files that match the torrent exactly', async () => {
  const { torrent, files } = await fixture();
  const result = await verifyTorrent(torrent, sourcesOf(files));

  assert.equal(result.ok, torrent.pieceCount);
  assert.equal(result.bad, 0);
  assert.equal(result.missing, 0);
  assert.equal(result.verifiedBytes, torrent.totalLength);
  assert.ok(result.pieces.every((status) => status === PIECE_OK));

  for (const file of torrent.files) {
    assert.equal(result.files.get(file.index).status, 'complete', `${file.path} should be complete`);
  }
});

test('catches a single flipped byte', async () => {
  const { torrent, files } = await fixture();
  const corrupted = Uint8Array.from(files[1].data);
  corrupted[10] ^= 0xff;

  const result = await verifyTorrent(torrent, sourcesOf(files, { 1: corrupted }));

  assert.equal(result.bad, 1);
  assert.equal(result.ok, torrent.pieceCount - 1);

  // Byte 160 overall (file 1 starts at 150) sits in piece 2 at 64 bytes a piece.
  assert.equal(result.pieces[2], PIECE_BAD);
  assert.equal(result.files.get(1).status, 'partial');
});

test('blames a shared boundary piece on the boundary, not the file', async () => {
  const { torrent, files } = await fixture();
  // File 0 ends at byte 150, inside piece 2, which file 1 also occupies. A
  // corruption there fails a piece both files touch, so neither is convicted
  // outright.
  const corrupted = Uint8Array.from(files[0].data);
  corrupted[149] ^= 0xff;

  const result = await verifyTorrent(torrent, sourcesOf(files, { 0: corrupted }));

  assert.equal(result.pieces[2], PIECE_BAD);
  assert.equal(result.files.get(0).sharedFailureOnly, true);
  assert.equal(result.files.get(1).sharedFailureOnly, true);
});

test('convicts a file when the failure is its alone', async () => {
  const { torrent, files } = await fixture();
  const corrupted = Uint8Array.from(files[0].data);
  corrupted[0] ^= 0xff; // piece 0 belongs only to file 0

  const result = await verifyTorrent(torrent, sourcesOf(files, { 0: corrupted }));

  assert.equal(result.pieces[0], PIECE_BAD);
  assert.equal(result.files.get(0).sharedFailureOnly, false);
  assert.equal(result.files.get(0).status, 'partial');
});

test('marks pieces unavailable when a file is not attached', async () => {
  const { torrent, files } = await fixture();
  const result = await verifyTorrent(torrent, sourcesOf(files, { 2: null }));

  assert.equal(result.files.get(2).status, 'missing');
  assert.ok(result.missing > 0);
  assert.equal(result.bad, 0);
  // File 2 starts at byte 240, i.e. piece 3 onwards.
  assert.equal(result.pieces[3], PIECE_MISSING);
  assert.equal(result.pieces[0], PIECE_OK);
  assert.equal(result.files.get(0).status, 'complete');
});

test('reports a file as corrupt when every one of its pieces fails', async () => {
  const { torrent, files } = await fixture(512); // one piece covers everything
  assert.equal(torrent.pieceCount, 1);

  const corrupted = Uint8Array.from(files[0].data);
  corrupted[0] ^= 0xff;
  const result = await verifyTorrent(torrent, sourcesOf(files, { 0: corrupted }));

  assert.equal(result.bad, 1);
  assert.equal(result.files.get(0).status, 'corrupt');
});

test('reports progress and honours cancellation', async () => {
  const { torrent, files } = await fixture();
  const seen = [];
  await verifyTorrent(torrent, sourcesOf(files), {
    onProgress: (progress) => seen.push(progress),
  });
  assert.ok(seen.length >= 1);
  assert.equal(seen.at(-1).piece, torrent.pieceCount);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => verifyTorrent(torrent, sourcesOf(files), { signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
});

test('refuses to claim a verdict on a torrent with no piece hashes', async () => {
  const { torrent } = await fixture();
  const v2Only = { ...torrent, hasPieceHashes: false };
  await assert.rejects(() => verifyTorrent(v2Only, new Map()), /cannot be verified/);
});
