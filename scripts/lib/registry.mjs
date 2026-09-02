// Loading and ordering the curated registry. Semantic validation lives in
// scripts/validate-registry.mjs; this file is only about getting the entries off disk in
// a deterministic order and answering the two questions every consumer asks: what is the
// canonical filename for an entry, and which index shard does it belong to.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, readYamlFile } from './repo.mjs';

export const REGISTRY_DIR = join(ROOT, 'registry');

/**
 * FS-02 §3 state enum, verbatim and in the spec's own order. Exported so no other file
 * re-types it.
 */
export const STATES = ['detected', 'verified', 'suspended', 'quit', 'delisted'];

/**
 * States that get a published repo record, a badge, and a listing (FS02-062).
 * `detected` is excluded: a detected-but-unclaimed repo appears in aggregate counts only
 * (GH-014, OPEN-33 default (a)) — publishing its page would assert a relationship the
 * project never confirmed.
 */
export const PUBLISHED_STATES = ['verified', 'suspended', 'quit', 'delisted'];

/**
 * States whose badge must NOT keep asserting registration (WEB-085, FS10-031). A stale
 * README badge on a repo that quit is the single most damaging honesty failure available
 * to this system, so the neutral form is computed from state, never from a flag.
 */
export const NEUTRAL_BADGE_STATES = ['suspended', 'quit', 'delisted'];

/**
 * The canonical filename for an entry: `{owner}--{name}.yml`, lowercased.
 *
 * Lowercased because macOS and Windows checkouts are case-insensitive: two entries whose
 * filenames differ only in case would collide on a contributor's disk and not in CI.
 * The YAML keeps the true case of `owner` and `name` for display.
 *
 * Split on the FIRST `--`: a GitHub login cannot contain consecutive hyphens, so the
 * owner segment is unambiguous, while a repository NAME legitimately can (`foo--bar`).
 *
 * NOTE — DIVERGENCE FROM FS-02, RECORDED: FS02-060 and VS-03 name the file by node_id
 * (`repos/{node_id}.yml`). This repo is built to the `{owner}--{name}.yml` convention
 * instead, because an opaque `R_kgDO…` filename makes a curation PR unreviewable at a
 * glance. Nothing downstream depends on the filename — node_id remains the key in every
 * artifact and every reference (FS-00 §6.1) — but the two conventions must be reconciled
 * by an FS-00 amendment note before P-M3's importer is written. See README, "Open
 * decisions a human must make".
 */
export function entryFileName(owner, name) {
  return `${owner.toLowerCase()}--${name.toLowerCase()}.yml`;
}

/**
 * Index shard for a repository name (FS02-062: shard by first letter of `name`).
 * Anything not a–z lands in the `0` shard, so the shard set is closed at 27 members.
 */
export function shardOf(name) {
  const c = name.slice(0, 1).toLowerCase();
  return c >= 'a' && c <= 'z' ? c : '0';
}

export const ALL_SHARDS = [
  '0',
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),
];

/** Display order within a shard and in the bulk export (FS02-090: keyed by owner/name). */
export function byOwnerName(a, b) {
  const ao = a.owner.toLowerCase();
  const bo = b.owner.toLowerCase();
  if (ao !== bo) return ao < bo ? -1 : 1;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  // Same owner/name is impossible after validation, but a total order must not depend on
  // filesystem enumeration order, so fall through to the key.
  return a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0;
}

/**
 * Reads every registry/*.yml.
 *
 * Returns ALL entries, each with its filename attached, sorted deterministically. Callers
 * decide what to do with `entry.example === true`; the split is deliberate — the
 * validator must see examples (they are validated like anything else) while
 * index-build-lite must not publish them.
 *
 * `dir` is overridable so the tests can point at a fixture registry covering all five
 * states without seeding five entries into the real one.
 */
export function loadRegistry(dir = REGISTRY_DIR) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const entries = files
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((file) => {
      const data = readYamlFile(join(dir, file));
      return { file, data };
    });
  // Sort by node_id when available so downstream emission order never depends on the
  // filename convention. Files that fail validation may lack node_id; keep them last and
  // in filename order so error reporting stays stable.
  return entries.sort((x, y) => {
    const a = x.data && typeof x.data.node_id === 'string' ? x.data.node_id : '￿' + x.file;
    const b = y.data && typeof y.data.node_id === 'string' ? y.data.node_id : '￿' + y.file;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Entries eligible for publication: everything not marked `example: true`. */
export function publishable(loaded) {
  return loaded.filter(({ data }) => data && data.example !== true).map(({ data }) => data);
}

/** Entries marked `example: true` — the seeded demonstration data. */
export function examples(loaded) {
  return loaded.filter(({ data }) => data && data.example === true).map(({ data }) => data);
}

/**
 * The Apache-2.0 conversion date for a licence version (D9): the FOURTH anniversary of
 * that version's publication date. Derived, never stored — a stored copy could drift
 * from the licence text, and the licence text is the promise.
 *
 * Returns an ISO date string. Uses UTC arithmetic on the date parts only, so it cannot
 * be shifted by a runtime timezone. 29 February + 4 years is 29 February again (2028 and
 * 2032 are both leap years), so no clamping case exists for a 4-year offset; the guard is
 * kept anyway because `apacheConversionYears` is a config value.
 */
export function conversionDate(publishedIsoDate, years) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(publishedIsoDate);
  if (!m) throw new TypeError(`conversionDate: not an ISO date: ${publishedIsoDate}`);
  const y = Number(m[1]) + years;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const day = Math.min(d, daysInMonth);
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
