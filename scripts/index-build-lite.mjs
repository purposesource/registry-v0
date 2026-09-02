#!/usr/bin/env node
// index-build-lite — the v0 bridge from curated sources to the public artifact plane.
//
//   node scripts/index-build-lite.mjs [--out dist] [--include-examples]
//                                     [--registry-dir registry]
//                                     [--ledger-dir ledger] [--ct-dir ct]
//
// WHAT IT IS. FS-00 §6.10 makes P-M2 deliberately serverless-static: no `pg`, no `api`,
// no `jobs.index-build`. This script is the stand-in — it reads the committed sources in
// this repository and emits the FS-00 §6.2 artifacts at EXACTLY the §6.2 paths, so that
// P-M3's migration to `pg` + `jobs.index-build` changes no URL (FS02-062/FS02-064).
//
// WHAT IT IS NOT. It is not a publisher. It writes a directory; a deploy publishes it.
// And it is not a source of facts: every number it emits is derived from registry/,
// ledger/ or ct/. There is no code path here that can invent a count, a figure, or a
// state — which is the mechanical form of D21, "nothing claimed before it's real".
//
// DETERMINISM (VS-04's reviewable diffs, FS02-084's "ETags change only on changed
// files"):
//   * `generatedAt` comes from GENERATED_AT or the HEAD commit date, never the clock
//     (see generatedAt() in lib/repo.mjs — it hard-fails rather than guessing).
//   * every object is built with its keys inserted in a fixed order and serialised by
//     writeArtifact() as two-space JSON with a trailing newline.
//   * every collection is sorted by an explicit comparator; nothing depends on
//     filesystem enumeration order.
//   Two runs over identical sources therefore produce byte-identical output, which
//   tests/index-build.test.mjs asserts by running it twice.
//
// EXAMPLES ARE NEVER PUBLISHED. Entries marked `example: true` are excluded unless
// --include-examples is passed, which no publishing path passes. scripts/check-artifacts.mjs
// fails the build if an example identifier appears anywhere in the default output.

import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  ROOT,
  config,
  die,
  generatedAt,
  noteLine,
  parseArgs,
  writeArtifact,
  writeTextArtifact,
} from './lib/repo.mjs';
import {
  ALL_SHARDS,
  NEUTRAL_BADGE_STATES,
  PUBLISHED_STATES,
  REGISTRY_DIR,
  byOwnerName,
  conversionDate,
  examples as exampleEntries,
  loadRegistry,
  publishable,
  shardOf,
} from './lib/registry.mjs';
import { LEDGER_DIR, flatRows, loadLedger, monthDigest } from './lib/ledger.mjs';
import { CT_DIR, loadCt } from './lib/ct.mjs';

const args = parseArgs(process.argv.slice(2), {
  flags: ['include-examples'],
  values: ['out', 'registry-dir', 'ledger-dir', 'ct-dir'],
  defaults: { out: 'dist', 'registry-dir': null, 'ledger-dir': null, 'ct-dir': null },
});

const cfg = config();
const now = generatedAt();
const OUT = resolve(ROOT, args.out);
const SV = cfg.artifactSchemaVersions;

if (OUT === ROOT) die('--out must be a subdirectory, not the repository root.');
rmSync(OUT, { recursive: true, force: true });

const ledgerDir = args['ledger-dir'] ? resolve(ROOT, args['ledger-dir']) : LEDGER_DIR;
const ctDir = args['ct-dir'] ? resolve(ROOT, args['ct-dir']) : CT_DIR;

const loaded = loadRegistry(args['registry-dir'] ? resolve(ROOT, args['registry-dir']) : REGISTRY_DIR);
const entries = args['include-examples']
  ? [...publishable(loaded), ...exampleEntries(loaded)].sort(byOwnerName)
  : publishable(loaded).sort(byOwnerName);

const months = loadLedger(ledgerDir);
const ctSegments = loadCt(ctDir);

/** Relative artifact paths this run wrote, for the manifest check to compare against. */
const written = [];

function emit(relPath, value) {
  writeArtifact(join(OUT, relPath), value);
  written.push(relPath);
}

function emitText(relPath, text) {
  writeTextArtifact(join(OUT, relPath), text);
  written.push(relPath);
}

// =============================================================== registry index + shards
//
// Shard by the first letter of `name` (FS02-062). Only shards that hold at least one
// listed repository are emitted, and `meta.json` names exactly the ones that exist —
// twenty-six empty files would be twenty-six artifacts asserting nothing.
//
// `detected` repositories are counted and never listed (GH-014, OPEN-33 default (a)):
// detection is a safety net, and a project that never claimed its registration has not
// agreed to appear on a page.

const listed = entries.filter((e) => PUBLISHED_STATES.includes(e.state));
const detected = entries.filter((e) => e.state === 'detected');

function indexRow(e) {
  return {
    nodeId: e.node_id,
    owner: e.owner,
    name: e.name,
    state: e.state,
    licenseVersion: e.license.version,
    adopted: e.license.adopted,
    weightClass: e.weight_class,
  };
}

const shardMembers = new Map();
for (const e of listed) {
  const s = shardOf(e.name);
  if (!shardMembers.has(s)) shardMembers.set(s, []);
  shardMembers.get(s).push(e);
}

const shardsPresent = ALL_SHARDS.filter((s) => shardMembers.has(s));

for (const shard of shardsPresent) {
  const rows = shardMembers.get(shard).sort(byOwnerName);
  emit(`registry/index/${shard}.json`, {
    schemaVersion: SV.registryIndexShard,
    generatedAt: now,
    shard,
    count: rows.length,
    repos: rows.map(indexRow),
  });
}

const stateCounts = {};
for (const s of ['detected', 'verified', 'suspended', 'quit', 'delisted']) {
  stateCounts[s] = entries.filter((e) => e.state === s).length;
}

emit('registry/index/meta.json', {
  schemaVersion: SV.registryIndexMeta,
  generatedAt: now,
  shardOn: 'name',
  shards: shardsPresent.map((s) => ({ shard: s, count: shardMembers.get(s).length })),
  counts: {
    listed: listed.length,
    detectedNotListed: detected.length,
    byState: stateCounts,
  },
  // Stated in the artifact rather than only in prose, so a machine consumer knows the
  // omission is by design and not an incomplete build.
  notes: [
    'Repositories in state `detected` are counted here and appear in no shard, no repo record, and no badge (GH-014).',
    'Shards are keyed by the first letter of the repository name, lowercased; names not starting a-z fall in shard `0`.',
  ],
});

// =============================================================== per-repo record + badge

for (const e of listed) {
  const neutral = NEUTRAL_BADGE_STATES.includes(e.state);

  emit(`registry/repo/${e.node_id}.json`, {
    schemaVersion: SV.registryRepo,
    generatedAt: now,
    nodeId: e.node_id,
    owner: e.owner,
    name: e.name,
    repoUrl: `https://github.com/${e.owner}/${e.name}`,
    defaultBranch: e.default_branch,
    state: e.state,
    ...(typeof e.state_note === 'string' ? { stateNote: e.state_note } : {}),
    license: {
      id: e.license.id,
      version: e.license.version,
      published: e.license.published,
      adopted: e.license.adopted,
      textSha256: e.license.text_sha256,
      // D9: derived from `published`, never stored. The four-year conversion is a promise
      // in the licence text, so the date on the page must be computed from the same
      // anchor the text uses.
      apacheConversionDate: conversionDate(e.license.published, cfg.apacheConversionYears),
      canonicalTextUrl: `${cfg.siteOrigin}/license/${e.license.id}.txt`,
    },
    weightClass: e.weight_class,
    inboundFamily: e.inbound_family,
    impactCategoryDefaults: e.impact_category_defaults || null,
    // FS02-050/D23: PURPOSE.yml is optional overrides only, and v0 does not parse it. The
    // honest statement is "not evaluated", not "absent" — this build never looked.
    manifest: {
      evaluated: false,
      note: 'PURPOSE.yml is optional overrides only (D23) and is not parsed at v0; the published defaults apply.',
    },
    // FS02-060/D14: there is no waiver field in the registry schema and no waiver can
    // exist before the claim flow. The empty list is a fact, not a placeholder.
    waivers: [],
    badge: {
      endpointUrl: `${cfg.apiOrigin}/badge/${e.node_id}.json`,
      state: neutral ? 'neutral' : 'registered',
    },
    // No statistics block. VS-18 is explicit: PP and charity figures are Phase E+, so a
    // zero here would be theatre. The key is absent rather than null for the same reason.
    verify: cfg.verifyStatement,
  });

  emit(
    `badge/${e.node_id}.json`,
    neutral
      ? {
          schemaVersion: SV.badge,
          label: cfg.badge.label,
          message: cfg.badge.neutral.message,
          color: cfg.badge.neutral.color,
          cacheSeconds: cfg.badge.cacheSeconds,
        }
      : {
          schemaVersion: SV.badge,
          label: cfg.badge.label,
          message: cfg.badge.registered.message,
          color: cfg.badge.registered.color,
          cacheSeconds: cfg.badge.cacheSeconds,
        }
  );
}

// ====================================================================== bulk export

emit('registry.json', {
  schemaVersion: SV.registryExport,
  generatedAt: now,
  count: listed.length,
  repos: listed.map((e) => ({
    ...indexRow(e),
    defaultBranch: e.default_branch,
    inboundFamily: e.inbound_family,
    repoUrl: `https://github.com/${e.owner}/${e.name}`,
    apacheConversionDate: conversionDate(e.license.published, cfg.apacheConversionYears),
    recordUrl: `${cfg.apiOrigin}/v1/registry/repo/${e.node_id}.json`,
  })),
});

// ========================================================================== waivers
//
// The honest empty state (VS-18, FS02-060). Every listed repository gets a waiver file
// saying, in a machine-readable way, that no waiver exists and why — a 404 would be
// indistinguishable from a broken build, and "no waivers yet" is a fact worth publishing.

const WAIVER_NOTE =
  'No waivers exist. Waiver issuance requires the Phase E claim flow: a claimed ' +
  'repository administrator issues waivers from the dashboard (D14), and a waiver can ' +
  'never be added by a pull request to the registry.';

for (const e of listed) {
  emit(`waivers/${e.node_id}.json`, {
    schemaVersion: SV.waivers,
    generatedAt: now,
    nodeId: e.node_id,
    waivers: [],
    note: WAIVER_NOTE,
  });
}

emit('waivers/all.json', {
  schemaVersion: SV.waivers,
  generatedAt: now,
  count: 0,
  waivers: [],
  note: WAIVER_NOTE,
});

// =========================================================================== ledger
//
// Month exports, the CSV twin, and the chain. The JSON and the CSV are rendered from ONE
// row list in one pass, because VS-37 makes divergence between them a defect.

const allRows = flatRows(months);
const CSV_COLUMNS = [
  'seq',
  'led_id',
  'month',
  'row_type',
  'amount_minor',
  'currency',
  'src_amount_minor',
  'src_currency',
  'fx_rate',
  'fx_source',
  'fx_date',
  'lane',
  'hold_status',
  'payer_name',
  'ent_id',
  'co_id',
  'repo_node_id',
  'category_fund_id',
  'schedule_version',
  'corrects_led_id',
  'external_key',
  'note',
  'emitting_job',
  'created_at',
  'prev_hash',
  'row_hash',
];

function csvCell(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const monthSummaries = [];

for (const m of months) {
  const rows = [...(m.data.rows || [])].sort((a, b) => a.seq - b.seq);
  const digest = monthDigest(rows);
  const totals = rows.reduce(
    (acc, r) => {
      acc.rows += 1;
      acc.netMinor += r.amount_minor;
      return acc;
    },
    { rows: 0, netMinor: 0 }
  );

  emit(`ledger/${m.month}.json`, {
    schemaVersion: SV.ledgerMonth,
    generatedAt: now,
    month: m.month,
    currency: cfg.stats.reportingCurrency,
    // No `policy` block and no allocation `totals`: at v0 there is no allocator, so
    // levy/commons/directed figures do not exist. FS07-100 — the export shape is the
    // FS-07 §6.2 shape minus allocation totals, so public transparency pages have one
    // format forever.
    totals: { rowCount: totals.rows, netIntakeMinor: totals.netMinor },
    rows,
    monthDigest: digest,
    methodology: [
      'Append-only: a committed row is never edited or deleted. Corrections are new rows (FS07-042).',
      'Row hashes chain globally in `seq` order: row_hash = SHA-256(prev_hash || JCS(row minus its two hash fields)), RFC 8785 canonical JSON.',
      'No allocation, levy, or disbursement row exists before the platform computes one; this table records intake only.',
    ],
  });

  emitText(
    `ledger/${m.month}.csv`,
    `${CSV_COLUMNS.join(',')}\n${rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(',')).join('\n')}${rows.length ? '\n' : ''}`
  );

  monthSummaries.push({
    month: m.month,
    rowCount: rows.length,
    monthDigest: digest,
    headHashAtMonthEnd: rows.length ? rows[rows.length - 1].row_hash : null,
  });
}

const head = allRows.length ? allRows[allRows.length - 1].row : null;

emit('ledger/chain.json', {
  schemaVersion: SV.ledgerChain,
  generatedAt: now,
  algorithm: 'SHA-256 over prev_hash || RFC-8785-JCS(row minus prev_hash and row_hash)',
  genesisHash: cfg.ledger.genesisHash,
  headHash: head ? head.row_hash : cfg.ledger.genesisHash,
  headSeq: head ? head.seq : 0,
  rowCount: allRows.length,
  months: monthSummaries,
  // FS07-040 publishes the chain head plus every month-LOCK row. There are no locks at
  // v0 (locking is the allocator's act, FS07-050), so this artifact carries the head plus
  // per-month digests, which is what VS-37 specifies for v0.
  locks: [],
  notes: [
    'Month locks begin at P-M3 with `jobs.allocator`; the `locks` array is empty by design at v0, not by omission.',
    allRows.length === 0
      ? 'No money has moved yet: the ledger holds no rows.'
      : 'Re-walk the chain from genesis to verify: scripts/ledger-verify.mjs does exactly that on every CI run.',
  ],
});

// =============================================================================== CT log

for (const s of ctSegments) {
  // Byte-for-byte passthrough of the shape, re-serialised through writeArtifact so the
  // published bytes are canonical even if a hand-edited source file was formatted oddly.
  // The published segment must stay hashable by anyone who mirrors it, so key order is
  // the source's key order.
  emit(`ct/${s.segment}.json`, s.data);
}

if (ctSegments.length) {
  const open = ctSegments[ctSegments.length - 1];
  emit('ct/latest.json', open.data);
} else {
  die('ct/ holds no segment files. The v0 log is exactly one committed segment, ct/0.json (FS08-113); an absent log cannot be published as an empty one.');
}

// ================================================================================ stats
//
// The three-state machine (FS-10 §10 schema, VS-19 rules). The state is CHOSEN BY REAL
// DATA and never set by hand:
//
//   pre-launch                 no listed repository and no ledger row.
//   launched-pre-disbursement  something real exists, but no franc has been disbursed.
//   post-first-franc           a `disburse` row exists in the ledger.
//
// The honesty rules that make this artifact worth publishing:
//   * At `pre-launch` every numeric field is null, not 0. VS-19: mechanism copy only. A
//     zero reads as an achievement or an embarrassment; a null reads as "not yet".
//   * `contributorsClaimed` stays null past pre-launch too. There is no claim flow at v0
//     (Phase E), so the number is structurally unknowable rather than zero.
//   * `chfRoutedMinor` stays null until a disbursement exists — never "CHF 0".
//   * `post-first-franc` is unreachable at v0 by construction, because no allocation row
//     type is permitted in the v0 ledger. It is implemented anyway so the artifact's
//     shape is final now and P-M3 flips it with data, not with code.

const disburseRows = allRows.filter(({ row }) => row.row_type === 'disburse');
const intakeRowCount = allRows.length;

let state;
if (listed.length === 0 && detected.length === 0 && intakeRowCount === 0) {
  state = 'pre-launch';
} else if (disburseRows.length === 0) {
  state = 'launched-pre-disbursement';
} else {
  state = 'post-first-franc';
}

const companiesCovered = new Set(
  allRows.map(({ row }) => row.co_id).filter((v) => typeof v === 'string')
).size;

const isPreLaunch = state === 'pre-launch';

emit('stats.json', {
  schemaVersion: SV.stats,
  generatedAt: now,
  state,
  // "Registered" means currently carrying the licence: verified, detected or suspended.
  // A repository that quit or was delisted is not a current registration and is not
  // counted (WEB-085's logic applied to a counter rather than a badge).
  projectsRegistered: isPreLaunch
    ? null
    : entries.filter((e) => ['verified', 'detected', 'suspended'].includes(e.state)).length,
  contributorsClaimed: null,
  companiesCovered: isPreLaunch ? null : companiesCovered,
  // Absolute value: FS-07 does not fix the sign convention for `disburse` rows, and this
  // branch is unreachable at v0 (no allocation row type is permitted in the v0 ledger),
  // so the figure is derived without depending on a convention P-M3 owns.
  chfRoutedMinor:
    state === 'post-first-franc'
      ? Math.abs(disburseRows.reduce((a, { row }) => a + row.amount_minor, 0))
      : null,
  cur: cfg.stats.reportingCurrency,
  firstDisbursementScheduledFor: cfg.stats.firstDisbursementScheduledFor,
  loi: cfg.stats.loi,
  detectedUnclaimed: isPreLaunch ? null : detected.length,
  smallnessThresholds: cfg.stats.smallnessThresholds,
  notes: [
    'contributorsClaimed is null, not zero: the contributor claim flow is Phase E, so the figure is structurally unknowable at v0 rather than empty.',
    'Numeric fields are null while state is `pre-launch`. A zero would read as a claim about the world; a null reads as "no data yet".',
  ],
});

// ============================================================================== summary

// `/meta/publish-log.json` is the publish-batch record from the FS-00 §6.2 amendment note
// of 2026-09-01 (owner FS-10). A v0 build publishes exactly one batch per run, so the log
// holds one entry: what was read, what was written, and the timestamp every artifact in
// the batch carries. It is the only place in the plane that describes the BUILD rather
// than the data.
emit('meta/publish-log.json', {
  schemaVersion: 1,
  generatedAt: now,
  batches: [
    {
      generatedAt: now,
      generator: 'index-build-lite',
      phase: 'P-M2',
      org: cfg.org,
      domain: cfg.domain,
      includedExamples: Boolean(args['include-examples']),
      sources: {
        registryEntries: entries.length,
        ledgerMonths: months.length,
        ledgerRows: allRows.length,
        ctSegments: ctSegments.length,
      },
      artifactCount: written.length + 1,
    },
  ],
});

noteLine(
  `index-build-lite -> ${args.out}: ${written.length} artifacts ` +
    `(${listed.length} listed repos, ${detected.length} detected, ${months.length} ledger months, ` +
    `${allRows.length} ledger rows, ${ctSegments.length} CT segments), state=${state}, generatedAt=${now}` +
    (args['include-examples'] ? ' [EXAMPLES INCLUDED — not publishable]' : '')
);
