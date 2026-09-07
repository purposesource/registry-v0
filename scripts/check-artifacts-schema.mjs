#!/usr/bin/env node
// Gate: every emitted artifact validates against its PUBLISHED schema in the `spec`
// repository.
//
//   node scripts/check-artifacts-schema.mjs [--dir dist] [--baseline]
//
// WHY THIS IS SEPARATE FROM check-artifacts.mjs
// That gate does not trust the build: it re-derives the expected artifact path set from
// registry/ + ledger/ + ct/ and asserts this repository's own invariants (path grammar,
// set equality, no example leakage, the honesty rules). It says nothing about whether the
// BYTES match the contract published to the world. This one does exactly that and nothing
// else, against `spec/schemas/*.json` — the schemas the public `purposesource/spec`
// repository ships, which is what an adopter or a scanner validates with.
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
// THE DIVERGENCE BASELINE
// Several classes are not merely carrying a stray key: they are a different contract from
// the schema (`registry.json`'s flat export, the snake_case ledger row set against a
// camelCase `ledger-row.v1`, `owner` as a string where the schema wants an object).
// Closing those re-specifies a frozen contract, which changes only by a dated FS-00 §6
// amendment note — not by a builder patch and not by loosening a published schema. Until
// that decision exists, `EXPECTED_DIVERGENCE` records the exact violation signatures each
// class produces today, and the gate FAILS on anything not in the list, FAILS when a class
// present in the run stops diverging while its entry survives, and reports the rest. It is
// the list of what is not yet enforced, printed on every run — not a way to be green.
// `--baseline` regenerates the block from the current output.

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
const MAP = [
  [/^stats\.json$/, 'stats.v1'],
  [/^badge\/.+\.json$/, 'badge.v1'],
  [/^registry\/index\/meta\.json$/, 'registry-index-meta.v1'],
  [/^registry\/index\/.+\.json$/, 'registry-index.v1'],
  [/^registry\.json$/, 'registry-index.v1'],
  [/^registry\/repo\/.+\.json$/, 'repo-record.v1'],
  [/^waivers\/.+\.json$/, 'waiver.v1'],
  [/^ledger\/chain\.json$/, 'ledger-chain.v1'],
  [/^ledger\/\d{4}-\d{2}\.json$/, 'ledger-export.v1'],
  [/^ct\/checkpoint-latest\.json$/, 'ct-checkpoint.v1'],
  [/^ct\/latest\.json$/, 'ct-segment.v1'],
  [/^ct\/\d+\.json$/, 'ct-segment.v1'],
];

// Emitted files with no published schema, each for a stated reason. This list is the
// honest half of the gate: it says out loud what is NOT checked.
const UNSCHEMATISED = new Map([
  ['meta/publish-log.json', 'publish batch records (FS-00 §6.2 amendment note); no schema published in spec/'],
]);

// The CSV twin of every ledger month is checked by check-artifacts.mjs against the JSON it
// mirrors. JSON Schema has nothing to say about it.
const NOT_JSON = /\.csv$/;

// Recorded 2026-09-07. Open question for the operator: which side is authoritative, the
// emitted plane or the published schema? Read the header before touching this.
//
// KEYED BY OUTPUT DIRECTORY, and it has to be. `dist` and `dist-demo` are different data:
// the demo plane carries the examples and the fixture ledger, so it exercises classes the
// publishable plane has none of, and a class can be clean in one and divergent in the
// other. One merged list would make every `dist` run trip the "this class is clean now"
// rule below and let every `dist-demo` run hide behind the other plane's debt.
//
// One entry below is a FIXTURE gap rather than a contract divergence, and is marked as
// such: `dist-demo`'s stats.json derives `launched-pre-disbursement` from the fixture
// ledger, and stats.v1 requires that state to name `firstDisbursementScheduledFor` so the
// empty money figure has a date attached instead of a shrug. config/publish.json holds
// null and says why in its own comment — the date is set by hand when a real one exists and
// is NEVER guessed. So the demo plane cannot satisfy the rule without inventing a date,
// which the honesty law forbids. The publishable `dist` plane is `pre-launch` and clean.
const EXPECTED_DIVERGENCE = {
  /** The publishable plane: registry/ + ledger/ + ct/ only, no examples. */
  "dist": {
    "ledger-chain.v1": [
      "(root) must NOT have additional properties {\"additionalProperty\":\"genesisHash\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"headSeq\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"locks\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"notes\"}",
      "(root) must have required property 'canonicalisation' {\"missingProperty\":\"canonicalisation\"}",
      "(root) must have required property 'genesisPrevHash' {\"missingProperty\":\"genesisPrevHash\"}",
      "/algorithm must be equal to constant {\"allowedValue\":\"sha256\"}",
      "/months/[] must NOT have additional properties {\"additionalProperty\":\"headHashAtMonthEnd\"}",
      "/months/[] must have required property 'headHash' {\"missingProperty\":\"headHash\"}",
      "/months/[] must have required property 'locked' {\"missingProperty\":\"locked\"}",
    ],
    "ledger-export.v1": [
      "(root) must NOT have additional properties {\"additionalProperty\":\"methodology\"}",
      "(root) must have required property 'headHash' {\"missingProperty\":\"headHash\"}",
      "/totals must NOT have additional properties {\"additionalProperty\":\"netIntakeMinor\"}",
      "/totals must NOT have additional properties {\"additionalProperty\":\"rowCount\"}",
    ],
    "registry-index-meta.v1": [
      "(root) must NOT have additional properties {\"additionalProperty\":\"counts\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"notes\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"shardOn\"}",
      "(root) must have required property 'totals' {\"missingProperty\":\"totals\"}",
    ],
    "registry-index.v1": [
      "(root) must NOT have additional properties {\"additionalProperty\":\"repos\"}",
      "(root) must have required property 'entries' {\"missingProperty\":\"entries\"}",
      "(root) must have required property 'shard' {\"missingProperty\":\"shard\"}",
    ],
    "waiver.v1": [
      "(root) must NOT have additional properties {\"additionalProperty\":\"count\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"note\"}",
    ],
  },
  /** The demo plane: examples plus the fixture ledger and CT. Never publishable. */
  "dist-demo": {
    "ct-segment.v1": [
      "/entries/[]/typ must be equal to one of the allowed values {\"allowedValues\":[\"contributor\",\"steward\",\"supporter\",\"license-status\",\"topup\"]}",
    ],
    "ledger-chain.v1": [
      "(root) must NOT have additional properties {\"additionalProperty\":\"genesisHash\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"headSeq\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"locks\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"notes\"}",
      "(root) must have required property 'canonicalisation' {\"missingProperty\":\"canonicalisation\"}",
      "(root) must have required property 'genesisPrevHash' {\"missingProperty\":\"genesisPrevHash\"}",
      "/algorithm must be equal to constant {\"allowedValue\":\"sha256\"}",
      "/months/[] must NOT have additional properties {\"additionalProperty\":\"headHashAtMonthEnd\"}",
      "/months/[] must have required property 'headHash' {\"missingProperty\":\"headHash\"}",
      "/months/[] must have required property 'locked' {\"missingProperty\":\"locked\"}",
    ],
    "ledger-export.v1": [
      "(root) must NOT have additional properties {\"additionalProperty\":\"methodology\"}",
      "(root) must have required property 'headHash' {\"missingProperty\":\"headHash\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"amount_minor\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"category_fund_id\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"co_id\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"corrects_led_id\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"created_at\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"emitting_job\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"ent_id\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"external_key\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"fx_date\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"fx_rate\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"fx_source\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"hold_status\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"led_id\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"month\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"payer_name\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"prev_hash\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"row_hash\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"row_type\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"schedule_version\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"src_amount_minor\"}",
      "/rows/[] must NOT have additional properties {\"additionalProperty\":\"src_currency\"}",
      "/rows/[] must have required property 'amountMinor' {\"missingProperty\":\"amountMinor\"}",
      "/rows/[] must have required property 'ledId' {\"missingProperty\":\"ledId\"}",
      "/rows/[] must have required property 'rowHash' {\"missingProperty\":\"rowHash\"}",
      "/rows/[] must have required property 'type' {\"missingProperty\":\"type\"}",
      "/totals must NOT have additional properties {\"additionalProperty\":\"netIntakeMinor\"}",
      "/totals must NOT have additional properties {\"additionalProperty\":\"rowCount\"}",
    ],
    "registry-index-meta.v1": [
      "(root) must NOT have additional properties {\"additionalProperty\":\"counts\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"notes\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"shardOn\"}",
      "(root) must have required property 'totals' {\"missingProperty\":\"totals\"}",
      "/shards/[] must have required property 'url' {\"missingProperty\":\"url\"}",
    ],
    "registry-index.v1": [
      "(root) must NOT have additional properties {\"additionalProperty\":\"repos\"}",
      "(root) must have required property 'entries' {\"missingProperty\":\"entries\"}",
      "(root) must have required property 'shard' {\"missingProperty\":\"shard\"}",
    ],
    "repo-record.v1": [
      "(root) must NOT have additional properties {\"additionalProperty\":\"impactCategoryDefaults\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"inboundFamily\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"repoUrl\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"stateNote\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"verify\"}",
      "/badge must NOT have additional properties {\"additionalProperty\":\"endpointUrl\"}",
      "/badge must have required property 'url' {\"missingProperty\":\"url\"}",
      "/license must NOT have additional properties {\"additionalProperty\":\"adopted\"}",
      "/license must NOT have additional properties {\"additionalProperty\":\"published\"}",
      "/license must have required property 'adoptedAt' {\"missingProperty\":\"adoptedAt\"}",
      "/manifest must NOT have additional properties {\"additionalProperty\":\"evaluated\"}",
      "/manifest must NOT have additional properties {\"additionalProperty\":\"note\"}",
      "/manifest must have required property 'present' {\"missingProperty\":\"present\"}",
      "/nodeId must match pattern \"^[A-Za-z0-9_-]{4,128}$\" {\"pattern\":\"^[A-Za-z0-9_-]{4,128}$\"}",
      "/owner must be object {\"type\":\"object\"}",
      "/waivers must be object {\"type\":\"object\"}",
    ],
    "stats.v1": [
      "(root) must match \"then\" schema {\"failingKeyword\":\"then\"}",
      "/firstDisbursementScheduledFor must be string {\"type\":\"string\"}",
    ],
    "waiver.v1": [
      "(root) must NOT have additional properties {\"additionalProperty\":\"count\"}",
      "(root) must NOT have additional properties {\"additionalProperty\":\"note\"}",
      "/nodeId must match pattern \"^[A-Za-z0-9_-]{4,128}$\" {\"pattern\":\"^[A-Za-z0-9_-]{4,128}$\"}",
    ],
  },
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
    if (NOT_JSON.test(rel)) continue;
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

  // The ratchet: a baseline entry may not outlive the divergence it records.
  const stillDiverging = [];
  const notExercised = [];
  for (const [key, signatures] of Object.entries(expected)) {
    const record = seen.get(key);
    if (!record || record.checked === 0) {
      notExercised.push(key);
      continue;
    }
    if (record.signatures.size === 0) {
      failures.add(
        key,
        `${record.checked} artifact(s) of this class now validate CLEANLY in ${args.dir}, but ` +
          `EXPECTED_DIVERGENCE["${args.dir}"] still records ${signatures.length} violation(s). ` +
          'Delete its entry — a baseline that outlives its divergence is an exemption nobody granted.',
      );
      continue;
    }
    stillDiverging.push([key, record]);
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
