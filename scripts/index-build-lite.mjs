#!/usr/bin/env node
// index-build-lite — the v0 bridge from the curated registry to its slice of the public
// artifact plane.
//
//   node scripts/index-build-lite.mjs [--out dist] [--include-examples]
//                                     [--registry-dir registry]
//                                     [--stats-config tests/fixtures/publish-stats.json]
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
//
// THE PUBLISHED SHAPES ARE {ORG}/spec's, NOT THIS FILE'S (2026-09-08). FS-00 §6.2's
// amendment note of that date makes the schemas published in the contract repository the
// profile of the frozen contract: a shape a schema does not admit is a defect HERE, and
// scripts/check-artifacts-schema.mjs is the gate that says so. Every object below is built
// to `registry-index.v1`, `registry-index-meta.v1`, `repo-record.v1`, `waiver.v1`,
// `badge.v1` and `stats.v1` as published, which is why several members read as renames of
// what this build used to emit. Where a sentence left an artifact, it left because the
// schema already carries it as a field description — restating it in the bytes made every
// artifact fail the contract it claims to implement.

import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  ROOT,
  config,
  die,
  generatedAt,
  noteLine,
  parseArgs,
  readJsonFile,
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
  values: ['out', 'registry-dir', 'stats-config'],
  defaults: { out: 'dist', 'registry-dir': null, 'stats-config': null },
});

const cfg = config();
const now = generatedAt();
const OUT = resolve(ROOT, args.out);
const SV = cfg.artifactSchemaVersions;

// WHICH PLANE PRODUCED THESE BYTES (FS-00 §6.2 amendment note, 2026-09-08). `source` is an
// optional envelope member on every artifact schema this build emits except the badge,
// whose body shields.io owns; the badge borrows the plane's declaration from
// `/registry/index/meta.json`, so that document carrying the member is what makes the
// borrowing work at all. `sample` and `fixture` name a NON-PRODUCTION plane and a `prod`
// deployment refuses to serve one outright (FS-10 §2 v0 note).
//
// The value is a fact about the BUILD and not a name for the output directory: what makes
// a plane unpublishable is that it carries the seeded demonstration entries, so
// `--include-examples` is what decides it. `registry-v0` is the enum's name for this
// producer — the curated registry repository the index is built from.
const SOURCE = args['include-examples'] ? 'sample' : 'registry-v0';

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

/** The absolute URL of a repository's public page on the site (WEB-080). */
function pageUrl(nodeId) {
  return `${cfg.siteOrigin}/registry/repo/${nodeId}`;
}

/** The absolute URL of a repository's record artifact, as the edge serves it (FS10-060). */
function recordUrl(nodeId) {
  return `${cfg.apiOrigin}/v1/registry/repo/${nodeId}.json`;
}

/** The absolute URL of a repository's shields.io endpoint body (FS10-030). */
function badgeUrl(nodeId) {
  return `${cfg.apiOrigin}/badge/${nodeId}.json`;
}

/**
 * One `registry-index.v1` entry — the same shape in a shard and in the bulk export, which
 * is why one function builds both (the export is a shard document with `shard: "export"`).
 *
 * The entry is the minimum a browse page or a scanner needs; everything else about a
 * repository lives in the record its `recordUrl` names. So `defaultBranch`, `inboundFamily`
 * and `repoUrl` are NOT here: the first is a member of the RECORD and the third is
 * `links.repository` there, and `inboundFamily` has no member in the contract at all.
 * `adopted` is `adoptedAt`,
 * whose own description makes it the key the browse view's "recently registered" ordering
 * reads (WEB-073), and `licenseVersion` carries `license.version` beside `licenseId` for
 * `license.id` — one name per fact.
 */
function indexEntry(e) {
  return {
    nodeId: e.node_id,
    owner: e.owner,
    name: e.name,
    state: e.state,
    weightClass: e.weight_class,
    licenseId: e.license.id,
    licenseVersion: e.license.version,
    adoptedAt: e.license.adopted,
    apacheConversionDate: conversionDate(e.license.published, cfg.apacheConversionYears),
    recordUrl: recordUrl(e.node_id),
    badgeUrl: badgeUrl(e.node_id),
    pageUrl: pageUrl(e.node_id),
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
    source: SOURCE,
    shard,
    count: rows.length,
    entries: rows.map(indexEntry),
  });
}

const stateCount = (s) => entries.filter((e) => e.state === s).length;

emit('registry/index/meta.json', {
  schemaVersion: SV.registryIndexMeta,
  generatedAt: now,
  source: SOURCE,
  // Each shard with its absolute URL, so a browse client fetches the shards it needs
  // without knowing this producer's directory layout.
  shards: shardsPresent.map((s) => ({
    shard: s,
    url: `${cfg.apiOrigin}/v1/registry/index/${s}.json`,
    count: shardMembers.get(s).length,
  })),
  // The bulk export on the API origin. FS10-060 gives the one document two published
  // addresses — `/v1/registry/export.json` on the API origin, and the alias
  // `/registry.json` mounted on the APEX of the site domain — and this member names the
  // API one, the same `/v1/` grammar as `shards[].url` above. The plane-local file below
  // is written at `registry.json` because that is where the deploying step picks it up;
  // an emit path is not a URL, and `apiOrigin` serves nothing at that name.
  exportUrl: `${cfg.apiOrigin}/v1/registry/export.json`,
  totals: {
    listed: listed.length,
    verified: stateCount('verified'),
    suspended: stateCount('suspended'),
    quit: stateCount('quit'),
    delisted: stateCount('delisted'),
    detected: detected.length,
  },
  // The badge route's belt-and-braces guard (FS10-032): every listed repository whose state
  // is not `verified` serves the neutral badge even if a cached artifact still says
  // otherwise. All three states render neutral (WEB-085), so the set covers all three — the
  // member keeps the name a reader recognises.
  delisted: listed.filter((e) => NEUTRAL_BADGE_STATES.includes(e.state)).map((e) => e.node_id),
  // No `shardOn`, no `notes`. The two sentences this document used to carry — that
  // `detected` repositories are counted here and listed nowhere, and that a shard key is
  // the lowercased first character of the name with `0` for the rest — are the published
  // schema's own descriptions of `totals.detected` and `shards[].shard`. `registry-index-meta.v1`
  // is `additionalProperties: false`, so restating them made every emitted meta.json fail
  // the contract it implements: a worse trade than trusting the schema to carry its own
  // reasoning.
});

// =============================================================== per-repo record + badge

for (const e of listed) {
  const neutral = NEUTRAL_BADGE_STATES.includes(e.state);

  emit(`registry/repo/${e.node_id}.json`, {
    schemaVersion: SV.registryRepo,
    generatedAt: now,
    source: SOURCE,
    nodeId: e.node_id,
    // An object, not a login string: the contract keeps room for the owner organisation's
    // node id and account type, and this producer has neither. `{ login }` alone is the
    // whole honest answer — the curated record carries a display login and nothing more.
    owner: { login: e.owner },
    name: e.name,
    defaultBranch: e.default_branch,
    state: e.state,
    ...(typeof e.state_note === 'string' ? { stateNote: e.state_note } : {}),
    // No `stateChangedAt`. The published record contract DOES define the member — a
    // producer with a real state-change date belongs there — but this one has no such date
    // to put in it: the curated record contract has none. The nearest date it does carry is
    // `curation.recorded_at`, which is when the OPERATOR wrote the record down and not when
    // the repository's state changed. Publishing the one as the other would be an invented
    // fact, so the member is absent and the page says the date is not recorded.
    weightClass: e.weight_class,
    license: {
      id: e.license.id,
      version: e.license.version,
      publishedAt: e.license.published,
      adoptedAt: e.license.adopted,
      textSha256: e.license.text_sha256,
      // D9: derived from `publishedAt`, never stored. The four-year conversion is a promise
      // in the licence text, so the date on the page must be computed from the same
      // anchor the text uses.
      apacheConversionDate: conversionDate(e.license.published, cfg.apacheConversionYears),
      canonicalTextUrl: `${cfg.siteOrigin}/license/${e.license.id}.txt`,
    },
    // Absent, never null, when the project chose nothing: "absent means the steward default
    // applies" is the contract's own reading, and a project that chose nothing is not a
    // project that chose none (FS02-050 tier 3).
    ...(Array.isArray(e.impact_category_defaults) && e.impact_category_defaults.length > 0
      ? { impactCategoryDefaults: e.impact_category_defaults }
      : {}),
    // No `manifest` block at all. FS02-050/D23: PURPOSE.yml is optional overrides only and
    // v0 does not parse it, so this build has nothing to report — and the contract's
    // `manifest.present` is a boolean about a file somebody LOOKED for. `present: false`
    // for a file nobody looked for is a false statement; absence is the true one, and the
    // page prints "manifest status not evaluated at v0".
    links: {
      repository: `https://github.com/${e.owner}/${e.name}`,
      projectPage: pageUrl(e.node_id),
    },
    // FS02-060/D14: there is no waiver field in the registry schema and no waiver can
    // exist before the claim flow. The count is the fact; the URL is where the list lives,
    // so a reader never has to guess whether zero means "none" or "not published here".
    waivers: { count: 0, url: `${cfg.apiOrigin}/v1/waivers/${e.node_id}.json` },
    badge: {
      url: badgeUrl(e.node_id),
      state: neutral ? 'neutral' : 'registered',
    },
    // No statistics block. VS-18 is explicit: PP and charity figures are Phase E+, so a
    // zero here would be theatre. The key is absent rather than null for the same reason.
    //
    // No `verify` statement either: the frozen exclusive-verify wording of FS-00 §6.4 is
    // the verify PAGE's to make, and the contract has no member for it — a machine record
    // repeating it on every repository is the same sentence in a place nobody reads it.
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

// The same document shape as a shard, holding every listed repository, distinguished only
// by `shard: "export"` (FS10-060). It is a shard document by contract, so it carries no
// member a shard does not: one shape, one consumer code path, one thing to keep in step.

emit('registry.json', {
  schemaVersion: SV.registryExport,
  generatedAt: now,
  source: SOURCE,
  shard: 'export',
  count: listed.length,
  entries: listed.map(indexEntry),
});

// ========================================================================== waivers
//
// The honest empty state (VS-18, FS02-060). Every listed repository gets a waiver file
// saying, in a machine-readable way, that no waiver exists — a 404 would be
// indistinguishable from a broken build, and "no waivers yet" is a fact worth publishing.
//
// The empty array IS the statement, and `waiver.v1` says so in its own description of the
// member: "an empty array is a valid and expected state — it means no waiver exists, not
// that data is missing". The sentence this build used to put in a `note` — why no waiver
// can exist yet, and why one can never arrive by pull request — is prose for a reader, so
// it lives in the README's "What the build emits" and on the page, not in bytes the
// contract forbids. `scope` is what tells the two documents apart: `repo` sets `nodeId`,
// `all` puts `repoNodeId` on each entry.

for (const e of listed) {
  emit(`waivers/${e.node_id}.json`, {
    schemaVersion: SV.waivers,
    generatedAt: now,
    source: SOURCE,
    scope: 'repo',
    nodeId: e.node_id,
    waivers: [],
  });
}

emit('waivers/all.json', {
  schemaVersion: SV.waivers,
  generatedAt: now,
  source: SOURCE,
  scope: 'all',
  waivers: [],
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

// THE FIRST-DISBURSEMENT DATE, AND WHY THIS BUILD REFUSES TO GUESS ONE.
//
// `stats.v1` requires `firstDisbursementScheduledFor` to name a date whenever `state` is
// `launched-pre-disbursement` — the empty money figure gets a date attached instead of a
// shrug. config/publish.json holds `null` and says in its own comment that the date is set
// by hand when a real one exists and is NEVER guessed. Both rules are right, and together
// they mean this build must have no way to satisfy the contract by inventing a date.
//
// So it fails instead. A guessed date is forbidden by the honesty law, and an artifact the
// published contract forbids must never be written — including into a directory nobody has
// published yet, because the file is what a later step publishes. The failure names the
// error and the one file where a real date is recorded, so the operator is not left
// reading a schema error to find out what to do.
//
// --stats-config points at a JSON file whose `firstDisbursementScheduledFor` is used
// instead. Only the demo plane passes it (package.json `build:demo`), and only at a
// clearly-labelled fixture date under tests/fixtures/: the demo plane is demonstration
// data by declaration (`source: "sample"` above) and is never publishable, which is what
// makes a fictional date honest there and dishonest here.
const statsConfigPath = args['stats-config'] ? resolve(ROOT, args['stats-config']) : null;
if (statsConfigPath && !existsSync(statsConfigPath)) {
  // Named, like every other failure here: a mistyped path must not surface as a bare
  // ENOENT stack from the reader, which reads like a broken build rather than a wrong flag.
  die(`stats.config-not-found: --stats-config ${args['stats-config']} does not exist.`);
}
const statsOverrides = statsConfigPath ? readJsonFile(statsConfigPath) : null;
const firstDisbursementScheduledFor = statsOverrides
  ? statsOverrides.firstDisbursementScheduledFor ?? null
  : cfg.stats.firstDisbursementScheduledFor;

if (state === 'launched-pre-disbursement' && firstDisbursementScheduledFor === null) {
  die(
    'stats.first-disbursement-date-missing: this build derives state ' +
      '`launched-pre-disbursement` from the registry, and stats.v1 requires ' +
      '`firstDisbursementScheduledFor` to name a date in that state. It is null in ' +
      // The member sits at the root of a --stats-config file and under `stats` in
      // config/publish.json, so the path named here follows the file being read.
      `${statsConfigPath
        ? `${args['stats-config']} (firstDisbursementScheduledFor)`
        : 'config/publish.json (stats.firstDisbursementScheduledFor)'}. ` +
      'Record the real date there — it is set by hand when one exists and is never ' +
      'guessed — and re-run. No stats.json is written: an artifact the published contract ' +
      'forbids must not exist, and a date nobody decided is not a way to satisfy it.'
  );
}

emit('stats.json', {
  schemaVersion: SV.stats,
  generatedAt: now,
  source: SOURCE,
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
  firstDisbursementScheduledFor,
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
