#!/usr/bin/env node
// Copy gate — the hard bans, applied to the prose this repository ships.
//
//   node scripts/check-copy.mjs
//
// THE CANONICAL PATTERN FILE DOES NOT LIVE HERE. FS-00 §2 places it in {ORG}/website at
// `copy-lint/banned.txt` (MKT-018), and there must be exactly one canon. This script is a
// deliberately small vendored subset covering the bans that could plausibly be tripped by
// a data repository's README, CONTRIBUTING, PR template, and schema descriptions. When
// {ORG}/website publishes the canonical list, replace the PATTERNS table below with a
// pinned copy of that file (the way the reference site pins its SKU fixture by SHA-256)
// rather than maintaining a second list.
//
// WHAT A GREP CANNOT DO. MARKETING §1 rule 2 permits copy to MENTION open source as the
// predecessor while forbidding it as a self-description. No regular expression can tell
// those apart, so this gate bans only the specific self-descriptive constructions the
// record enumerates, and a human reviews the rest. A gate that tried to ban the phrase
// outright would be turned off within a week, which is worse than a narrow gate that
// stays on.
//
// SELF-EXCLUSION. This file necessarily contains every banned string, so it excludes
// itself from its own scan. That is the same carve-out the reference site's naming gate
// makes for its dated internal record, and for the same reason: a gate cannot be its own
// counter-example.
//
// PROBE MODE. `--probe <file>` scans exactly that one file and nothing else. It exists for
// tests/check-copy.test.mjs, which feeds the gate the forbidden shortenings it must catch
// and the permitted sentence it must not — counter-examples that cannot live anywhere the
// gate reads (the tests directory is scanned), so the test writes them to a temp file at
// run time. The vacuous-scan guard does not apply to a probe: one file is the point.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { Failures, ROOT, parseArgs } from './lib/repo.mjs';

const args = parseArgs(process.argv.slice(2), { flags: [], values: ['probe'], defaults: { probe: null } });
const failures = new Failures('copy');

const SCAN_DIRS = ['.github', 'config', 'schema', 'scripts', 'registry', 'ledger', 'ct', 'tests'];
const SCAN_FILES = ['README.md', 'CONTRIBUTING.md', 'LICENSE-DATA', 'package.json'];
// Text this repository ships. LICENSE-DATA has no extension, hence the alternative.
const SCAN_EXT = /(\.(md|mjs|js|json|yml|yaml|txt)|LICENSE-DATA)$/;

// Files that must not be scanned, with the reason each is exempt.
const EXCLUDE = new Set([
  // A gate cannot be its own counter-example.
  'scripts/check-copy.mjs',
]);

const PATTERNS = [
  {
    re: /\brabten\b/i,
    why: 'This venture is separate from the operator\'s other work and nothing here may name it (D2 resource firewall).',
  },
  {
    re: /\bstiftung\b/i,
    why: 'The entity is an association (Verein), not a foundation; the word implies a legal form that does not exist.',
  },
  {
    re: /\bnobody profits\b/i,
    why: 'Never utter: processors, intermediaries, contractors and any future staff are paid. The canonical form is "No distributable private profit — structurally, not by policy. The direct costs charged to Purpose Fees are capped and published to the invoice, and any cost support is listed by name." (MARKETING §3 as amended by D29, 2026-09-05)',
  },
  {
    re: /every (?:franc|dollar|euro) (?:traceable|visible)/i,
    why: 'Never utter: the bank and intermediary legs cannot be publicly proven end to end. The canonical form is "every recorded allocation and disbursement is independently reconcilable".',
  },
  {
    // "100% to charity", "100% of profits go to charity", "100 % of profit goes to charity":
    // the shortening D29 §6.2 forbids by name. At most one noun (optionally preceded by
    // "of" / "the") between the percentage and the verb, the verb "go" or "goes" or absent
    // — an earlier "goes" matched only the singular, so the plural sentence slipped past.
    // The permitted §6.2 sentence, whose qualifier sits between the noun and "goes to
    // charity", stays unmatched; tests/check-copy.test.mjs pins both sides.
    re: /100\s*%\s*(?:(?:of\s+)?(?:the\s+)?\w+\s+)?(?:go(?:es)?\s+)?to\s+charit/i,
    why: 'Uncapped "100% to charity" is banned: the direct costs charged to Purpose Fees are capped and published to the invoice, and any cost support is listed by name (MARKETING §3 as amended by D29, 2026-09-05). State that mechanism instead.',
  },
  {
    re: /\bno CLA\b/i,
    why: 'Never promise: the contribution instrument is counsel-confirmed and its final form is not ours to pre-guarantee. The permanent promise is "no copyright assignment, ever".',
  },
  {
    re: /amnesty on purchase/i,
    why: 'Scope it: the steward and steward-of-record covenants are automatic, a total past-use release needs the opt-in mandate pool. Use "amnesty covenants".',
  },
  {
    re: /open[- ]source(?:,)? with purpose/i,
    why: 'Self-descriptive use of "open source" is banned (D5/D25). "Open Code. With Purpose." is the philosophy line.',
  },
  {
    re: /the open[- ]source experience/i,
    why: 'Self-descriptive use of "open source" is banned (D5/D25).',
  },
  {
    re: /open source (?:on|with) purpose/i,
    why: 'Rejected name form (D25); also a live collision with an existing publication.',
  },
  {
    re: /\bthis (?:is|repo(?:sitory)? is) (?:an )?open[- ]source\b/i,
    why: 'Never self-describe as open source (D5). Mentioning open source as the predecessor is fine; being it is not what this is.',
  },
];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name.startsWith('.git')) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, acc);
    else acc.push(abs);
  }
  return acc;
}

const targets = [];
if (args.probe) {
  targets.push(resolve(ROOT, args.probe));
} else {
  for (const d of SCAN_DIRS) {
    try {
      if (statSync(join(ROOT, d)).isDirectory()) targets.push(...walk(join(ROOT, d)));
    } catch {
      /* a directory that does not exist yet is not a copy problem */
    }
  }
  for (const f of SCAN_FILES) {
    try {
      if (statSync(join(ROOT, f)).isFile()) targets.push(join(ROOT, f));
    } catch {
      /* likewise */
    }
  }
}

let scanned = 0;
for (const abs of targets) {
  // A probe is reported by the path it was given; it usually lies outside the repository.
  const rel = args.probe ? args.probe : relative(ROOT, abs).split(sep).join('/');
  if (EXCLUDE.has(rel)) continue;
  if (!SCAN_EXT.test(rel)) continue;
  scanned++;
  const lines = readFileSync(abs, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { re, why } of PATTERNS) {
      const hit = re.exec(line);
      if (hit) failures.add(`${rel}:${i + 1}`, `banned copy "${hit[0].trim()}" — ${why}`);
    }
  });
}

// A gate that scans nothing passes forever. Same guard the reference site puts on its
// link check and its third-party-tag check.
if (!args.probe && scanned < 10) {
  failures.add('scripts/check-copy.mjs', `only ${scanned} file(s) were scanned — the target list is broken and this gate would pass vacuously.`);
}

failures.finish(`${scanned} file(s) scanned, ${PATTERNS.length} pattern(s) clean`);
