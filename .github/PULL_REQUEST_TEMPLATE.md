<!--
Everything merged here becomes a public statement about a real repository. CI checks the
shape; the boxes below are the part only a human can check.

A ledger append or a CT log append is NOT a change to this repository: since 2026-09-09 both
live in the website repository (FS-00 §6.10). If a pull request here proposes a ledger row or
a log entry, it is in the wrong repository. The rules for making one are written beside the
data, in that repository's `src/data/ledger/README.md` and `ct/README.md` — not in a
pull-request template, there or here. The ten boxes this template used to carry for those two
appends are therefore gone rather than relocated, and one of them did not survive the move at
all: see the note in this repository's CONTRIBUTING.md.

Delete the sections that do not apply.
-->

## What this changes

<!-- One line. e.g. "Register acme/widget-engine (verified)." or "Flip foo/bar to quit." -->

## Kind of change

- [ ] New registry entry
- [ ] Registry state change (verified / suspended / quit / delisted)
- [ ] Registry correction (display cache, contacts, licence version bump)
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

## For tooling, schema, or configuration

- [ ] `npm test` passes locally.
- [ ] If a new artifact path appeared: it is in the FS-00 §6.2 catalog **and derivable from
      registry YAML**. Adding a public URL is an FS-00 amendment, not a build change; a
      ledger, CT, certificate or entitlement path belongs to the website's builder, which
      holds those sources (FS-00 §6.10).

---

## Anything a reviewer should look at twice

<!-- Say so plainly. "I am not sure the hash check was against the right version" is a
     more useful line than silence. -->
