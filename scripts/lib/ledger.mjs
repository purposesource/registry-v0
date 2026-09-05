// The v0 committed ledger: loading, the FS-07 §5.2 hash chain, month digests, and the
// month-close clock that makes a month file immutable.
//
// One idea carries this whole file: THE CHAIN IS THE INTEGRITY MECHANISM, and it is a
// GLOBAL chain, not a per-month one. FS-07 §5.2 is explicit that a row's predecessor is
// "the immediately preceding row in global insertion order, regardless of month", so
// intake for an open month chains onto the current head while earlier months are still
// open. `seq` is that global order. `month` is a label for reporting.
//
// The practical consequence, and the reason it is spelled out here: you cannot verify one
// month file on its own. Every gate in this repo loads the whole ledger.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, readJsonFile } from './repo.mjs';
import { jcs, ledgerRowHash, sha256Hex } from './jcs.mjs';

export const LEDGER_DIR = join(ROOT, 'ledger');

/**
 * Allocation row types. Structurally impossible before P-M3 (FS07-100: "no allocation
 * rows exist before P-M3"), so seeing one is not a typo to be reported as an enum miss —
 * it means someone tried to publish an allocation the platform has not computed.
 */
export const ALLOCATION_ROW_TYPES = [
  'charged-to-fees',
  'commons-alloc',
  'directed-alloc',
  'directed-to-commons',
  'repo-pool',
  'category-route',
  'category-agg',
  'rollforward-in',
  'rollforward-out',
  'disburse',
  'sponsor-ops-in',
  'month-lock',
  'adjustment',
  'donation-entitlement-note',
];

/** Row types whose amount must be exactly zero: narrative rows carry no money. */
export const ZERO_AMOUNT_ROW_TYPES = ['month-note', 'annotation'];

/** Row types whose amount must be negative (money leaving the pool). */
export const NEGATIVE_ROW_TYPES = ['refund-out', 'chargeback-out'];

/** Row types whose amount must be positive. */
export const POSITIVE_ROW_TYPES = [
  'pool-in',
  'topup-multiplier-in',
  'topup-donation-in',
  'chargeback-reverse-in',
];

const MONTH_FILE = /^(\d{4}-(?:0[1-9]|1[0-2]))\.json$/;

/**
 * Loads every ledger/{YYYY-MM}.json, ascending by month key.
 * `dir` is overridable so the tests can point at tests/fixtures/ledger.
 */
export function loadLedger(dir = LEDGER_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => MONTH_FILE.test(f))
    .sort()
    .map((file) => ({
      file,
      month: MONTH_FILE.exec(file)[1],
      data: readJsonFile(join(dir, file)),
    }));
}

/** Filenames in the directory that are NOT a valid month file — always a mistake. */
export function strayLedgerFiles(dir = LEDGER_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => !MONTH_FILE.test(f));
}

/**
 * Every row across every month, in GLOBAL chain order (ascending seq), each tagged with
 * the file it came from so an error message can point at a file a human can open.
 */
export function flatRows(months) {
  const rows = [];
  for (const m of months) {
    for (const row of (m.data && m.data.rows) || []) rows.push({ row, file: m.file });
  }
  return rows.sort((a, b) => {
    const s = (a.row.seq ?? 0) - (b.row.seq ?? 0);
    // Equal seq is itself a failure, reported by verifyChain; keep the order stable so
    // the failure message does not change between runs.
    return s !== 0 ? s : a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });
}

/** The row body the hash covers: everything except the two chain fields. */
export function hashInput(row) {
  const { prev_hash: _p, row_hash: _r, ...rest } = row;
  return rest;
}

/**
 * Recomputes the whole chain and reports every divergence.
 *
 * Checks, in order, because a later check is meaningless if an earlier one failed:
 *   1. `seq` is contiguous from 1 with no gaps and no duplicates. A gap would let a
 *      deleted row hide behind an otherwise-intact chain.
 *   2. each row's `month` equals its file's month.
 *   3. `prev_hash` equals the previous row's `row_hash` (genesis = 64 zeros).
 *   4. `row_hash` equals SHA-256(prev_hash || JCS(row minus hashes)).
 *   5. `led_id`, `external_key` uniqueness.
 *   6. the per-row-type amount sign law.
 *
 * Returns { headHash, headSeq, rowCount } on a clean chain (values are still returned on
 * a dirty one, so a caller can report both the chain problem and what it found).
 */
export function verifyChain(months, cfg, failures) {
  const genesis = cfg.ledger.genesisHash;
  const rows = flatRows(months);

  const seen = new Map();
  const ledIds = new Set();
  const externalKeys = new Map();

  let prev = genesis;
  let expectedSeq = 1;
  let headHash = genesis;
  let headSeq = 0;

  for (const { row, file } of rows) {
    const at = `ledger/${file} seq=${row.seq}`;

    if (seen.has(row.seq)) {
      failures.add(at, `duplicate seq — also in ${seen.get(row.seq)}. The chain has one global order; two rows cannot share a position.`);
    } else {
      seen.set(row.seq, file);
    }
    if (row.seq !== expectedSeq) {
      failures.add(
        at,
        `expected seq ${expectedSeq}. Global sequence numbers are contiguous from 1 across every month file — a gap is how a deleted row would hide.`
      );
    }
    expectedSeq = row.seq + 1;

    const fileMonth = MONTH_FILE.exec(file)[1];
    if (row.month !== fileMonth) {
      failures.add(at, `row.month is ${row.month} but the file is ${fileMonth}.`);
    }

    if (row.prev_hash !== prev) {
      failures.add(
        at,
        `prev_hash ${row.prev_hash.slice(0, 12)}… does not match the previous row's row_hash ${prev.slice(0, 12)}… — the chain is broken here.`
      );
    }

    let recomputed;
    try {
      recomputed = ledgerRowHash(row.prev_hash, hashInput(row));
    } catch (err) {
      failures.add(at, `row cannot be canonicalized: ${err.message}`);
      recomputed = null;
    }
    if (recomputed && recomputed !== row.row_hash) {
      failures.add(
        at,
        `row_hash mismatch: stored ${row.row_hash.slice(0, 12)}…, recomputed ${recomputed.slice(0, 12)}…. ` +
          `Some field of this row was edited after it was committed — the ledger is append-only and never restates (FS07-042); correct it with a new annotation or correction row instead.`
      );
    }

    if (ledIds.has(row.led_id)) failures.add(at, `duplicate led_id ${row.led_id}.`);
    ledIds.add(row.led_id);

    if (typeof row.external_key === 'string') {
      if (externalKeys.has(row.external_key)) {
        failures.add(
          at,
          `external_key ${row.external_key} is already used by seq=${externalKeys.get(row.external_key)} — external keys are the idempotency guard (ENG-065/066) and must be unique.`
        );
      } else {
        externalKeys.set(row.external_key, row.seq);
      }
    }

    if (ALLOCATION_ROW_TYPES.includes(row.row_type)) {
      failures.add(
        at,
        `row_type "${row.row_type}" is an ALLOCATION row. No allocation row exists before P-M3 (FS07-100): at v0 there is no allocator, so an allocation figure here would be an unbacked claim. The v0 whitelist is intake plus month-note/annotation.`
      );
    }
    if (ZERO_AMOUNT_ROW_TYPES.includes(row.row_type) && row.amount_minor !== 0) {
      failures.add(at, `${row.row_type} rows carry no money; amount_minor must be 0, got ${row.amount_minor}.`);
    }
    if (ZERO_AMOUNT_ROW_TYPES.includes(row.row_type) && typeof row.note !== 'string') {
      failures.add(at, `${row.row_type} rows exist to carry narrative; \`note\` is required.`);
    }
    if (NEGATIVE_ROW_TYPES.includes(row.row_type) && !(row.amount_minor < 0)) {
      failures.add(at, `${row.row_type} moves money out of the pool; amount_minor must be negative, got ${row.amount_minor}.`);
    }
    if (POSITIVE_ROW_TYPES.includes(row.row_type) && !(row.amount_minor > 0)) {
      failures.add(at, `${row.row_type} moves money into the pool; amount_minor must be positive, got ${row.amount_minor}.`);
    }
    if (typeof row.src_amount_minor === 'number' || typeof row.src_currency === 'string') {
      const complete =
        typeof row.src_amount_minor === 'number' &&
        typeof row.src_currency === 'string' &&
        typeof row.fx_rate === 'string' &&
        typeof row.fx_source === 'string' &&
        typeof row.fx_date === 'string';
      if (!complete) {
        failures.add(
          at,
          'a row settled in another currency must carry the whole captured-FX set: src_amount_minor, src_currency, fx_rate, fx_source, fx_date (ENG-037). A partial set means the reporting figure cannot be re-derived.'
        );
      }
      if (row.src_currency === row.currency) {
        failures.add(at, 'src_currency equals currency — there was no conversion, so the FX fields must be omitted.');
      }
    }

    prev = row.row_hash;
    headHash = row.row_hash;
    headSeq = row.seq;
  }

  return { headHash, headSeq, rowCount: rows.length };
}

/**
 * Per-month digest published in /ledger/chain.json (VS-37: "head + per-month digests").
 *
 * v0 definition, stated here because it must never change: SHA-256 of the JCS text of the
 * ARRAY of that month's rows, complete rows including their chain fields, in ascending
 * seq. FS-07 §5.2's `month_digest` is defined "over that month's rows in the FS07-032
 * canonical serialization order"; this is the v0 reading of that order, and it is pinned
 * by tests/ledger-verify.test.mjs so a P-M3 port has a fixed target to reproduce.
 */
export function monthDigest(monthRows) {
  const ordered = [...monthRows].sort((a, b) => a.seq - b.seq);
  return sha256Hex(jcs(ordered));
}

/**
 * The date on which a month file becomes IMMUTABLE (VS-36: "monthly files immutable once
 * the month closes").
 *
 * Close = day `monthCloseDayOfMonth` of month M + `monthCloseOffsetMonths`, i.e. day 3 of
 * M+2 with the shipped configuration. That is exactly when FS07-050's allocator would
 * lock the month, the M+1 chargeback hold having fully elapsed — so v0's CI-enforced
 * immutability begins at the same instant P-M3's database-enforced immutability would.
 */
export function monthCloseDate(month, cfg) {
  const [y, m] = month.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + cfg.ledger.monthCloseOffsetMonths, cfg.ledger.monthCloseDayOfMonth));
  return t.toISOString().slice(0, 10);
}

/** True when `nowInstant` (an ISO instant) is at or past the month's close date. */
export function isMonthClosed(month, cfg, nowInstant) {
  return nowInstant.slice(0, 10) >= monthCloseDate(month, cfg);
}
