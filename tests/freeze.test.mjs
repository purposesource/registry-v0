/**
 * The freeze switch — `config/publish.json`'s `frozen` block, read by
 * `scripts/validate-registry.mjs` (FS02-064, FS-00 §2).
 *
 * WHAT IS BEING PROVED. That the act of freezing this repository costs one edit to one
 * committed file and no workflow change at all: `registry-ci` already runs the validation
 * step on every push and every pull request, so a filled-in `frozen` block makes the NEXT
 * change to a record red on a gate that is already there. The mechanism lands now; the act
 * is a later commit's, and `frozen` is null in this tree — the first test below is what
 * says so and what would notice if it stopped being true.
 *
 * WHY A FIXTURE CONFIG RATHER THAN THE REAL ONE. Freezing the registry to test the freeze
 * would freeze the registry. `--config` exists for exactly this, on the same terms as the
 * `--dir` beside it, and the gate is run as a real process because its contract with CI is
 * "non-zero exit plus a message that names the file".
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { REPO, cleanup, readJson, runScript, workspace } from './helpers.mjs';
import { registryDigest } from '../scripts/lib/registry.mjs';

const EXPORTS_AT = 'https://api.purposesource.org/v1/registry/export.json';
const FREEZE_DATE = '2027-03-01';

const workspaces = [];
after(() => workspaces.forEach(cleanup));

/**
 * A throwaway copy of the fixture registry plus a publication config of its own, frozen at
 * whatever that copy currently digests to. Returns the paths the gate is run with.
 */
function frozenWorkspace(prefix, { digest, ...overrides } = {}) {
  const ws = workspace(prefix, { registry: 'tests/fixtures/registry-all-states' });
  workspaces.push(ws);

  const registryDir = `${ws}/registry`;
  const configDir = join(REPO, ws, 'config');
  mkdirSync(configDir, { recursive: true });
  const config = {
    ...readJson('config', 'publish.json'),
    frozen: {
      at: FREEZE_DATE,
      registryDigest: digest ?? registryDigest(join(REPO, registryDir)),
      headSha: 'f'.repeat(40),
      exportsAt: EXPORTS_AT,
      ...overrides,
    },
  };
  writeFileSync(join(configDir, 'publish.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { registryDir, configPath: `${ws}/config/publish.json` };
}

// `--allow-no-examples` because the fixture registry carries none: that rule is about the
// REAL tree keeping the tooling exercised, and it would otherwise fail every case here for
// a reason that has nothing to do with the freeze.
const validate = ({ registryDir, configPath }) =>
  runScript('validate-registry.mjs', [
    '--dir',
    registryDir,
    '--config',
    configPath,
    '--allow-no-examples',
  ]);

/** The first `registry/*.yml` of a workspace, by name — the file a test mutates. */
function firstRecord(registryDir) {
  const abs = join(REPO, registryDir);
  const name = readdirSync(abs)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()[0];
  return join(abs, name);
}

/* ---------------------------------------------------------------- the state of this tree */

test('this repository is NOT frozen: the switch is present and null', () => {
  const config = readJson('config', 'publish.json');
  assert.equal(
    Object.hasOwn(config, 'frozen'),
    true,
    'the key exists so that freezing is an edit to a value rather than an invention of a key',
  );
  assert.equal(
    config.frozen,
    null,
    'nothing is frozen by the commit that builds this mechanism — the act is a later one, ' +
      'and it waits on the platform plane serving the pointer the block will name',
  );
  assert.ok(
    Array.isArray(config._comment_frozen) && config._comment_frozen.join(' ').includes(EXPORTS_AT),
    'and the shape it takes at the freeze is written down beside it, pointer included',
  );
});

test('a null switch changes nothing: the real registry validates exactly as before', () => {
  const { code, stdout, stderr } = runScript('validate-registry.mjs');
  assert.equal(code, 0, `${stderr}\n${stdout}`);
  assert.match(stdout, /^ok {2}registry\(registry\)/m);
});

/* ------------------------------------------------------------------------ (a) unchanged */

test('a frozen registry whose tree is unchanged passes', () => {
  const paths = frozenWorkspace('freeze-clean');
  const { code, stdout, stderr } = validate(paths);

  assert.equal(code, 0, `a frozen registry that nobody changed is not an error:\n${stderr}\n${stdout}`);
  assert.match(stdout, /^ok {2}registry\(/m);
});

/* --------------------------------------------------------------------- (b) one byte moved */

test('one changed byte fails, and the message names the pointer and the freeze date', () => {
  const paths = frozenWorkspace('freeze-edited');

  // A comment line: the record still parses and still validates against the schema, so the
  // ONLY thing that can catch this is the digest. A change that broke the schema would
  // have failed for the wrong reason and proved nothing.
  appendFileSync(firstRecord(paths.registryDir), '# a change made after the freeze\n', 'utf8');

  const { code, stderr, stdout } = validate(paths);
  assert.equal(code, 1, `a post-freeze edit must fail:\n${stdout}`);
  assert.match(stderr, /FROZEN/);
  assert.match(stderr, new RegExp(FREEZE_DATE));
  assert.match(
    stderr,
    new RegExp(EXPORTS_AT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'a contributor who wanted to change a record is told where the registry lives now',
  );
});

/* ------------------------------------------------------------------------- (c) added file */

test('an added record fails even though the file itself is perfectly valid', () => {
  const paths = frozenWorkspace('freeze-added');
  const source = firstRecord(paths.registryDir);
  writeFileSync(join(REPO, paths.registryDir, 'zzz--added-after-freeze.yml'), readFileSync(source), 'utf8');

  const { code, stderr } = validate(paths);
  assert.equal(code, 1, 'the listing is part of the digest, so an addition moves it');
  assert.match(stderr, /FROZEN/);
  assert.match(stderr, new RegExp(EXPORTS_AT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a deleted record fails too — the digest covers absence as well as content', () => {
  const paths = frozenWorkspace('freeze-deleted');
  // Emptying a file changes its byte digest; removing it changes the listing. The second
  // is the one a digest over content alone would miss, so it is the one tested here.
  const abs = join(REPO, paths.registryDir);
  const names = readdirSync(abs).filter((f) => f.endsWith('.yml')).sort();
  assert.ok(names.length > 1, 'the fixture has more than one record to delete from');
  rmSync(join(abs, names[0]));

  const { code, stderr } = validate(paths);
  assert.equal(code, 1);
  assert.match(stderr, /FROZEN/);
});

/* --------------------------------------------------------------- the guard's own guards */

test('a freeze recorded without a digest is refused rather than trusted', () => {
  const paths = frozenWorkspace('freeze-no-digest', { registryDigest: undefined });
  const { code, stderr } = validate(paths);

  assert.equal(code, 1, 'a freeze with nothing to check against is a claim, not a guard');
  assert.match(stderr, /no `registryDigest`/);
});

test('the digest is the importer’s grammar: names and byte digests, sorted, hashed', () => {
  const dir = join(REPO, 'registry');
  const listing = readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((name) => `${name}\n${createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')}\n`)
    .join('');

  assert.equal(
    registryDigest(dir),
    createHash('sha256').update(listing, 'utf8').digest('hex'),
    'spelled out here rather than only called, because the value is written into a committed ' +
      'record at the freeze and the platform importer (V0Source.DigestOf) recomputes it from ' +
      'the same directory — two spellings of "what is in this tree" would be two answers ' +
      'nobody could reconcile at the one moment it matters',
  );
  assert.match(registryDigest(dir), /^[0-9a-f]{64}$/);
});

test('a directory with no records still digests, rather than throwing', () => {
  const ws = workspace('freeze-empty', {});
  workspaces.push(ws);
  assert.match(registryDigest(join(REPO, ws)), /^[0-9a-f]{64}$/, 'the digest of an empty listing');
});
