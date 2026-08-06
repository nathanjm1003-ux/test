// Which files in a torrent count as audio, and which of those a browser can
// realistically decode.

/** Extensions we treat as audio when listing a torrent's contents. */
export const AUDIO_EXTENSIONS = new Set([
  'mp3', 'm4a', 'm4b', 'aac', 'flac', 'wav', 'wave', 'ogg', 'oga', 'opus',
  'wma', 'aiff', 'aif', 'aifc', 'ape', 'alac', 'mka', 'mp2', 'mpga', 'wv',
  'dsf', 'dff', 'mpc', 'spx', 'caf', 'amr', 'au', 'ra', 'tta', 'shn', 'ac3',
  'dts', 'm4r', '3ga',
]);

/**
 * Formats mainstream browsers decode natively. Anything outside this still gets
 * listed and verified — it just may not play, and the UI says so rather than
 * failing silently.
 */
export const BROWSER_DECODABLE_EXTENSIONS = new Set([
  'mp3', 'm4a', 'm4b', 'aac', 'flac', 'wav', 'wave', 'ogg', 'oga', 'opus', 'mp2', 'mpga', 'm4r', '3ga',
]);

/** Lowercase extension without the dot, or '' when there isn't one. */
export function extensionOf(filename) {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function isAudioFile(filename) {
  return AUDIO_EXTENSIONS.has(extensionOf(filename));
}

export function isProbablyDecodable(filename) {
  return BROWSER_DECODABLE_EXTENSIONS.has(extensionOf(filename));
}

/**
 * Natural sort for track listings, so "Track 2" precedes "Track 10".
 * @param {string} a @param {string} b
 */
export function compareNatural(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
