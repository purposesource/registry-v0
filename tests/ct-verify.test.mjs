// The certificate-transparency log guards.
//
// CERT-030 makes log presence a REQUIREMENT of verification: a certificate whose hash is
// absent renders UNVERIFIED even with a valid signature. That is what makes the log the
// rogue-issuance detector — and it only detects anything if the log cannot be quietly
// rewritten. Each test below is one way it could be, and asserts CI goes red.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { Failures, config } from '../scripts/lib/repo.mjs';
import { verifyCt } from '../scripts/lib/ct.mjs';
import { sha256Hex } from '../scripts/lib/jcs.mjs';
import { REPO, cleanup, runScript, workspace } from './helpers.mjs';

const FX = 'tests/fixtures/ct';
const FX_LEDGER = 'tests/fixtures/ledger';

function ws(prefix) {
  return workspace(prefix, { ct: FX, ledger: FX_LEDGER });
}

function segment(wsRel, n) {
  return JSON.parse(readFileSync(join(REPO, wsRel, 'ct', `${n}.json`), 'utf8'));
}

function writeSegment(wsRel, n, data) {
  writeFileSync(join(REPO, wsRel, 'ct', `${n}.json`), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function verify(wsRel, extra = []) {
  return runScript('ct-verify.mjs', ['--dir', `${wsRel}/ct`, ...extra]);
}

test('the committed log verifies (an empty log is a well-formed log)', () => {
  const r = runScript('ct-verify.mjs');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /log empty and well-formed/);
});

test('the fixture log verifies, including a revocation referencing an earlier entry', () => {
  const r = runScript('ct-verify.mjs', ['--dir', FX]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /5 entries across 1 segment\(s\)/);
});

test('a sequence GAP is refused — that is how a removed entry would hide', (t) => {
  const w = ws('gap');
  t.after(() => cleanup(w));

  const s = segment(w, 0);
  s.entries.splice(2, 1);
  writeSegment(w, 0, s);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /expected seq 2/);
});

test('a repeated sequence number is refused', (t) => {
  const w = ws('dupseq');
  t.after(() => cleanup(w));

  const s = segment(w, 0);
  s.entries[3].seq = 2;
  writeSegment(w, 0, s);

  assert.equal(verify(w).code, 1);
});

test('a duplicate entry hash is refused — one signed object, one entry', (t) => {
  const w = ws('duphash');
  t.after(() => cleanup(w));

  const s = segment(w, 0);
  s.entries[2].h = s.entries[1].h;
  writeSegment(w, 0, s);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /hash already logged at seq=1/);
});

test('a malformed hash is refused by the schema before anything else looks at it', (t) => {
  const w = ws('badhash');
  t.after(() => cleanup(w));

  const s = segment(w, 0);
  s.entries[1].h = 'not-a-hash';
  writeSegment(w, 0, s);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /pattern/);
});

test('time must not run backwards', (t) => {
  const w = ws('time');
  t.after(() => cleanup(w));

  const s = segment(w, 0);
  s.entries[3].ts = '2020-01-01T00:00:00Z';
  writeSegment(w, 0, s);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is earlier than the previous entry/);
});

test('a revocation must reference an EARLIER entry that exists (CERT-033)', (t) => {
  const w = ws('ref');
  t.after(() => cleanup(w));

  const dangling = segment(w, 0);
  dangling.entries[3].ref = 'a'.repeat(64);
  writeSegment(w, 0, dangling);
  let r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not name an earlier entry/);

  const nullRef = segment(w, 0);
  nullRef.entries[3].ref = null;
  writeSegment(w, 0, nullRef);
  r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /must reference the original entry's hash/);
});

test('an `issue` entry must not carry a ref', (t) => {
  const w = ws('issueref');
  t.after(() => cleanup(w));

  const s = segment(w, 0);
  s.entries[1].ref = s.entries[0].h;
  writeSegment(w, 0, s);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /`ref` must be null/);
});

test('a certificate type v0 cannot issue is refused by name (VS-30)', (t) => {
  const w = ws('typ');
  t.after(() => cleanup(w));

  const s = segment(w, 0);
  s.entries[1].typ = 'contributor';
  writeSegment(w, 0, s);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not issuable at v0/);
  assert.match(r.stderr, /Phase E\+/);
});

test('PERSONAL DATA is refused: the log is immutable forever, so PII in it is permanent', (t) => {
  const w = ws('pii');
  t.after(() => cleanup(w));

  const s = segment(w, 0);
  // The schema closes the object, so the only way in is through a field that is
  // legitimately a string. This is the belt to that braces.
  s.entries[1].typ = 'holder@example.org';
  writeSegment(w, 0, s);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /email-shaped text/);
  assert.match(r.stderr, /CERT-031/);
});

test('startSeq must agree with the segment number', (t) => {
  const w = ws('startseq');
  t.after(() => cleanup(w));

  const s = segment(w, 0);
  s.startSeq = 7;
  writeSegment(w, 0, s);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /startSeq must be segment \*/);
});

test('segment 0 has no predecessor hash', (t) => {
  const w = ws('prev0');
  t.after(() => cleanup(w));

  const s = segment(w, 0);
  s.prevSegmentSha256 = 'b'.repeat(64);
  writeSegment(w, 0, s);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /prevSegmentSha256 must be null/);
});

// The 10,000-entry segment size makes a real multi-segment fixture impractical, so the
// segment chain is exercised against the library with a small configured size. This is
// the only rule in the repo whose test does not go through the CLI, and the reason is
// arithmetic rather than convenience.
test('the SEGMENT CHAIN is verified: prevSegmentSha256 is the previous file bytes', () => {
  const cfg = structuredClone(config());
  cfg.ct.entriesPerSegment = 2;

  const mk = (n, startSeq, entries, prev) => {
    const data = { schemaVersion: 1, segment: n, startSeq, prevSegmentSha256: prev, entries };
    const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return { file: `${n}.json`, segment: n, data, bytes };
  };
  const e = (seq, tag) => ({
    seq,
    h: sha256Hex(`entry-${tag}`),
    typ: 'supporter',
    kind: 'issue',
    ref: null,
    ts: `2027-0${seq + 1}-01T00:00:00Z`,
  });

  const seg0 = mk(0, 0, [e(0, 'a'), e(1, 'b')], null);
  const good = mk(1, 2, [e(2, 'c')], sha256Hex(seg0.bytes));
  const bad = mk(1, 2, [e(2, 'c')], 'c'.repeat(64));

  const okF = new Failures('t');
  verifyCt([seg0, good], cfg, okF);
  assert.equal(okF.count, 0, JSON.stringify(okF.items));

  const badF = new Failures('t');
  verifyCt([seg0, bad], cfg, badF);
  assert.equal(badF.count, 1);
  assert.match(badF.items[0].message, /does not match the SHA-256 of segment 0's bytes/);
});

test('a closed segment must be full — only the open one may be short', () => {
  const cfg = structuredClone(config());
  cfg.ct.entriesPerSegment = 2;
  const mk = (n, startSeq, entries, prev) => {
    const data = { schemaVersion: 1, segment: n, startSeq, prevSegmentSha256: prev, entries };
    return { file: `${n}.json`, segment: n, data, bytes: Buffer.from(JSON.stringify(data)) };
  };
  const e = (seq) => ({ seq, h: sha256Hex(`x${seq}`), typ: 'supporter', kind: 'issue', ref: null, ts: '2027-01-01T00:00:00Z' });

  const f = new Failures('t');
  // Segment 0 holds one entry while segment 1 exists — the log skipped capacity.
  const s0 = mk(0, 0, [e(0)], null);
  verifyCt([s0, mk(1, 2, [e(2)], sha256Hex(s0.bytes))], cfg, f);
  assert.ok(f.items.some((i) => /a closed segment holds exactly 2 entries/.test(i.message)), JSON.stringify(f.items));
});

// -------------------------------------------------------------------- append-only guard

test('appending an entry passes the baseline guard', (t) => {
  const w = ws('append');
  t.after(() => cleanup(w));

  const s = segment(w, 0);
  s.entries.push({
    seq: 5,
    h: sha256Hex('a new certificate'),
    typ: 'supporter',
    kind: 'issue',
    ref: null,
    ts: '2027-01-10T10:00:00Z',
  });
  writeSegment(w, 0, s);

  const r = verify(w, ['--base-dir', 'tests/fixtures']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /6 entries/);
});

test('EDITING a published entry fails the baseline guard with the CERT-033 fix', (t) => {
  const w = ws('base-edit');
  t.after(() => cleanup(w));

  const s = segment(w, 0);
  s.entries[1].typ = 'license-status';
  writeSegment(w, 0, s);

  const r = verify(w, ['--base-dir', 'tests/fixtures']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /has been EDITED/);
  assert.match(r.stderr, /CERT-033/);
});

test('DELETING a published entry fails the baseline guard', (t) => {
  const w = ws('base-del');
  t.after(() => cleanup(w));

  const s = segment(w, 0);
  s.entries = s.entries.slice(0, 4);
  writeSegment(w, 0, s);

  const r = verify(w, ['--base-dir', 'tests/fixtures']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /has been REMOVED/);
  assert.match(r.stderr, /unverifiable/);
});

test('a stray file in the log directory is refused', (t) => {
  const w = ws('stray');
  t.after(() => cleanup(w));

  writeFileSync(join(REPO, w, 'ct', 'latest.json'), '{}', 'utf8');
  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is not a segment file/);
  assert.match(r.stderr, /EMITTED artifact/);
});

test('the guard SAYS SO when no baseline is available', () => {
  const r = runScript('ct-verify.mjs', ['--dir', FX]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /append-only comparison SKIPPED/);
});
