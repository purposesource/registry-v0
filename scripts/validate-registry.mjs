#!/usr/bin/env node
// Registry validation gate — FS02-061.
//
//   node scripts/validate-registry.mjs [--dir registry] [--allow-no-examples]
//
// Runs on every PR. Validates every registry/*.yml against
// schema/registry-v0-record.v1.json — the VENDORED copy of the published record contract,
// byte-identical to it and checked against it in CI — then applies the checks a JSON
// Schema cannot express: filename agreement, cross-repo uniqueness, node_id decodability,
// date sanity, the conditional weight-class approval rule, the no-PII rule, and the
// schema/config agreement that keeps the category menu from drifting.
//
// FS02-063: any failure here FAILS THE BUILD. A broken registry never half-publishes,
// because a half-published registry is a set of public claims about other people's
// repositories.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Failures, ROOT, categoryMenu, config, parseArgs, readJsonFile, schemaValidator } from './lib/repo.mjs';
import { REGISTRY_DIR, STATES, entryFileName, loadRegistry, shardOf } from './lib/registry.mjs';

// `--dir` exists so the tests can validate fixture registries; `--allow-no-examples` so a
// fixture directory is not forced to carry a seeded example of its own.
const args = parseArgs(process.argv.slice(2), {
  flags: ['allow-no-examples'],
  values: ['dir'],
  defaults: { dir: 'registry' },
});

const cfg = config();
const DIR = args.dir === 'registry' ? REGISTRY_DIR : join(ROOT, args.dir);
const label = args.dir.split('\\').join('/');
const failures = new Failures(`registry(${label})`);
const SCHEMA_FILE = 'registry-v0-record.v1.json';
const validate = schemaValidator(SCHEMA_FILE);

// ---------------------------------------------------------------- schema/config parity
//
// The category menu exists in two places here by necessity: the JSON Schema must be
// self-contained so a scanner can validate a record with nothing but the schema file, and
// config/category-funds.json must exist so the build can render category names. BOTH are
// vendored copies of the published contract set, and the workflow checks their bytes
// against it on every run — but a byte check upstream says nothing about the two files
// agreeing with each other, and two copies of one list is a drift bug waiting to happen.
// So assert equality rather than trusting a convention.
{
  const schemaFile = readJsonFile(join(ROOT, 'schema', SCHEMA_FILE));
  const inSchema = [...schemaFile.$defs.categorySlug.enum].sort();
  const menu = categoryMenu();
  const inConfig = menu.categories.map((c) => c.slug).sort();
  if (inSchema.join(',') !== inConfig.join(',')) {
    failures.add(
      'config/category-funds.json',
      `the category slug set (${inConfig.join(', ')}) differs from the enum in ` +
        `schema/${SCHEMA_FILE} (${inSchema.join(', ')}). Both must list the same ` +
        'published menu (ENG-033, D33 item 1); both are vendored, so fix the published copy ' +
        'and re-vendor rather than editing either one here.'
    );
  }
  const seenIds = new Set();
  for (const c of menu.categories) {
    if (c.category_id !== `cat-${c.slug}`) {
      failures.add('config/category-funds.json', `category_id for "${c.slug}" should be "cat-${c.slug}", got "${c.category_id}".`);
    }
    if (seenIds.has(c.category_id)) failures.add('config/category-funds.json', `duplicate category_id ${c.category_id}.`);
    seenIds.add(c.category_id);
  }
  const n = menu.categories.length;
  if (n !== 7) {
    failures.add(
      'config/category-funds.json',
      `the published menu holds exactly the seven categories of the statutes' Art. 7 ` +
        `(D33 item 1); this one holds ${n}. The count is constitutional, not a bound to tune ` +
        '(ENG-033 permitted 5 to 8 before the decision).'
    );
  }
}

// ------------------------------------------------------------------------ entry checks

if (!existsSync(DIR)) {
  failures.add(`${label}/`, 'directory is missing.');
  failures.finish('nothing to validate');
}

const loaded = loadRegistry(DIR);

// Files that are not entries at all.
{
  for (const f of readdirSync(DIR)) {
    if (f.endsWith('.yaml')) {
      failures.add(`${label}/${f}`, 'the extension is `.yml`, not `.yaml`. One spelling keeps the filename rule mechanical.');
    } else if (!f.endsWith('.yml')) {
      failures.add(`${label}/${f}`, 'this directory holds registry entries only, one `.yml` file per repository.');
    }
  }
}

const byNodeId = new Map();
const byFileName = new Map();
const byOwnerName = new Map();

// The keys a registry entry may never carry, with the reason a contributor needs to read.
// `additionalProperties: false` already rejects them; this turns the rejection into an
// explanation. The waiver ban is the one that matters most: it is a D14 decision, not a
// schema preference.
const FORBIDDEN_KEYS = {
  waivers: 'Waivers are issued ONLY from the platform dashboard by a claimed admin (D14) and can never enter the registry by PR. At v0 the /waivers/* artifacts render the honest empty state (FS02-060, VS-18).',
  waiver: 'See `waivers`: waiver issuance is dashboard-only, from P-M3.',
  waiver_powers: 'Steward powers are platform state, not registry data (FS02-020 flags F1/F2).',
  gratis_waivers: 'The gratis-waiver guarantee is a constitutional clause, not a per-repo field.',
  entitlements: 'Entitlements are FS-05 state, published as signed JWS records, never as registry YAML.',
  impact_shares: 'Impact Shares are computed from attribution snapshots (FS-06), never declared.',
  amount_minor: 'No money figure belongs in the registry. Money is recorded only in the v0 ledger, which is the website repository\'s (FS-00 §6.10) and reaches it through its own append tool — never through a registry entry.',
  stats: 'Per-repo statistics are computed into the repo record and /stats.json; a declared figure would be an unbacked claim (D21).',
  manifest: 'PURPOSE.yml lives in the repository, not here, and is optional overrides only (D23). v0 does not parse it.',
  powers_suspended: 'An orthogonal private flag (FS02-020 F1), not registry data.',
  allocation_frozen: 'An orthogonal private flag (FS02-020 F2), not registry data.',
};

const EMAIL_SHAPED = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function walkStrings(value, path, visit) {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, `${path}[${i}]`, visit));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walkStrings(v, `${path}.${k}`, visit);
  }
}

for (const { file, data } of loaded) {
  const at = `${label}/${file}`;

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    failures.add(at, 'the file must contain one YAML mapping.');
    continue;
  }

  // Named bans first: they produce a better message than the schema's generic one, and a
  // contributor who tripped over `waivers:` should read the D14 reason, not an AJV path.
  for (const [key, why] of Object.entries(FORBIDDEN_KEYS)) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      failures.add(at, `the key \`${key}\` is not allowed. ${why}`);
    }
  }

  for (const err of validate(data)) failures.add(at, err);

  if (typeof data.owner !== 'string' || typeof data.name !== 'string') continue;

  // --- filename agreement -------------------------------------------------------------
  const expected = entryFileName(data.owner, data.name);
  if (file !== expected) {
    failures.add(
      at,
      `filename must be \`${expected}\` (owner and name, lowercased, joined by \`--\`). ` +
        'The filename is derived from the entry, so a rename is a file rename.'
    );
  }
  if (byFileName.has(expected)) {
    failures.add(at, `collides with registry/${byFileName.get(expected)} — filenames are compared case-insensitively because checkouts on macOS and Windows are.`);
  } else {
    byFileName.set(expected, file);
  }

  const ownerName = `${data.owner.toLowerCase()}/${data.name.toLowerCase()}`;
  if (byOwnerName.has(ownerName)) {
    failures.add(at, `owner/name ${ownerName} already appears in registry/${byOwnerName.get(ownerName)}.`);
  } else {
    byOwnerName.set(ownerName, file);
  }

  // --- node_id ------------------------------------------------------------------------
  if (typeof data.node_id === 'string') {
    if (byNodeId.has(data.node_id)) {
      failures.add(
        at,
        `node_id ${data.node_id} already appears in registry/${byNodeId.get(data.node_id)}. ` +
          'node_id is the primary key everywhere (FS-00 §6.1) — one repository, one registration (FS02-095).'
      );
    } else {
      byNodeId.set(data.node_id, file);
    }
    // The legacy form is base64 of `010:Repository<dbid>`; decode and check, which a
    // pattern cannot do. This is the FS02-095 "one node_id = one registration" key, so a
    // node_id that is actually a USER or ORGANISATION id must not slip through.
    if (data.node_id.startsWith('MD')) {
      const decoded = Buffer.from(data.node_id, 'base64').toString('utf8');
      if (!/^010:Repository\d+$/.test(decoded)) {
        failures.add(
          at,
          `node_id decodes to ${JSON.stringify(decoded)}, which is not a repository id. ` +
            'A legacy GitHub repository node_id decodes to `010:Repository<number>`.'
        );
      }
    }
  }

  // --- state --------------------------------------------------------------------------
  if (typeof data.state === 'string' && !STATES.includes(data.state)) {
    failures.add(at, `state must be one of ${STATES.join(' | ')} (FS-02 §3, verbatim).`);
  }
  if ((data.state === 'delisted' || data.state === 'quit') && typeof data.state_note !== 'string') {
    failures.add(
      at,
      `state "${data.state}" needs a \`state_note\`: the public page is a neutral tombstone that names a reason class (WEB-075), and a page with no reason reads as an accusation.`
    );
  }

  // --- licence dates ------------------------------------------------------------------
  if (data.license && typeof data.license === 'object') {
    const { id, version, published, adopted } = data.license;
    if (typeof id === 'string' && typeof version === 'string' && id !== `PurposeSource-${version}`) {
      failures.add(at, `license.id "${id}" and license.version "${version}" disagree — id is \`PurposeSource-{version}\`.`);
    }
    if (typeof published === 'string' && typeof adopted === 'string' && adopted < published) {
      failures.add(at, `license.adopted (${adopted}) precedes license.published (${published}) — a version cannot be adopted before it exists.`);
    }
    if (typeof adopted === 'string' && data.curation && typeof data.curation.recorded_at === 'string') {
      if (data.curation.recorded_at.slice(0, 10) < adopted) {
        failures.add(at, `curation.recorded_at (${data.curation.recorded_at.slice(0, 10)}) precedes license.adopted (${adopted}) — the registry records an adoption that already happened (D13: the repo's LICENSE file is the truth, this file is the cache).`);
      }
    }
  }

  // --- weight class -------------------------------------------------------------------
  if (data.weight_class === 'major' && typeof data.weight_class_approval_ref !== 'string') {
    failures.add(
      at,
      'weight_class `major` requires `weight_class_approval_ref`. `standard -> major` takes effect only on steward approval (FS02-071); merging this entry IS that approval being recorded, so the reference must be reviewable.'
    );
  }
  if (data.weight_class === 'standard' && typeof data.weight_class_approval_ref === 'string') {
    failures.add(at, 'weight_class_approval_ref applies to `major` only; `major -> standard` is immediate and needs no approval (FS02-071).');
  }

  // --- no PII -------------------------------------------------------------------------
  walkStrings(data, 'entry', (s, path) => {
    if (EMAIL_SHAPED.test(s)) {
      failures.add(
        at,
        `${path} contains email-shaped text. This repository is data class P0-public (FS-00 §6.9); the only person-identifying data it may hold is a GitHub login (D15).`
      );
    }
  });

  // --- shard sanity -------------------------------------------------------------------
  // Not a rule so much as a tripwire: if shardOf ever stops returning a member of the
  // closed shard set, every index URL changes, so catch it at the source.
  const shard = shardOf(data.name);
  if (!/^[a-z0]$/.test(shard)) {
    failures.add(at, `internal: shardOf("${data.name}") returned "${shard}", which is not in the closed shard set.`);
  }
}

// -------------------------------------------------------------------------- examples

const exampleCount = loaded.filter(({ data }) => data && data.example === true).length;
const realCount = loaded.length - exampleCount;
if (exampleCount === 0 && !args['allow-no-examples']) {
  failures.add(
    `${label}/`,
    'no `example: true` entry is present. The seeded examples are what the build, the artifact checks, and the tests run against; deleting them leaves the tooling unexercised.'
  );
}

failures.finish(
  `${loaded.length} entr${loaded.length === 1 ? 'y' : 'ies'} valid ` +
    `(${realCount} publishable, ${exampleCount} seeded example${exampleCount === 1 ? '' : 's'}); ` +
    `org=${cfg.org} domain=${cfg.domain}`
);
