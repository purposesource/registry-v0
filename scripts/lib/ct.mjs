// The v0 certificate-transparency log: loading segments and the invariants that make the
// log worth trusting.
//
// The log's whole job is CERT-030: a certificate whose hash is not in the log renders
// UNVERIFIED even when its signature is perfectly valid. That makes the log the rogue-
// issuance detector, which only works if the log is append-only in fact and not merely
// in intention — hence ct-verify.mjs, and hence the deliberate absence of any code in
// this repository that can rewrite an entry.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, readJsonFile } from './repo.mjs';
import { sha256Hex } from './jcs.mjs';

export const CT_DIR = join(ROOT, 'ct');

const SEGMENT_FILE = /^(0|[1-9]\d*)\.json$/;

/**
 * Certificate types issuable at v0 (VS-30): the payment certificate (`supporter`) and,
 * where a recorded status exists, the status certificate (`license-status`). Impact
 * certificates and impact figures are Phase E+ and never exist before the first disbursed
 * ledger row (NEV-017, D21) — so `contributor`, `steward` and `topup` are valid tokens in
 * the schema but must not appear in a v0 log, and ct-verify says so by name.
 */
export const V0_CERT_TYPES = ['supporter', 'license-status'];

/** The non-certificate JWS families the v0 operator script also CT-appends (VS-27). */
export const V0_OTHER_TYPES = ['entitlement-record', 'ct-checkpoint'];

/** Loads ct/{n}.json ascending by segment number. `dir` overridable for the tests. */
export function loadCt(dir = CT_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => SEGMENT_FILE.test(f))
    .sort((a, b) => Number(SEGMENT_FILE.exec(a)[1]) - Number(SEGMENT_FILE.exec(b)[1]))
    .map((file) => ({
      file,
      segment: Number(SEGMENT_FILE.exec(file)[1]),
      data: readJsonFile(join(dir, file)),
      bytes: readFileSync(join(dir, file)),
    }));
}

export function strayCtFiles(dir = CT_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => !SEGMENT_FILE.test(f));
}

/**
 * Anything that looks like personal data (CERT-031). The log holds hashes, type codes and
 * timestamps; a name, an email or a login in it would make an immutable-forever artifact
 * carry PII, which is the one way this design could become impossible to comply with.
 *
 * The schema already closes the object (`additionalProperties: false`), so this is the
 * belt to that braces: it scans VALUES, catching an email smuggled into a field that is
 * legitimately a string.
 */
const EMAIL_SHAPED = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Verifies the whole log. Checks:
 *   1. segment numbers are contiguous from 0.
 *   2. startSeq === segment * entriesPerSegment.
 *   3. no closed segment exceeds entriesPerSegment; only the last may be short.
 *   4. prevSegmentSha256 is null for segment 0 and equals the previous FILE's SHA-256
 *      otherwise — the cross-segment tamper evidence (FS08-135).
 *   5. entry seq is contiguous and strictly increasing from startSeq, across segments.
 *   6. `h` values are unique and well-formed; `ts` is non-decreasing.
 *   7. `kind: issue` has `ref: null`; `revoke`/`status` reference an EARLIER entry's `h`.
 *   8. `typ` is one a v0 log may contain.
 *   9. no value in any entry is email-shaped.
 *
 * Returns { headSeq, headSegment, entryCount }.
 */
export function verifyCt(segments, cfg, failures) {
  const per = cfg.ct.entriesPerSegment;

  const hashes = new Map();
  let expectedSegment = 0;
  let expectedSeq = 0;
  let lastTs = '';
  let prevBytesHash = null;
  let headSeq = -1;
  let headSegment = -1;
  let entryCount = 0;

  for (let i = 0; i < segments.length; i++) {
    const { file, segment, data, bytes } = segments[i];
    const at = `ct/${file}`;

    if (segment !== expectedSegment) {
      failures.add(at, `expected segment ${expectedSegment} — segment numbers are contiguous from 0.`);
    }
    expectedSegment = segment + 1;

    if (data.segment !== segment) {
      failures.add(at, `\`segment\` is ${data.segment} but the filename says ${segment}.`);
    }
    if (data.startSeq !== segment * per) {
      failures.add(at, `startSeq must be segment * ${per} = ${segment * per}, got ${data.startSeq}.`);
    }

    const isLast = i === segments.length - 1;
    if (data.entries.length > per) {
      failures.add(at, `${data.entries.length} entries exceeds the ${per}-entry segment size (FS08-111).`);
    }
    if (!isLast && data.entries.length !== per) {
      failures.add(
        at,
        `a closed segment holds exactly ${per} entries (FS08-111) — only the open, highest-numbered segment may be short. This one has ${data.entries.length}.`
      );
    }

    if (segment === 0) {
      if (data.prevSegmentSha256 !== null) {
        failures.add(at, 'segment 0 has no predecessor; prevSegmentSha256 must be null.');
      }
    } else if (data.prevSegmentSha256 !== prevBytesHash) {
      failures.add(
        at,
        `prevSegmentSha256 does not match the SHA-256 of segment ${segment - 1}'s bytes ` +
          `(expected ${String(prevBytesHash).slice(0, 12)}…, found ${String(data.prevSegmentSha256).slice(0, 12)}…). ` +
          'The segment chain is what makes retroactive tampering provable.'
      );
    }
    prevBytesHash = sha256Hex(bytes);

    for (const entry of data.entries) {
      entryCount++;
      const eat = `${at} seq=${entry.seq}`;

      if (entry.seq !== expectedSeq) {
        failures.add(
          eat,
          `expected seq ${expectedSeq}. The log's sequence numbers are contiguous and strictly increasing across the whole log — a gap or a repeat is either a lost entry or a rewritten one.`
        );
      }
      expectedSeq = entry.seq + 1;

      if (entry.seq < data.startSeq || entry.seq >= data.startSeq + per) {
        failures.add(eat, `entry belongs to a different segment: seq is outside [${data.startSeq}, ${data.startSeq + per}).`);
      }

      if (hashes.has(entry.h)) {
        failures.add(
          eat,
          `hash already logged at seq=${hashes.get(entry.h)}. Every entry is a distinct signed object; a repeated hash means the same object was logged twice.`
        );
      } else {
        hashes.set(entry.h, entry.seq);
      }

      if (entry.ts < lastTs) {
        failures.add(eat, `timestamp ${entry.ts} is earlier than the previous entry's ${lastTs} — the log is time-ordered.`);
      }
      lastTs = entry.ts;

      if (entry.kind === 'issue') {
        if (entry.ref !== null) failures.add(eat, 'an `issue` entry has no predecessor; `ref` must be null.');
      } else {
        if (entry.ref === null) {
          failures.add(eat, `a \`${entry.kind}\` entry must reference the original entry's hash (CERT-033) — the log never edits.`);
        } else if (!hashes.has(entry.ref) || hashes.get(entry.ref) >= entry.seq) {
          failures.add(eat, `\`ref\` ${entry.ref.slice(0, 12)}… does not name an earlier entry in this log.`);
        }
      }

      if (!V0_CERT_TYPES.includes(entry.typ) && !V0_OTHER_TYPES.includes(entry.typ)) {
        failures.add(
          eat,
          `typ "${entry.typ}" is not issuable at v0. v0 issues exactly two certificate classes — ` +
            `${V0_CERT_TYPES.join(' and ')} (VS-30) — plus the ${V0_OTHER_TYPES.join('/')} JWS families. ` +
            'Contributor and steward certificates, and any impact figure, are Phase E+.'
        );
      }

      for (const [k, v] of Object.entries(entry)) {
        if (typeof v === 'string' && EMAIL_SHAPED.test(v)) {
          failures.add(eat, `field \`${k}\` contains email-shaped text. The CT log carries no personal data (CERT-031) and is immutable forever.`);
        }
      }

      headSeq = entry.seq;
      headSegment = segment;
    }
  }

  return { headSeq, headSegment, entryCount };
}
