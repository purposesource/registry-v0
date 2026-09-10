// index-build-lite and the artifact-plane gate.
//
// Covers FS02-084 ("a merged change produces refreshed artifacts at all §7 paths within
// one build, with generatedAt advancing"), the determinism requirement behind it, and the
// honesty rules that make the plane publishable: detected repositories are counted and
// never listed, quit repositories get a neutral badge, waivers are empty, and no seeded
// example ever reaches a published artifact.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { NOW, REPO, cleanup, runScript, treeOf, workspace } from './helpers.mjs';

/**
 * Writes JSON to an ABSOLUTE path — the tests plant files inside temp build outputs.
 *
 * The directory is created first. Without that, planting a file at a path the build no longer
 * emits — the retired `ledger/chain.json` being the case that matters — throws ENOENT, and the
 * only planted paths that work are the root-level ones. That silently reduces a test of "a
 * retired subtree is rejected" to a duplicate of "a stray root file is rejected".
 */
function writeJsonAt(abs, value) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const ALL_STATES = 'tests/fixtures/registry-all-states';
const STATS_FIXTURE = 'tests/fixtures/publish-stats.json';

/**
 * A build over the all-states fixture registry.
 *
 * It passes `--stats-config` because the fixture registry has listed repositories, so the
 * build derives `launched-pre-disbursement` — and in that state `stats.v1` requires a named
 * `firstDisbursementScheduledFor`, which the publishable configuration deliberately does not
 * have. Fixture data, fixture date: the test that proves the PUBLISHABLE path refuses to
 * invent one is the last case in this file, and it is the one that omits this flag.
 */
function build(outRel, extra = [], env = {}) {
  const r = runScript(
    'index-build-lite.mjs',
    ['--out', outRel, '--registry-dir', ALL_STATES, '--stats-config', STATS_FIXTURE, ...extra],
    env
  );
  assert.equal(r.code, 0, r.stderr);
  return join(REPO, outRel);
}

function readOut(outRel, ...parts) {
  return JSON.parse(readFileSync(join(REPO, outRel, ...parts), 'utf8'));
}

test('the registry half of the FS-00 §6.2 catalog is emitted, and nothing else', (t) => {
  const ws = workspace('build', {});
  t.after(() => cleanup(ws));
  const out = `${ws}/dist`;
  build(out);

  // NO `ledger/**` AND NO `ct/**`, deliberately (2026-09-09). Their sources are the
  // website's (FS-00 §6.10), so this producer emitting either would mean emitting an
  // artifact it derived from nothing. The absence is the assertion: it is spelled out in
  // this list rather than left to the reader of a shorter one.
  const paths = treeOf(join(REPO, out)).map(([p]) => p);
  assert.deepEqual(paths.sort(), [
    // shard `0` holds `9lives`; `a`, `c` and `d` hold the rest. `bravo-lib` is `detected`
    // and therefore in NO shard at all.
    'badge/R_kgDOFIXTUREA001.json',
    'badge/R_kgDOFIXTUREC003.json',
    'badge/R_kgDOFIXTURED004.json',
    'badge/R_kgDOFIXTUREE005.json',
    'meta/publish-log.json',
    'registry.json',
    'registry/index/0.json',
    'registry/index/a.json',
    'registry/index/c.json',
    'registry/index/d.json',
    'registry/index/meta.json',
    'registry/repo/R_kgDOFIXTUREA001.json',
    'registry/repo/R_kgDOFIXTUREC003.json',
    'registry/repo/R_kgDOFIXTURED004.json',
    'registry/repo/R_kgDOFIXTUREE005.json',
    'stats.json',
    'waivers/R_kgDOFIXTUREA001.json',
    'waivers/R_kgDOFIXTUREC003.json',
    'waivers/R_kgDOFIXTURED004.json',
    'waivers/R_kgDOFIXTUREE005.json',
    'waivers/all.json',
  ]);
});

test('two runs over identical sources are byte-identical (VS-04 reviewable diffs)', (t) => {
  const ws = workspace('determinism', {});
  t.after(() => cleanup(ws));

  const a = treeOf(build(`${ws}/one`));
  const b = treeOf(build(`${ws}/two`));

  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i][0], b[i][0], 'same paths, same order');
    assert.ok(a[i][1].equals(b[i][1]), `${a[i][0]} differs between two runs of identical sources`);
  }
});

test('generatedAt comes from GENERATED_AT and NEVER from the wall clock', (t) => {
  const ws = workspace('stamp', {});
  t.after(() => cleanup(ws));

  build(`${ws}/dist`, [], { GENERATED_AT: '2029-06-01T12:34:56Z' });
  assert.equal(readOut(`${ws}/dist`, 'stats.json').generatedAt, '2029-06-01T12:34:56Z');

  // Millisecond precision is normalised away: `generatedAt` lands in every artifact, so a
  // sub-second field would make two builds of unchanged data differ for no reviewable
  // reason.
  build(`${ws}/dist2`, [], { GENERATED_AT: '2029-06-01T12:34:56.789Z' });
  assert.equal(readOut(`${ws}/dist2`, 'stats.json').generatedAt, '2029-06-01T12:34:56Z');
});

test('a `detected` repository is COUNTED and never LISTED (GH-014, OPEN-33)', (t) => {
  const ws = workspace('detected', {});
  t.after(() => cleanup(ws));
  const out = `${ws}/dist`;
  build(out);

  const meta = readOut(out, 'registry/index/meta.json');
  assert.equal(meta.totals.detected, 1);
  assert.equal(meta.totals.listed, 4);
  assert.equal(meta.totals.verified, 1);
  // The four listed states sum to `listed`, and the detected one is outside that sum —
  // which is the arithmetic form of "counted, never listed".
  assert.equal(
    meta.totals.verified + meta.totals.suspended + meta.totals.quit + meta.totals.delisted,
    meta.totals.listed
  );

  // Not in any shard, not in the bulk export, and with no record, badge or waiver file.
  const everything = treeOf(join(REPO, out))
    .map(([, bytes]) => bytes.toString('utf8'))
    .join('\n');
  assert.ok(
    !everything.includes('R_kgDOFIXTUREB002'),
    'the detected repository must not be named in any published artifact'
  );
  assert.ok(!everything.includes('bravo-lib'));

  // But it IS in the counter, which is the whole point of "aggregate-only".
  assert.equal(readOut(out, 'stats.json').detectedUnclaimed, 1);
});

test('quit, suspended and delisted repositories get the NEUTRAL badge (WEB-085)', (t) => {
  const ws = workspace('badges', {});
  t.after(() => cleanup(ws));
  const out = `${ws}/dist`;
  build(out);

  const verified = readOut(out, 'badge/R_kgDOFIXTUREA001.json');
  assert.deepEqual(verified, {
    schemaVersion: 1,
    label: 'purpose source',
    message: 'registered',
    color: 'brightgreen',
    cacheSeconds: 3600,
  });

  for (const id of ['R_kgDOFIXTUREC003', 'R_kgDOFIXTURED004', 'R_kgDOFIXTUREE005']) {
    const badge = readOut(out, `badge/${id}.json`);
    assert.equal(badge.message, 'status: see registry', `${id} must not keep asserting registration`);
    assert.equal(badge.color, 'lightgrey');
    assert.ok(!('generatedAt' in badge), 'a shields endpoint body carries only the shields fields');
  }
});

test('every repo record points at an empty waiver list and carries no statistics block', (t) => {
  const ws = workspace('waivers', {});
  t.after(() => cleanup(ws));
  const out = `${ws}/dist`;
  build(out);

  const rec = readOut(out, 'registry/repo/R_kgDOFIXTUREA001.json');
  assert.deepEqual(rec.waivers, {
    count: 0,
    url: 'https://api.purposesource.org/v1/waivers/R_kgDOFIXTUREA001.json',
  });
  assert.equal(rec.stats, undefined, 'VS-18: no statistics block — PP and charity figures are Phase E+');
  assert.equal(rec.license.apacheConversionDate, '2030-11-01');

  // NOT `manifest: { present: false }`. v0 never parses PURPOSE.yml, so the whole block is
  // absent: `present: false` would report on a file this build never looked for, which is a
  // different statement from "not evaluated" and a false one.
  assert.equal(rec.manifest, undefined, 'no manifest block for a file nobody looked for');

  const all = readOut(out, 'waivers/all.json');
  assert.deepEqual(all.waivers, []);
  assert.equal(all.scope, 'all');
  assert.equal(all.nodeId, undefined, '/waivers/all.json is not about one repository');
  assert.equal(all.count, undefined, 'the empty array is the count');
  assert.equal(all.note, undefined, 'the honest-empty sentence is page copy, not a member the contract forbids');

  const one = readOut(out, 'waivers/R_kgDOFIXTUREA001.json');
  assert.equal(one.scope, 'repo');
  assert.equal(one.nodeId, 'R_kgDOFIXTUREA001');
});

test('the record and the index carry the published member names, and nothing beside them', (t) => {
  const ws = workspace('shapes', {});
  t.after(() => cleanup(ws));
  const out = `${ws}/dist`;
  build(out);

  // The published `repo-record.v1` names: an owner OBJECT, dates under `…At`, the badge and
  // the repository link where the contract puts them. The members that left had no home in
  // the contract at all, and a member with no home is a fact published where nobody agreed
  // to read it.
  const rec = readOut(out, 'registry/repo/R_kgDOFIXTURED004.json');
  assert.deepEqual(rec.owner, { login: 'psn-fixture-d' });
  assert.equal(rec.license.publishedAt, '2026-11-01');
  assert.equal(rec.license.adoptedAt, '2026-11-08');
  assert.equal(rec.badge.url, 'https://api.purposesource.org/badge/R_kgDOFIXTURED004.json');
  assert.equal(rec.badge.state, 'neutral');
  assert.equal(rec.links.repository, 'https://github.com/psn-fixture-d/9lives');
  assert.equal(rec.links.projectPage, 'https://purposesource.org/registry/repo/R_kgDOFIXTURED004');
  assert.equal(rec.stateNote, 'moderation decision under appeal');
  for (const gone of ['repoUrl', 'inboundFamily', 'verify', 'stateChangedAt', 'licenseVersion', 'adoptedAt']) {
    assert.equal(rec[gone], undefined, `${gone} has no member in repo-record.v1`);
  }
  // A record whose project chose no categories omits the member rather than nulling it:
  // "absent means the steward default applies" — choosing nothing is not choosing none.
  assert.equal(rec.impactCategoryDefaults, undefined);
  assert.deepEqual(
    readOut(out, 'registry/repo/R_kgDOFIXTUREA001.json').impactCategoryDefaults,
    ['health']
  );

  // The bulk export is a shard document with `shard: "export"` — one shape, so a consumer
  // reads a shard and the export with the same code (FS10-060).
  const exp = readOut(out, 'registry.json');
  const shard = readOut(out, 'registry/index/a.json');
  assert.equal(exp.shard, 'export');
  assert.equal(shard.shard, 'a');
  assert.equal(exp.count, exp.entries.length);
  assert.equal(exp.repos, undefined, 'entries, not repos');
  assert.deepEqual(
    exp.entries.find((r) => r.nodeId === 'R_kgDOFIXTUREA001'),
    shard.entries[0],
    'the same repository is the same entry in both documents'
  );
  assert.deepEqual(Object.keys(shard.entries[0]).sort(), [
    'adoptedAt',
    'apacheConversionDate',
    'badgeUrl',
    'licenseId',
    'licenseVersion',
    'name',
    'nodeId',
    'owner',
    'pageUrl',
    'recordUrl',
    'state',
    'weightClass',
  ]);

  // Meta names each shard's absolute URL and the export's, so a client never has to know
  // this producer's directory layout.
  const meta = readOut(out, 'registry/index/meta.json');
  assert.deepEqual(meta.shards.map((s) => s.shard), ['0', 'a', 'c', 'd']);
  assert.equal(meta.shards[1].url, 'https://api.purposesource.org/v1/registry/index/a.json');
  assert.equal(meta.exportUrl, 'https://api.purposesource.org/registry.json');
  // All three neutral states, not just `delisted` — a stale cached badge must never keep
  // asserting registration for a suspended repository either (FS10-032, WEB-085).
  assert.deepEqual(meta.delisted.sort(), ['R_kgDOFIXTUREC003', 'R_kgDOFIXTURED004', 'R_kgDOFIXTUREE005']);
});

test('every artifact whose schema admits it declares which plane produced it', (t) => {
  const ws = workspace('source', {});
  t.after(() => cleanup(ws));
  build(`${ws}/dist`);
  build(`${ws}/demo`, ['--include-examples']);

  // The publishable plane declares this producer; the plane carrying the seeded examples
  // declares itself non-production, which is what a `prod` deployment refuses to serve
  // (FS-10 §2 v0 note). The flag decides it, not the directory name.
  for (const rel of ['stats.json', 'registry.json', 'registry/index/meta.json', 'waivers/all.json',
    'registry/index/a.json', 'registry/repo/R_kgDOFIXTUREA001.json', 'waivers/R_kgDOFIXTUREA001.json']) {
    assert.equal(readOut(`${ws}/dist`, rel).source, 'registry-v0', rel);
    assert.equal(readOut(`${ws}/demo`, rel).source, 'sample', rel);
  }

  // The badge is the one artifact that cannot carry it: shields.io owns that body, so it
  // borrows the plane's declaration from meta.json — which is why meta carrying it above is
  // load-bearing and not decoration.
  assert.equal(readOut(`${ws}/dist`, 'badge/R_kgDOFIXTUREA001.json').source, undefined);
});

test('stats flips from pre-launch to launched-pre-disbursement on real data (VS-19)', (t) => {
  const ws = workspace('stats', { registry: ALL_STATES });
  t.after(() => cleanup(ws));

  // With data: launched, a real project count, and every ledger-derived figure null.
  build(`${ws}/withdata`);
  const s2 = readOut(`${ws}/withdata`, 'stats.json');
  assert.equal(s2.state, 'launched-pre-disbursement');
  assert.equal(s2.projectsRegistered, 3, 'verified + detected + suspended; quit and delisted are not registrations');
  assert.equal(s2.contributorsClaimed, null, 'no claim flow at v0 — structurally unknowable, not zero');
  // Both were counted off ledger rows until 2026-09-09. This producer holds no ledger
  // (FS-00 §6.10), so a figure could only come from somewhere other than the data — and a
  // 0 would assert that no company is covered and no franc has moved, which a registry has
  // no standing to say. check-artifacts.mjs fails the build on either.
  assert.equal(s2.companiesCovered, null, 'no ledger here — null, and never 0');
  assert.equal(s2.chfRoutedMinor, null, 'never "CHF 0" before a disbursement exists');

  assert.equal(s2.firstDisbursementScheduledFor, '2027-03-31', 'the fixture date, from --stats-config');

  // No registry at all: pre-launch, every numeric field null. No --stats-config: at
  // pre-launch the contract asks for no date, so the publishable configuration's null is
  // the right answer and the build says so rather than failing.
  const r = runScript('index-build-lite.mjs', [
    '--out', `${ws}/prelaunch`,
    '--registry-dir', `${ws}/empty-registry`,
  ]);
  // That directory does not exist, which loadRegistry treats as "nothing here" — the honest
  // pre-launch state for a repo whose curation has not started.
  assert.equal(r.code, 0, r.stderr);
  const s1 = readOut(`${ws}/prelaunch`, 'stats.json');
  assert.equal(s1.state, 'pre-launch');
  assert.equal(s1.firstDisbursementScheduledFor, null);
  for (const k of ['projectsRegistered', 'contributorsClaimed', 'companiesCovered', 'chfRoutedMinor', 'detectedUnclaimed']) {
    assert.equal(s1[k], null, `${k} must be null at pre-launch, not 0`);
  }
});

test('a publishable build that would name no first-disbursement date FAILS, and writes nothing', (t) => {
  const ws = workspace('nodate', {});
  t.after(() => cleanup(ws));
  const out = `${ws}/dist`;

  // The publishable path: real registry data (so the state is `launched-pre-disbursement`)
  // and no --stats-config, so the date comes from config/publish.json, where it is null and
  // is set by hand when a real one exists. `stats.v1` requires a date in that state. The
  // build must not resolve that by inventing one.
  const r = runScript('index-build-lite.mjs', ['--out', out, '--registry-dir', ALL_STATES]);

  assert.equal(r.code, 1, 'a guessed date is not an option, so the build fails');
  assert.match(r.stderr, /stats\.first-disbursement-date-missing/);
  assert.match(r.stderr, /config\/publish\.json/, 'the message names the one file where a real date is recorded');

  // And the artifact the contract forbids was never written. Everything before it was —
  // the build is not transactional — but a failed build publishes nothing, and the missing
  // counters would fail check-artifacts.mjs on their own.
  assert.throws(() => readOut(out, 'stats.json'), /ENOENT/);
});

test('this producer cannot emit a ledger or CT artifact, and the gate says so if one appears', (t) => {
  const ws = workspace('noledger', {});
  t.after(() => cleanup(ws));
  const out = `${ws}/dist`;
  build(out);

  // The flags that used to point the build at a ledger and a CT tree are gone, and
  // parseArgs refuses an unknown one rather than ignoring it — so the retirement cannot be
  // undone by an argument.
  const r = runScript('index-build-lite.mjs', [
    '--out', `${ws}/again`, '--registry-dir', ALL_STATES, '--ledger-dir', 'tests/fixtures',
  ]);
  assert.equal(r.code, 1, 'a --ledger-dir flag must not be silently accepted');

  // And if one is planted straight into the output, the gate rejects it: the catalog is a
  // closed set per producer, and this producer's half has no ledger in it. The planted path is
  // a REAL retired one, `ledger/chain.json` — a root-level `ledger-chain.json` would only
  // re-test what the next case already covers with `surprise.json`, and would leave the one
  // regression the two gate headers stake a claim on untested.
  writeJsonAt(join(REPO, out, 'ledger', 'chain.json'), { schemaVersion: 1, generatedAt: NOW });
  const g = runScript('check-artifacts.mjs', ['--dir', out, '--expect-examples', '--registry-dir', ALL_STATES]);
  assert.equal(g.code, 1);
  // BOTH errors, which is what tells this apart from a stray root file: the path is outside
  // the grammar AND it is not derivable from the committed sources. A retired subtree has to
  // fail on both counts, because either one alone could be a mapping oversight.
  assert.match(g.stderr, /not a path in the FS-00 §6\.2 artifact catalog/);
  assert.match(g.stderr, /NOT derivable from the committed sources/);
});

test('the artifact gate fails when the plane grows a path nobody agreed to', (t) => {
  const ws = workspace('extra', {});
  t.after(() => cleanup(ws));
  const out = `${ws}/dist`;
  build(out);

  writeJsonAt(join(REPO, out, 'surprise.json'), { schemaVersion: 1, generatedAt: NOW });
  const r = runScript('check-artifacts.mjs', [
    '--dir', out, '--expect-examples', '--registry-dir', ALL_STATES,
  ]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a path in the FS-00 §6\.2 artifact catalog/);
});

test('the artifact gate fails when an artifact the sources imply is MISSING', (t) => {
  const ws = workspace('missing', {});
  t.after(() => cleanup(ws));
  const out = `${ws}/dist`;
  build(out);

  rmSync(join(REPO, out, 'badge/R_kgDOFIXTUREA001.json'));
  const r = runScript('check-artifacts.mjs', [
    '--dir', out, '--expect-examples', '--registry-dir', ALL_STATES,
  ]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /MISSING from the build/);
});

test('SEEDED EXAMPLES NEVER REACH A PUBLISHED ARTIFACT', () => {
  // The real build, over the real registry — which holds nothing but examples today.
  const r = runScript('index-build-lite.mjs', ['--out', 'dist']);
  assert.equal(r.code, 0, r.stderr);
  const g = runScript('check-artifacts.mjs');
  assert.equal(g.code, 0, g.stderr);

  const everything = treeOf(join(REPO, 'dist'))
    .map(([, bytes]) => bytes.toString('utf8'))
    .join('\n');
  for (const token of ['psn-example-org', 'psn-example-lab', 'R_kgDOEXAMPLE0001', 'psn-example-admin']) {
    assert.ok(!everything.includes(token), `"${token}" leaked into the published plane`);
  }
  assert.equal(readOut('dist', 'stats.json').state, 'pre-launch');
});

test('the leakage gate actually catches a leak when one is planted', (t) => {
  const ws = workspace('leak', {});
  t.after(() => cleanup(ws));
  const out = `${ws}/dist`;

  const r = runScript('index-build-lite.mjs', ['--out', out]);
  assert.equal(r.code, 0, r.stderr);

  // Plant an example identifier in a legitimately-shaped artifact — and plant it as the
  // leak this gate actually exists to stop: a seeded demonstration repository appearing in
  // the published registry as though it had adopted the licence. The export entry below is
  // a valid `registry-index.v1` entry, so the planted leak is the ONLY thing wrong with the
  // plane, which is what makes this a test of the leakage gate rather than of some other
  // invariant.
  //
  // Two earlier homes for this plant are gone, both for the same reason: `stats.json`'s
  // `notes` array and `waivers/all.json`'s `note` were free text the published schemas do
  // not admit (`additionalProperties: false`), so they left the artifacts when the plane
  // was conformed to the contract. Nothing prose-shaped is left to plant in, and the entry
  // is a better subject anyway.
  const nodeId = 'R_kgDOEXAMPLE0001';
  const registry = readOut(out, 'registry.json');
  registry.entries.push({
    nodeId,
    owner: 'psn-example-org',
    name: 'widget-engine',
    state: 'quit',
    weightClass: 'major',
    recordUrl: `https://api.purposesource.org/v1/registry/repo/${nodeId}.json`,
  });
  registry.count = registry.entries.length;
  writeJsonAt(join(REPO, out, 'registry.json'), registry);

  const g = runScript('check-artifacts.mjs', ['--dir', out]);
  assert.equal(g.code, 1);
  assert.match(g.stderr, /belongs to a seeded `example: true` entry/);
});
