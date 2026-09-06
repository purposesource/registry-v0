# Contributing to `registry-v0`

**Pre-launch.** This repository is part of the Purpose Source Network build; nothing here
is a public commitment yet.

This is a **data** repository with a small amount of tooling around it. The tooling exists
to stop the data from ever being wrong in a way a reader could not detect. Read this
before opening a pull request — most of it is about *why* the rules are shaped the way
they are, which is the part that makes them survivable.

---

## The one rule everything else follows from

Every file in `registry/`, `ledger/` and `ct/` is a **public statement**:

- a registry entry says *this real repository adopted the licence, on this date, with this
  exact licence text*;
- a ledger row says *this much money was recorded, in this month, under this lane*;
- a CT entry says *this signed object exists, and was logged before it was delivered*.

None of those statements is ours to take back. So the rules below are not process for its
own sake — they are what makes it safe to publish a claim about someone else.

---

## Curation flow

There is no self-service write path at v0. Every change is a pull request, reviewed and
merged by the steward operator (CODEOWNERS + branch protection; FS02-060).

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

## Appending to the ledger

**Do not hand-write a ledger row.** Every row's hash covers every one of its fields and
chains onto the current global head; getting `seq`, `prev_hash` and `row_hash` right by
hand is both tedious and exactly the sort of tedium that produces a broken chain in a
public artifact.

```bash
# 1. Write the FACTS of the row into a file — no seq, no prev_hash, no row_hash.
cat > /tmp/row.json <<'JSON'
{
  "led_id": "led_01j...",
  "month": "2027-01",
  "row_type": "pool-in",
  "amount_minor": 250000,
  "currency": "CHF",
  "lane": "project",
  "hold_status": "open-M+1",
  "payer_name": "unnamed",
  "external_key": "<Paddle transaction id>",
  "emitting_job": "operator:record-purchases",
  "created_at": "2027-01-14T10:15:00Z"
}
JSON

# 2. Append it. The tool assigns the position and computes the hashes, validates the
#    resulting file, re-verifies the whole chain, and only then writes.
node scripts/ledger-append.mjs --file /tmp/row.json

# 3. Verify, then commit the month file.
npm run verify:ledger
```

Three rules with no exceptions:

1. **Never edit or delete a committed row.** CI compares against the previous revision and
   will refuse the pull request. A correction is a **new** row pointing at the old one with
   `corrects_led_id`; narrative context is a zero-amount `annotation` row. The ledger
   annotates, it never restates — including when the fact being corrected is embarrassing.
2. **A closed month is closed.** A month becomes immutable on day 3 of the month after
   next — the v0 immutability clock, a ceiling on the close. The rule that decides the close
   once the allocator exists is lock before sweep (D33 item 4, 2026-09-06): the allocation is
   computed at the lock, no later than twenty days after the month's last rail payout, and
   each listed recipient's share is transferred directly on or before the thirtieth day. A
   late fact posts against the earliest still-open month, forward-only; nothing is ever
   clawed back from a recipient.
3. **`payer_name` is `unnamed`** unless the payer explicitly opted in to being named.

No allocation row exists at v0. There is no allocator yet, so `charged-to-fees`,
`reserve-retention`, `hardship-pay` (the two capped lines of D34), `repo-pool`, `disburse`
(a transfer to a listed recipient) and their relatives are refused by name rather than by a
generic enum error — publishing one would be publishing a figure nothing computed.

---

## Appending to the CT log

The log is `ct/0.json`. A new entry goes at the **end**, with `seq` equal to the previous
head plus one:

```json
{ "seq": 5, "h": "<sha256 of the compact JWS>", "typ": "supporter",
  "kind": "issue", "ref": null, "ts": "2027-01-14T10:20:00Z" }
```

Then `npm run verify:ct`.

- `h` is the hash of the **signed object** (the compact JWS), never of a rendered PDF.
  That is why a certificate's PDF does not need to be byte-deterministic, and why a
  signature that never reached the log is harmless: verification requires log presence.
- A revocation or status change is a **new entry** whose `ref` is the original hash. The
  log never edits. An edited entry silently invalidates every verification that already
  succeeded against it, which is why CI refuses one.
- **No personal data, ever.** Hashes, type codes, timestamps. The log is immutable
  forever, so anything in it is in it permanently — that is precisely what makes it
  privacy-compatible, and one name would end that.
- The order of operations for an issuance is: compute the JWS → **merge its hash into this
  log** → emit the verify record and the rendered artifact → deliver. A deliverable whose
  hash is not merged is not deliverable.

---

## The tooling

| Command | What it does |
|---|---|
| `npm run validate` | Every registry entry, against the schema and the rules a schema cannot express |
| `npm run build` | `index-build-lite`: emits the public artifact plane into `dist/` |
| `npm run check:artifacts` | Independently re-derives the expected artifact set and compares; asserts the honesty invariants |
| `npm run build:demo` / `check:artifacts:demo` | The same build over the seeded examples and fixture ledger/CT, so every artifact shape is exercised even while the real plane is empty |
| `npm run verify:ledger` | Recomputes the chain from genesis; compares against the base revision |
| `npm run verify:ct` | Structure, monotonicity, segment chain, no PII; compares against the base revision |
| `npm run check:copy` | The hard copy bans |
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
