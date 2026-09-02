<!--
Everything merged here becomes a public statement about a real repository, a real month of
money, or a real signed object. CI checks the shape; the boxes below are the part only a
human can check.

Delete the sections that do not apply.
-->

## What this changes

<!-- One line. e.g. "Register acme/widget-engine (verified)." or "Flip foo/bar to quit." -->

## Kind of change

- [ ] New registry entry
- [ ] Registry state change (verified / suspended / quit / delisted)
- [ ] Registry correction (display cache, contacts, licence version bump)
- [ ] Ledger append
- [ ] CT log append
- [ ] Tooling, schema, or configuration

---

## For a new registry entry or a state change

- [ ] **The repository's own LICENSE file is the truth, and I looked at it.** Adoption is
      the committed LICENSE file alone (GH-002, D13); this YAML is only the cache of what
      I verified.
- [ ] **The canonical-text hash matches** the published licence version, byte for byte
      (GH-015). A modified text is not an adoption (D10) — if the hash differs, this PR
      does not get merged and the admin gets pinged instead.
- [ ] `node_id` is the repository's GitHub node id, copied not typed, and appears in no
      other entry.
- [ ] The filename is `{owner}--{name}.yml`, lowercased.
- [ ] `state` uses the FS-02 §3 enum verbatim. A `detected` entry will be **counted and
      not listed** — no page, no badge (GH-014); I have checked that is the intent.
- [ ] For `quit` or `delisted`: `state_note` names a reason **class**, not a narrative,
      and no person is named (WEB-075).
- [ ] For `weight_class: major`: `weight_class_approval_ref` links the recorded steward
      approval (FS02-071). Merging this PR is that approval being recorded.
- [ ] `inbound_family` is right — it drives the adoption gate a maintainer sees.
- [ ] **No email addresses, no personal names, no contact details beyond GitHub logins
      and public URLs.** This repository is P0-public and immutable in effect.
- [ ] There is **no `waivers` field**. Waivers are issued only from the dashboard by a
      claimed admin (D14) and can never enter the registry by pull request.

## For a ledger append

- [ ] The row was produced by `node scripts/ledger-append.mjs`, not hand-written. `seq`,
      `prev_hash` and `row_hash` are computed; I did not edit them.
- [ ] **No existing row is touched.** A correction is a NEW row carrying
      `corrects_led_id`; narrative context is a zero-amount `annotation` row. The ledger
      annotates and never restates (FS07-042) — there is no exception, including for
      embarrassing facts.
- [ ] The target month is still open. A closed month is immutable; a late fact posts
      against the earliest open month.
- [ ] `payer_name` is `unnamed` unless the payer explicitly opted in to being named.
- [ ] Amounts are integer minor units, and any non-CHF settlement carries the whole
      captured-FX set.

## For a CT log append

- [ ] The entry appends at the end: `seq` is the previous head plus one.
- [ ] **No existing entry is edited or deleted.** A revocation or status change is a NEW
      entry whose `ref` is the original hash (CERT-033).
- [ ] `h` is the SHA-256 of the compact JWS — the signed object, not a rendered PDF.
- [ ] The entry carries no personal data of any kind (CERT-031). This log is immutable
      forever, so anything in it is in it permanently.
- [ ] `typ` is one v0 actually issues: `supporter`, `license-status`, or one of the two
      non-certificate JWS families.

## For tooling, schema, or configuration

- [ ] `npm test` passes locally.
- [ ] If a hash definition changed: I understand that every committed row and entry
      depends on it, that FS07-101 requires the chain to import unbroken at P-M3, and
      that `tests/jcs.test.mjs` pins the digest on purpose.
- [ ] If a new artifact path appeared: it is in the FS-00 §6.2 catalog. Adding a public
      URL is an FS-00 amendment, not a build change.

---

## Anything a reviewer should look at twice

<!-- Say so plainly. "I am not sure the hash check was against the right version" is a
     more useful line than silence. -->
