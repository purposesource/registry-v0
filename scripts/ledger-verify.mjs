#!/usr/bin/env node
// Ledger gate — FS07-100, VS-36. Recomputes the chain and enforces the append-only law.
//
//   node scripts/ledger-verify.mjs [--dir ledger] [--base-ref <rev>] [--base-dir <path>]
//
// FAILS CI ON:
//   * a schema-invalid month file;
//   * a broken hash chain (any edited field of any committed row);
//   * a seq gap, duplicate, or misfiled month;
//   * a row type that does not exist at v0 (every allocation type);
//   * a row removed or edited since the base revision — the RETRO-EDIT case;
//   * any change at all to a month file whose month has closed.
//
// WHY TWO MECHANISMS. The chain proves internal consistency. It does not prove that
// history was not rewritten: recompute every hash after an edit and the chain is valid
// again over falsified rows. The base-revision comparison is what catches that, and it is
// the reason CERT-032 wants the log in an independent medium. At v0 the independent
// medium is git history — see the header of scripts/lib/baseline.mjs.
//
// If no baseline is available (first commit, or a shallow clone), the run SAYS SO and
// continues with the chain checks only. A skipped guard that announces itself is
// recoverable; a skipped guard that reports success is not.

import { resolve } from 'node:path';

import { Failures, config, generatedAt, noteLine, parseArgs, schemaValidator, ROOT } from './lib/repo.mjs';
import { LEDGER_DIR, isMonthClosed, loadLedger, monthCloseDate, strayLedgerFiles, verifyChain } from './lib/ledger.mjs';
import { assertAppendOnly, loadBaseline } from './lib/baseline.mjs';

const args = parseArgs(process.argv.slice(2), {
  flags: [],
  values: ['dir', 'base-ref', 'base-dir'],
  defaults: {
    dir: 'ledger',
    // PSN_BASE_REF lets CI supply the base commit without every workflow step repeating
    // the flag; the flag still wins when both are present.
    'base-ref': process.env.PSN_BASE_REF || null,
    'base-dir': null,
  },
});

const cfg = config();
const now = generatedAt();
const dir = resolve(ROOT, args.dir);
const failures = new Failures(`ledger(${args.dir})`);
const validate = schemaValidator('ledger-month.v1.json');

for (const stray of strayLedgerFiles(dir)) {
  failures.add(
    `${args.dir}/${stray}`,
    'is not a month file. The ledger directory holds `{YYYY-MM}.json` files and nothing else — chain.json is an EMITTED artifact, not a source.'
  );
}

const months = loadLedger(dir);
if (months.length === 0) {
  failures.add(
    `${args.dir}/`,
    'holds no month files. The v0 ledger is a committed table (FS07-100); an absent table is not the same as an empty one, and the honest empty state is a month file with `"rows": []`.'
  );
  failures.finish('nothing to verify');
}

for (const m of months) {
  for (const err of validate(m.data)) failures.add(`${args.dir}/${m.file}`, err);
  if (m.data.month !== m.month) {
    failures.add(`${args.dir}/${m.file}`, `\`month\` is ${m.data.month} but the filename says ${m.month}.`);
  }
}

// ------------------------------------------------------------------------- the chain

const { headHash, headSeq, rowCount } = verifyChain(months, cfg, failures);

// ---------------------------------------------------------------- month immutability

const baseline = loadBaseline({ baseRef: args['base-ref'], baseDir: args['base-dir'] });

for (const m of months) {
  if (!isMonthClosed(m.month, cfg, now)) continue;
  const closedOn = monthCloseDate(m.month, cfg);
  if (!baseline) continue;

  const before = [...baseline.ledgerRows.values()].filter((r) => r.month === m.month);
  const after = m.data.rows || [];
  if (before.length !== after.length) {
    failures.add(
      `${args.dir}/${m.file}`,
      `month ${m.month} closed on ${closedOn} and had ${before.length} row(s) at the base revision; it now has ${after.length}. ` +
        'A closed month is immutable (VS-36). Post a forward-dated correction against the earliest OPEN month instead (FS07-042) — the ledger annotates, it never restates.'
    );
  }
}

// -------------------------------------------------------------------- append-only

if (!baseline) {
  noteLine('append-only comparison SKIPPED (no baseline). Chain and schema checks ran; the retro-edit guard did not.');
} else {
  noteLine(`append-only baseline: ${baseline.source} (${baseline.ledgerRows.size} row(s))`);
  const current = new Map();
  for (const m of months) for (const row of m.data.rows || []) current.set(row.seq, row);

  assertAppendOnly({
    label: 'ledger row',
    baseline: baseline.ledgerRows,
    current,
    failures,
    describe: {
      removedFix:
        'restore it. If the underlying fact was wrong, add a correcting row that points at it with `corrects_led_id`, or a zero-amount `annotation` row (FS07-042).',
      editedFix:
        'Revert the edit. A committed row is immutable forever; a correction is a NEW row with `corrects_led_id`, and narrative context is a zero-amount `annotation` row. No exception exists (NEV-019).',
    },
  });

  // Growth must be at the END of the chain, never in the middle. A new row inserted at an
  // existing position would show up above as an edit, but a row appended with a seq lower
  // than the old head would not — and it would silently re-order published history.
  let baseHead = 0;
  for (const seq of baseline.ledgerRows.keys()) baseHead = Math.max(baseHead, seq);
  for (const [seq] of current) {
    if (!baseline.ledgerRows.has(seq) && seq <= baseHead) {
      failures.add(
        `ledger row ${seq}`,
        `is new but sits at or below the published head (seq ${baseHead}). New rows append: the next free seq is ${baseHead + 1}.`
      );
    }
  }
}

failures.finish(
  rowCount === 0
    ? `chain empty and consistent — no money has moved yet (head = genesis, ${months.length} month file(s))`
    : `${rowCount} row(s) across ${months.length} month(s); chain verified to seq ${headSeq}, head ${headHash.slice(0, 16)}…`
);
