// The no-records gate's own counter-examples (VS-35).
//
// The gate's contract with CI is not "the matcher works" — it is "non-zero exit plus a
// message that names the path", which is why every gate in this suite is run as a real child
// process rather than imported. The gate self-tests its matcher in process on every run;
// this file tests the contract around it.
//
// PLANTED TREES LIVE IN THE OS TEMP DIRECTORY, NOT UNDER THIS ROOT. Every other guard test
// here builds its workspace under the repository, because those gates resolve `--dir`
// relative to it. This one must do the opposite: the gate walks the WHOLE repository, so a
// `records/x.json` planted under this root would be seen by any parallel run of the gate and
// could be committed by anyone who typed `git add -A` while the suite was mid-flight. The
// `--root` option exists for exactly this, and each tree is removed in a `finally` so a
// failing assertion still cleans up.
//
// The clean-tree half is asserted against the REAL repository root with no `--root` at all,
// so the default the gate uses in CI is the one under test.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { runScript, tempDir } from './helpers.mjs';

/** Builds a throwaway tree outside the repository and runs the gate over it. */
function onPlantedTree(plant) {
  // tempDir() hands back an OS temp directory, removed by the OS rather than by us — the
  // rule this suite already follows so a test can never rm -rf its way into the checkout.
  const dir = tempDir('no-records');
  plant(dir);
  return runScript('check-no-records.mjs', ['--root', dir]);
}

const file = (dir, rel, body = '{}\n') => {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
};

test('a planted records/x.json fails the gate, and the failure names the path', () => {
  const r = onPlantedTree((dir) => file(dir, join('records', 'x.json')));
  assert.equal(r.code, 1, `expected a non-zero exit. stdout: ${r.stdout}`);
  assert.match(r.stderr, /records\//, 'the failure names the offending path');
  assert.match(r.stderr, /never in a repository that is or becomes public/);
});

test('the store is caught at any depth — beside the registry entries, beside a ledger month', () => {
  for (const at of [join('registry', 'records', 'x.json'), join('ledger', 'records', 'log.jsonl')]) {
    const r = onPlantedTree((dir) => file(dir, at));
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /records\//);
  }
});

test('a rail export under paddle/ fails even where nothing is named records', () => {
  const r = onPlantedTree((dir) => file(dir, join('ct', 'paddle', 'txn_01H0.json')));
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /ct\/paddle\/txn_01H0\.json/);
});

test('the recording log fails by name, wherever it is put', () => {
  const r = onPlantedTree((dir) => file(dir, join('ledger', 'log.jsonl')));
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /ledger\/log\.jsonl/);
});

test('the same tree without the plant passes — the gate is not failing on the tree itself', () => {
  const r = onPlantedTree((dir) => {
    file(dir, join('registry', 'example.yml'), 'name: example\n');
    file(dir, join('ledger', '2026-09.json'));
    // Near misses: each is a legitimate name and none may fail the gate.
    file(dir, join('registry', 'recordings', 'note.md'), 'x\n');
    file(dir, 'paddle-notes.md', 'x\n');
    file(dir, join('ledger', 'log.json'));
  });
  assert.equal(r.code, 0, `expected a clean pass. stderr: ${r.stderr}`);
  assert.match(r.stdout, /none from the private recording store/);
});

test('a whole copied store reports one line, not one per file', () => {
  // The remedy is the same for every file in it — move the directory — so a hundred lines
  // would bury the one sentence that says so.
  const r = onPlantedTree((dir) => {
    for (const rel of ['log.jsonl', 'paddle/txn_a.json', 'paddle/txn_b.json', 'terms/v1.md']) {
      file(dir, join('records', ...rel.split('/')));
    }
  });
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.stderr.match(/records\/:/g)?.length, 1, r.stderr);
  assert.match(r.stderr, /no-records: 1 problem\(s\)/);
});

test('the reserved name is matched whatever its case — a copy off a case-folding disk still fails', () => {
  const r = onPlantedTree((dir) => file(dir, join('Records', 'x.json')));
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /Records\//);
});

test('this repository is clean, scanned at the default root the way CI scans it', () => {
  const r = runScript('check-no-records.mjs');
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /^ok {2}no-records: \d+ path\(s\) walked/m);
});
