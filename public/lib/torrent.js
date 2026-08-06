// .torrent metadata parsing.
//
// Handles BitTorrent v1 (BEP 3), v2 (BEP 52) and hybrid torrents, plus magnet
// URIs (BEP 9 / BEP 53). A .torrent describes content — names, sizes, tracker
// URLs and piece hashes — it does not contain the media. The piece hashes are
// what let us verify local files actually are the torrent's content.

import { decode, toText, spanOf } from './bencode.js';
import { sha1, sha256, toHex, fromHex, base32Decode } from './hash.js';
import { extensionOf, isAudioFile, isProbablyDecodable } from './media.js';

/** Pad files (BEP 47) exist only to align real files to piece boundaries. */
function looksLikePadFile(pathParts, attr) {
  if (attr.includes('p')) return true;
  const first = pathParts[0] ?? '';
  const last = pathParts[pathParts.length - 1] ?? '';
  return first === '.pad' || first === '_____padding_file' || last.startsWith('_____padding_file');
}

/** Read a bencoded string field, preferring the `.utf-8` variant when present. */
function textField(dict, key) {
  const utf8Variant = dict.get(`${key}.utf-8`);
  if (utf8Variant) return toText(utf8Variant);
  const value = dict.get(key);
  return value === undefined ? '' : toText(value);
}

function numberField(dict, key) {
  const value = dict.get(key);
  return typeof value === 'number' ? value : undefined;
}

/** Collect a v1 `info.files` list (or the single-file form) into flat entries. */
function readV1FileList(info, name) {
  const files = info.get('files');
  if (!Array.isArray(files)) {
    const length = numberField(info, 'length');
    if (length === undefined) throw new Error('torrent info has neither "files" nor "length"');
    return [{ pathParts: [name], length, isPad: false }];
  }

  return files.map((entry, index) => {
    if (!(entry instanceof Map)) throw new Error(`info.files[${index}] is not a dictionary`);
    const rawPath = entry.get('path.utf-8') ?? entry.get('path');
    if (!Array.isArray(rawPath)) throw new Error(`info.files[${index}] has no path`);
    const pathParts = rawPath.map(toText);
    const length = numberField(entry, 'length');
    if (length === undefined) throw new Error(`info.files[${index}] has no length`);
    const attr = toText(entry.get('attr') ?? new Uint8Array());
    return { pathParts, length, isPad: looksLikePadFile(pathParts, attr) };
  });
}

/**
 * Walk a v2 `info["file tree"]`. Leaves are dictionaries keyed by "" holding
 * `length` and `pieces root`.
 */
function readV2FileTree(node, prefix, out) {
  for (const [key, value] of node.entries()) {
    if (!(value instanceof Map)) continue;
    if (key === '') {
      const length = numberField(value, 'length');
      if (length === undefined) continue;
      const piecesRoot = value.get('pieces root');
      out.push({
        pathParts: [...prefix],
        length,
        isPad: false,
        piecesRoot: piecesRoot instanceof Uint8Array ? toHex(piecesRoot) : undefined,
      });
    } else {
      readV2FileTree(value, [...prefix, key], out);
    }
  }
  return out;
}

/** Flatten `announce` + `announce-list` into a deduplicated tracker list. */
function readTrackers(root) {
  const trackers = [];
  const seen = new Set();
  const add = (value) => {
    const url = toText(value).trim();
    if (url && !seen.has(url)) {
      seen.add(url);
      trackers.push(url);
    }
  };

  add(root.get('announce'));
  const announceList = root.get('announce-list');
  if (Array.isArray(announceList)) {
    for (const tier of announceList) {
      if (Array.isArray(tier)) tier.forEach(add);
      else add(tier);
    }
  }
  return trackers;
}

function readWebSeeds(root) {
  const urlList = root.get('url-list');
  if (!urlList) return [];
  const values = Array.isArray(urlList) ? urlList : [urlList];
  return values.map(toText).filter(Boolean);
}

/**
 * Parse a .torrent file.
 * @param {Uint8Array|ArrayBuffer} input raw file bytes
 * @returns {Promise<Torrent>}
 */
export async function parseTorrent(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const root = decode(bytes);
  if (!(root instanceof Map)) throw new Error('torrent file is not a bencoded dictionary');

  const info = root.get('info');
  if (!(info instanceof Map)) throw new Error('torrent file has no "info" dictionary');

  // Hash the original bytes of the info dict, not a re-encoding of it.
  const span = spanOf(root, 'info');
  if (!span) throw new Error('could not locate the "info" dictionary in the source bytes');
  const infoBytes = bytes.subarray(span[0], span[1]);

  const metaVersion = numberField(info, 'meta version');
  const pieceLength = numberField(info, 'piece length');
  const pieces = info.get('pieces');
  const hasV1Pieces = pieces instanceof Uint8Array && pieces.length > 0 && pieceLength !== undefined;

  const name = textField(info, 'name') || 'unnamed torrent';

  let infoHash = '';
  let infoHashV2 = '';
  if (hasV1Pieces || metaVersion === undefined) infoHash = toHex(await sha1(infoBytes));
  if (metaVersion === 2) infoHashV2 = toHex(await sha256(infoBytes));

  // Prefer the v1 layout for file ordering: piece mapping depends on it, and
  // hybrid torrents describe the same files both ways.
  const fileTree = info.get('file tree');
  const rawFiles = hasV1Pieces || !(fileTree instanceof Map)
    ? readV1FileList(info, name)
    : readV2FileTree(fileTree, [], []);

  const isSingleFile = !Array.isArray(info.get('files')) && !(fileTree instanceof Map);

  let offset = 0;
  const files = rawFiles.map((entry, index) => {
    const pathParts = isSingleFile ? entry.pathParts : [...entry.pathParts];
    const pathString = pathParts.join('/');
    const filename = pathParts[pathParts.length - 1] ?? '';
    const start = offset;
    offset += entry.length;
    return {
      index,
      pathParts,
      path: pathString,
      name: filename,
      extension: extensionOf(filename),
      length: entry.length,
      offset: start,
      endOffset: offset,
      isPad: entry.isPad,
      isAudio: !entry.isPad && isAudioFile(filename),
      isBrowserDecodable: isProbablyDecodable(filename),
      piecesRoot: entry.piecesRoot,
      // Inclusive piece index range covering this file (v1 layout only).
      firstPiece: hasV1Pieces && entry.length > 0 ? Math.floor(start / pieceLength) : undefined,
      lastPiece: hasV1Pieces && entry.length > 0 ? Math.floor((offset - 1) / pieceLength) : undefined,
    };
  });

  const totalLength = offset;
  const pieceCount = hasV1Pieces ? pieces.length / 20 : 0;
  if (hasV1Pieces && !Number.isInteger(pieceCount)) {
    throw new Error(`info.pieces length ${pieces.length} is not a multiple of 20`);
  }
  if (hasV1Pieces && pieceCount !== Math.ceil(totalLength / pieceLength)) {
    throw new Error(
      `info.pieces holds ${pieceCount} hashes but the file layout needs ${Math.ceil(totalLength / pieceLength)}`,
    );
  }

  const trackers = readTrackers(root);

  return {
    name,
    infoHash,
    infoHashV2,
    metaVersion: metaVersion ?? 1,
    isHybrid: metaVersion === 2 && hasV1Pieces,
    pieceLength: pieceLength ?? 0,
    pieces: hasV1Pieces ? pieces : new Uint8Array(0),
    pieceCount,
    hasPieceHashes: hasV1Pieces,
    files,
    audioFiles: files.filter((file) => file.isAudio),
    totalLength,
    isSingleFile,
    trackers,
    webSeeds: readWebSeeds(root),
    comment: textField(root, 'comment'),
    createdBy: textField(root, 'created by'),
    creationDate: numberField(root, 'creation date') ?? 0,
    isPrivate: numberField(info, 'private') === 1,
    source: textField(info, 'source'),
    magnetURI: buildMagnetURI({ infoHash, infoHashV2, name, trackers, totalLength }),
  };
}

/** The SHA-1 hash for piece `index`, as a 20-byte view into `torrent.pieces`. */
export function pieceHash(torrent, index) {
  if (index < 0 || index >= torrent.pieceCount) throw new RangeError(`no piece at index ${index}`);
  return torrent.pieces.subarray(index * 20, index * 20 + 20);
}

/** Byte length of piece `index` (the last piece is usually short). */
export function pieceLengthAt(torrent, index) {
  const start = index * torrent.pieceLength;
  return Math.min(torrent.pieceLength, torrent.totalLength - start);
}

export function buildMagnetURI({ infoHash, infoHashV2, name, trackers = [], totalLength }) {
  const params = [];
  if (infoHash) params.push(`xt=urn:btih:${infoHash}`);
  if (infoHashV2) params.push(`xt=urn:btmh:1220${infoHashV2}`);
  if (!params.length) return '';
  if (name) params.push(`dn=${encodeURIComponent(name)}`);
  if (Number.isFinite(totalLength) && totalLength > 0) params.push(`xl=${totalLength}`);
  for (const tracker of trackers) params.push(`tr=${encodeURIComponent(tracker)}`);
  return `magnet:?${params.join('&')}`;
}

/**
 * Parse a magnet URI. A magnet carries an info hash and hints, not the file
 * list — the file list only arrives from the swarm, so this returns metadata
 * without files.
 */
export function parseMagnet(uri) {
  const trimmed = String(uri).trim();
  if (!/^magnet:\?/i.test(trimmed)) throw new Error('not a magnet URI (must start with "magnet:?")');
  const params = new URLSearchParams(trimmed.slice(trimmed.indexOf('?') + 1));

  let infoHash = '';
  let infoHashV2 = '';
  for (const xt of params.getAll('xt')) {
    const btih = /^urn:btih:(.+)$/i.exec(xt);
    if (btih) {
      const value = btih[1];
      if (/^[0-9a-f]{40}$/i.test(value)) infoHash = value.toLowerCase();
      else if (/^[a-z2-7]{32}$/i.test(value)) infoHash = toHex(base32Decode(value));
      else throw new Error(`unrecognised btih info hash: ${value}`);
      continue;
    }
    // btmh is multihash-prefixed: 0x12 0x20 marks a 32-byte SHA-256.
    const btmh = /^urn:btmh:1220([0-9a-f]{64})$/i.exec(xt);
    if (btmh) infoHashV2 = btmh[1].toLowerCase();
  }
  if (!infoHash && !infoHashV2) throw new Error('magnet URI has no usable "xt" info hash');
  if (infoHash) fromHex(infoHash); // validate

  const exactLength = Number(params.get('xl'));

  return {
    name: params.get('dn') ?? '',
    infoHash,
    infoHashV2,
    trackers: params.getAll('tr'),
    webSeeds: params.getAll('ws'),
    totalLength: Number.isFinite(exactLength) && exactLength > 0 ? exactLength : 0,
    magnetURI: trimmed,
  };
}

/**
 * @typedef {Awaited<ReturnType<typeof parseTorrent>>} Torrent
 */
