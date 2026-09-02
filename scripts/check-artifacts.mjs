#!/usr/bin/env node
// Artifact-plane gate — the other end of index-build-lite.
//
//   node scripts/check-artifacts.mjs [--dir dist] [--expect-examples]
//                                    [--registry-dir registry]
//                                    [--ledger-dir ledger] [--ct-dir ct]
//
// THE POINT OF THIS SCRIPT IS THAT IT DOES NOT TRUST THE BUILD. It derives the expected
// artifact path set a SECOND time, straight from registry/ + ledger/ + ct/, and compares
// it to what is actually on disk. A bug that makes the build skip a repository would be
// invisible to a check that read the build's own manifest; it is not invisible to this
// one.
//
// Four assertions:
//   1. PATH GRAMMAR — every file in the output matches one of the FS-00 §6.2 path
//      patterns. An unexpected path means the plane grew a surface nobody reviewed.
//   2. SET EQUALITY — the emitted set equals the independently derived set: nothing
//      missing, nothing extra.
//   3. NO EXAMPLE LEAKAGE — no `example: true` entry's node_id, owner, or name appears
//      anywhere in the output bytes. This is the one that protects real people: a seeded
//      demo repository must never appear in a published registry as though it had adopted
//      the licence.
//   4. HONESTY INVARIANTS — the zero-state rules that make the plane publishable:
//      waivers are empty, no CHF figure appears while chfRoutedMinor is null, no impact
//      vocabulary appears anywhere, and every artifact carries schemaVersion+generatedAt.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { Failures, ROOT, config, die, parseArgs } from './lib/repo.mjs';
import {
  PUBLISHED_STATES,
  REGISTRY_DIR,
  examples as exampleEntries,
  loadRegistry,
  publishable,
  shardOf,
} from './lib/registry.mjs';
import { LEDGER_DIR, loadLedger } from './lib/ledger.mjs';
import { CT_DIR, loadCt } from './lib/ct.mjs';

const args = parseArgs(process.argv.slice(2), {
  flags: ['expect-examples'],
  values: ['dir', 'registry-dir', 'ledger-dir', 'ct-dir'],
  defaults: { dir: 'dist', 'registry-dir': null, 'ledger-dir': null, 'ct-dir': null },
});

const cfg = config();
const DIR = resolve(ROOT, args.dir);
const failures = new Failures(`artifacts(${args.dir})`);

let root;
try {
  root = statSync(DIR);
} catch {
  die(`${args.dir}/ does not exist — run \`npm run build\` first.`);
}
if (!root.isDirectory()) die(`${args.dir} is not a directory.`);

// ---------------------------------------------------------------- what is actually there

function walk(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, acc);
    else acc.push(relative(DIR, abs).split(sep).join('/'));
  }
  return acc;
}

const actual = walk(DIR);
if (actual.length === 0) die(`${args.dir}/ is empty.`);

// ------------------------------------------------------- what SHOULD be there (derived)

const loaded = loadRegistry(args['registry-dir'] ? resolve(ROOT, args['registry-dir']) : REGISTRY_DIR);
const entries = args['expect-examples']
  ? [...publishable(loaded), ...exampleEntries(loaded)]
  : publishable(loaded);
const listed = entries.filter((e) => PUBLISHED_STATES.includes(e.state));
const months = loadLedger(args['ledger-dir'] ? resolve(ROOT, args['ledger-dir']) : LEDGER_DIR);
const ct = loadCt(args['ct-dir'] ? resolve(ROOT, args['ct-dir']) : CT_DIR);

const expected = new Set(['registry/index/meta.json', 'registry.json', 'waivers/all.json', 'stats.json', 'ledger/chain.json', 'ct/latest.json', 'meta/publish-log.json']);

for (const shard of new Set(listed.map((e) => shardOf(e.name)))) {
  expected.add(`registry/index/${shard}.json`);
}
for (const e of listed) {
  expected.add(`registry/repo/${e.node_id}.json`);
  expected.add(`badge/${e.node_id}.json`);
  expected.add(`waivers/${e.node_id}.json`);
}
for (const m of months) {
  expected.add(`ledger/${m.month}.json`);
  expected.add(`ledger/${m.month}.csv`);
}
for (const s of ct) expected.add(`ct/${s.segment}.json`);

// ------------------------------------------------------------------ 1. the path grammar
//
// The FS-00 §6.2 catalog, as patterns. Anything the plane can legally contain is on this
// list; the list is deliberately narrow, because widening it is the moment to ask whether
// a new public surface was actually agreed.

const NODE_ID = '(?:R_[A-Za-z0-9_-]{6,118}|MDEwOlJlcG9zaXRvcnk[A-Za-z0-9+/=]{1,96})';
const GRAMMAR = [
  ['registry index shard', new RegExp(`^registry/index/[a-z0]\\.json$`)],
  ['registry index meta', /^registry\/index\/meta\.json$/],
  ['repo record', new RegExp(`^registry/repo/${NODE_ID}\\.json$`)],
  ['bulk registry export', /^registry\.json$/],
  ['badge', new RegExp(`^badge/${NODE_ID}\\.json$`)],
  ['waiver record', new RegExp(`^waivers/${NODE_ID}\\.json$`)],
  ['waiver registry', /^waivers\/all\.json$/],
  ['public counters', /^stats\.json$/],
  ['ledger month (json)', /^ledger\/\d{4}-(?:0[1-9]|1[0-2])\.json$/],
  ['ledger month (csv)', /^ledger\/\d{4}-(?:0[1-9]|1[0-2])\.csv$/],
  ['ledger chain', /^ledger\/chain\.json$/],
  ['ct segment', /^ct\/(?:0|[1-9]\d*)\.json$/],
  ['ct head', /^ct\/latest\.json$/],
  ['publish log', /^meta\/publish-log\.json$/],
];

for (const p of actual) {
  if (!GRAMMAR.some(([, re]) => re.test(p))) {
    failures.add(
      `${args.dir}/${p}`,
      'is not a path in the FS-00 §6.2 artifact catalog. The public data plane is a closed set of URLs; ' +
        'adding one is an FS-00 amendment, not a build change. Known shapes: ' +
        GRAMMAR.map(([n]) => n).join(', ') +
        '.'
    );
  }
}

// -------------------------------------------------------------------- 2. set equality

const actualSet = new Set(actual);
for (const want of [...expected].sort()) {
  if (!actualSet.has(want)) {
    failures.add(`${args.dir}/${want}`, 'expected from the committed sources but MISSING from the build.');
  }
}
for (const got of actual) {
  if (!expected.has(got)) {
    failures.add(`${args.dir}/${got}`, 'present in the build but NOT derivable from the committed sources.');
  }
}

// ------------------------------------------------------------ 3. no example leakage

if (!args['expect-examples']) {
  const exampleTokens = [];
  for (const e of exampleEntries(loaded)) {
    exampleTokens.push(e.node_id, `${e.owner}/${e.name}`, e.license.text_sha256);
    for (const login of (e.contacts && e.contacts.admin_logins) || []) exampleTokens.push(login);
  }
  if (exampleTokens.length === 0) {
    failures.add(
      'registry/',
      'there are no `example: true` entries, so the leakage check has nothing to look for and would pass vacuously. ' +
        'Seeded examples are required — see scripts/validate-registry.mjs.'
    );
  }
  for (const p of actual) {
    const text = readFileSync(join(DIR, p), 'utf8');
    for (const token of exampleTokens) {
      if (token && text.includes(token)) {
        failures.add(
          `${args.dir}/${p}`,
          `contains "${token}", which belongs to a seeded \`example: true\` entry. ` +
            'Example entries are demonstration data and must never appear in a published artifact — a published ' +
            'registry entry is a public statement that a real repository adopted the licence.'
        );
      }
    }
  }
}

// ---------------------------------------------------------- 4. honesty invariants

// Impact vocabulary. Impact certificates and impact figures are Phase E+ and never exist
// before the first disbursed ledger row (NEV-017, D21, VS-30). A grep cannot police
// prose, but it can prove these words are absent from a machine plane that has no
// business carrying them.
const IMPACT_WORDS = /\b(impact certificate|impact figure|charity produced|lives saved|tonnes? of CO2)\b/i;

const statsPath = join(DIR, 'stats.json');
let stats = null;
try {
  stats = JSON.parse(readFileSync(statsPath, 'utf8'));
} catch {
  failures.add(`${args.dir}/stats.json`, 'missing or unreadable — every build publishes public counters.');
}

for (const p of actual) {
  const text = readFileSync(join(DIR, p), 'utf8');

  if (IMPACT_WORDS.test(text)) {
    failures.add(`${args.dir}/${p}`, `carries impact vocabulary (${IMPACT_WORDS.exec(text)[0]}). Impact claims are Phase E+ and never precede a disbursed ledger row (D21).`);
  }

  if (p.endsWith('.json')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      failures.add(`${args.dir}/${p}`, `is not valid JSON — ${err.message}`);
      continue;
    }
    // FS-00 §6.2: every artifact carries schemaVersion and generatedAt. There are exactly
    // TWO documented exceptions, both because another specification owns the body:
    //
    //   ct/*.json — the shape is FS08-111's, which carries schemaVersion and deliberately
    //     no generatedAt. A CT segment is immutable and its bytes are hashed by the next
    //     segment, so a regeneration timestamp inside it would break the segment chain.
    //
    //   badge/*.json — the body is the shields.io ENDPOINT schema, and FS10-030 is
    //     byte-authoritative for it. Its `schemaVersion: 1` is shields' own required
    //     constant, not this plane's artifact version, and shields validates the object it
    //     receives — so the four fields are the whole body and nothing is added to it. The
    //     badge's freshness lives in `cacheSeconds` and the edge cache headers (INF-15),
    //     which is where a badge consumer actually looks.
    if (parsed.schemaVersion === undefined) {
      failures.add(`${args.dir}/${p}`, 'has no `schemaVersion` (FS-00 §6.2 requires it on every artifact).');
    }
    const ctSegment = /^ct\//.test(p);
    const badge = /^badge\//.test(p);
    if (!ctSegment && !badge && parsed.generatedAt === undefined) {
      failures.add(`${args.dir}/${p}`, 'has no `generatedAt` (FS-00 §6.2 requires it on every artifact).');
    }
    if (ctSegment && parsed.generatedAt !== undefined) {
      failures.add(
        `${args.dir}/${p}`,
        'carries `generatedAt`. A CT segment is immutable and its bytes are hashed by the next segment; ' +
          'a regeneration timestamp inside it would break the segment chain (FS08-111/FS08-135).'
      );
    }
    if (badge && parsed.generatedAt !== undefined) {
      failures.add(
        `${args.dir}/${p}`,
        'carries `generatedAt`. A badge body is the shields.io endpoint object (FS10-030) and shields validates what it receives; ' +
          "keep it to label/message/color/cacheSeconds plus shields' own schemaVersion."
      );
    }
    if (!ctSegment && parsed.generatedAt !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(parsed.generatedAt)) {
      failures.add(`${args.dir}/${p}`, `generatedAt "${parsed.generatedAt}" is not the fixed UTC second-precision form — determinism depends on it.`);
    }

    if (/^waivers\//.test(p)) {
      if (!Array.isArray(parsed.waivers) || parsed.waivers.length !== 0) {
        failures.add(
          `${args.dir}/${p}`,
          'publishes a non-empty waiver list. Waivers cannot exist before the Phase E claim flow (D14) and can never enter the registry by PR (FS02-060).'
        );
      }
    }

    if (/^registry\/repo\//.test(p) && parsed.stats !== undefined) {
      failures.add(
        `${args.dir}/${p}`,
        'carries a `stats` block. VS-18 has no statistics block on a project record: attribution and charity figures are Phase E+, so a zero would be theatre.'
      );
    }
  }
}

// Cross-artifact honesty: no CHF amount may be rendered anywhere while the ledger has
// routed nothing. `chfRoutedMinor: null` is the fact; a stray figure would contradict it.
if (stats && stats.chfRoutedMinor === null) {
  const CHF_FIGURE = /\bCHF[\s ]*[0-9]/i;
  for (const p of actual) {
    const text = readFileSync(join(DIR, p), 'utf8');
    if (CHF_FIGURE.test(text)) {
      failures.add(
        `${args.dir}/${p}`,
        `renders a CHF figure (${CHF_FIGURE.exec(text)[0].trim()}) while stats.json reports chfRoutedMinor: null. ` +
          'No money figure may appear on any surface before a real disbursed row exists (D21, VS-18).'
      );
    }
  }
}

if (stats) {
  const preLaunch = stats.state === 'pre-launch';
  if (preLaunch) {
    for (const k of ['projectsRegistered', 'companiesCovered', 'chfRoutedMinor', 'detectedUnclaimed']) {
      if (stats[k] !== null) {
        failures.add(
          `${args.dir}/stats.json`,
          `state is \`pre-launch\` but ${k} is ${JSON.stringify(stats[k])}. At pre-launch every numeric field is null (VS-19): a zero reads as an achievement or an embarrassment, a null reads as "not yet".`
        );
      }
    }
  }
  if (stats.contributorsClaimed !== null) {
    failures.add(
      `${args.dir}/stats.json`,
      'contributorsClaimed must be null at v0: there is no contributor claim flow before Phase E, so the number is structurally unknowable rather than zero (VS-19).'
    );
  }
  if (!['pre-launch', 'launched-pre-disbursement', 'post-first-franc'].includes(stats.state)) {
    failures.add(`${args.dir}/stats.json`, `state "${stats.state}" is not one of the three machine states (FS-10 §10).`);
  }
}

// A build with nothing published is the CORRECT pre-launch state, but it also makes most
// of the checks above vacuous, so say so out loud rather than reporting a confident pass.
const vacuous = listed.length === 0;
failures.finish(
  `${actual.length} artifact(s), ${listed.length} listed repo(s), ${months.length} ledger month(s), ${ct.length} CT segment(s)` +
    (vacuous
      ? ' — NOTE: no repository is published yet, so the per-repo assertions had nothing to inspect. ' +
        `The per-repo shapes are covered by the demo build (npm run check:artifacts:demo) and by tests/index-build.test.mjs.`
      : '') +
    ` [org=${cfg.org}]`
);
