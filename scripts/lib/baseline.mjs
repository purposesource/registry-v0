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
//
// AND THREE OUTCOMES, KEPT APART. A baseline that was never asked for is a skip; a
// baseline that was asked for and did not arrive is a FAILURE. Collapsing the two — which
// is what returning `null` for both did — is how this guard came to report success on
// every push of a republished history without ever comparing anything: the publish rewrites
// commit messages and strips private paths, so the pre-push sha a push event names does not
// exist in the republished repository, the loader said so in one line, and the job went
// green. See `usableBaseline()` for the rule each outcome earns.

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
    // `--full-name` is load-bearing, not tidiness. Without it `ls-tree` prints paths
    // relative to the CWD, while `git show <rev>:<path>` always resolves from the
    // repository root — so whenever this repository is a SUBDIRECTORY of the git
    // repository holding it (which is how it is developed), every listed file was named
    // one way and read another, `showAt` returned null for all of them, and the baseline
    // came out silently EMPTY: a guard comparing against nothing, reporting a pass. The
    // pathspec stays CWD-relative on purpose — it means this repository's own tree.
    out = git(['ls-tree', '-r', '--name-only', '--full-name', rev, '--', `${dir}/`]);
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

// The three states a baseline can be in. They are kept APART on purpose: for years the
// loader collapsed all three onto `null`, so "nobody asked for a comparison" and "somebody
// asked and it did not happen" produced the same green run and the same log line. The
// second of those is the one outcome append-only enforcement cannot survive, and it needs
// its own name to be enforceable.
export const NOT_ASKED = 'not-asked';
export const UNRESOLVABLE = 'unresolvable';
export const READY = 'ready';

/**
 * Reads the baseline and reports WHICH of the three states applies:
 *
 *   `{ state: NOT_ASKED }`
 *       no `--base-ref` and no `--base-dir`. Nobody asked for the comparison.
 *   `{ state: UNRESOLVABLE, ref }`
 *       a revision was named and is not in this checkout. Somebody asked and the
 *       comparison cannot happen.
 *   `{ state: READY, ledgerRows, ctEntries, trees, source }`
 *       a usable baseline. `trees` says whether the baseline actually CONTAINS each
 *       tree (`{ ledger: boolean, ct: boolean }`) — a revision that predates a tree, or a
 *       path that is wrong for this checkout, yields an empty map, and an empty baseline
 *       makes every comparison below vacuously true. The caller has to know the difference
 *       between "compared against nothing published yet" and "compared against nothing at
 *       all"; `usableBaseline()` below is where that judgement lives.
 *
 * Never returns null and never decides policy: deciding is the caller's, through
 * `usableBaseline()`, so both gates decide the same way.
 */
export function loadBaseline({ baseRef, baseDir }) {
  if (baseDir) {
    const abs = join(ROOT, baseDir);
    if (!existsSync(abs)) die(`--base-dir ${baseDir} does not exist.`);
    const ledgerRows = new Map();
    const months = loadLedger(join(abs, 'ledger'));
    for (const m of months) {
      for (const row of m.data.rows || []) ledgerRows.set(row.seq, row);
    }
    const ctEntries = new Map();
    const segments = loadCt(join(abs, 'ct'));
    for (const s of segments) {
      for (const e of s.data.entries || []) ctEntries.set(e.seq, e);
    }
    return {
      state: READY,
      ledgerRows,
      ctEntries,
      trees: { ledger: months.length > 0, ct: segments.length > 0 },
      source: `--base-dir ${baseDir}`,
    };
  }

  if (!baseRef) return { state: NOT_ASKED };

  const sha = resolveRef(baseRef);
  if (!sha) return { state: UNRESOLVABLE, ref: baseRef };

  // Files MATCHING the artifact's own filename grammar, not just any file under the
  // directory: `ledger/README.md` at the base revision would prove the directory existed
  // and prove nothing about the rows, and it is the rows the guard compares.
  const readTree = (dir, pattern, collect) => {
    let matched = 0;
    for (const path of filesAt(sha, dir)) {
      if (!pattern.test(path)) continue;
      matched++;
      const text = showAt(sha, path);
      if (text === null) {
        // git listed the blob and then could not show it. Skipping it would shrink the
        // baseline silently, and a row missing from the baseline is a row whose removal
        // nothing would notice — the exact failure this module exists to prevent.
        die(`${path} at ${baseRef} is listed at that revision but cannot be read — the baseline itself is unusable.`);
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        die(`${path} at ${baseRef} is not valid JSON — the baseline itself is unusable.`);
      }
      collect(parsed);
    }
    return matched;
  };

  const ledgerRows = new Map();
  const ledgerFiles = readTree('ledger', /\/\d{4}-\d{2}\.json$/, (parsed) => {
    for (const row of parsed.rows || []) ledgerRows.set(row.seq, row);
  });

  const ctEntries = new Map();
  const ctFiles = readTree('ct', /\/\d+\.json$/, (parsed) => {
    for (const e of parsed.entries || []) ctEntries.set(e.seq, e);
  });

  return {
    state: READY,
    ledgerRows,
    ctEntries,
    trees: { ledger: ledgerFiles > 0, ct: ctFiles > 0 },
    source: `${baseRef} (${sha.slice(0, 12)})`,
  };
}

/**
 * Turns a baseline state into the gate's decision, and prints the reason.
 *
 * Returns the baseline when the comparison can run, or null when it cannot — and in the
 * null case it has ALREADY either printed an honest note or recorded a failure, so the
 * caller has exactly one branch and no way to pass silently.
 *
 * The rule, which is the whole point of this function:
 *
 *   NOT_ASKED                  -> note, and PASS. Nobody asked. This is a developer
 *                                 running the chain checks on a laptop, and it is the only
 *                                 state in which a skip is honest.
 *   UNRESOLVABLE               -> FAIL. Naming a baseline IS asking for the comparison.
 *                                 Reporting success without having done it is a false
 *                                 green on the only mechanical enforcement the append-only
 *                                 law has (VS-28, VS-36), and the log line saying so is
 *                                 not a substitute for a red run — nobody reads the log of
 *                                 a green job.
 *   READY but the tree is absent, and there IS something here
 *                              -> FAIL. Every row counts as new, nothing is compared, and
 *                                 the log reads `append-only baseline: <sha>` as if the
 *                                 guard had run. That is worse than the announced skip.
 *   READY but the tree is absent, and there is nothing here either
 *                              -> note, and PASS. Nothing exists that could have been
 *                                 removed or edited; say so rather than implying a
 *                                 comparison happened.
 */
export function usableBaseline({ baseline, tree, currentCount, failures, skipNote }) {
  if (baseline.state === UNRESOLVABLE) {
    failures.add(
      `append-only baseline "${baseline.ref}"`,
      'was named and does not resolve in this checkout, so the retro-edit guard did NOT run. ' +
        'This is a failure and not a skip: naming a baseline is asking for the comparison, and a gate that reports ' +
        'success without doing it is exactly the false green the append-only law cannot survive (VS-28, VS-36). ' +
        'Either the base commit was never fetched (fetch-depth), or it belongs to a history that has since been ' +
        'rewritten and no longer exists here — a republished repository gets new shas on every publish, so the ' +
        'pre-push tip a push event names is routinely gone. Name a revision this checkout HAS (`HEAD^` is one), or ' +
        'compare against an unpacked published copy with `--base-dir`.'
    );
    return null;
  }

  if (baseline.state === NOT_ASKED) {
    noteLine(skipNote);
    return null;
  }

  if (!baseline.trees[tree]) {
    const unit = tree === 'ledger' ? 'ledger month file' : 'log segment';
    if (currentCount > 0) {
      failures.add(
        `append-only baseline ${baseline.source}`,
        `resolves but holds no ${unit} at all, while ${currentCount} ${currentCount === 1 ? 'record is' : 'records are'} ` +
          `committed under \`${tree}/\` here. Every one of them therefore counts as NEW, nothing was compared, and the ` +
          'run would have passed while printing a baseline line that reads as if the guard had run — a vacuous pass is ' +
          'worse than an announced skip. Either the revision predates the tree (name a later one) or the path is wrong ' +
          'for this checkout.'
      );
      return null;
    }
    noteLine(
      `append-only comparison had nothing to compare: baseline ${baseline.source} holds no ${unit}, and nothing is ` +
        `committed under \`${tree}/\` here either — there is no published record that could have been removed or edited.`
    );
    return null;
  }

  return baseline;
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
