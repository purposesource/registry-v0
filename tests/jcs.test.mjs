// RFC 8785 canonicalization and the two hash primitives.
//
// These are the most consequential tests in the repository. Every ledger row hash and
// every published chain head is a function of jcs(), and FS07-101 requires the chain to
// import UNBROKEN into `pg` at P-M3 — which means the .NET implementation that replaces
// this one has to reproduce these exact bytes. So the assertions here are deliberately
// literal, and the LEDGER ROW HASH IS PINNED TO A PRE-COMPUTED DIGEST. If a refactor
// changes that digest, the refactor is wrong, however reasonable it looks.

import assert from 'node:assert/strict';
import test from 'node:test';

import { jcs, ledgerRowHash, sha256Hex } from '../scripts/lib/jcs.mjs';

test('object keys are sorted by UTF-16 code unit, not by locale', () => {
  assert.equal(jcs({ b: 1, a: 2, C: 3 }), '{"C":3,"a":2,"b":1}');
  // Uppercase sorts before lowercase in code-unit order; a locale-aware comparator would
  // interleave them and produce a different hash.
  assert.equal(jcs({ a: 1, A: 2 }), '{"A":2,"a":1}');
  assert.equal(jcs({ 'ä': 1, z: 2 }), '{"z":2,"ä":1}');
});

test('nested structures, arrays keep their order, no whitespace anywhere', () => {
  assert.equal(
    jcs({ z: [3, 1, 2], a: { n: null, t: true, f: false } }),
    '{"a":{"f":false,"n":null,"t":true},"z":[3,1,2]}'
  );
  assert.equal(jcs([]), '[]');
  assert.equal(jcs({}), '{}');
});

test('integers serialise per §3.2.2.3, and -0 is indistinguishable from 0', () => {
  assert.equal(jcs({ n: 0 }), '{"n":0}');
  assert.equal(jcs({ n: -0 }), '{"n":0}');
  assert.equal(jcs({ n: -250000 }), '{"n":-250000}');
  assert.equal(jcs({ n: Number.MAX_SAFE_INTEGER }), '{"n":9007199254740991}');
});

test('string escaping matches §3.2.2.2: two-char escapes, \\u00xx for other controls', () => {
  assert.equal(jcs('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(jcs('\b\t\n\f\r'), '"\\b\\t\\n\\f\\r"');
  assert.equal(jcs(''), '"\\u0001\\u001f"');
  // Non-ASCII is emitted literally, not escaped.
  assert.equal(jcs('héllo'), '"héllo"');
  // Astral characters survive as a surrogate pair.
  assert.equal(jcs('\u{1f600}'), '"\u{1f600}"');
});

test('refuses everything it cannot reproduce identically in another runtime', () => {
  // Non-integer numbers: ECMAScript shortest-round-trip output is the hard part of
  // §3.2.2.3, and money here is integer minor units so the case never arises legitimately.
  assert.throws(() => jcs({ n: 0.1 }), /non-integer/);
  assert.throws(() => jcs({ n: Number.MAX_SAFE_INTEGER + 2 }), /out-of-safe-range/);
  assert.throws(() => jcs({ n: Infinity }), /non-finite/);
  assert.throws(() => jcs({ n: NaN }), /non-finite/);
  // undefined would be DROPPED by JSON.stringify, silently changing a hash input.
  assert.throws(() => jcs({ a: undefined }), /undefined/);
  // A Date would serialise through toJSON and bury a timezone decision inside a hash.
  assert.throws(() => jcs({ d: new Date(0) }), /refusing to canonicalize/);
  assert.throws(() => jcs({ m: new Map() }), /refusing to canonicalize/);
  assert.throws(() => jcs({ b: 1n }), /refusing to canonicalize/);
  // A lone surrogate has no defined UTF-8 encoding.
  assert.throws(() => jcs('\ud800'), /lone surrogate/);
  assert.throws(() => jcs('\udc00x'), /lone surrogate/);
  // And in a KEY, not only in a value. Keys reach the output through JSON.stringify
  // rather than through the value walker, so this needed its own check: without it, the
  // one escape the .NET port will not reproduce was refused on one axis and emitted on
  // the other. Not reachable from a real ledger row — every column name is fixed ASCII —
  // which is exactly why it needs a test.
  assert.throws(() => jcs({ '\ud800': 1 }), /lone surrogate/);
  assert.throws(() => jcs({ 'a\udc00': 1 }), /lone surrogate/);
  assert.throws(() => jcs({ nested: { '\ud83d': true } }), /lone surrogate/);
  // A well-formed surrogate PAIR in a key is not a lone surrogate and stays legal.
  assert.equal(jcs({ '\u{1f600}': 1 }), '{"\u{1f600}":1}');
});

test('sha256Hex is lowercase hex over UTF-8', () => {
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('ledgerRowHash: PINNED. hex prev_hash string || JCS(row), never raw bytes', () => {
  const genesis = '0'.repeat(64);
  const row = {
    led_id: 'led_01jd0000000000000000000001',
    seq: 1,
    month: '2026-11',
    row_type: 'month-note',
    amount_minor: 0,
    currency: 'CHF',
    hold_status: 'not-applicable',
    note: 'FIXTURE month opened. Test data only.',
    emitting_job: 'operator:record-purchases',
    created_at: '2026-11-01T00:00:00Z',
  };

  // This is the value in tests/fixtures/ledger/2026-11.json at seq 1. FS-07 §5.2 writes
  // `prev_hash || JCS(...)` where prev_hash is the char(64) column and genesis is spelled
  // as 64 zeros, so the CONCATENATION IS OF TEXT. Hashing the 32 raw bytes instead would
  // be a defensible-looking "optimisation" that silently forks the chain from every other
  // implementation, so the expected digest is pinned here rather than recomputed.
  const expected = 'b9060a9086e532a11eab7437690855a34d330e4d759e024fe4ea7cd4f9588aac';
  const actual = ledgerRowHash(genesis, row);
  assert.equal(actual, sha256Hex(genesis + jcs(row)), 'definition must stay text-concatenation');
  assert.notEqual(
    actual,
    sha256Hex(Buffer.concat([Buffer.from(genesis, 'hex'), Buffer.from(jcs(row), 'utf8')])),
    'the raw-bytes variant must give a DIFFERENT digest — that is why the definition is pinned'
  );
  assert.equal(actual, expected);
});

test('ledgerRowHash rejects a malformed prev_hash rather than hashing it anyway', () => {
  assert.throws(() => ledgerRowHash('nope', { a: 1 }), /64 lowercase hex/);
  assert.throws(() => ledgerRowHash('0'.repeat(63), { a: 1 }), /64 lowercase hex/);
  assert.throws(() => ledgerRowHash('A'.repeat(64), { a: 1 }), /64 lowercase hex/);
});

test('key order in the source object does not affect the hash', () => {
  const a = { x: 1, y: 2, z: 3 };
  const b = { z: 3, x: 1, y: 2 };
  assert.equal(ledgerRowHash('0'.repeat(64), a), ledgerRowHash('0'.repeat(64), b));
});
