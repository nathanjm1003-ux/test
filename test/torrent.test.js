import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTorrent, parseMagnet, pieceHash, pieceLengthAt } from '../public/lib/torrent.js';
import { encode } from '../public/lib/bencode.js';
import { sha1, toHex } from '../public/lib/hash.js';
import { makeTorrentBytes, pseudoBytes } from './helpers.js';

test('parses a single-file torrent', async () => {
  const data = pseudoBytes(200, 7);
  const { bytes } = await makeTorrentBytes({
    single: true,
    pieceLength: 64,
    files: [{ path: ['song.mp3'], data }],
  });

  const torrent = await parseTorrent(bytes);
  assert.equal(torrent.name, 'song.mp3');
  assert.equal(torrent.isSingleFile, true);
  assert.equal(torrent.totalLength, 200);
  assert.equal(torrent.pieceLength, 64);
  assert.equal(torrent.pieceCount, 4); // 64 + 64 + 64 + 8
  assert.equal(torrent.files.length, 1);
  assert.equal(torrent.files[0].path, 'song.mp3');
  assert.equal(torrent.files[0].isAudio, true);
  assert.equal(torrent.audioFiles.length, 1);
  assert.equal(torrent.trackers[0], 'http://tracker.example/announce');
});

test('computes the info hash over the original info dictionary bytes', async () => {
  const { bytes, info } = await makeTorrentBytes({
    files: [{ path: ['a.flac'], data: pseudoBytes(100, 3) }],
  });
  const torrent = await parseTorrent(bytes);

  const expected = toHex(await sha1(encode(info)));
  assert.equal(torrent.infoHash, expected);
  assert.match(torrent.infoHash, /^[0-9a-f]{40}$/);
});

test('lays multi-file torrents out contiguously and maps them to pieces', async () => {
  const files = [
    { path: ['album', '01 - one.mp3'], data: pseudoBytes(150, 1) },
    { path: ['album', '02 - two.mp3'], data: pseudoBytes(90, 2) },
    { path: ['album', 'cover.jpg'], data: pseudoBytes(40, 3) },
  ];
  const { bytes } = await makeTorrentBytes({ name: 'album', pieceLength: 64, files });
  const torrent = await parseTorrent(bytes);

  assert.equal(torrent.isSingleFile, false);
  assert.equal(torrent.totalLength, 280);
  assert.equal(torrent.pieceCount, Math.ceil(280 / 64));

  assert.deepEqual(
    torrent.files.map((file) => [file.path, file.offset, file.endOffset]),
    [
      ['album/01 - one.mp3', 0, 150],
      ['album/02 - two.mp3', 150, 240],
      ['album/cover.jpg', 240, 280],
    ],
  );

  // File 0 spans bytes 0..149, i.e. pieces 0 through 2 at 64 bytes per piece.
  assert.equal(torrent.files[0].firstPiece, 0);
  assert.equal(torrent.files[0].lastPiece, 2);
  assert.equal(torrent.files[1].firstPiece, 2);
  assert.equal(torrent.files[1].lastPiece, 3);

  assert.deepEqual(
    torrent.audioFiles.map((file) => file.name),
    ['01 - one.mp3', '02 - two.mp3'],
  );
});

test('exposes per-piece hashes and the short final piece length', async () => {
  const { bytes, content } = await makeTorrentBytes({
    pieceLength: 64,
    files: [{ path: ['x.wav'], data: pseudoBytes(140, 5) }],
  });
  const torrent = await parseTorrent(bytes);

  assert.equal(pieceLengthAt(torrent, 0), 64);
  assert.equal(pieceLengthAt(torrent, 2), 12); // 140 - 128
  assert.deepEqual([...pieceHash(torrent, 0)], [...(await sha1(content.subarray(0, 64)))]);
  assert.deepEqual([...pieceHash(torrent, 2)], [...(await sha1(content.subarray(128, 140)))]);
  assert.throws(() => pieceHash(torrent, 99), RangeError);
});

test('marks BEP 47 padding files so they are not treated as content', async () => {
  const { bytes } = await makeTorrentBytes({
    pieceLength: 64,
    files: [
      { path: ['track.mp3'], data: pseudoBytes(50, 1) },
      { path: ['.pad', '14'], data: pseudoBytes(14, 2) },
      { path: ['next.mp3'], data: pseudoBytes(64, 3) },
    ],
  });
  const torrent = await parseTorrent(bytes);
  assert.deepEqual(
    torrent.files.map((file) => file.isPad),
    [false, true, false],
  );
  assert.equal(torrent.audioFiles.length, 2);
});

test('reads announce-list, comment, privacy and creation metadata', async () => {
  const { bytes } = await makeTorrentBytes({
    files: [{ path: ['a.mp3'], data: pseudoBytes(64, 1) }],
    info: { private: 1, source: 'ExampleTracker' },
    root: {
      'announce-list': [['http://one.example/a'], ['http://two.example/a', 'http://tracker.example/announce']],
      comment: 'a comment',
      'creation date': 1700000000,
    },
  });
  const torrent = await parseTorrent(bytes);

  // Deduplicated, announce first, tiers flattened.
  assert.deepEqual(torrent.trackers, [
    'http://tracker.example/announce',
    'http://one.example/a',
    'http://two.example/a',
  ]);
  assert.equal(torrent.comment, 'a comment');
  assert.equal(torrent.creationDate, 1700000000);
  assert.equal(torrent.isPrivate, true);
  assert.equal(torrent.source, 'ExampleTracker');
  assert.equal(torrent.createdBy, 'unit tests');
});

test('parses a v2 file tree', async () => {
  const info = {
    name: 'v2 album',
    'meta version': 2,
    'piece length': 16384,
    'file tree': {
      album: {
        'one.flac': { '': { length: 1234, 'pieces root': new Uint8Array(32).fill(9) } },
        'two.flac': { '': { length: 5678 } },
      },
    },
  };
  const torrent = await parseTorrent(encode({ info }));

  assert.equal(torrent.metaVersion, 2);
  assert.equal(torrent.isHybrid, false);
  assert.equal(torrent.hasPieceHashes, false);
  assert.match(torrent.infoHashV2, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    torrent.files.map((file) => [file.path, file.length]),
    [
      ['album/one.flac', 1234],
      ['album/two.flac', 5678],
    ],
  );
  assert.equal(torrent.totalLength, 6912);
  assert.equal(torrent.audioFiles.length, 2);
});

test('builds a magnet link that round-trips', async () => {
  const { bytes } = await makeTorrentBytes({
    name: 'my album',
    files: [{ path: ['a.mp3'], data: pseudoBytes(64, 1) }],
  });
  const torrent = await parseTorrent(bytes);
  const magnet = parseMagnet(torrent.magnetURI);

  assert.equal(magnet.infoHash, torrent.infoHash);
  assert.equal(magnet.name, 'my album');
  assert.equal(magnet.totalLength, torrent.totalLength);
  assert.deepEqual(magnet.trackers, torrent.trackers);
});

test('parses hex and base32 magnet info hashes', () => {
  const hex = 'c9e15763f722f23e98a29decdfae341b98d53056';
  assert.equal(parseMagnet(`magnet:?xt=urn:btih:${hex}`).infoHash, hex);

  // Same hash, base32 encoded — still used by older clients.
  const base32 = 'ZHQVOY7XELZD5GFCTXWN7LRUDOMNKMCW';
  assert.equal(parseMagnet(`magnet:?xt=urn:btih:${base32}`).infoHash, hex);
});

test('parses a v2 multihash magnet and collects trackers', () => {
  const v2 = 'a'.repeat(64);
  const magnet = parseMagnet(
    `magnet:?xt=urn:btmh:1220${v2}&dn=Thing&tr=${encodeURIComponent('udp://t.example:80')}`,
  );
  assert.equal(magnet.infoHashV2, v2);
  assert.equal(magnet.name, 'Thing');
  assert.deepEqual(magnet.trackers, ['udp://t.example:80']);
});

test('rejects input that is not a torrent', async () => {
  await assert.rejects(() => parseTorrent(new TextEncoder().encode('not a torrent')));
  await assert.rejects(() => parseTorrent(encode({ announce: 'x' })), /no "info" dictionary/);
  assert.throws(() => parseMagnet('http://example.com'), /not a magnet URI/);
  assert.throws(() => parseMagnet('magnet:?dn=nothing'), /no usable "xt"/);
});

test('rejects a torrent whose piece count contradicts its file sizes', async () => {
  const { bytes } = await makeTorrentBytes({
    pieceLength: 64,
    files: [{ path: ['a.mp3'], data: pseudoBytes(200, 1) }],
    info: { length: 999999 },
    single: true,
  });
  await assert.rejects(() => parseTorrent(bytes), /piece/);
});
