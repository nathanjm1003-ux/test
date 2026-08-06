// Match local files on disk against the entries described by a torrent.
//
// Pure functions over plain objects so they can be unit tested without a DOM.
// Local files are described as `{ path, name, size }`, where `path` is a
// relative path (a browser directory picker supplies `webkitRelativePath`).

/** Strip a leading directory segment from a path. */
function stripFirstSegment(path) {
  const slash = path.indexOf('/');
  return slash === -1 ? '' : path.slice(slash + 1);
}

/** The single top-level directory shared by every path, or '' when there isn't one. */
export function commonRoot(paths) {
  let root = null;
  for (const path of paths) {
    const slash = path.indexOf('/');
    if (slash === -1) return '';
    const segment = path.slice(0, slash);
    if (root === null) root = segment;
    else if (root !== segment) return '';
  }
  return root ?? '';
}

/** Lowercase a path for case-insensitive comparison (filesystems vary). */
function key(path) {
  return path.toLowerCase();
}

function pushTo(map, k, value) {
  const existing = map.get(k);
  if (existing) existing.push(value);
  else map.set(k, [value]);
}

/**
 * Match torrent entries to local files.
 *
 * Three passes, most specific first: relative path + size, then basename +
 * size, then basename alone. A file matched by name but not size is still
 * reported, flagged `sizeMismatch`, because verification will say for certain.
 *
 * @param {Array<{index:number, path:string, name:string, length:number, isPad?:boolean}>} torrentFiles
 * @param {Array<{path:string, name:string, size:number}>} localFiles
 * @returns {{
 *   matches: Map<number, {localIndex:number, how:string, sizeMismatch:boolean}>,
 *   unmatchedTorrent: number[],
 *   unusedLocal: number[],
 *   ambiguous: Array<{torrentIndex:number, candidates:number[]}>,
 * }}
 */
export function matchFiles(torrentFiles, localFiles) {
  const matches = new Map();
  const usedLocal = new Set();
  // Keyed by torrent index: successive passes can flag the same entry more than
  // once, and it is still only one ambiguity.
  const ambiguous = new Map();

  const candidates = torrentFiles.filter((file) => !file.isPad);

  // Local paths may or may not include the torrent's root directory; index both
  // forms so either layout matches.
  const localRoot = commonRoot(localFiles.map((file) => file.path));
  const byPath = new Map();
  const byName = new Map();
  localFiles.forEach((file, localIndex) => {
    pushTo(byPath, key(file.path), localIndex);
    if (localRoot) pushTo(byPath, key(stripFirstSegment(file.path)), localIndex);
    pushTo(byName, key(file.name), localIndex);
  });

  const claim = (torrentIndex, localIndex, how, sizeMismatch) => {
    matches.set(torrentIndex, { localIndex, how, sizeMismatch });
    usedLocal.add(localIndex);
  };

  /** Run one pass over the still-unmatched torrent entries. */
  const pass = (lookup, makeKeys, how, requireSize) => {
    for (const file of candidates) {
      if (matches.has(file.index)) continue;
      const found = [];
      for (const k of makeKeys(file)) {
        for (const localIndex of lookup.get(k) ?? []) {
          if (usedLocal.has(localIndex)) continue;
          if (requireSize && localFiles[localIndex].size !== file.length) continue;
          if (!found.includes(localIndex)) found.push(localIndex);
        }
      }
      if (found.length === 1) {
        claim(file.index, found[0], how, localFiles[found[0]].size !== file.length);
      } else if (found.length > 1) {
        ambiguous.set(file.index, { torrentIndex: file.index, candidates: found });
      }
    }
  };

  pass(byPath, (file) => [key(file.path)], 'path+size', true);
  pass(byName, (file) => [key(file.name)], 'name+size', true);
  pass(byPath, (file) => [key(file.path)], 'path', false);
  pass(byName, (file) => [key(file.name)], 'name', false);

  return {
    matches,
    unmatchedTorrent: candidates.filter((file) => !matches.has(file.index)).map((file) => file.index),
    unusedLocal: localFiles.map((_, i) => i).filter((i) => !usedLocal.has(i)),
    ambiguous: [...ambiguous.values()].filter((entry) => !matches.has(entry.torrentIndex)),
  };
}

/**
 * Summarise a match result for display.
 */
export function summariseMatches(torrentFiles, result) {
  const wanted = torrentFiles.filter((file) => !file.isPad);
  const matchedBytes = wanted
    .filter((file) => result.matches.has(file.index))
    .reduce((total, file) => total + file.length, 0);
  return {
    total: wanted.length,
    matched: result.matches.size,
    missing: result.unmatchedTorrent.length,
    matchedBytes,
    totalBytes: wanted.reduce((total, file) => total + file.length, 0),
  };
}
