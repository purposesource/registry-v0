# Contributing to `registry-v0`

**Pre-launch.** This repository is part of the Purpose Source Network build; nothing here
is a public commitment yet.

This is a **data** repository with a small amount of tooling around it. The tooling exists
to stop the data from ever being wrong in a way a reader could not detect. Read this
before opening a pull request — most of it is about *why* the rules are shaped the way
they are, which is the part that makes them survivable.

---

## The one rule everything else follows from

Every file in `registry/` is a **public statement**: a registry entry says *this real
repository adopted the licence, on this date, with this exact licence text*.

That statement is not ours to take back. So the rules below are not process for its own
sake — they are what makes it safe to publish a claim about someone else.

The other two statements of that kind — a ledger row (*this much money was recorded, in this
month, under this lane*) and a CT entry (*this signed object exists, and was logged before it
was delivered*) — are made in the `website` repository, which has held the v0 ledger and the
transparency log since FS-00 §6.10's ruling of 2026-09-07 and whose trees here retired on
2026-09-09. Their rules are written beside the data, in that repository's
`src/data/ledger/README.md` and `ct/README.md`.

---

## Curation flow

There is no self-service write path at v0. Every change is a pull request, reviewed and
merged by the steward operator (CODEOWNERS + branch protection; FS02-060).

*(Dated note, 2026-09-11: `.github/CODEOWNERS` now names the organisation team
`@purposesource/stewards` on every path, where it named a single login from 2026-09-08.
Read what that file says about its own limits before you rely on it: measured read-only the
same day, the team holds no repository access yet and this branch carries no required-review
rule, so a review is **requested** of the stewards and not yet **required** of them. Both
are operator acts, in that order. Nothing about how you open a pull request changes; what
changes is who is asked to read it.)*

### 1. Registering a repository

Adoption happens in the project's **own** repository: the maintainer commits the licence
file. The platform never commits to anyone's repository, and the registry never registers
anyone who has not adopted. So the sequence is always:

1. The maintainer commits `LICENSE` (or `LICENSE.md`) with the canonical licence text.
   *That is the adoption.* It is complete without this registry, without an account, and
   without anyone's permission.
2. The operator fetches that file and computes its SHA-256.
3. **The hash is compared against the published canonical text for that licence version.**
   If it differs, this is not an adoption — a modified text is not the licence — and the
   entry is not created. The maintainer is told what differs.
4. Only then does a pull request add `registry/{owner}--{name}.yml`.

The registry is the **cache**; the repository's licence file is the **truth**. When they
disagree, the file wins and the cache is corrected.

### 2. Writing the entry

Copy one of the seeded examples in `registry/` — they are the shape, and they carry the
reasoning inline. Then:

```bash
npm ci
npm run validate      # schema + every rule a schema cannot express
npm test              # the whole gate set, as CI runs it
```

Things the validator will tell you about, so you do not have to remember them:

| If you… | You will be told |
|---|---|
| name the file anything but `{owner}--{name}.yml`, lowercased | the exact filename it wants |
| reuse a `node_id` | which other file already has it |
| use a state outside the FS-02 enum | the five legal values |
| set `weight_class: major` without an approval reference | that merging is the approval, so it must be reviewable |
| mark a repository `quit`/`delisted` with no reason class | that a tombstone page with no reason reads as an accusation |
| put an email address anywhere | that this repository holds logins and public URLs only |
| add a `waivers:` field | that waiver issuance is dashboard-only, and why |
| invent a category slug | the curated menu |

### 3. What a reviewer is actually checking

CI checks shape. A reviewer checks the two things it cannot:

- **Did the licence-text hash really match?** This is the one check that cannot be
  automated at v0 and the one that matters most. Everything downstream trusts it.
- **Is this the state the project is actually in?** A `verified` entry asserts the project
  confirmed its registration. If nobody confirmed anything, the state is `detected`, which
  is counted and never listed.

---

## Appending to the ledger, or to the CT log

**Not in this repository, since 2026-09-09.** Both trees live in the `website` repository
(FS-00 §6.10, ruling of 2026-09-07) together with the tools and the guards that were ported
there: `scripts/ledger-append.mjs` is the only writer of a ledger row, `npm run verify:ledger`
recomputes the chain from genesis and compares against a base revision, and `npm run verify:ct`
does the same for the log. The step-by-step flow that used to be printed here is in that
repository's `src/data/ledger/README.md` and `ct/README.md`, beside the data it governs, and
is not restated here — a second copy of an append-only rule is a second thing to keep in step.

Of the three rules with no exceptions this section carried, **two travelled and one did not.**
Forward-only corrections and closed-month immutability are rules in
`src/data/ledger/README.md`, and the CT rules — append only, log before deliver, revocation is
an append, `h` is the hash of the compact JWS, no personal data ever — are rules in
`ct/README.md`. **`payer_name` is `unnamed` unless the payer explicitly opted in to being
named** is the one that did not: it appears there only as a value inside a sample row, never
as a rule, so at this date it is written down in no checklist and no README. Recorded here as
a gap rather than pointed at, because a payer named without opting in is not a defect a later
reader should have to rediscover. It is the website's to carry across, and filed as such.

A pull request against **this** repository never appends a ledger row or a log entry. If one
seems to, it is in the wrong repository.

---

## The tooling

| Command | What it does |
|---|---|
| `npm run validate` | Every registry entry, against the schema and the rules a schema cannot express |
| `npm run build` | `index-build-lite`: emits the registry half of the public artifact plane into `dist/` |
| `npm run check:artifacts` | Independently re-derives the expected artifact set and compares; asserts the honesty invariants |
| `npm run check:schema` | Validates every emitted artifact against the schemas `{ORG}/spec` publishes |
| `npm run build:demo` / `check:artifacts:demo` | The same build over the seeded examples, so every artifact shape this producer emits is exercised even while the real plane is empty |
| `npm run check:copy` | The hard copy bans |
| `npm run check:no-records` | The private recording store may never appear here |
| `npm test` | All of the above, in the order CI runs them |

Two design choices worth knowing before you change anything:

**The build and its check derive the answer twice.** `check-artifacts.mjs` does not read a
manifest the build wrote — it computes the expected path set again, from the sources. A bug
that made the build skip a repository would be invisible to a check that trusted the
build's own account of itself.

**Nothing degrades silently.** A missing timestamp, a missing directory, an unreadable file
are all hard failures with a message naming the input. This is a deliberate reaction to a
sibling project where a missing configuration variable produced a quietly wrong page
instead of a failed build.

---

## Seeded examples

`registry/` carries two entries marked `example: true`. They exist so the tooling has data
to run against — a pipeline that has only ever run over an empty directory is not a tested
pipeline. They are excluded from every published artifact, and CI fails if any of their
identifiers appears in `dist/`. **Do not delete them**, and do not use a real repository's
name in one.

## Style

`.editorconfig` covers it: UTF-8, LF, two-space indent, final newline. LF is not a
preference here — every artifact is hashed, so a CRLF checkout would change the bytes the
append-only guards compare. `.gitattributes` pins it and CI asserts it.

Comments in this repository explain **why**, on the assumption that the reader can already
see *what*. If a rule looks arbitrary, the comment above it is missing, and that is a bug
worth reporting.
