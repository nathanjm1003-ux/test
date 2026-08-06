import test from 'node:test';
import assert from 'node:assert/strict';

import { decode, encode, toText, spanOf, BencodeError } from '../public/lib/bencode.js';

const bytes = (text) => new TextEncoder().encode(text);

test('decodes the four bencode types', () => {
  assert.equal(decode(bytes('i42e')), 42);
  assert.equal(decode(bytes('i-13e')), -13);
  assert.equal(decode(bytes('i0e')), 0);
  assert.equal(toText(decode(bytes('5:hello'))), 'hello');
  assert.deepEqual(decode(bytes('le')), []);
  assert.deepEqual(decode(bytes('li1ei2ee')), [1, 2]);

  const dict = decode(bytes('d3:cow3:moo4:spami7ee'));
  assert.ok(dict instanceof Map);
  assert.equal(toText(dict.get('cow')), 'moo');
  assert.equal(dict.get('spam'), 7);
});

test('decodes an empty byte string and nested structures', () => {
  assert.equal(decode(bytes('0:')).length, 0);
  const value = decode(bytes('d4:listli1eld1:ai2eeeee'));
  const list = value.get('list');
  assert.equal(list[0], 1);
  assert.equal(list[1][0].get('a'), 2);
});

test('preserves binary byte strings exactly', () => {
  const payload = new Uint8Array([0, 255, 10, 13, 58, 101]);
  const encoded = encode({ p: payload });
  const decoded = decode(encoded).get('p');
  assert.deepEqual([...decoded], [...payload]);
});

test('round-trips through encode and decode', () => {
  const original = {
    announce: 'http://tracker.example/announce',
    'creation date': 1700000000,
    info: { name: 'thing', 'piece length': 16384, list: [1, 'two', new Uint8Array([3])] },
  };
  const decoded = decode(encode(original));
  assert.equal(toText(decoded.get('announce')), original.announce);
  assert.equal(decoded.get('creation date'), 1700000000);
  assert.equal(toText(decoded.get('info').get('name')), 'thing');
  assert.equal(decoded.get('info').get('piece length'), 16384);
});

test('encodes dictionary keys in sorted order, as the spec requires', () => {
  const encoded = new TextDecoder().decode(encode({ zebra: 1, apple: 2, mango: 3 }));
  assert.equal(encoded, 'd5:applei2e5:mangoi3e5:zebrai1ee');
});

test('records the byte span of every dictionary value', () => {
  // The info hash depends on this: it must cover the original bytes of the
  // info dict, byte for byte.
  const source = bytes('d1:ai1e4:infod1:bi2eee');
  const decoded = decode(source);
  const span = spanOf(decoded, 'info');
  assert.deepEqual(span, [13, 21]);
  assert.equal(new TextDecoder().decode(source.subarray(span[0], span[1])), 'd1:bi2ee');
});

test('spans survive non-canonical input the encoder would normalise', () => {
  // Keys out of order: re-encoding would reorder them and change the hash, so
  // the span must point at the original bytes instead.
  const source = bytes('d4:infod1:z1:x1:a1:yee');
  const span = spanOf(decode(source), 'info');
  assert.equal(new TextDecoder().decode(source.subarray(span[0], span[1])), 'd1:z1:x1:a1:ye');
});

test('rejects malformed input', () => {
  const bad = [
    ['i03e', 'leading zero'],
    ['i-0e', 'negative zero'],
    ['ie', 'no digits'],
    ['i12', 'unterminated integer'],
    ['5:abc', 'short byte string'],
    ['li1e', 'unterminated list'],
    ['d1:a', 'unterminated dictionary'],
    ['di1ei2ee', 'non-string key'],
    ['', 'empty'],
    ['x', 'unknown type'],
  ];
  for (const [input, label] of bad) {
    assert.throws(() => decode(bytes(input)), BencodeError, `expected ${label} to be rejected`);
  }
});

test('rejects trailing bytes unless explicitly allowed', () => {
  assert.throws(() => decode(bytes('i1ejunk')), BencodeError);
  assert.equal(decode(bytes('i1ejunk'), { allowTrailing: true }), 1);
});

test('rejects integers beyond the safe range rather than losing precision', () => {
  assert.throws(() => decode(bytes('i99999999999999999999e')), BencodeError);
});
