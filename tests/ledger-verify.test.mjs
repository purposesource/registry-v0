// The ledger chain and the append-only law.
//
// Every test here breaks the ledger in one specific way that a careless or a dishonest
// change would produce, and asserts that CI goes red. The two halves matter for different
// reasons:
//
//   CHAIN tests prove that no field of a committed row can be altered unnoticed.
//   BASELINE tests prove that history cannot be REWRITTEN — recompute every hash after an
//     edit and the chain is valid again over falsified rows, so the chain alone is not
//     enough. That is the case FS-07 §5.4's "never restate" actually depends on.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { REPO, cleanup, runScript, workspace } from './helpers.mjs';
import { monthDigest } from '../scripts/lib/ledger.mjs';

const FX = 'tests/fixtures/ledger';
const FX_CT = 'tests/fixtures/ct';

function ws(prefix) {
  return workspace(prefix, { ledger: FX, ct: FX_CT });
}

function month(wsRel, key) {
  return JSON.parse(readFileSync(join(REPO, wsRel, 'ledger', `${key}.json`), 'utf8'));
}

function writeMonth(wsRel, key, data) {
  writeFileSync(join(REPO, wsRel, 'ledger', `${key}.json`), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function verify(wsRel, extra = []) {
  return runScript('ledger-verify.mjs', ['--dir', `${wsRel}/ledger`, ...extra]);
}

test('the committed ledger verifies (the honest empty state is a valid chain)', () => {
  const r = runScript('ledger-verify.mjs');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /chain empty and consistent/);
});

test('the fixture ledger verifies across two months in one global chain', () => {
  const r = runScript('ledger-verify.mjs', ['--dir', FX]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /6 row\(s\) across 2 month\(s\)/);
});

test('EDITING AN AMOUNT breaks the chain and names the row', (t) => {
  const w = ws('amount');
  t.after(() => cleanup(w));

  const m = month(w, '2026-11');
  m.rows[1].amount_minor = 999999;
  writeMonth(w, '2026-11', m);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /row_hash mismatch/);
  assert.match(r.stderr, /seq=2/);
  assert.match(r.stderr, /append-only and never restates/);
});

test('editing a NOTE breaks the chain too — narrative is as immutable as an amount', (t) => {
  const w = ws('note');
  t.after(() => cleanup(w));

  const m = month(w, '2026-11');
  m.rows[0].note = 'a different story';
  writeMonth(w, '2026-11', m);

  assert.equal(verify(w).code, 1);
});

test('recomputing the edited row alone still fails: every later prev_hash disagrees', (t) => {
  const w = ws('recompute');
  t.after(() => cleanup(w));

  // The realistic dishonest edit: change a value AND fix that one row's hash, hoping the
  // gate only checks each row against itself.
  const m = month(w, '2026-11');
  m.rows[1].amount_minor = 999999;
  m.rows[1].row_hash = 'f'.repeat(64);
  writeMonth(w, '2026-11', m);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the chain is broken here/);
});

test('DELETING a row leaves a seq gap, which is exactly how a deletion would hide', (t) => {
  const w = ws('delete');
  t.after(() => cleanup(w));

  const m = month(w, '2026-11');
  m.rows.splice(1, 1);
  writeMonth(w, '2026-11', m);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /expected seq 2/);
});

test('SWAPPING two rows in the global chain is caught', (t) => {
  const w = ws('reorder');
  t.after(() => cleanup(w));

  // `seq` is inside the hashed body, so exchanging two rows' positions in the global
  // chain changes both of their hashes. (Reversing the ORDER OF LINES in the file alone
  // is not a change to the ledger: every gate sorts by seq, and the emitted artifact is
  // rendered in seq order. Position is `seq`, not line number.)
  const swapped = month(w, '2026-11');
  const a = swapped.rows[0].seq;
  swapped.rows[0].seq = swapped.rows[1].seq;
  swapped.rows[1].seq = a;
  writeMonth(w, '2026-11', swapped);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /row_hash mismatch/);
});

test('a row filed under the wrong month is caught', (t) => {
  const w = ws('wrongmonth');
  t.after(() => cleanup(w));

  const m = month(w, '2026-11');
  m.rows[0].month = '2026-12';
  writeMonth(w, '2026-11', m);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /row\.month is 2026-12 but the file is 2026-11/);
});

test('an ALLOCATION row type is refused by name — none exists before P-M3 (FS07-100)', (t) => {
  const w = ws('alloc');
  t.after(() => cleanup(w));

  const m = month(w, '2026-12');
  m.rows.push({
    ...m.rows[m.rows.length - 1],
    led_id: 'led_01jd0000000000000000000009',
    seq: 7,
    row_type: 'disburse',
    amount_minor: -1000,
  });
  writeMonth(w, '2026-12', m);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is an ALLOCATION row/);
  assert.match(r.stderr, /FS07-100/);
});

test('the two capped lines of D34 — reserve-retention and hardship-pay — are refused by name too', (t) => {
  const w = ws('capped-lines');
  t.after(() => cleanup(w));

  const m = month(w, '2026-12');
  const last = m.rows[m.rows.length - 1];
  m.rows.push(
    { ...last, led_id: 'led_01jd0000000000000000000010', seq: 7, row_type: 'reserve-retention', amount_minor: 0, note: 'x' },
    { ...last, led_id: 'led_01jd0000000000000000000011', seq: 8, row_type: 'hardship-pay', amount_minor: 0, note: 'x' }
  );
  writeMonth(w, '2026-12', m);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /"reserve-retention" is an ALLOCATION row/);
  assert.match(r.stderr, /"hardship-pay" is an ALLOCATION row/);
  assert.match(r.stderr, /reserve retention, a hardship payment or a transfer to a listed recipient/);
});

test('recipient_id is refused on anything but a disburse row (D33 item 1)', (t) => {
  const w = ws('recipient');
  t.after(() => cleanup(w));

  const m = month(w, '2026-12');
  m.rows[0] = { ...m.rows[0], recipient_id: 'rcp_01jd0000000000000000000001' };
  writeMonth(w, '2026-12', m);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /recipient_id belongs to a `disburse` row only/);
});

test('the amount-sign law is enforced per row type', (t) => {
  const w = ws('signs');
  t.after(() => cleanup(w));

  const m = month(w, '2026-11');
  m.rows[0].amount_minor = 500; // a month-note carries no money
  m.rows[1].amount_minor = -500; // a pool-in moves money IN
  writeMonth(w, '2026-11', m);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /month-note rows carry no money/);
  assert.match(r.stderr, /pool-in moves money into the pool/);
});

test('a partial captured-FX set is refused: the reporting figure must be re-derivable', (t) => {
  const w = ws('fx');
  t.after(() => cleanup(w));

  const m = month(w, '2026-11');
  delete m.rows[2].fx_rate;
  writeMonth(w, '2026-11', m);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /whole captured-FX set/);
});

test('a duplicate external_key is refused — it is the idempotency guard', (t) => {
  const w = ws('extkey');
  t.after(() => cleanup(w));

  const m = month(w, '2026-12');
  m.rows[0].external_key = 'fixture-txn-0001';
  writeMonth(w, '2026-12', m);

  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already used by seq=2/);
});

// ------------------------------------------------------------------- append-only guard

test('appending a row at the END passes the baseline guard', (t) => {
  const w = ws('append-ok');
  t.after(() => cleanup(w));

  const row = {
    led_id: 'led_01jd000000000000000000000c',
    month: '2027-01',
    row_type: 'pool-in',
    amount_minor: 120000,
    currency: 'CHF',
    lane: 'project',
    hold_status: 'open-M+1',
    payer_name: 'unnamed',
    external_key: 'fixture-txn-0009',
    emitting_job: 'operator:record-purchases',
    created_at: '2027-01-10T09:00:00Z',
  };
  const rowFile = `${w}/row.json`;
  writeFileSync(join(REPO, rowFile), `${JSON.stringify(row, null, 2)}\n`, 'utf8');

  const a = runScript('ledger-append.mjs', ['--dir', `${w}/ledger`, '--file', rowFile]);
  assert.equal(a.code, 0, a.stderr);

  const r = verify(w, ['--base-dir', 'tests/fixtures']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /7 row\(s\)/);
});

test('REMOVING a published row fails the baseline guard with the forward-correction fix', (t) => {
  const w = ws('base-remove');
  t.after(() => cleanup(w));

  const m = month(w, '2026-12');
  m.rows.pop();
  writeMonth(w, '2026-12', m);

  const r = verify(w, ['--base-dir', 'tests/fixtures']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /has been REMOVED/);
  assert.match(r.stderr, /corrects_led_id/);
});

test('EDITING a published row and rehashing the whole chain STILL fails the baseline guard', async (t) => {
  const w = ws('base-rewrite');
  t.after(() => cleanup(w));

  // Rewrite history properly: change the amount, then recompute seq 2..6 so the chain is
  // internally perfect. This is the attack the chain cannot see.
  const nov = month(w, '2026-11');
  nov.rows[1].amount_minor = 1;
  writeMonth(w, '2026-11', nov);

  const rowFileHelper = runScript('ledger-verify.mjs', ['--dir', `${w}/ledger`]);
  assert.equal(rowFileHelper.code, 1, 'the chain notices the un-rehashed edit');

  // Now do the rehash for real, using the same primitive the append tool uses.
  const { ledgerRowHash } = await import('../scripts/lib/jcs.mjs');
  const genesis = '0'.repeat(64);
  const months = ['2026-11', '2026-12'].map((k) => [k, month(w, k)]);
  const all = months.flatMap(([k, m]) => m.rows.map((row) => ({ k, row }))).sort((x, y) => x.row.seq - y.row.seq);
  let prev = genesis;
  for (const { row } of all) {
    row.prev_hash = prev;
    const { prev_hash: _p, row_hash: _r, ...body } = row;
    row.row_hash = ledgerRowHash(prev, body);
    prev = row.row_hash;
  }
  for (const [k, m] of months) writeMonth(w, k, m);

  const chainOnly = runScript('ledger-verify.mjs', ['--dir', `${w}/ledger`]);
  assert.equal(chainOnly.code, 0, 'a rewritten chain is internally VALID — this is the point');

  const withBase = verify(w, ['--base-dir', 'tests/fixtures']);
  assert.equal(withBase.code, 1, 'the baseline comparison is what catches a rewrite');
  assert.match(withBase.stderr, /has been EDITED/);
});

test('inserting a new row BELOW the published head is refused', (t) => {
  const w = ws('base-insert');
  t.after(() => cleanup(w));

  const nov = month(w, '2026-11');
  nov.rows.push({ ...nov.rows[0], led_id: 'led_01jd00000000000000000000zz', seq: 99 });
  const dec = month(w, '2026-12');
  dec.rows[dec.rows.length - 1].seq = 100;
  writeMonth(w, '2026-11', nov);
  writeMonth(w, '2026-12', dec);

  const r = verify(w, ['--base-dir', 'tests/fixtures']);
  assert.equal(r.code, 1);
});

test('the guard SAYS SO when no baseline is available instead of reporting success', () => {
  const r = runScript('ledger-verify.mjs', ['--dir', FX]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /append-only comparison SKIPPED/);
  assert.match(r.stdout, /the retro-edit guard did not/);
});

// ------------------------------------------- a baseline that was ASKED FOR and did not come
//
// The three states below used to be one. The loader returned null for "nobody named a
// baseline" AND for "a baseline was named and is not here", so the second one produced the
// first one's green run and its one-line note — which is how the retro-edit guard came to
// have never run on a push of the republished repository while every run reported success.
// A published history gets new shas on every publish, so the pre-push sha a push event
// names is routinely gone, and the guard said so into a green log nobody reads.

test('a baseline that was NAMED and does not resolve FAILS — it is not the same as no baseline', () => {
  const dead = 'deadbeef'.repeat(5); // sha-shaped and cannot exist: the CI case exactly
  const r = runScript('ledger-verify.mjs', ['--dir', FX, '--base-ref', dead]);

  assert.equal(r.code, 1, 'naming a baseline is asking for the comparison; not doing it is a failure');
  assert.match(r.stderr, /does not resolve in this checkout/);
  assert.match(r.stderr, /retro-edit guard did NOT run/);
  // The distinction is the point: this outcome must not be reported as the skip.
  assert.doesNotMatch(r.stdout, /SKIPPED/);
});

test('an unresolvable PSN_BASE_REF fails the same way a flag does — the guards read the env in CI', () => {
  const r = runScript('ledger-verify.mjs', ['--dir', FX], { PSN_BASE_REF: 'deadbeef'.repeat(5) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not resolve in this checkout/);
});

test('an EMPTY PSN_BASE_REF still means "no baseline named" and skips honestly', () => {
  // A workflow that has decided there is legitimately nothing to compare against says so
  // with an empty value. That has to stay a skip, or a repository's first commit cannot
  // pass its own CI.
  const r = runScript('ledger-verify.mjs', ['--dir', FX], { PSN_BASE_REF: '' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /append-only comparison SKIPPED/);
});

test('a baseline that resolves but holds NO month file is refused while rows exist', (t) => {
  // The other false green: the baseline is found, so the log prints a baseline line and
  // the guard reads as if it ran — but the revision has no ledger at all, every row counts
  // as new, and nothing is compared. A wrong path for the checkout looks exactly like this.
  const w = ws('base-empty-tree');
  t.after(() => cleanup(w));
  mkdirSync(join(REPO, w, 'empty-base', 'ledger'), { recursive: true });

  const r = verify(w, ['--base-dir', `${w}/empty-base`]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /holds no ledger month file/);
  assert.match(r.stderr, /vacuous pass is worse than an announced skip/);
});

test('the same empty baseline PASSES when nothing is committed here either, and says why', (t) => {
  // The committed ledger is one month file with no rows, so there is genuinely no published
  // record that could have been removed or edited. That earns a pass — and a sentence
  // saying nothing was compared, rather than a baseline line implying something was.
  const w = ws('base-empty-both');
  t.after(() => cleanup(w));
  mkdirSync(join(REPO, w, 'empty-base', 'ledger'), { recursive: true });

  const r = runScript('ledger-verify.mjs', ['--base-dir', `${w}/empty-base`]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /nothing to compare/);
  assert.match(r.stdout, /no published record that could have been removed or edited/);
});

// ---------------------------------------------------------------- the append tool

test('ledger-append refuses a body that carries computed fields', (t) => {
  const w = ws('append-computed');
  t.after(() => cleanup(w));

  const rowFile = `${w}/row.json`;
  writeFileSync(
    join(REPO, rowFile),
    JSON.stringify({ led_id: 'led_01jd000000000000000000000z', month: '2027-01', seq: 1 }),
    'utf8'
  );
  const a = runScript('ledger-append.mjs', ['--dir', `${w}/ledger`, '--file', rowFile]);
  assert.equal(a.code, 1);
  assert.match(a.stderr, /must not carry `seq`/);
});

test('ledger-append refuses to touch a CLOSED month (VS-36)', (t) => {
  const w = ws('append-closed');
  t.after(() => cleanup(w));

  const rowFile = `${w}/row.json`;
  writeFileSync(
    join(REPO, rowFile),
    JSON.stringify({
      led_id: 'led_01jd000000000000000000000y',
      month: '2026-11',
      row_type: 'pool-in',
      amount_minor: 1000,
      currency: 'CHF',
      lane: 'project',
      hold_status: 'released',
      payer_name: 'unnamed',
      emitting_job: 'operator:record-purchases',
      created_at: '2026-11-30T00:00:00Z',
    }),
    'utf8'
  );
  // The suite's fixed NOW is 2027-01-15, so 2026-11 closed on 2027-01-03.
  const a = runScript('ledger-append.mjs', ['--dir', `${w}/ledger`, '--file', rowFile]);
  assert.equal(a.code, 1);
  assert.match(a.stderr, /closed on 2027-01-03/);
  assert.match(a.stderr, /never restates/);
});

// ------------------------------------------------------------------- month digests

test('the month digest is stable and covers the whole row set', () => {
  const nov = JSON.parse(readFileSync(join(REPO, FX, '2026-11.json'), 'utf8'));
  const d1 = monthDigest(nov.rows);
  // Order-independent by construction: the digest sorts by seq first.
  const d2 = monthDigest([...nov.rows].reverse());
  assert.equal(d1, d2);
  // And sensitive to content.
  const changed = structuredClone(nov.rows);
  changed[0].note = 'x';
  assert.notEqual(monthDigest(changed), d1);
});
