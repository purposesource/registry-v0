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
config/         publication constants (org, hosts, badge text) and the category menu
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
npm run check:schema        # ...and check it against the schemas {ORG}/spec publishes
npm run build:demo          # the same build over the seeded examples + fixture data
npm run verify:ledger       # recompute the hash chain; check append-only
npm run verify:ct           # check the transparency log
```

`npm run build` needs a deterministic timestamp and **refuses to invent one**. It takes
`GENERATED_AT` if set, otherwise the HEAD commit date, and fails with an explanation if it
has neither. It never reads the wall clock: a rebuild of unchanged data must produce
identical bytes, or every rebuild would look like a change to every consumer.

`npm run check:schema` needs the published JSON Schemas on disk. It reads `PSN_SPEC_DIR`,
else `../spec/schemas`, else `spec/schemas`, and **fails loudly rather than skipping** when
it finds none — a contract check that silently passes is not a contract check. The schemas
are never vendored here: a copy would drift, and catching drift is the point. CI does an
`actions/checkout` of the PUBLIC `{ORG}/spec` repository into `./spec`; no token is needed
or used. Working on this repository alone? Clone `spec` beside it.

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

`scripts/check-artifacts-schema.mjs` holds the other end of the same rule, one level down:
the catalog says which PATHS may exist, and the schemas say what the BYTES at them must
look like. It maps every emitted path to its schema in `{ORG}/spec` and reports the file
plus a JSON pointer for every violation. Several classes do not match today, and not
because of a stray key — the emitted shape and the published schema are two different
contracts (`registry.json`'s flat export; the snake_case ledger row set against a camelCase
`ledger-row.v1`; `owner` as a string where the schema wants an object). Reconciling those
re-specifies a frozen contract, which is a specification amendment and not a build change
either. Until that decision exists, `EXPECTED_DIVERGENCE` in that script records each
class's exact violation signatures per output directory, prints them on every run, and the
gate fails on three things: a signature that is not recorded, an artifact no schema is
mapped to, and a recorded class that has quietly become clean while its entry survives.
The last one matters most — it is what stops the list turning into an exemption nobody
granted.

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

Two files in those trees are **vendored, not ours**: `schema/registry-v0-record.v1.json`
(the published record contract) and `config/category-funds.json` (the published category
menu). They are byte-identical copies of files published in the contract repository, and
CI checks out that repository and fails on any byte difference — so an edit here is never
the way to change them. Change the published contract, then copy it back byte for byte.

## Open decisions a human must make

These are recorded rather than silently resolved. Each one is a real fork in the road that
this scaffold had to pick a side of in order to run at all.

1. **Where the v0 ledger and transparency log actually live.** The architecture places
   both in the `website` repository (`src/data/ledger/{YYYY-MM}.json` and a repo-root
   `ct/` tree). This repository hosts them instead, per its build assignment. Both cannot
   be true. The scripts read their locations from arguments, and nothing hardcodes a path,
   so moving them is a configuration change — but the specification needs an amendment
   note naming one location before the artifact plane is wired to a deployment.
2. **Registry filenames: `{owner}--{name}.yml` or `{node_id}.yml`.** *(Settled 2026-09-07:
   `{owner}--{name}.yml` is KEPT.)* The specification said node_id; this repository uses
   `{owner}--{name}.yml` because an opaque `R_kgDO…` filename makes a curation pull request
   unreviewable at a glance. Nothing downstream depends on the filename — node_id remains
   the key in every artifact and every reference — and the published record contract now
   states this path, so the next phase's importer has its one answer. Kept here because
   the reasoning is worth reading, not because anything is open.
3. **The curated category menu.** *(Settled 2026-09-07: the menu is the seven published
   public-benefit categories of the statutes' Art. 7, and it is no longer written down
   here at all.)* Health, education, poverty relief, humanitarian aid, environment, animal
   welfare, research. `config/category-funds.json` is a byte-identical vendored copy of the
   menu published in the contract repository, and the record schema's slug enum is a copy
   of the same list; the validator asserts the two agree with each other and CI asserts
   both match what is published. The provisional six-fund placeholder menu is gone, and so
   is the drift between this repository's slugs and the website's. `provisional` stays true
   for one reason only: the named organisations inside each category — the Recipient List —
   are adopted at the founding assembly and published as the annex to the statutes, and
   none is listed yet. The category NAMES are published.
4. **The transparency-log type tokens for the two non-certificate JWS families.**
   `entitlement-record` and `ct-checkpoint` are this repository's names for them. If the
   contracts repository freezes different tokens, `schema/ct-segment.v1.json` is the one
   place to change.
5. **The GitHub org name.** `purposesource` is proposed and pending confirmation. It lives
   only in `config/publish.json`; a rename is a one-file diff. *(Closed 2026-09-08: the
   organisation exists and the name is confirmed. It still lives only in
   `config/publish.json` — the `org` key, L14 as this note is written, with the
   superseded wording kept beside it — so the one-file-diff property outlived the
   question, which is the reason it was worth building. Note what this does NOT confirm:
   the steward organisation's legal name is a different name and a different open row.)*
6. **CODEOWNERS names `@purposesource/stewards`, a team that does not exist yet.** A
   CODEOWNERS file naming a non-existent team reviews nothing while looking as though it
   does. Verify on the org's first pull request that a review is actually requested.
   *(Corrected 2026-09-08: `.github/CODEOWNERS` names the organisation owner's login
   instead, so every path now has an owner GitHub can actually request a review from.
   The team is still to be created, and creating it — together with the required-review
   rule that makes a CODEOWNERS file binding rather than advisory — is an operator act,
   tracked as PS-O14; the file goes back to the team on the day the team exists. The
   verification above stands unchanged: confirm on the first pull request that a review
   is actually requested.)*
7. **The full CC0 legal code is not vendored** — `LICENSE-DATA` carries the dedication
   notice and the canonical URL. Vendor the full text before the repository is made public.
   *(Closed 2026-09-08: `LICENSE-DATA` now carries the full CC0 1.0 Universal legal code
   verbatim, copied from the plain-text form served at the canonical URL, under this
   repository's own scope note and a rule that says where the vendored text begins. The
   repository was made public before the text was vendored rather than after; the order
   is recorded here rather than tidied away.)*
8. **Cross-repository triggering.** The architecture has a registry merge fire a
   `repository_dispatch` at the website repository. That needs cross-repository write
   credentials, which the OIDC-only, no-secrets rule forbids. This repository's CI
   therefore only validates and gates: it holds no token and writes nothing. Someone must
   decide between a GitHub App installation token and having the consumer poll on its own
   schedule — a deployment question, not a data question.

## Reading order, if you are new to this

1. `CONTRIBUTING.md` — the curation flow, and the three rules with no exceptions.
2. `schema/registry-v0-record.v1.json` — every field carries the reason it exists. It is
   the published record contract, vendored: read it here, change it there.
3. `scripts/index-build-lite.mjs` — the header explains what the build is and is not.
4. `scripts/lib/jcs.mjs` — the header explains why the canonicalizer refuses rather than
   guesses. It is the most consequential file here: every published hash depends on it.
