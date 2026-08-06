import test from 'node:test';
import assert from 'node:assert/strict';

import { matchFiles, summariseMatches, commonRoot } from '../public/lib/matcher.js';

const torrentFiles = [
  { index: 0, path: 'album/01 - one.mp3', name: '01 - one.mp3', length: 100 },
  { index: 1, path: 'album/02 - two.mp3', name: '02 - two.mp3', length: 200 },
  { index: 2, path: 'album/cover.jpg', name: 'cover.jpg', length: 50 },
];

const local = (path, size) => ({ path, name: path.slice(path.lastIndexOf('/') + 1), size });

test('finds the common root directory', () => {
  assert.equal(commonRoot(['a/b', 'a/c/d']), 'a');
  assert.equal(commonRoot(['a/b', 'z/c']), '');
  assert.equal(commonRoot(['bare.mp3']), '');
  assert.equal(commonRoot([]), '');
});

test('matches on relative path plus size', () => {
  const result = matchFiles(torrentFiles, [
    local('album/01 - one.mp3', 100),
    local('album/02 - two.mp3', 200),
    local('album/cover.jpg', 50),
  ]);

  assert.equal(result.matches.size, 3);
  assert.equal(result.matches.get(0).localIndex, 0);
  assert.equal(result.matches.get(0).how, 'path+size');
  assert.equal(result.matches.get(0).sizeMismatch, false);
  assert.deepEqual(result.unmatchedTorrent, []);
  assert.deepEqual(result.unusedLocal, []);
});

test('matches when the picked folder adds its own root directory', () => {
  // A directory picker reports paths relative to the chosen folder, which may
  // be named anything.
  const result = matchFiles(torrentFiles, [
    local('Downloads Copy/album/01 - one.mp3', 100),
    local('Downloads Copy/album/02 - two.mp3', 200),
  ]);
  assert.equal(result.matches.size, 2);
  assert.equal(result.matches.get(1).how, 'path+size');
});

test('falls back to basename plus size when the folder layout differs', () => {
  const result = matchFiles(torrentFiles, [local('elsewhere/02 - two.mp3', 200)]);
  assert.equal(result.matches.size, 1);
  assert.equal(result.matches.get(1).localIndex, 0);
  assert.equal(result.matches.get(1).how, 'name+size');
});

test('still matches on name alone, but flags the size disagreement', () => {
  const result = matchFiles(torrentFiles, [local('album/01 - one.mp3', 999)]);
  const match = result.matches.get(0);
  assert.equal(match.how, 'path');
  assert.equal(match.sizeMismatch, true);
});

test('is case-insensitive about paths', () => {
  const result = matchFiles(torrentFiles, [local('ALBUM/01 - ONE.MP3', 100)]);
  assert.equal(result.matches.size, 1);
  assert.equal(result.matches.get(0).localIndex, 0);
});

test('reports files it could not place', () => {
  const result = matchFiles(torrentFiles, [local('album/01 - one.mp3', 100), local('album/extra.txt', 5)]);
  assert.deepEqual(result.unmatchedTorrent, [1, 2]);
  assert.deepEqual(result.unusedLocal, [1]);
});

test('never assigns one local file to two torrent entries', () => {
  const duplicated = [
    { index: 0, path: 'a/track.mp3', name: 'track.mp3', length: 100 },
    { index: 1, path: 'b/track.mp3', name: 'track.mp3', length: 100 },
  ];
  const result = matchFiles(duplicated, [local('a/track.mp3', 100)]);
  assert.equal(result.matches.size, 1);
  assert.equal(result.matches.get(0).localIndex, 0);
  assert.deepEqual(result.unmatchedTorrent, [1]);
});

test('reports ambiguity instead of guessing', () => {
  const single = [{ index: 0, path: 'x/track.mp3', name: 'track.mp3', length: 100 }];
  const result = matchFiles(single, [local('one/track.mp3', 100), local('two/track.mp3', 100)]);
  assert.equal(result.matches.size, 0);
  assert.equal(result.ambiguous.length, 1);
  assert.deepEqual(result.ambiguous[0].candidates, [0, 1]);
});

test('skips padding files entirely', () => {
  const withPad = [
    { index: 0, path: 'a.mp3', name: 'a.mp3', length: 100 },
    { index: 1, path: '.pad/28', name: '28', length: 28, isPad: true },
  ];
  const result = matchFiles(withPad, [local('a.mp3', 100)]);
  assert.equal(result.matches.size, 1);
  assert.deepEqual(result.unmatchedTorrent, []);

  const summary = summariseMatches(withPad, result);
  assert.deepEqual(summary, { total: 1, matched: 1, missing: 0, matchedBytes: 100, totalBytes: 100 });
});
