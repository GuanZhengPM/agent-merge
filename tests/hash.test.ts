import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CanonicalJsonError, CorruptObjectError } from '../src/errors.ts';
import { canonicalJson, decodeObject, encodeObject, sha256Hex } from '../src/hash.ts';

test('canonicalJson sorts object keys and ignores insertion order', () => {
  const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":{"y":2,"z":1}}');
});

test('canonicalJson normalizes -0 and keeps ordinary numbers', () => {
  assert.equal(canonicalJson(-0), '0');
  assert.equal(canonicalJson([1.5, -2, 1e21]), '[1.5,-2,1e+21]');
});

test('canonicalJson rejects values JSON cannot represent faithfully', () => {
  assert.throws(() => canonicalJson({ x: undefined }), CanonicalJsonError);
  assert.throws(() => canonicalJson(Number.NaN), CanonicalJsonError);
  assert.throws(() => canonicalJson(Infinity), CanonicalJsonError);
  assert.throws(() => canonicalJson(() => 1), CanonicalJsonError);
  assert.throws(() => canonicalJson(10n), CanonicalJsonError);
  assert.throws(() => canonicalJson(new Date(0)), CanonicalJsonError);
  assert.throws(() => canonicalJson(new Map()), CanonicalJsonError);
});

test('canonicalJson rejects lone surrogates instead of silently mutating them', () => {
  assert.throws(() => canonicalJson('\ud800'), CanonicalJsonError);
  assert.throws(() => canonicalJson({ text: 'ok \udfff broken' }), CanonicalJsonError);
  // well-formed pairs (real emoji) are fine
  assert.equal(canonicalJson('🐳中文'), JSON.stringify('🐳中文'));
});

test('canonicalJson rejects circular references but allows repeated siblings', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert.throws(() => canonicalJson(cyclic), CanonicalJsonError);

  const shared = { x: 1 };
  assert.equal(canonicalJson([shared, shared]), '[{"x":1},{"x":1}]');
});

test('encodeObject/decodeObject round-trip and identical content shares an id', () => {
  const bytes = encodeObject('event', { kind: 'message', at: 1, actor: 'user', payload: null });
  const again = encodeObject('event', { payload: null, actor: 'user', at: 1, kind: 'message' });
  assert.equal(sha256Hex(bytes), sha256Hex(again));

  const decoded = decodeObject(bytes);
  assert.equal(decoded.type, 'event');
  assert.deepEqual(decoded.body, { kind: 'message', at: 1, actor: 'user', payload: null });
});

test('decodeObject rejects corrupt encodings', () => {
  const enc = new TextEncoder();
  assert.throws(() => decodeObject(enc.encode('no header here')), CorruptObjectError);
  assert.throws(() => decodeObject(enc.encode('agent-merge bogus\n{}')), CorruptObjectError);
  assert.throws(() => decodeObject(enc.encode('agent-merge event\nnot-json')), CorruptObjectError);
  assert.throws(() => decodeObject(new Uint8Array([0xff, 0xfe, 0x0a])), CorruptObjectError);
});
