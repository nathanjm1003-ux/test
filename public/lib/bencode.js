// Bencode decoder/encoder.
//
// The decoder records the raw byte span of every dictionary value (see
// `dictSpans`). That matters for torrents: the info hash is SHA-1 over the
// *original* bytes of the `info` dictionary. Re-encoding the parsed value and
// hashing that would produce a wrong hash for any torrent whose encoding isn't
// perfectly canonical, and plenty of real ones aren't.

const CH_i = 0x69;
const CH_l = 0x6c;
const CH_d = 0x64;
const CH_e = 0x65;
const CH_COLON = 0x3a;
const CH_MINUS = 0x2d;
const CH_0 = 0x30;
const CH_9 = 0x39;

/**
 * Maps a decoded dictionary (a Map) to `Map<key, [startOffset, endOffset]>`
 * describing where each value sat in the source bytes.
 * @type {WeakMap<Map<string, unknown>, Map<string, [number, number]>>}
 */
export const dictSpans = new WeakMap();

export class BencodeError extends Error {
  constructor(message, offset) {
    super(offset === undefined ? message : `${message} (at byte ${offset})`);
    this.name = 'BencodeError';
    this.offset = offset;
  }
}

const utf8 = new TextDecoder('utf-8');

/** Decode ASCII bytes to a string. Used for dictionary keys, which are ASCII. */
function asciiString(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

class Decoder {
  constructor(bytes) {
    this.b = bytes;
    this.i = 0;
  }

  peek() {
    if (this.i >= this.b.length) throw new BencodeError('unexpected end of input', this.i);
    return this.b[this.i];
  }

  readValue() {
    const c = this.peek();
    if (c === CH_i) return this.readInteger();
    if (c === CH_l) return this.readList();
    if (c === CH_d) return this.readDictionary();
    if (c >= CH_0 && c <= CH_9) return this.readByteString();
    throw new BencodeError(`unexpected byte 0x${c.toString(16).padStart(2, '0')}`, this.i);
  }

  readInteger() {
    const start = this.i;
    this.i++; // 'i'
    let negative = false;
    if (this.peek() === CH_MINUS) {
      negative = true;
      this.i++;
    }
    const digitsStart = this.i;
    while (this.i < this.b.length && this.b[this.i] >= CH_0 && this.b[this.i] <= CH_9) this.i++;
    if (this.i === digitsStart) throw new BencodeError('integer has no digits', start);
    if (this.i >= this.b.length || this.b[this.i] !== CH_e) {
      throw new BencodeError('unterminated integer', start);
    }
    const digits = asciiString(this.b.subarray(digitsStart, this.i));
    this.i++; // 'e'

    // Bencode forbids leading zeros, "-0", and negative zero.
    if (digits.length > 1 && digits[0] === '0') throw new BencodeError('integer has a leading zero', start);
    if (negative && digits === '0') throw new BencodeError('negative zero integer', start);

    const value = Number(digits);
    if (!Number.isSafeInteger(value)) {
      throw new BencodeError(`integer ${negative ? '-' : ''}${digits} exceeds safe range`, start);
    }
    return negative ? -value : value;
  }

  readByteString() {
    const start = this.i;
    let length = 0;
    let digits = 0;
    while (this.i < this.b.length && this.b[this.i] >= CH_0 && this.b[this.i] <= CH_9) {
      length = length * 10 + (this.b[this.i] - CH_0);
      digits++;
      this.i++;
      if (length > Number.MAX_SAFE_INTEGER) throw new BencodeError('byte string length overflow', start);
    }
    if (digits === 0) throw new BencodeError('byte string has no length', start);
    if (this.i >= this.b.length || this.b[this.i] !== CH_COLON) {
      throw new BencodeError('byte string length not followed by ":"', start);
    }
    this.i++; // ':'
    const end = this.i + length;
    if (end > this.b.length) throw new BencodeError('byte string runs past end of input', start);
    const value = this.b.subarray(this.i, end);
    this.i = end;
    return value;
  }

  readList() {
    const start = this.i;
    this.i++; // 'l'
    const items = [];
    for (;;) {
      if (this.i >= this.b.length) throw new BencodeError('unterminated list', start);
      if (this.b[this.i] === CH_e) break;
      items.push(this.readValue());
    }
    this.i++; // 'e'
    return items;
  }

  readDictionary() {
    const start = this.i;
    this.i++; // 'd'
    const map = new Map();
    const spans = new Map();
    for (;;) {
      if (this.i >= this.b.length) throw new BencodeError('unterminated dictionary', start);
      if (this.b[this.i] === CH_e) break;
      const keyByte = this.b[this.i];
      if (keyByte < CH_0 || keyByte > CH_9) {
        throw new BencodeError('dictionary key is not a byte string', this.i);
      }
      const key = asciiString(this.readByteString());
      const valueStart = this.i;
      const value = this.readValue();
      map.set(key, value);
      spans.set(key, [valueStart, this.i]);
    }
    this.i++; // 'e'
    dictSpans.set(map, spans);
    return map;
  }
}

/**
 * Decode a bencoded buffer.
 * @param {Uint8Array|ArrayBuffer} input
 * @param {{allowTrailing?: boolean}} [options]
 */
export function decode(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) throw new BencodeError('empty input', 0);
  const decoder = new Decoder(bytes);
  const value = decoder.readValue();
  if (!options.allowTrailing && decoder.i !== bytes.length) {
    throw new BencodeError(`${bytes.length - decoder.i} trailing byte(s) after top-level value`, decoder.i);
  }
  return value;
}

/** Decode a bencoded byte string as UTF-8 text (non-fatal: bad bytes become U+FFFD). */
export function toText(bytes) {
  if (bytes === undefined || bytes === null) return '';
  if (typeof bytes === 'string') return bytes;
  return utf8.decode(bytes);
}

const utf8Encoder = new TextEncoder();

function concatChunks(chunks, totalLength) {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Compare two byte arrays lexicographically (bencode requires sorted dict keys). */
function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Encode a value to bencode. Accepts Uint8Array, string, integer Number,
 * boolean, Array, Map, and plain objects. Dictionary keys are emitted sorted.
 * @returns {Uint8Array}
 */
export function encode(value) {
  const chunks = [];
  let total = 0;
  const push = (chunk) => {
    chunks.push(chunk);
    total += chunk.length;
  };
  const pushAscii = (str) => push(utf8Encoder.encode(str));

  const write = (v) => {
    if (v instanceof Uint8Array) {
      pushAscii(`${v.length}:`);
      push(v);
      return;
    }
    if (typeof v === 'string') {
      const bytes = utf8Encoder.encode(v);
      pushAscii(`${bytes.length}:`);
      push(bytes);
      return;
    }
    if (typeof v === 'boolean') {
      pushAscii(`i${v ? 1 : 0}e`);
      return;
    }
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new BencodeError(`cannot encode non-integer number ${v}`);
      pushAscii(`i${v}e`);
      return;
    }
    if (Array.isArray(v)) {
      pushAscii('l');
      for (const item of v) write(item);
      pushAscii('e');
      return;
    }
    if (v instanceof Map || (typeof v === 'object' && v !== null)) {
      const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
      const encoded = entries
        .filter(([, val]) => val !== undefined && val !== null)
        .map(([key, val]) => [utf8Encoder.encode(String(key)), val]);
      encoded.sort((a, b) => compareBytes(a[0], b[0]));
      pushAscii('d');
      for (const [keyBytes, val] of encoded) {
        pushAscii(`${keyBytes.length}:`);
        push(keyBytes);
        write(val);
      }
      pushAscii('e');
      return;
    }
    throw new BencodeError(`cannot encode value of type ${typeof v}`);
  };

  write(value);
  return concatChunks(chunks, total);
}

/**
 * Byte span of a value inside its parent dictionary, as `[start, end)`.
 * @returns {[number, number] | undefined}
 */
export function spanOf(dict, key) {
  return dictSpans.get(dict)?.get(key);
}
