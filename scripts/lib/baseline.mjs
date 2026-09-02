// Append-only enforcement needs a BEFORE picture, and a hash chain alone cannot supply
// one.
//
// This is the subtle half of "append-only", so it is worth being explicit about. The
// FS-07 §5.2 chain proves that a set of rows is internally consistent. It does NOT prove
// that the set is a superset of what was published yesterday: someone who edits a row and
// then recomputes every subsequent hash produces a perfectly valid chain over rewritten
// history. Detecting THAT requires comparing against a copy of the log that the editor
// did not control — which is exactly what VS-28 and VS-36 mean by "CI guard rejects any
// diff that edits or deletes an existing entry", and why CERT-032 wants the log in an
// independent medium.
//
// At v0 the independent medium is git history. This module reads the ledger and CT trees
// as they existed at a base revision so the verify scripts can assert that every row and
// every entry present then is still present now, byte-identical, at the same position.
//
// Two sources, one shape:
//   --base-ref <rev>   read the trees out of git (what CI uses)
//   --base-dir <path>  read them from a directory (what the tests use, and what a human
//                      can use against an unpacked archive of a published release)

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, die, noteLine } from './repo.mjs';
import { jcs } from './jcs.mjs';
import { loadLedger } from './ledger.mjs';
import { loadCt } from './ct.mjs';

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Resolves a revision to a commit sha, or null when it does not exist here. */
export function resolveRef(rev) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).trim() || null;
  } catch {
    return null;
  }
}

function filesAt(rev, dir) {
  let out;
  try {
    out = git(['ls-tree', '-r', '--name-only', rev, '--', `${dir}/`]);
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function showAt(rev, path) {
  try {
    return git(['show', `${rev}:${path}`]);
  } catch {
    return null;
  }
}

/**
 * The baseline as `{ ledgerRows: Map<seq, row>, ctEntries: Map<seq, entry>, source }`,
 * or null when no baseline is available (a repository whose first commit is being made,
 * or a shallow clone whose base is not fetched).
 *
 * A null baseline is REPORTED, never silently treated as "nothing changed": the caller
 * prints why the comparison was skipped, so a CI log always says which half of the guard
 * ran.
 */
export function loadBaseline({ baseRef, baseDir }) {
  if (baseDir) {
    const abs = join(ROOT, baseDir);
    if (!existsSync(abs)) die(`--base-dir ${baseDir} does not exist.`);
    const ledgerRows = new Map();
    for (const m of loadLedger(join(abs, 'ledger'))) {
      for (const row of m.data.rows || []) ledgerRows.set(row.seq, row);
    }
    const ctEntries = new Map();
    for (const s of loadCt(join(abs, 'ct'))) {
      for (const e of s.data.entries || []) ctEntries.set(e.seq, e);
    }
    return { ledgerRows, ctEntries, source: `--base-dir ${baseDir}` };
  }

  if (!baseRef) return null;

  const sha = resolveRef(baseRef);
  if (!sha) {
    noteLine(
      `append-only baseline unavailable: "${baseRef}" does not resolve in this checkout. ` +
        'On a first commit that is expected; in CI on an existing branch it means the base ' +
        'commit was not fetched (fetch-depth) and the guard did not run.'
    );
    return null;
  }

  const ledgerRows = new Map();
  for (const path of filesAt(sha, 'ledger')) {
    if (!/\/\d{4}-\d{2}\.json$/.test(path)) continue;
    const text = showAt(sha, path);
    if (text === null) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      die(`${path} at ${baseRef} is not valid JSON — the baseline itself is unusable.`);
    }
    for (const row of parsed.rows || []) ledgerRows.set(row.seq, row);
  }

  const ctEntries = new Map();
  for (const path of filesAt(sha, 'ct')) {
    if (!/\/\d+\.json$/.test(path)) continue;
    const text = showAt(sha, path);
    if (text === null) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      die(`${path} at ${baseRef} is not valid JSON — the baseline itself is unusable.`);
    }
    for (const e of parsed.entries || []) ctEntries.set(e.seq, e);
  }

  return { ledgerRows, ctEntries, source: `${baseRef} (${sha.slice(0, 12)})` };
}

/**
 * Compares a baseline map against the current one, keyed by seq.
 *
 * Reports three distinct wrongs with three distinct messages, because they are three
 * different mistakes with three different fixes:
 *   REMOVED  — a position that existed is gone.
 *   CHANGED  — a position exists but its content differs.
 *   REORDERED is not a separate case: it surfaces as CHANGED at both positions.
 */
export function assertAppendOnly({ label, baseline, current, failures, describe }) {
  for (const [seq, before] of baseline) {
    const after = current.get(seq);
    if (after === undefined) {
      failures.add(
        `${label} ${seq}`,
        `was published and has been REMOVED. ${label} entries are append-only forever — ${describe.removedFix}`
      );
      continue;
    }
    // Canonical comparison, not JSON.stringify: an added or removed key must count as
    // an edit, and key order in the file must not. jcs() gives both properties.
    if (jcs(before) !== jcs(after)) {
      failures.add(
        `${label} ${seq}`,
        `was published and has been EDITED. ${describe.editedFix}`
      );
    }
  }
}
