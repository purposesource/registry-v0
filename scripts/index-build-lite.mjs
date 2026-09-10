#!/usr/bin/env node
// index-build-lite — the v0 bridge from the curated registry to its slice of the public
// artifact plane.
//
//   node scripts/index-build-lite.mjs [--out dist] [--include-examples]
//                                     [--registry-dir registry]
//
// WHAT IT IS. FS-00 §6.10 makes P-M2 deliberately serverless-static: no `pg`, no `api`,
// no `jobs.index-build`. This script is the stand-in — it reads the committed registry in
// this repository and emits the FS-00 §6.2 artifacts DERIVABLE FROM IT at EXACTLY the §6.2
// paths, so that P-M3's migration to `pg` + `jobs.index-build` changes no URL
// (FS02-062/FS02-064).
//
// THE REGISTRY SUBSET, NOT THE WHOLE PLANE (2026-09-09). This repository is canonical for
// registry YAML only. The ledger, the CT log, the certificate and entitlement records and
// the artifacts derived from them live in {ORG}/website (FS-00 §6.10, ruling of
// 2026-09-07), whose own builder emits them from `src/data/ledger/{YYYY-MM}.json` and its
// repo-root `ct/` tree and validates them against {ORG}/spec. So `/ledger/**`, `/ct/**` and
// the CSV twin are emitted THERE and no longer here: the trees this build used to read were
// non-canonical from 2026-09-07, received no row, and retired on 2026-09-09. The published
// URLs did not move — only the producer did.
//
// WHAT IT IS NOT. It is not a publisher. It writes a directory; a deploy publishes it.
// And it is not a source of facts: every number it emits is derived from registry/. There
// is no code path here that can invent a count, a figure, or a state — which is the
// mechanical form of D21, "nothing claimed before it's real". Where the registry cannot
// know a figure, the figure is `null` and says so, never 0 and never a guess.
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

const args = parseArgs(process.argv.slice(2), {
  flags: ['include-examples'],
  values: ['out', 'registry-dir'],
  defaults: { out: 'dist', 'registry-dir': null },
});

const cfg = config();
const now = generatedAt();
const OUT = resolve(ROOT, args.out);
const SV = cfg.artifactSchemaVersions;

if (OUT === ROOT) die('--out must be a subdirectory, not the repository root.');
rmSync(OUT, { recursive: true, force: true });

const loaded = loadRegistry(args['registry-dir'] ? resolve(ROOT, args['registry-dir']) : REGISTRY_DIR);
const entries = args['include-examples']
  ? [...publishable(loaded), ...exampleEntries(loaded)].sort(byOwnerName)
  : publishable(loaded).sort(byOwnerName);

/** Relative artifact paths this run wrote, for the manifest check to compare against. */
const written = [];

function emit(relPath, value) {
  writeArtifact(join(OUT, relPath), value);
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

// ============================================================= ledger and CT: NOT HERE
//
// Retired 2026-09-09. `/ledger/{YYYY-MM}.json`, its CSV twin, `/ledger/chain.json`,
// `/ct/{n}.json` and `/ct/latest.json` are emitted by {ORG}/website's builder from
// `src/data/ledger/{YYYY-MM}.json` and its repo-root `ct/` tree — the canonical homes since
// FS-00 §6.10's ruling of 2026-09-07. The trees this section used to read were
// non-canonical from that date and received no row, so nothing was moved on the way out:
// the honest-empty month and segment 0 already lived there, under the guards ported with
// them (`website/scripts/{ledger,ct}-verify.mjs`, run by `site-ci` against a resolved
// append-only baseline). The catalog paths are unchanged — only their producer is.
//
// VS-37's rule that a month's CSV and JSON are rendered from ONE row list in one pass
// travelled with the code and is asserted there (`website/tests/unit/ledger-csv.test.mjs`).
// It is not restated here as a comment on nothing.

// ================================================================================ stats
//
// The three-state machine (FS-10 §10 schema, VS-19 rules). The state is CHOSEN BY REAL
// DATA and never set by hand:
//
//   pre-launch                 nothing is registered.
//   launched-pre-disbursement  something real exists, but no franc has been disbursed.
//   post-first-franc           a `disburse` row exists in the ledger.
//
// DERIVED FROM THE REGISTRY ALONE since 2026-09-09. The ledger this section used to read is
// the website's (FS-00 §6.10), so the two flips that need a row are not this build's to
// make: S1 -> S2 is decided here, by whether any repository is registered, and S2 -> S3 is
// decided by the website's builder, which can see a `disburse` row. Deriving S3 from a
// registry would mean inferring a payment from a licence adoption, which is exactly the
// invention the honesty law forbids — so this build cannot emit `post-first-franc`, and
// check-artifacts.mjs asserts the two money fields stay null to keep it that way.
//
// The honesty rules that make this artifact worth publishing:
//   * At `pre-launch` every numeric field is null, not 0. VS-19: mechanism copy only. A
//     zero reads as an achievement or an embarrassment; a null reads as "not yet".
//   * `contributorsClaimed` stays null past pre-launch too. There is no claim flow at v0
//     (Phase E), so the number is structurally unknowable rather than zero.
//   * `companiesCovered` and `chfRoutedMinor` are null for the same KIND of reason from
//     2026-09-09: both are counted off ledger rows, and this repository holds none. Null is
//     the honest reading of "this producer cannot see it" — a 0 here would assert that no
//     company is covered and no franc has moved, which is a claim about the world that a
//     registry has no standing to make.

const state = listed.length === 0 && detected.length === 0 ? 'pre-launch' : 'launched-pre-disbursement';

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
  companiesCovered: null,
  chfRoutedMinor: null,
  cur: cfg.stats.reportingCurrency,
  firstDisbursementScheduledFor: cfg.stats.firstDisbursementScheduledFor,
  loi: cfg.stats.loi,
  detectedUnclaimed: isPreLaunch ? null : detected.length,
  smallnessThresholds: cfg.stats.smallnessThresholds,
  // No `notes` array. The two sentences it used to carry — contributorsClaimed is null
  // because the claim flow is Phase E, and a null while `pre-launch` reads as "no data yet"
  // where a zero would read as a claim about the world — are the published schema's own
  // field descriptions (spec/schemas/stats.v1.json). stats.v1 is
  // `additionalProperties: false`, so restating them in the artifact made every emitted
  // stats.json fail the contract it claims to implement, which is a worse trade than
  // trusting the schema to carry its own reasoning.
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
      // One source since 2026-09-09. The `ledgerMonths` / `ledgerRows` / `ctSegments`
      // counters this batch used to carry described trees that are no longer read here;
      // the website's publish log carries them for the plane that does read them.
      sources: {
        registryEntries: entries.length,
      },
      artifactCount: written.length + 1,
    },
  ],
});

noteLine(
  `index-build-lite -> ${args.out}: ${written.length} artifacts ` +
    `(${listed.length} listed repos, ${detected.length} detected), state=${state}, generatedAt=${now}` +
    (args['include-examples'] ? ' [EXAMPLES INCLUDED — not publishable]' : '')
);
