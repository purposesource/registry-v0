#!/usr/bin/env node
// Certificate-transparency gate — FS-08 §12, VS-28.
//
//   node scripts/ct-verify.mjs [--dir ct] [--base-ref <rev>] [--base-dir <path>]
//
// FAILS CI ON:
//   * a schema-invalid segment;
//   * a non-monotonic, gapped, or duplicated sequence number;
//   * a malformed entry hash, a duplicate hash, or a `ref` that names no earlier entry;
//   * a broken segment chain (prevSegmentSha256 not matching the previous file's bytes);
//   * a `typ` a v0 log may not contain;
//   * anything email-shaped anywhere in an entry;
//   * an entry edited or deleted since the base revision.
//
// Why the guard is worth this much code: CERT-030 makes log presence a REQUIREMENT of
// verification, so the log is the rogue-issuance detector. A log that can be quietly
// rewritten detects nothing. See scripts/lib/baseline.mjs for why a hash chain alone
// cannot establish append-only-ness.

import { resolve } from 'node:path';

import { Failures, ROOT, config, noteLine, parseArgs, schemaValidator } from './lib/repo.mjs';
import { CT_DIR, loadCt, strayCtFiles, verifyCt } from './lib/ct.mjs';
import { assertAppendOnly, loadBaseline } from './lib/baseline.mjs';

const args = parseArgs(process.argv.slice(2), {
  flags: [],
  values: ['dir', 'base-ref', 'base-dir'],
  defaults: {
    dir: 'ct',
    'base-ref': process.env.PSN_BASE_REF || null,
    'base-dir': null,
  },
});

const cfg = config();
const dir = resolve(ROOT, args.dir);
const failures = new Failures(`ct(${args.dir})`);
const validate = schemaValidator('ct-segment.v1.json');

for (const stray of strayCtFiles(dir)) {
  failures.add(
    `${args.dir}/${stray}`,
    'is not a segment file. The log directory holds `{n}.json` segments and nothing else — `latest.json` is an EMITTED artifact (a copy of the open segment), not a source.'
  );
}

const segments = loadCt(dir);
if (segments.length === 0) {
  failures.add(
    `${args.dir}/`,
    'holds no segments. The v0 log is exactly one committed file, ct/0.json (FS08-113). An empty log is `"entries": []` in segment 0, not a missing directory.'
  );
  failures.finish('nothing to verify');
}

for (const s of segments) {
  for (const err of validate(s.data)) failures.add(`${args.dir}/${s.file}`, err);
}

const { headSeq, headSegment, entryCount } = verifyCt(segments, cfg, failures);

// ------------------------------------------------------------------------ append-only

const baseline = loadBaseline({ baseRef: args['base-ref'], baseDir: args['base-dir'] });

if (!baseline) {
  noteLine('append-only comparison SKIPPED (no baseline). Structural checks ran; the retro-edit guard did not.');
} else {
  noteLine(`append-only baseline: ${baseline.source} (${baseline.ctEntries.size} entr${baseline.ctEntries.size === 1 ? 'y' : 'ies'})`);
  const current = new Map();
  for (const s of segments) for (const e of s.data.entries || []) current.set(e.seq, e);

  assertAppendOnly({
    label: 'CT entry',
    baseline: baseline.ctEntries,
    current,
    failures,
    describe: {
      removedFix:
        'restore it. A revocation or status change is a NEW entry referencing the original hash (CERT-033); deleting the original would make every certificate issued around it unverifiable.',
      editedFix:
        'Revert the edit. The log never edits: status changes append a new entry whose `ref` is the original hash (CERT-033). Editing an entry silently invalidates every verification that already succeeded against it.',
    },
  });

  let baseHead = -1;
  for (const seq of baseline.ctEntries.keys()) baseHead = Math.max(baseHead, seq);
  for (const [seq] of current) {
    if (!baseline.ctEntries.has(seq) && seq <= baseHead) {
      failures.add(
        `CT entry ${seq}`,
        `is new but sits at or below the published head (seq ${baseHead}). Appends go to the end: the next free seq is ${baseHead + 1}.`
      );
    }
  }
}

failures.finish(
  entryCount === 0
    ? `log empty and well-formed — no certificate has been issued yet (${segments.length} segment(s))`
    : `${entryCount} entr${entryCount === 1 ? 'y' : 'ies'} across ${segments.length} segment(s); head seq ${headSeq} in segment ${headSegment}`
);
