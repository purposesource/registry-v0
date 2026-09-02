#!/usr/bin/env node
// Operator tool: append ONE row to the v0 ledger.
//
//   node scripts/ledger-append.mjs --file row.json [--dir ledger] [--led-id led_…]
//                                  [--dry-run]
//
// Why this exists. The row hash covers every field of the row and chains onto the current
// global head, so a row cannot be hand-written: getting `seq`, `prev_hash` and `row_hash`
// right by hand is both tedious and the kind of tedium that produces a broken chain in a
// public artifact. This tool computes those three fields and nothing else — every FACT in
// the row comes from the input file.
//
// It refuses rather than repairs:
//   * the row body must not carry seq, prev_hash or row_hash (those are computed);
//   * the target month must not be closed (VS-36 immutability);
//   * the resulting month file must validate against schema/ledger-month.v1.json;
//   * the resulting whole-ledger chain must verify.
// Any of those failing leaves the file on disk untouched.
//
// SCOPE. This is a mechanical helper, not the money pipeline. The recording discipline —
// what a row means, when it may be written, the attestation bundle behind it — belongs to
// the operator recording script (FS-05 §4.2 / VS-27's `tools/record-purchases`). This
// tool assumes the decision has already been made and only makes the append correct.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  Failures,
  ROOT,
  config,
  die,
  generatedAt,
  noteLine,
  parseArgs,
  readJsonFile,
  schemaValidator,
  writeArtifact,
} from './lib/repo.mjs';
import { flatRows, isMonthClosed, loadLedger, monthCloseDate, verifyChain } from './lib/ledger.mjs';
import { ledgerRowHash } from './lib/jcs.mjs';

const args = parseArgs(process.argv.slice(2), {
  flags: ['dry-run'],
  values: ['file', 'dir', 'led-id'],
  defaults: { dir: 'ledger', file: null, 'led-id': null },
});

if (!args.file) die('--file <row.json> is required: the row body, without seq/prev_hash/row_hash.');

const cfg = config();
const now = generatedAt();
const dir = resolve(ROOT, args.dir);
const body = readJsonFile(resolve(ROOT, args.file));

for (const computed of ['seq', 'prev_hash', 'row_hash']) {
  if (Object.prototype.hasOwnProperty.call(body, computed)) {
    die(`the row body must not carry \`${computed}\` — this tool computes it. Remove it from ${args.file}.`);
  }
}
if (typeof body.month !== 'string') die('the row body must carry `month` (the settlement month, YYYY-MM).');
if (args['led-id']) body.led_id = args['led-id'];
if (typeof body.led_id !== 'string') {
  die('the row body must carry `led_id`, or pass --led-id. Ids are minted by the recording script, not guessed here.');
}

if (isMonthClosed(body.month, cfg, now)) {
  die(
    `month ${body.month} closed on ${monthCloseDate(body.month, cfg)} and is immutable (VS-36). ` +
      'A late fact posts against the earliest OPEN month as a forward correction with `corrects_led_id` (FS07-042) — the ledger never restates.'
  );
}

const months = loadLedger(dir);
const head = flatRows(months).slice(-1)[0];
const row = {
  ...body,
  seq: head ? head.row.seq + 1 : 1,
  prev_hash: head ? head.row.row_hash : cfg.ledger.genesisHash,
};
row.row_hash = ledgerRowHash(row.prev_hash, (({ prev_hash: _p, row_hash: _r, ...rest }) => rest)(row));

// Reassemble in the schema's field order so the committed file reads consistently.
const FIELD_ORDER = [
  'led_id', 'seq', 'month', 'row_type', 'amount_minor', 'currency',
  'src_amount_minor', 'src_currency', 'fx_rate', 'fx_source', 'fx_date',
  'lane', 'hold_status', 'payer_name',
  'ent_id', 'co_id', 'repo_node_id', 'category_fund_id', 'schedule_version',
  'corrects_led_id', 'external_key', 'note',
  'emitting_job', 'created_at', 'prev_hash', 'row_hash',
];
const ordered = {};
for (const k of FIELD_ORDER) if (row[k] !== undefined) ordered[k] = row[k];
for (const k of Object.keys(row)) if (!(k in ordered)) ordered[k] = row[k];

const target = join(dir, `${body.month}.json`);
const file = existsSync(target)
  ? readJsonFile(target)
  : { schema: 'ledger-v0/1', month: body.month, rows: [] };
file.rows = [...file.rows, ordered];

// Verify BEFORE writing: a tool that leaves a broken ledger behind is worse than no tool.
const failures = new Failures('ledger-append');
for (const err of schemaValidator('ledger-month.v1.json')(file)) failures.add(target, err);
const candidate = months.filter((m) => m.month !== body.month).concat([{ file: `${body.month}.json`, month: body.month, data: file }]).sort((a, b) => (a.month < b.month ? -1 : 1));
verifyChain(candidate, cfg, failures);
if (failures.count) failures.finish('(unreachable)');

if (args['dry-run']) {
  process.stdout.write(`${JSON.stringify(ordered, null, 2)}\n`);
  noteLine(`dry run: would append seq ${ordered.seq} to ${args.dir}/${body.month}.json`);
} else {
  writeArtifact(target, file);
  noteLine(`appended seq ${ordered.seq} (${ordered.row_type}) to ${args.dir}/${body.month}.json; head is now ${ordered.row_hash.slice(0, 16)}…`);
}
