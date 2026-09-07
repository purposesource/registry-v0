// RFC 8785 — JSON Canonicalization Scheme (JCS), plus the two hash helpers the ledger
// and the CT log are defined in terms of.
//
// WHY THIS EXISTS AT ALL. FS-07 §5.2 defines the ledger row hash as
//
//     row_hash = SHA-256( prev_hash || JCS(row minus prev_hash/row_hash) )
//
// and FS07-101 requires the ids, hashes and chain continuity to import UNBROKEN into
// `pg` at P-M3. That means this canonicalizer and the .NET one that replaces it must
// agree byte for byte, forever, on every row this repo ever commits. So it is written
// to be boringly literal about the spec and to REFUSE anything it is not certain about,
// rather than to accept broadly and guess.
//
// WHAT IT ACCEPTS. The subset the artifact plane actually uses:
//   - objects with string keys                (sorted, per §3.2.3)
//   - arrays                                  (order preserved, per §3.2.1)
//   - strings                                 (JSON escaping, per §3.2.2.2)
//   - integers within Number.MAX_SAFE_INTEGER (per §3.2.2.3)
//   - true / false / null
//
// WHAT IT REFUSES, AND WHY EACH REFUSAL IS DELIBERATE:
//   - NON-INTEGER NUMBERS. §3.2.2.3 defers to ECMAScript Number::toString, whose
//     shortest-round-trip output is genuinely hard to reproduce in another runtime.
//     Money in this system is integer minor units and FX rates are decimal STRINGS
//     precisely so no float ever reaches a hash (see schema/ledger-month.v1.json).
//     A canonicalizer that quietly serialised 0.1 would be a cross-language time bomb.
//   - NUMBERS BEYOND THE SAFE INTEGER RANGE, ±Infinity, NaN. Not representable, or not
//     representable identically.
//   - undefined, functions, symbols, BigInt, Date, Map, Set, class instances. A Date
//     would serialise via toJSON and hide a timezone decision inside a hash.
//   - LONE SURROGATES in strings. §3.2.2.2 assumes well-formed UTF-16; a lone surrogate
//     has no defined UTF-8 encoding and different runtimes substitute differently.
//   - Objects that are not plain (a prototype other than Object.prototype or null).
//
// KEY SORT ORDER. §3.2.3 sorts by UTF-16 code unit, which is exactly what
// Array.prototype.sort() does for strings by default. It is NOT localeCompare and it is
// NOT code-point order; do not "improve" this line.

import { createHash } from 'node:crypto';

const SAFE = Number.MAX_SAFE_INTEGER;

function refuse(what, path) {
  throw new TypeError(
    `JCS: refusing to canonicalize ${what} at ${path || '<root>'} — see the header of ` +
      `scripts/lib/jcs.mjs for why this canonicalizer refuses rather than guesses.`
  );
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function ser(value, path) {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    if (!Number.isFinite(value)) refuse(`the non-finite number ${value}`, path);
    if (!Number.isInteger(value)) refuse(`the non-integer number ${value}`, path);
    if (Math.abs(value) > SAFE) refuse(`the out-of-safe-range integer ${value}`, path);
    // -0 and 0 must not produce different bytes. §3.2.2.3 maps both to "0".
    return String(value === 0 ? 0 : value);
  }

  if (t === 'string') {
    if (hasLoneSurrogate(value)) refuse('a string containing a lone surrogate', path);
    // JSON.stringify's string escaping is RFC 8785 §3.2.2.2: the two-character escapes
    // for \b \t \n \f \r " \\, \u00xx for the remaining C0 controls, literal bytes
    // otherwise. Verified by the vectors in tests/jcs.test.mjs.
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const parts = value.map((v, i) => ser(v, `${path}[${i}]`));
    return `[${parts.join(',')}]`;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      const v = value[k];
      if (hasLoneSurrogate(k)) {
        // A KEY needs this check spelled out here, because keys reach the output through
        // the JSON.stringify below rather than through ser(), so they never pass the check
        // that guards string values. The hazard is identical on both axes and it is the
        // one this canonicalizer exists to prevent: V8 emits the \ud800 escape, while the
        // .NET serializer that replaces this one throws or substitutes U+FFFD for a lone
        // surrogate, so the chain would stop reproducing exactly where nobody is looking.
        refuse(`the key ${JSON.stringify(k)} containing a lone surrogate`, path);
      }
      if (v === undefined) {
        // JSON.stringify would DROP this key. Dropping a key silently changes a hash
        // input, so refuse instead: the caller must omit the key or pass null on purpose.
        refuse(`the key "${k}" whose value is undefined`, path);
      }
      parts.push(`${JSON.stringify(k)}:${ser(v, `${path}.${k}`)}`);
    }
    return `{${parts.join(',')}}`;
  }

  refuse(`a value of type ${t === 'object' ? Object.prototype.toString.call(value) : t}`, path);
}

/** RFC 8785 canonical JSON text for `value`. Throws on anything outside the accepted subset. */
export function jcs(value) {
  return ser(value, '');
}

/** Lowercase hex SHA-256 of a string (UTF-8) or a Buffer. */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * FS-07 §5.2 row hash: SHA-256 over the concatenation of the 64-character lowercase-hex
 * `prevHash` STRING and the JCS text of the row with its two chain fields removed.
 *
 * The concatenation is of TEXT, not of the 32 raw bytes prevHash decodes to. FS-07 writes
 * `prev_hash || JCS(...)` where `prev_hash` is the char(64) column, and the genesis value
 * is spelled as 64 zeros rather than 32 zero bytes — so the hex string is what is hashed.
 * That choice must survive the P-M3 port unchanged; tests/ledger-verify.test.mjs pins it
 * with a fixed expected digest so nobody can "optimise" it into raw bytes.
 */
export function ledgerRowHash(prevHash, rowWithoutHashes) {
  if (!/^[0-9a-f]{64}$/.test(prevHash)) {
    throw new TypeError(`ledgerRowHash: prevHash must be 64 lowercase hex chars, got ${prevHash}`);
  }
  return sha256Hex(prevHash + jcs(rowWithoutHashes));
}
