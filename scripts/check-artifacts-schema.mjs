#!/usr/bin/env node
// Gate: every emitted artifact validates against its PUBLISHED schema in the `spec`
// repository.
//
//   node scripts/check-artifacts-schema.mjs [--dir dist] [--baseline]
//
// WHY THIS IS SEPARATE FROM check-artifacts.mjs
// That gate does not trust the build: it re-derives the expected artifact path set from
// registry/ and asserts this repository's own invariants (path grammar, set equality, no
// example leakage, the honesty rules). It says nothing about whether the BYTES match the
// contract published to the world. This one does exactly that and nothing else, against
// `spec/schemas/*.json` — the schemas the public `purposesource/spec` repository ships,
// which is what an adopter or a scanner validates with.
//
// WHERE THE SCHEMAS COME FROM
// `PSN_SPEC_DIR`, else `../spec/schemas` (the monorepo layout), else `spec/schemas` (a CI
// checkout of the public spec repository beside this one — public, so no token). Never
// vendored: a copy would drift from the contract it is supposed to be checking.
//
// THE WEBSITE HAS A TWIN OF THIS SCRIPT
// `website/scripts/check-artifacts-schema.mjs` does the same job over the website
// builder's plane. The two are deliberately separate files because these are two separate
// GitHub repositories with no shared package — a common module would have to be published
// or vendored, and vendoring is what this gate exists to catch. They must stay in step:
// the mapping, the ajv settings and the baseline rules are the same by construction, and a
// change to one belongs in the same commit as the change to the other.
//
// THE DIVERGENCE BASELINE — EMPTY SINCE 2026-09-10, AND KEPT
// `EXPECTED_DIVERGENCE` records the exact violation signatures each class produces, and the
// gate FAILS on anything not in the list, FAILS on any recorded SIGNATURE that has stopped
// occurring (naming the line to delete — per signature and not per class, so a class that
// fixes all but one of its violations cannot sit green on the rest), and reports what
// remains. It is the list of what is not yet enforced, printed on every run — not a way to
// be green. `--baseline` regenerates the block from the current output.
//
// It is empty by DECISION, not by omission. The question it existed to hold open — which
// side moves, the emitted plane or the published schema — was answered on 2026-09-08: the
// schemas published in {ORG}/spec are the profile of the frozen contract, and a shape a
// schema does not admit is a defect in this builder. Both planes were conformed to it, so
// every class is enforced and there is nothing left to record.
//
// The block stays anyway, because a ratchet with nothing on it is exactly the ratchet that
// catches the NEXT drift: a new violation is unrecorded, and unrecorded is red. Adding an
// entry back is therefore a deliberate act and needs a dated note here saying which
// decision admits it and when it retires — a silent line is an exemption nobody granted.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import { Failures, ROOT, die, parseArgs } from './lib/repo.mjs';

// Both packages ship CommonJS and both shapes appear in the wild; normalise once.
const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const addFormats = addFormatsModule.default ?? addFormatsModule;

const args = parseArgs(process.argv.slice(2), {
  flags: ['baseline'],
  values: ['dir'],
  defaults: { dir: 'dist' },
});

const DIR = resolve(ROOT, args.dir);
const failures = new Failures(`artifacts-schema(${args.dir})`);

/* --------------------------------------------------------------------------- mapping */

// Public artifact path → schema key. ORDER MATTERS: literals before templates, because
// four literal names overlap a templated path (spec CHANGELOG open question 5).
//
// The registry half of the catalog, which is what this producer emits. The `ledger-chain.v1`,
// `ledger-export.v1`, `ct-segment.v1` and `ct-checkpoint.v1` rows left with their sources on
// 2026-09-09 (FS-00 §6.10) and live in the website's twin of this file. Nothing is unmapped
// as a result: an unmapped artifact is a FAILURE here, so a ledger path reappearing in this
// plane is reported rather than skipped.
const MAP = [
  [/^stats\.json$/, 'stats.v1'],
  [/^badge\/.+\.json$/, 'badge.v1'],
  [/^registry\/index\/meta\.json$/, 'registry-index-meta.v1'],
  [/^registry\/index\/.+\.json$/, 'registry-index.v1'],
  [/^registry\.json$/, 'registry-index.v1'],
  [/^registry\/repo\/.+\.json$/, 'repo-record.v1'],
  [/^waivers\/.+\.json$/, 'waiver.v1'],
];

// Emitted files with no published schema, each for a stated reason. This list is the
// honest half of the gate: it says out loud what is NOT checked.
const UNSCHEMATISED = new Map([
  ['meta/publish-log.json', 'publish batch records (FS-00 §6.2 amendment note); no schema published in spec/'],
]);

// Every artifact this producer emits is JSON. The one non-JSON member of the catalog is the
// CSV twin of a ledger month, which left with the ledger on 2026-09-09; the website's twin
// of this file skips it there, against the JSON it mirrors, because JSON Schema has nothing
// to say about a CSV.

// KEYED BY OUTPUT DIRECTORY, and it has to be. `dist` and `dist-demo` are different data:
// the demo plane carries the examples, so it exercises classes the publishable plane has
// none of, and a class can be clean in one and divergent in the other. One merged list would
// make every `dist` run trip the "this class is clean now" rule below and let every
// `dist-demo` run hide behind the other plane's debt. Both are present and both are empty:
// a MISSING key is a hard failure ("no divergence baseline recorded for --dir ..."), so a
// plane can never borrow the other's, and an empty object is what says "measured, nothing
// diverges" rather than "nobody looked".
const EXPECTED_DIVERGENCE = {
  /** The publishable plane: registry/ only, no examples. */
  "dist": {},
  /** The demo plane: the seeded examples. Never publishable. */
  "dist-demo": {},
};

/* --------------------------------------------------------------------------- schemas */

function resolveSpecDir() {
  const candidates = [process.env.PSN_SPEC_DIR, join(ROOT, '..', 'spec', 'schemas'), join(ROOT, 'spec', 'schemas')]
    .filter(Boolean);
  for (const candidate of candidates) {
    const dir = resolve(ROOT, candidate);
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  }
  return die(
    'no schema directory found. Set PSN_SPEC_DIR, or check out the public ' +
      `purposesource/spec repository beside this one. Tried: ${candidates.join(', ')}.`,
  );
}

const SPEC_DIR = resolveSpecDir();

function loadValidators() {
  // The same four settings spec/scripts/lib/spec.mjs uses, for the same reasons: `x-psn`
  // is the annotation block every schema carries; several artifact fields are honestly
  // `["integer","null"]`; the conditional rules are `allOf: [{ if, then: required }]` with
  // the properties declared once at the object root.
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  ajv.addKeyword({ keyword: 'x-psn', metaSchema: { type: 'object' } });

  const byKey = new Map();
  for (const name of readdirSync(SPEC_DIR).filter((f) => f.endsWith('.json')).sort()) {
    const schema = JSON.parse(readFileSync(join(SPEC_DIR, name), 'utf8'));
    ajv.addSchema(schema, schema.$id);
    byKey.set(name.replace(/\.json$/, ''), schema.$id);
  }
  return { ajv, byKey };
}

/* ----------------------------------------------------------------------------- plane */

function walk(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, base, acc);
    else acc.push(relative(base, path).split(/[\\/]/).join('/'));
  }
  return acc;
}

/**
 * One violation, with array indices collapsed to `[]` — the signature must be structural,
 * not a function of how many rows a fixture happens to have.
 */
function signature(error) {
  const pointer = (error.instancePath || '(root)').replace(/\/\d+(?=\/|$)/g, '/[]');
  return `${pointer} ${error.message} ${JSON.stringify(error.params)}`;
}

function main() {
  let root;
  try {
    root = statSync(DIR);
  } catch {
    die(`${args.dir}/ does not exist — run \`npm run build\` first.`);
  }
  if (!root.isDirectory()) die(`${args.dir} is not a directory.`);

  const expected = EXPECTED_DIVERGENCE[args.dir];
  if (!expected) {
    die(
      `no divergence baseline recorded for --dir ${args.dir}. Known: ` +
        `${Object.keys(EXPECTED_DIVERGENCE).join(', ')}. Add one with --baseline rather than ` +
        'letting this directory borrow the other plane\'s.',
    );
  }

  const { ajv, byKey } = loadValidators();
  const seen = new Map();
  let validated = 0;

  for (const rel of walk(DIR)) {
    const entry = MAP.find(([pattern]) => pattern.test(rel));
    if (!entry) {
      if (!UNSCHEMATISED.has(rel)) {
        failures.add(
          rel,
          'no schema mapped and not on the UNSCHEMATISED list. Either map it in MAP or ' +
            'record why it has no published schema — an unmapped artifact means the plane ' +
            'grew a surface nobody reviewed.',
        );
      }
      continue;
    }
    const key = entry[1];
    const schemaId = byKey.get(key);
    if (!schemaId) {
      failures.add(rel, `mapped to ${key}, which is not published in ${relative(ROOT, SPEC_DIR)}.`);
      continue;
    }
    const validate = ajv.getSchema(schemaId);

    let instance;
    try {
      instance = JSON.parse(readFileSync(join(DIR, rel), 'utf8'));
    } catch (err) {
      failures.add(rel, `unreadable — ${err.message}`);
      continue;
    }

    validated += 1;
    const record = seen.get(key) ?? { checked: 0, signatures: new Set() };
    record.checked += 1;
    seen.set(key, record);

    if (validate(instance)) continue;

    const baseline = new Set(expected[key] ?? []);
    for (const error of validate.errors ?? []) {
      const sig = signature(error);
      record.signatures.add(sig);
      if (!baseline.has(sig)) failures.add(rel, `(${key}) ${sig}`);
    }
  }

  // The ratchet: a baseline entry may not outlive the divergence it records — PER
  // SIGNATURE, not per class. The re-spec lands one schema and often one field at a time,
  // so a class that fixed all but one of its recorded violations would sit green on the
  // rest under a class-level rule. A class this plane did not emit is skipped rather than
  // demanded: `dist` has no repo record, and asking for its signatures would be asking
  // about artifacts that do not exist.
  const stillDiverging = [];
  const notExercised = [];
  for (const [key, signatures] of Object.entries(expected)) {
    const record = seen.get(key);
    if (!record || record.checked === 0) {
      notExercised.push(key);
      continue;
    }
    const gone = signatures.filter((sig) => !record.signatures.has(sig));
    if (gone.length === signatures.length) {
      failures.add(
        key,
        `${record.checked} artifact(s) of this class now validate CLEANLY in ${args.dir}, but ` +
          `EXPECTED_DIVERGENCE["${args.dir}"] still records ${signatures.length} violation(s). ` +
          'Delete its entry — a baseline that outlives its divergence is an exemption nobody granted.',
      );
      continue;
    }
    for (const sig of gone) {
      failures.add(
        key,
        `this recorded violation no longer occurs in ${args.dir}, so the baseline is stale — ` +
          `delete the line from EXPECTED_DIVERGENCE["${args.dir}"]: ${sig}`,
      );
    }
    if (record.signatures.size > 0) stillDiverging.push([key, record]);
  }

  if (args.baseline) {
    const block = {};
    for (const [key, record] of seen) {
      if (record.signatures.size > 0) block[key] = [...record.signatures].sort();
    }
    process.stdout.write(`${JSON.stringify(block, null, 2)}\n`);
    return;
  }

  if (stillDiverging.length > 0) {
    process.stdout.write(
      `  RECORDED DIVERGENCE (${args.dir}) — ${stillDiverging.length} class(es) do not match the\n` +
        '  published schema and are not enforced here. Each needs a dated FS-00 §6 amendment\n' +
        '  note (or a spec CHANGELOG entry) deciding which side moves:\n',
    );
    for (const [key, record] of stillDiverging.sort((a, b) => a[0].localeCompare(b[0]))) {
      process.stdout.write(
        `    · ${key} — ${record.signatures.size} distinct violation(s) over ${record.checked} artifact(s)\n`,
      );
    }
  }
  if (notExercised.length > 0) {
    process.stdout.write(
      `  (${notExercised.length} recorded class(es) not emitted by this plane: ${notExercised.sort().join(', ')})\n`,
    );
  }

  const enforced = [...seen.keys()].filter((k) => !expected[k]).sort();
  failures.finish(
    `${validated} artifact(s) against ${relative(ROOT, SPEC_DIR).split(/[\\/]/).join('/')}, ` +
      `0 unrecorded violations; fully enforced: ${enforced.length ? enforced.join(', ') : 'none'}`,
  );
}

main();
