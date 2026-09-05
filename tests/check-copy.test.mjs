// The copy gate's own counter-examples.
//
// MARKETING §3 as amended by D29 (2026-09-05) forbids the shortening "100% of profits go to
// charity" by name and permits exactly one "goes to charity" sentence — the one whose
// qualifier sits between the noun and the destination. Catching the first and passing the
// second is the whole job of the uncapped-charity rule, so both sides are pinned here as a
// process-level test of the gate's contract (non-zero exit, a message naming the file and
// line), the way every other gate in this suite is tested.
//
// The tests directory is itself scanned by the gate, so the forbidden strings are assembled
// at run time and written to a temp file outside the repository — never committed anywhere
// the gate reads.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { runScript, tempDir } from './helpers.mjs';

// "100%" and "100 %", assembled so this file never carries the claim it tests for.
const PCT = `${100}%`;
const PCT_SPACED = `${100} %`;

function probe(name, lines) {
  const file = join(tempDir('copy'), `${name}.md`);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return runScript('check-copy.mjs', ['--probe', file]);
}

const FORBIDDEN = [
  `${PCT} to charity`,
  `${PCT} of profits go to charity`,
  `${PCT} of profit goes to charity`,
  `${PCT_SPACED} of profits go to charity`,
  `${PCT} of the profits go to charity`,
];

for (const line of FORBIDDEN) {
  test(`the uncapped-charity rule catches ${JSON.stringify(line)}`, () => {
    const r = probe('forbidden', ['# probe', line]);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /banned copy/);
    assert.match(r.stderr, /:2: /, 'the failure names the line');
  });
}

test('the permitted D29 §6.2 sentence passes — its qualifier sits between the noun and the destination', () => {
  const r = probe('permitted', [
    '# probe',
    `${PCT} of profit beyond published operating needs goes to charity and to charity programmes.`,
    'The direct costs charged to Purpose Fees are capped and published to the invoice, and any cost support is listed by name.',
    'Every recorded allocation and disbursement is independently reconcilable.',
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 file\(s\) scanned/);
});

test('a probe scans only the probed file — the vacuous-scan guard does not fire on it', () => {
  const r = probe('lone', ['# probe', 'Nothing to see.']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /pass vacuously/);
});
