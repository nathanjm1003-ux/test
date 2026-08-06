// Hashing helpers. Uses WebCrypto, which is available both in browsers on a
// secure context (localhost counts) and in Node 18+ as a global.

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** @param {Uint8Array} bytes */
export function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]];
  return out;
}

/** @param {string} hex */
export function fromHex(hex) {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) throw new Error(`not a hex string: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** SHA-1 digest. @returns {Promise<Uint8Array>} */
export async function sha1(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
}

/** SHA-256 digest. @returns {Promise<Uint8Array>} */
export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** Constant-shape byte comparison. */
export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Decode a base32 string (RFC 4648, no padding required).
 * Magnet links may carry the info hash as 32-char base32 instead of 40-char hex.
 */
export function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/, '').toUpperCase();
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    const digit = alphabet.indexOf(char);
    if (digit === -1) throw new Error(`not a base32 string: ${input}`);
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}
