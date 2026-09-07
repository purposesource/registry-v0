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
const FX_LEDGER = 'tests/fixtures/ledger';
const FX_CT = 'tests/fixtures/ct';

function build(outRel, extra = [], env = {}) {
  const r = runScript(
    'index-build-lite.mjs',
    ['--out', outRel, '--registry-dir', ALL_STATES, '--ledger-dir', FX_LEDGER, '--ct-dir', FX_CT, ...extra],
    env
  );
  assert.equal(r.code, 0, r.stderr);
  return join(REPO, outRel);
}

function readOut(outRel, ...parts) {
  return JSON.parse(readFileSync(join(REPO, outRel, ...parts), 'utf8'));
}

test('the full artifact set is emitted at exactly the FS-00 §6.2 paths', (t) => {
  const ws = workspace('build', {});
  t.after(() => cleanup(ws));
  const out = `${ws}/dist`;
  build(out);

  const paths = treeOf(join(REPO, out)).map(([p]) => p);
  assert.deepEqual(paths.sort(), [
    // shard `0` holds `9lives`; `a`, `c` and `d` hold the rest. `bravo-lib` is `detected`
    // and therefore in NO shard at all.
    'badge/R_kgDOFIXTUREA001.json',
    'badge/R_kgDOFIXTUREC003.json',
    'badge/R_kgDOFIXTURED004.json',
    'badge/R_kgDOFIXTUREE005.json',
    'ct/0.json',
    'ct/latest.json',
    'ledger/2026-11.csv',
    'ledger/2026-11.json',
    'ledger/2026-12.csv',
    'ledger/2026-12.json',
    'ledger/chain.json',
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
  const ws = workspace('stats', { registry: ALL_STATES, ledger: FX_LEDGER, ct: FX_CT });
  t.after(() => cleanup(ws));

  // With data: launched, real project/company counts, contributors and CHF still null.
  build(`${ws}/withdata`);
  const s2 = readOut(`${ws}/withdata`, 'stats.json');
  assert.equal(s2.state, 'launched-pre-disbursement');
  assert.equal(s2.projectsRegistered, 3, 'verified + detected + suspended; quit and delisted are not registrations');
  assert.equal(s2.companiesCovered, 2);
  assert.equal(s2.contributorsClaimed, null, 'no claim flow at v0 — structurally unknowable, not zero');
  assert.equal(s2.chfRoutedMinor, null, 'never "CHF 0" before a disbursement exists');

  // Empty sources: pre-launch, every numeric field null.
  const emptyReg = `${ws}/empty-registry`;
  const emptyLedger = `${ws}/empty-ledger`;
  const r = runScript('index-build-lite.mjs', [
    '--out', `${ws}/prelaunch`,
    '--registry-dir', emptyReg,
    '--ledger-dir', emptyLedger,
    '--ct-dir', FX_CT,
  ]);
  // Those directories do not exist, which loadRegistry/loadLedger treat as "nothing here"
  // — the honest pre-launch state for a repo whose curation has not started.
  assert.equal(r.code, 0, r.stderr);
  const s1 = readOut(`${ws}/prelaunch`, 'stats.json');
  assert.equal(s1.state, 'pre-launch');
  for (const k of ['projectsRegistered', 'contributorsClaimed', 'companiesCovered', 'chfRoutedMinor', 'detectedUnclaimed']) {
    assert.equal(s1[k], null, `${k} must be null at pre-launch, not 0`);
  }
});

test('the ledger CSV twin carries the same rows as the JSON (VS-37: divergence is a defect)', (t) => {
  const ws = workspace('csv', {});
  t.after(() => cleanup(ws));
  const out = `${ws}/dist`;
  build(out);

  const json = readOut(out, 'ledger/2026-11.json');
  const csv = readFileSync(join(REPO, out, 'ledger/2026-11.csv'), 'utf8').trimEnd().split('\n');
  assert.equal(csv.length - 1, json.rows.length, 'one data line per row, plus the header');
  assert.match(csv[0], /^seq,led_id,month,row_type,amount_minor,currency,/);
  for (const row of json.rows) {
    assert.ok(
      csv.some((line) => line.startsWith(`${row.seq},${row.led_id},`)),
      `row ${row.seq} is missing from the CSV`
    );
    assert.ok(csv.some((line) => line.includes(row.row_hash)), `row ${row.seq}'s hash is missing from the CSV`);
  }
});

test('a CSV cell containing a comma or a quote is escaped, not silently broken', (t) => {
  const ws = workspace('csvesc', { registry: ALL_STATES, ct: FX_CT, ledger: FX_LEDGER });
  t.after(() => cleanup(ws));

  const monthPath = join(REPO, ws, 'ledger', '2026-11.json');
  const month = JSON.parse(readFileSync(monthPath, 'utf8'));
  month.rows[0].note = 'a note with, a comma and a "quote"';
  // The row hash no longer matches, which is exactly what ledger-verify would catch; this
  // test is only about CSV rendering, so it writes the file straight and never verifies.
  writeJsonAt(monthPath, month);

  const r = runScript('index-build-lite.mjs', [
    '--out', `${ws}/dist`, '--registry-dir', ALL_STATES, '--ledger-dir', `${ws}/ledger`, '--ct-dir', FX_CT,
  ]);
  assert.equal(r.code, 0, r.stderr);
  const csv = readFileSync(join(REPO, ws, 'dist', 'ledger/2026-11.csv'), 'utf8');
  assert.ok(csv.includes('"a note with, a comma and a ""quote"""'), csv);
});

test('the artifact gate fails when the plane grows a path nobody agreed to', (t) => {
  const ws = workspace('extra', {});
  t.after(() => cleanup(ws));
  const out = `${ws}/dist`;
  build(out);

  writeJsonAt(join(REPO, out, 'surprise.json'), { schemaVersion: 1, generatedAt: NOW });
  const r = runScript('check-artifacts.mjs', [
    '--dir', out, '--expect-examples', '--registry-dir', ALL_STATES, '--ledger-dir', FX_LEDGER, '--ct-dir', FX_CT,
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
    '--dir', out, '--expect-examples', '--registry-dir', ALL_STATES, '--ledger-dir', FX_LEDGER, '--ct-dir', FX_CT,
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
