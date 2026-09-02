// The registry schema and the semantic checks around it.
//
// FS02-084's acceptance criterion is "a schema-invalid PR fails CI", so each test below
// takes a KNOWN-GOOD entry and breaks exactly one thing. A suite that only proves the good
// case passes would let a rule be deleted without anything going red.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { load as yamlLoad } from 'js-yaml';

import { REPO, cleanup, runScript, workspace } from './helpers.mjs';
import { schemaValidator } from '../scripts/lib/repo.mjs';
import { conversionDate, entryFileName, shardOf } from '../scripts/lib/registry.mjs';

const validate = schemaValidator('registry-entry.v1.json');

const GOOD = yamlLoad(
  readFileSync(join(REPO, 'tests', 'fixtures', 'registry-all-states', 'psn-fixture-a--alpha-tool.yml'), 'utf8')
);

function mutated(patch, drop = []) {
  const e = structuredClone(GOOD);
  Object.assign(e, patch);
  for (const k of drop) delete e[k];
  return e;
}

test('the known-good fixture entry validates', () => {
  assert.deepEqual(validate(GOOD), []);
});

test('every required field is actually required', () => {
  for (const field of [
    'schema',
    'node_id',
    'owner',
    'name',
    'default_branch',
    'state',
    'license',
    'weight_class',
    'inbound_family',
    'contacts',
  ]) {
    const errs = validate(mutated({}, [field]));
    assert.ok(errs.length > 0, `dropping \`${field}\` must fail validation`);
  }
});

test('the state enum is the FS-02 §3 enum, verbatim and closed', () => {
  for (const s of ['detected', 'verified', 'suspended', 'quit', 'delisted']) {
    assert.deepEqual(validate(mutated({ state: s, state_note: 'x' })), [], `${s} must be accepted`);
  }
  for (const s of ['Verified', 'active', 'archived', 'unknown', '']) {
    assert.ok(validate(mutated({ state: s })).length > 0, `${JSON.stringify(s)} must be rejected`);
  }
});

test('WAIVERS CAN NEVER ENTER THE REGISTRY (D14, FS02-060)', () => {
  for (const key of ['waivers', 'waiver', 'waiver_powers', 'gratis_waivers']) {
    const errs = validate(mutated({ [key]: [] }));
    assert.ok(errs.length > 0, `\`${key}\` must be rejected by the schema`);
  }
});

test('platform state and money fields are rejected too', () => {
  for (const key of ['entitlements', 'impact_shares', 'amount_minor', 'stats', 'manifest', 'powers_suspended', 'allocation_frozen']) {
    assert.ok(validate(mutated({ [key]: 1 })).length > 0, `\`${key}\` must be rejected`);
  }
  // And anything else at all: the object is closed.
  assert.ok(validate(mutated({ something_new: true })).length > 0);
});

test('weight_class accepts only the two lowercase D11 classes', () => {
  assert.deepEqual(validate(mutated({ weight_class: 'standard' })), []);
  assert.deepEqual(
    validate(mutated({ weight_class: 'major', weight_class_approval_ref: 'https://example.org/a' })),
    []
  );
  for (const w of ['Standard', 'Major', 'huge', 2]) {
    assert.ok(validate(mutated({ weight_class: w })).length > 0);
  }
});

test('inbound_family is the FS02-010 four-value enum', () => {
  for (const f of ['permissive', 'copyleft', 'unknown', 'none']) {
    assert.deepEqual(validate(mutated({ inbound_family: f })), []);
  }
  assert.ok(validate(mutated({ inbound_family: 'mit' })).length > 0);
});

test('impact category defaults resolve against the curated menu only — free text impossible', () => {
  assert.deepEqual(validate(mutated({ impact_category_defaults: ['climate', 'health'] })), []);
  assert.ok(validate(mutated({ impact_category_defaults: ['puppies'] })).length > 0);
  assert.ok(validate(mutated({ impact_category_defaults: ['climate', 'climate'] })).length > 0, 'duplicates rejected');
  assert.ok(validate(mutated({ impact_category_defaults: [] })).length > 0, 'an empty list is not the same as absent');
});

test('node_id must look like a GitHub repository node id', () => {
  assert.deepEqual(validate(mutated({ node_id: 'R_kgDOAbc123' })), []);
  assert.deepEqual(validate(mutated({ node_id: 'MDEwOlJlcG9zaXRvcnk5MDEyMzQ1Njc=' })), []);
  for (const bad of ['abc123', 'U_kgDOAbc123', 'R_short', '', 'MDQ6VXNlcjE=']) {
    assert.ok(validate(mutated({ node_id: bad })).length > 0, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('contacts hold logins and URLs — an email address is structurally unrepresentable', () => {
  assert.ok(validate(mutated({ contacts: { admin_logins: ['maintainer@example.org'] } })).length > 0);
  assert.ok(validate(mutated({ contacts: { admin_logins: ['ok'], email: 'a@b.co' } })).length > 0);
  assert.ok(validate(mutated({ contacts: { admin_logins: [] } })).length > 0, 'at least one login');
});

test('licence dates and hash are shape-checked', () => {
  assert.ok(validate(mutated({ license: { ...GOOD.license, text_sha256: 'nope' } })).length > 0);
  assert.ok(validate(mutated({ license: { ...GOOD.license, text_sha256: 'AB'.repeat(32) } })).length > 0, 'uppercase hex rejected');
  assert.ok(validate(mutated({ license: { ...GOOD.license, adopted: '14-03-2027' } })).length > 0);
  assert.ok(validate(mutated({ license: { ...GOOD.license, id: 'MIT' } })).length > 0);
  const partial = { ...GOOD.license };
  delete partial.published;
  assert.ok(validate(mutated({ license: partial })).length > 0, 'the conversion-clock anchor is required');
});

// ---------------------------------------------------------------- derived-value helpers

test('the Apache-2.0 conversion date is the fourth anniversary of publication (D9)', () => {
  assert.equal(conversionDate('2027-03-14', 4), '2031-03-14');
  assert.equal(conversionDate('2028-02-29', 4), '2032-02-29');
  // Not a real 4-year case, but the clamp must exist because the offset is configuration.
  assert.equal(conversionDate('2028-02-29', 1), '2029-02-28');
});

test('filenames are derived from the entry, lowercased, split on the first --', () => {
  assert.equal(entryFileName('Acme', 'Widget-Engine'), 'acme--widget-engine.yml');
  // A repository name may itself contain `--`; an owner login never can.
  assert.equal(entryFileName('acme', 'foo--bar'), 'acme--foo--bar.yml');
});

test('shards are a closed set of 27', () => {
  assert.equal(shardOf('alpha'), 'a');
  assert.equal(shardOf('Zeta'), 'z');
  assert.equal(shardOf('9lives'), '0');
  assert.equal(shardOf('_x'), '0');
});

// -------------------------------------------------------- the gate as CI actually runs it

test('the committed registry passes the gate', () => {
  const r = runScript('validate-registry.mjs');
  assert.equal(r.code, 0, r.stderr);
});

test('a malformed entry fails the gate, and the message names the file and the reason', (t) => {
  const ws = workspace('badreg', { registry: 'tests/fixtures/registry-all-states' });
  t.after(() => cleanup(ws));

  const target = join(REPO, ws, 'registry', 'psn-fixture-a--alpha-tool.yml');
  writeFileSync(
    target,
    readFileSync(target, 'utf8').replace('weight_class: standard', 'weight_class: gigantic'),
    'utf8'
  );

  const r = runScript('validate-registry.mjs', ['--dir', `${ws}/registry`, '--allow-no-examples']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /psn-fixture-a--alpha-tool\.yml/);
  assert.match(r.stderr, /weight_class/);
});

test('a `waivers:` key fails the gate with the D14 reason, not an AJV path', (t) => {
  const ws = workspace('waiver', { registry: 'tests/fixtures/registry-all-states' });
  t.after(() => cleanup(ws));

  const target = join(REPO, ws, 'registry', 'psn-fixture-a--alpha-tool.yml');
  writeFileSync(target, `${readFileSync(target, 'utf8')}\nwaivers:\n  - id: wvr_x\n`, 'utf8');

  const r = runScript('validate-registry.mjs', ['--dir', `${ws}/registry`, '--allow-no-examples']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /dashboard/);
  assert.match(r.stderr, /D14/);
});

test('a filename that disagrees with the entry fails the gate', (t) => {
  const ws = workspace('fname', { registry: 'tests/fixtures/registry-all-states' });
  t.after(() => cleanup(ws));

  const from = join(REPO, ws, 'registry', 'psn-fixture-a--alpha-tool.yml');
  writeFileSync(join(REPO, ws, 'registry', 'wrong-name.yml'), readFileSync(from, 'utf8'), 'utf8');

  const r = runScript('validate-registry.mjs', ['--dir', `${ws}/registry`, '--allow-no-examples']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /filename must be `psn-fixture-a--alpha-tool\.yml`/);
  // The duplicate also trips the one-repository-one-registration rule.
  assert.match(r.stderr, /already appears in/);
});

test('a `major` class without a recorded approval reference fails the gate (FS02-071)', (t) => {
  const ws = workspace('major', { registry: 'tests/fixtures/registry-all-states' });
  t.after(() => cleanup(ws));

  const target = join(REPO, ws, 'registry', 'psn-fixture-e--delta-kit.yml');
  writeFileSync(
    target,
    readFileSync(target, 'utf8').replace(/^weight_class_approval_ref:.*$/m, ''),
    'utf8'
  );

  const r = runScript('validate-registry.mjs', ['--dir', `${ws}/registry`, '--allow-no-examples']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /weight_class_approval_ref/);
});

test('a quit or delisted entry without a reason class fails the gate (WEB-075)', (t) => {
  const ws = workspace('tomb', { registry: 'tests/fixtures/registry-all-states' });
  t.after(() => cleanup(ws));

  const target = join(REPO, ws, 'registry', 'psn-fixture-d--9lives.yml');
  writeFileSync(target, readFileSync(target, 'utf8').replace(/^state_note:.*$/m, ''), 'utf8');

  const r = runScript('validate-registry.mjs', ['--dir', `${ws}/registry`, '--allow-no-examples']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /state_note/);
});

test('an adoption dated before the licence version existed fails the gate', (t) => {
  const ws = workspace('dates', { registry: 'tests/fixtures/registry-all-states' });
  t.after(() => cleanup(ws));

  const target = join(REPO, ws, 'registry', 'psn-fixture-a--alpha-tool.yml');
  writeFileSync(
    target,
    readFileSync(target, 'utf8').replace('adopted: "2026-11-05"', 'adopted: "2026-10-01"'),
    'utf8'
  );

  const r = runScript('validate-registry.mjs', ['--dir', `${ws}/registry`, '--allow-no-examples']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /precedes license\.published/);
});
