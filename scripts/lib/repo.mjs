// Shared plumbing: where the repo is, what the published constants are, how a
// deterministic timestamp is obtained, and how every artifact is serialised.
//
// The rule this file exists to enforce is FS-00 §6.8's "never silently degrade": a
// missing input is a hard failure with a message that names the input, never a default
// that lets a half-configured build publish.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { load as yamlLoad } from 'js-yaml';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Exit code every gate in this repo uses for "the data is wrong". */
export const EXIT_FAIL = 1;

// ---------------------------------------------------------------------------- logging

const CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

/** A GitHub-annotated error line when running in Actions, a plain one otherwise. */
export function errorLine(message) {
  process.stderr.write(CI ? `::error::${message}\n` : `ERROR  ${message}\n`);
}

export function noteLine(message) {
  process.stdout.write(`  ${message}\n`);
}

/**
 * Collects failures so one run reports every problem instead of stopping at the first —
 * a reviewer fixing a PR wants the whole list.
 */
export class Failures {
  constructor(gateName) {
    this.gate = gateName;
    this.items = [];
  }
  add(where, message) {
    this.items.push({ where, message });
  }
  get count() {
    return this.items.length;
  }
  /** Prints everything and exits non-zero if anything failed. Returns on success. */
  finish(successMessage) {
    if (this.items.length === 0) {
      process.stdout.write(`ok  ${this.gate}: ${successMessage}\n`);
      return;
    }
    for (const { where, message } of this.items) errorLine(`${where}: ${message}`);
    errorLine(`${this.gate}: ${this.items.length} problem(s) — see above.`);
    process.exit(EXIT_FAIL);
  }
}

/** Unrecoverable: a missing file, an unusable configuration. No partial run follows. */
export function die(message) {
  errorLine(message);
  process.exit(EXIT_FAIL);
}

// ------------------------------------------------------------------------- file access

export function readText(...parts) {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

export function readJsonFile(absPath) {
  const text = readFileSync(absPath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    die(`${absPath}: not valid JSON — ${err.message}`);
  }
}

export function readYamlFile(absPath) {
  const text = readFileSync(absPath, 'utf8');
  try {
    // js-yaml's default schema already refuses custom tags and has no anchor-bomb
    // amplification path of the size FS02-055 worries about; these files are also
    // operator-merged rather than fetched from an untrusted repo. Still loaded with the
    // safe default schema (never `load` with a permissive schema) as a matter of habit.
    return yamlLoad(text, { filename: absPath, json: false });
  } catch (err) {
    die(`${absPath}: not valid YAML — ${err.message}`);
  }
}

/**
 * The one serialiser every emitted artifact goes through: two-space JSON, keys in the
 * order the generator inserted them, one trailing newline, LF (guaranteed by
 * .gitattributes).
 *
 * Insertion order is the artifact's stable key order — NOT sorted. Sorting would make
 * `schemaVersion` and `generatedAt` land in the middle of a body, and a reviewer reading
 * a diff wants them at the top where the generator puts them. Determinism comes from the
 * generator building the object in a fixed order, which the tests assert by running the
 * build twice and comparing bytes.
 */
export function writeArtifact(absPath, value) {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function writeTextArtifact(absPath, text) {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, text, 'utf8');
}

// ---------------------------------------------------------------------------- config

let configCache = null;

/** config/publish.json — the only place an org, host, or schema version is written. */
export function config() {
  if (!configCache) configCache = readJsonFile(join(ROOT, 'config', 'publish.json'));
  return configCache;
}

let menuCache = null;

/**
 * config/category-funds.json — the published category menu (ENG-033, D16, D33 item 1).
 *
 * A VENDORED file: it is a byte-identical copy of the menu published in the contract
 * repository, and CI checks the bytes against that published copy on every run. Never
 * edit it here — an edit that improves it locally is a fork of the one vocabulary that
 * decides where money goes.
 */
export function categoryMenu() {
  if (!menuCache) menuCache = readJsonFile(join(ROOT, 'config', 'category-funds.json'));
  return menuCache;
}

// ------------------------------------------------------------------------- timestamps

const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function normaliseInstant(raw, source) {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    die(`${source} is not a parseable instant: ${JSON.stringify(raw)}`);
  }
  // Second precision, UTC, `Z`. Fixed by design: `generatedAt` lands in every artifact,
  // so a millisecond field would make two builds of identical data differ in bytes for
  // no reason a reviewer can act on.
  return `${d.toISOString().slice(0, 19)}Z`;
}

/**
 * The build's single notion of "now" (FS-00 §7.3 determinism spirit, VS-04's reviewable
 * diffs). Resolution order:
 *
 *   1. GENERATED_AT   — an explicit instant. What CI and the tests use.
 *   2. the HEAD commit date — so a plain `npm run build` in a checkout is reproducible
 *      by anyone else with that checkout.
 *   3. HARD FAILURE. Never `new Date()`: a wall clock would make every rebuild of
 *      unchanged data produce a different ETag, which is exactly the thing FS02-084
 *      forbids ("ETags changing only on changed files").
 */
export function generatedAt() {
  if (process.env.GENERATED_AT) {
    return normaliseInstant(process.env.GENERATED_AT, 'GENERATED_AT');
  }
  let committerDate;
  try {
    committerDate = execFileSync('git', ['log', '-1', '--format=%cI'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    committerDate = '';
  }
  if (committerDate) return normaliseInstant(committerDate, 'the HEAD commit date');
  die(
    'No deterministic timestamp available: set GENERATED_AT (e.g. ' +
      'GENERATED_AT=2026-09-02T00:00:00Z) or run inside a git checkout with at least one ' +
      'commit. The build refuses to fall back to the wall clock — see generatedAt() in ' +
      'scripts/lib/repo.mjs.'
  );
}

export function assertIsoSeconds(value, where, failures) {
  if (!ISO_SECONDS.test(value)) {
    failures.add(where, `expected a UTC instant like 2026-09-02T00:00:00Z, got ${JSON.stringify(value)}`);
    return false;
  }
  return true;
}

// -------------------------------------------------------------------------- validation

const DIALECT_2020 = 'https://json-schema.org/draft/2020-12/schema';

const ajvCache = new Map();

/**
 * A validator for the dialect the schema itself declares.
 *
 * ONE DIALECT IS IN THE TREE TODAY, and the dispatch stays anyway. `schema/` holds exactly
 * `registry-v0-record.v1.json`, which is 2020-12 because it is not this repository's schema
 * at all: it is a byte-identical vendored copy of the published contract, and the contract
 * set is 2020-12 throughout. The two draft-07 schemas this repository did own —
 * `ct-segment` and `ledger-month` — retired on 2026-09-09 with the trees they validated
 * (FS-00 §6.10); the published pair in {ORG}/spec is the contract, and the website
 * validates its ledger and CT artifacts against it.
 *
 * The two-dialect dispatch is kept because it is a correctness property and not a headcount:
 * Ajv's two entry points are separate classes that each know one meta-schema, so the choice
 * is made from the file's own `$schema` rather than guessed — a schema that declares a
 * dialect its validator does not know fails loudly at compile time, which is the outcome we
 * want, and a vendored contract that changes dialect must not be validated by the wrong one.
 */
function ajv(dialect) {
  if (!ajvCache.has(dialect)) {
    const Ctor = dialect === DIALECT_2020 ? Ajv2020 : Ajv;
    const instance = new Ctor({
      allErrors: true,
      // Report every problem in a file, not just the first — same reason as Failures.
      strict: true,
      // `strictTypes: false`: a field is legitimately `["string","null"]` with a `pattern`
      // that applies only to the string branch. Ajv's strictTypes calls that a
      // union-with-constraint and warns; the schema is valid and the behaviour is the
      // intended one. Kept in step with the settings the contract set's own validator uses
      // (spec/scripts/lib/spec.mjs, mirrored in check-artifacts-schema.mjs), so a vendored
      // schema is judged here exactly as it is judged where it is published — the examples
      // this line used to name were the retired CT schema's and are gone with it.
      strictTypes: false,
      // `strictRequired: false`: the record schema states its bans as
      // `not: { required: ["waivers"] }`, which is precisely the point — `waivers` is a
      // property that must NOT be defined. Ajv's strictRequired flags a `required` naming
      // an undeclared property as a likely typo, which it is everywhere except here.
      strictRequired: false,
    });
    addFormats(instance, ['date', 'date-time', 'uri']);
    // `x-psn` is the provenance block every published contract carries (spec version,
    // artifact path, the clauses it implements). It is an annotation and never affects
    // validation; registering it is what lets strict mode stay on for everything else.
    instance.addKeyword({ keyword: 'x-psn', metaSchema: { type: 'object' } });
    ajvCache.set(dialect, instance);
  }
  return ajvCache.get(dialect);
}

/** Compiles a schema from schema/ and returns a `(data) => string[]` error reporter. */
export function schemaValidator(fileName) {
  const schema = readJsonFile(join(ROOT, 'schema', fileName));
  const validate = ajv(schema.$schema).compile(schema);
  return (data) => {
    if (validate(data)) return [];
    return (validate.errors || []).map((e) => {
      const at = e.instancePath || '/';
      const extra = e.params && Object.keys(e.params).length
        ? ` (${Object.entries(e.params)
            .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`)
            .join(', ')})`
        : '';
      return `${at} ${e.message}${extra}`;
    });
  };
}

// ------------------------------------------------------------------------------- args

/** Minimal `--flag` / `--key value` parser. No dependency, no surprises. */
export function parseArgs(argv, spec) {
  const out = { ...spec.defaults };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const key = a.slice(2);
    if (spec.flags.includes(key)) {
      out[key] = true;
    } else if (spec.values.includes(key)) {
      const v = argv[++i];
      if (v === undefined) die(`--${key} needs a value`);
      out[key] = v;
    } else {
      die(`unknown option --${key}. Known: ${[...spec.flags, ...spec.values].map((k) => `--${k}`).join(' ')}`);
    }
  }
  out._ = rest;
  return out;
}
