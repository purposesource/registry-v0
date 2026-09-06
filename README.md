# `registry-v0`

**Pre-launch.** This repository is part of the Purpose Source Network build; nothing here
is a public commitment yet.

The curated registry of participating repositories, plus the job that turns it — together
with the committed ledger table and the committed certificate-transparency log — into the
public artifact plane that every public page and every public API reads.

This is the **v0** form, deliberately. There is no database, no API and no dashboard at
this phase: the entire public data plane is a set of JSON files generated from files in
this repository by a CI job. At the next phase the same artifacts are generated from a
database by a job called `index-build`, at **exactly the same URLs**, and this repository
is frozen and archived with a pointer to the export endpoints.

---

## What is in here

```
registry/       one YAML file per participating repository, PR-curated
ledger/         the committed monthly ledger table, append-only, hash-chained
ct/             the committed certificate-transparency log, append-only
schema/         the JSON Schemas those three trees are validated against
config/         publication constants (org, hosts, badge text, the curated fund menu)
scripts/        the generator, the append tool, and the gates
tests/          the gate tests and their fixtures
```

## What is NOT in here, and where it lives instead

| Not here | Because | Where |
|---|---|---|
| The licence text | The text is the product and has its own repository and development record | `license` |
| Machine-readable contracts for external scanners | One canonical home for the schemas OSPOs and scanners consume | `spec` |
| The website, the edge Worker, the copy-lint canon | Public surfaces read the artifacts this repo emits; they do not live with the data | `website` |
| Signing keys, the certificate signing script, JWKS | Signing is an operator act against Key Vault. **No key, no secret, and no credential exists anywhere in this repository**, and CI needs none | operator tooling / `infra` |
| `/certs/{id}.json` and `/entitlements/{co}.jws` | Produced by the operator signing script at issuance time, not by this build | operator tooling |
| Waivers | Waiver issuance is dashboard-only, by a claimed repository administrator, from the next phase. **The registry schema forbids a waiver field**, so a waiver cannot enter by pull request. The published `/waivers/*` artifacts render the honest empty state | dashboard (later) |
| Any allocation figure — charged to fees, reserve retention, hardship pay, or a transfer to a listed recipient | There is no allocator at v0. Those row types are refused **by name**, because publishing one would publish a figure that nothing computed (D33/D34, 2026-09-06: the four outgoing lines arrive with the allocator) | later |
| Contributor counts, impact figures, CHF totals | No contributor claim flow exists yet, and no money has been disbursed. The counters publish `null`, not `0` | later |

## How to run it

Node 22 or newer. No Docker, no services, no network access needed.

```bash
npm ci
npm test          # everything CI runs, in order
```

Individually:

```bash
npm run validate            # every registry entry
npm run build               # emit the artifact plane into dist/
npm run check:artifacts     # independently verify what was emitted
npm run build:demo          # the same build over the seeded examples + fixture data
npm run verify:ledger       # recompute the hash chain; check append-only
npm run verify:ct           # check the transparency log
```

`npm run build` needs a deterministic timestamp and **refuses to invent one**. It takes
`GENERATED_AT` if set, otherwise the HEAD commit date, and fails with an explanation if it
has neither. It never reads the wall clock: a rebuild of unchanged data must produce
identical bytes, or every rebuild would look like a change to every consumer.

## What the build emits

Exactly this, and nothing else:

```
/registry/index/meta.json          shard list + counts (including states not listed)
/registry/index/{a-z|0}.json       index shards, keyed by first letter of the repo name
/registry/repo/{node_id}.json      one record per listed repository
/registry.json                     bulk export
/badge/{node_id}.json              shields.io endpoint body
/waivers/{node_id}.json            per-repository waiver record (empty, with the reason)
/waivers/all.json                  the waiver registry (empty, with the reason)
/stats.json                        public counters, honest three-state machine
/ledger/{YYYY-MM}.json + .csv      monthly ledger exports (identical content)
/ledger/chain.json                 chain head + per-month digests
/ct/{n}.json, /ct/latest.json      transparency log segments
/meta/publish-log.json             what this build read and wrote
```

The path set is a **closed catalog**. `scripts/check-artifacts.mjs` refuses any file
outside it: adding a public URL is a specification amendment, not a build change.

### The four things the gate asserts, and why each one earns its keep

1. **Path grammar.** Every emitted file matches a catalog pattern. A plane that quietly
   grew a surface is a plane nobody reviewed.
2. **Set equality, derived twice.** The check re-computes the expected path set from
   `registry/` + `ledger/` + `ct/` rather than reading a manifest the build wrote. A bug
   that made the build skip a repository would be invisible to a check that believed the
   build's own account of itself.
3. **No example leakage.** The seeded demonstration entries are excluded from publication,
   and no identifier of theirs may appear anywhere in the output. A published registry
   entry is a public claim that a real repository adopted the licence; a demo fixture must
   never make that claim by accident.
4. **Honesty invariants.** Waiver lists are empty. No CHF figure appears anywhere while
   nothing has been routed. No impact vocabulary appears at all. Every artifact carries its
   schema version and generation timestamp — with two named exceptions, the transparency
   segments (immutable, and hashed by the next segment) and the badge bodies (shields.io
   owns that object's shape).

## Append-only, and why a hash chain is not enough on its own

The ledger rows are hash-chained: each row's hash covers all of its fields plus the
previous row's hash, canonicalized with RFC 8785 so the bytes are reproducible in any
language. That proves a committed row cannot be *altered* unnoticed.

It does **not** prove history was not *rewritten*. Edit a row, recompute every hash after
it, and the chain is internally perfect over falsified rows. Catching that needs a copy of
the log the editor did not control — which at v0 is git history. So both gates compare the
current trees against a base revision and refuse any row or entry that was removed or
edited. When no base revision is available (a first commit, a shallow clone), the gate
**says so in the log** rather than reporting a pass: a guard that skips silently is a guard
nobody has.

The same reasoning applies to the transparency log, and there it is the whole point: a
certificate whose hash is absent from the log renders as unverified even when its signature
is valid. That makes the log the rogue-issuance detector — and a log that can be quietly
rewritten detects nothing.

## Licensing

Two licences, on purpose:

- **Data — CC0 1.0** (`LICENSE-DATA`): `registry/`, `ledger/`, `ct/`, `config/`. Mirror
  it, fork it, re-publish it, no conditions. A registry that anyone can copy is harder to
  hold hostage, including by us.
- **Tooling — Apache-2.0** (`LICENSE`): `scripts/`, `schema/`, `tests/`, `.github/`.

## Open decisions a human must make

These are recorded rather than silently resolved. Each one is a real fork in the road that
this scaffold had to pick a side of in order to run at all.

1. **Where the v0 ledger and transparency log actually live.** The architecture places
   both in the `website` repository (`src/data/ledger/{YYYY-MM}.json` and a repo-root
   `ct/` tree). This repository hosts them instead, per its build assignment. Both cannot
   be true. The scripts read their locations from arguments, and nothing hardcodes a path,
   so moving them is a configuration change — but the specification needs an amendment
   note naming one location before the artifact plane is wired to a deployment.
2. **Registry filenames: `{owner}--{name}.yml` or `{node_id}.yml`.** The specification says
   node_id; this repository uses `{owner}--{name}.yml` because an opaque `R_kgDO…`
   filename makes a curation pull request unreviewable at a glance. Nothing downstream
   depends on the filename — node_id remains the key in every artifact and every reference
   — but the next phase's importer needs one answer.
3. **The curated category-fund menu.** `config/category-funds.json` carries a provisional
   six-fund menu marked `provisional: true`. The real menu is steward-published; the slugs
   here are placeholders that happen to satisfy the schema.
4. **The transparency-log type tokens for the two non-certificate JWS families.**
   `entitlement-record` and `ct-checkpoint` are this repository's names for them. If the
   contracts repository freezes different tokens, `schema/ct-segment.v1.json` is the one
   place to change.
5. **The GitHub org name.** `purposesource` is proposed and pending confirmation. It lives
   only in `config/publish.json`; a rename is a one-file diff.
6. **CODEOWNERS names `@purposesource/stewards`, a team that does not exist yet.** A
   CODEOWNERS file naming a non-existent team reviews nothing while looking as though it
   does. Verify on the org's first pull request that a review is actually requested.
7. **The full CC0 legal code is not vendored** — `LICENSE-DATA` carries the dedication
   notice and the canonical URL. Vendor the full text before the repository is made public.
8. **Cross-repository triggering.** The architecture has a registry merge fire a
   `repository_dispatch` at the website repository. That needs cross-repository write
   credentials, which the OIDC-only, no-secrets rule forbids. This repository's CI
   therefore only validates and gates: it holds no token and writes nothing. Someone must
   decide between a GitHub App installation token and having the consumer poll on its own
   schedule — a deployment question, not a data question.

## Reading order, if you are new to this

1. `CONTRIBUTING.md` — the curation flow, and the three rules with no exceptions.
2. `schema/registry-entry.v1.json` — every field carries the reason it exists.
3. `scripts/index-build-lite.mjs` — the header explains what the build is and is not.
4. `scripts/lib/jcs.mjs` — the header explains why the canonicalizer refuses rather than
   guesses. It is the most consequential file here: every published hash depends on it.
