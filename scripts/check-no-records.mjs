#!/usr/bin/env node
// Gate: the private recording store may never appear in this repository.
//
//   node scripts/check-no-records.mjs [--root <dir>]
//
// The Association keeps one private evidence store: rail transaction exports, the officer
// and buyer attestations made at checkout, sanctions-screening results, the terms version
// each buyer accepted, and an append-only log tying them to the artifacts that were
// published. It is classified P2-financial with P3-restricted elements, retained ten years,
// and its governing requirement is one sentence long: NEVER IN PUBLIC REPOSITORIES. This
// repository is public today.
//
// It is also the repository whose whole job is committed data, which is exactly why the
// distinction has to be mechanical here. What this repository commits is P0-public by
// construction — registry records, the ledger, the transparency log, whose entries carry a
// hash, a type code, a kind, a ref and a timestamp and nothing else. The private store is
// the counterpart that keeps that true. A recording log dropped in beside a ledger month
// would look, to a tired reviewer, like one more data file.
//
// WHAT THIS IS NOT. It is not a content scanner. It matches PATH SHAPES, because that is how
// the store actually arrives somewhere it should not be — copied in as itself, by an
// operator moving a directory or a tool writing to the wrong root. Evidence pasted into the
// body of a markdown file is a different failure with a different remedy (a human reading a
// diff), and a gate that pretended to catch it would be trusted for something it cannot do.
//
// FOUR COPIES, DELIBERATELY. The same gate runs in all four of the organisation's
// publishable repositories — the website, the contracts, this one and the licence. They
// publish separately and none may import from another, so the shared core below is
// duplicated verbatim in all four and is meant to diff clean. The plumbing around it is each
// repository's own, which is the part that legitimately differs.
//
// NOT A GITIGNORE RULE, deliberately: an ignore entry would hide a copied store from
// `git status`, which is the moment it most needs to be visible.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Failures, ROOT, die } from './lib/repo.mjs';

/* ------------------------------------------------------------------- the three rules */
/* ==== SHARED CORE — byte-identical in all four repositories. Keep it that way. ==== */

const lower = (s) => s.toLowerCase();

const RULES = [
  {
    id: 'records-path',
    hit: (segments) => segments.some((s) => lower(s) === 'records'),
    why:
      'a `records` path. The recording store is the private ops area\'s records/ directory ' +
      'and lives there — nowhere else. The word is reserved in this repository so that a ' +
      'copy of the store cannot arrive quietly; if this directory is not evidence, rename it.',
  },
  {
    id: 'paddle-export',
    hit: (segments) =>
      segments.length >= 2 &&
      lower(segments[segments.length - 2]) === 'paddle' &&
      lower(segments[segments.length - 1]).endsWith('.json'),
    why:
      'a transaction export under a `paddle/` directory. A rail export carries the buyer ' +
      'identity, the amount and the tax document references verbatim; it belongs in the ' +
      'private store and in no repository that is, or becomes, public.',
  },
  {
    id: 'recording-log',
    hit: (segments) => lower(segments[segments.length - 1]) === 'log.jsonl',
    why:
      'the recording log by name. log.jsonl is the private store\'s append-only case log; a ' +
      'copy here would publish every case id, transaction id and screening outcome it holds.',
  },
];

/**
 * Walks `root` and returns every path a rule matches, plus how many entries were looked at.
 *
 * A matched DIRECTORY is reported once and not descended into: one mistake should produce
 * one line that says what to do, not two hundred that bury it. Symlinks are not followed —
 * `isDirectory()` is false for them, so a link into the store is reported as a file rather
 * than walked, which is the safe way round.
 */
function scan(root, skip) {
  const findings = [];
  const top = [];
  let visited = 0;

  const walk = (absDir, segments) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable is not a finding; a gate is not a permissions audit
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = [...segments, entry.name];
      if (segments.length === 0) top.push(entry.name);
      const isDir = entry.isDirectory();
      visited += 1;
      const rule = RULES.find((r) => r.hit(path));
      if (rule) {
        findings.push({ rel: isDir ? `${path.join('/')}/` : path.join('/'), id: rule.id, why: rule.why });
        continue;
      }
      if (isDir && !skip(path.join('/'), entry.name)) walk(join(absDir, entry.name), path);
    }
  };

  walk(root, []);
  return { findings, visited, top };
}

/**
 * ANTI-INERTIA, second half. selfTest() proves the matcher can fail; this proves the walk
 * reached THIS repository rather than an empty directory, a wrong root, or a tree the skip
 * list ate. A landmark check beats a file count: a count has to be tuned per repository and
 * goes stale every time the tree grows or shrinks, while a repository that has lost its own
 * top-level landmarks is broken in a way no threshold should paper over.
 */
function missingLandmarks(top, landmarks) {
  const seen = new Set(top);
  return landmarks.filter((name) => !seen.has(name));
}

/**
 * ANTI-INERTIA. A gate that cannot fail is worse than no gate, so before looking at a single
 * project path this plants the exact thing the gate exists to catch — `records/x.json` — in
 * a throwaway directory, along with a rail export, a recording log, and three near misses
 * that must NOT match. It asserts the WHOLE result rather than "something was found": a rule
 * that started matching `recordings/` would fail here rather than in someone's pull request.
 *
 * Returns null when the matcher behaved, or the sentence to print when it did not. The
 * planted tree is removed in a `finally`, so a failure still cleans up after itself.
 */
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'psn-no-records-'));
  try {
    mkdirSync(join(dir, 'records'), { recursive: true });
    writeFileSync(join(dir, 'records', 'x.json'), '{}\n');
    mkdirSync(join(dir, 'evidence', 'paddle'), { recursive: true });
    writeFileSync(join(dir, 'evidence', 'paddle', 'txn_01.json'), '{}\n');
    writeFileSync(join(dir, 'log.jsonl'), '{}\n');
    // Near misses. Each is a legitimate name this gate must leave alone.
    mkdirSync(join(dir, 'recordings'), { recursive: true });
    writeFileSync(join(dir, 'recordings', 'note.md'), 'x\n');
    writeFileSync(join(dir, 'paddle-notes.md'), 'x\n');
    writeFileSync(join(dir, 'log.json'), '{}\n');

    const got = scan(dir, () => false)
      .findings.map((f) => `${f.id} ${f.rel}`)
      .sort()
      .join(' | ');
    const want =
      'paddle-export evidence/paddle/txn_01.json | recording-log log.jsonl | records-path records/';
    return got === want
      ? null
      : `SELF-TEST FAILED — the matcher found [${got}] but must find [${want}]. Fix the rules ` +
          'before trusting this gate: it is inert until this passes.';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `--root <dir>` — scan a different tree. Used by this gate's tests; never by CI. */
function rootArgument(argv, onError) {
  const i = argv.indexOf('--root');
  if (i === -1) return null;
  if (argv[i + 1] === undefined) onError('--root needs a directory.');
  return resolve(argv[i + 1]);
}

/* ==== END SHARED CORE ==== */

/* --------------------------------------------------------------------- this repository */

const failures = new Failures('no-records');

const selfTestFailure = selfTest();
if (selfTestFailure) die(`check-no-records: ${selfTestFailure}`);

const root = rootArgument(process.argv.slice(2), (m) => die(`check-no-records: ${m}`));

// Skipped, with the reason each is skipped. `spec` and `.vendor-check` are CI's checkouts
// of the PUBLIC contract repository, mounted so the schema gate and the vendored-file
// comparison read the contracts as published rather than as copied. They are another
// repository: this gate speaks for this one, and that one runs the same gate on itself.
// `.tmp-*` are the throwaway workspaces the guard tests build under this root; an
// interrupted run is what leaves one behind, and it is not this gate's business.
const skip = (rel, name) =>
  name === '.git' ||
  name === 'node_modules' ||
  name.startsWith('.tmp-') ||
  rel === 'spec' ||
  rel === '.vendor-check';

const { findings, visited, top } = scan(root ?? ROOT, skip);

for (const f of findings) {
  failures.add(
    f.rel,
    `${f.why} The store is never in a repository that is or becomes public; move it to the ` +
      'private ops records area and remove it here.',
  );
}

if (!root) {
  const missing = missingLandmarks(top, ['package.json', 'registry', 'schema', 'scripts']);
  if (missing.length > 0) {
    failures.add(
      'scripts/check-no-records.mjs',
      `the walk never reached ${missing.join(', ')} — it is not scanning this repository, and ` +
        'this gate would pass vacuously.',
    );
  }
}

failures.finish(`${visited} path(s) walked, none from the private recording store`);
