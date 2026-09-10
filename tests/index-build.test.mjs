// index-build-lite and the artifact-plane gate.
//
// Covers FS02-084 ("a merged change produces refreshed artifacts at all §7 paths within
// one build, with generatedAt advancing"), the determinism requirement behind it, and the
// honesty rules that make the plane publishable: detected repositories are counted and
// never listed, quit repositories get a neutral badge, waivers are empty, and no seeded
// example ever reaches a published artifact.

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { NOW, REPO, cleanup, runScript, treeOf, workspace } from './helpers.mjs';

/** Writes JSON to an ABSOLUTE path — the tests plant files inside temp build outputs. */
function writeJsonAt(abs, value) {
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const ALL_STATES = 'tests/fixtures/registry-all-states';

function build(outRel, extra = [], env = {}) {
  const r = runScript('index-build-lite.mjs', ['--out', outRel, '--registry-dir', ALL_STATES, ...extra], env);
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
  assert.equal(meta.counts.detectedNotListed, 1);
  assert.equal(meta.counts.byState.detected, 1);
  assert.equal(meta.counts.listed, 4);

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

test('every repo record carries an empty waiver list and no statistics block', (t) => {
  const ws = workspace('waivers', {});
  t.after(() => cleanup(ws));
  const out = `${ws}/dist`;
  build(out);

  const rec = readOut(out, 'registry/repo/R_kgDOFIXTUREA001.json');
  assert.deepEqual(rec.waivers, []);
  assert.equal(rec.stats, undefined, 'VS-18: no statistics block — PP and charity figures are Phase E+');
  assert.equal(rec.manifest.evaluated, false);
  assert.equal(rec.license.apacheConversionDate, '2030-11-01');

  assert.deepEqual(readOut(out, 'waivers/all.json').waivers, []);
  assert.match(readOut(out, 'waivers/all.json').note, /Phase E claim flow/);
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

  // No registry at all: pre-launch, every numeric field null.
  const r = runScript('index-build-lite.mjs', [
    '--out', `${ws}/prelaunch`,
    '--registry-dir', `${ws}/empty-registry`,
  ]);
  // That directory does not exist, which loadRegistry treats as "nothing here" — the honest
  // pre-launch state for a repo whose curation has not started.
  assert.equal(r.code, 0, r.stderr);
  const s1 = readOut(`${ws}/prelaunch`, 'stats.json');
  assert.equal(s1.state, 'pre-launch');
  for (const k of ['projectsRegistered', 'contributorsClaimed', 'companiesCovered', 'chfRoutedMinor', 'detectedUnclaimed']) {
    assert.equal(s1[k], null, `${k} must be null at pre-launch, not 0`);
  }
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

  // And if one is planted straight into the output, the path grammar rejects it: the
  // catalog is a closed set per producer, and this producer's half has no ledger in it.
  writeJsonAt(join(REPO, out, 'ledger-chain.json'), { schemaVersion: 1, generatedAt: NOW });
  const g = runScript('check-artifacts.mjs', ['--dir', out, '--expect-examples', '--registry-dir', ALL_STATES]);
  assert.equal(g.code, 1);
  assert.match(g.stderr, /not a path in the FS-00 §6\.2 artifact catalog/);
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

  // Plant an example identifier in a legitimately-shaped artifact. The free-text `note` of
  // the waiver registry is used because it is prose in a document with no hash over it, so
  // the planted leak is the ONLY thing wrong with the plane — which is what makes this a
  // test of the leakage gate rather than of some other invariant. (It used to be planted in
  // `stats.json`'s `notes` array; that array is gone, because `spec/schemas/stats.v1.json`
  // is `additionalProperties: false` and publishes no such field.)
  const waivers = readOut(out, 'waivers/all.json');
  waivers.note = `${waivers.note} psn-example-org/widget-engine`;
  writeJsonAt(join(REPO, out, 'waivers/all.json'), waivers);

  const g = runScript('check-artifacts.mjs', ['--dir', out]);
  assert.equal(g.code, 1);
  assert.match(g.stderr, /belongs to a seeded `example: true` entry/);
});
