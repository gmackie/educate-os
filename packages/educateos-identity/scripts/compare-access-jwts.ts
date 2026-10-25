// Decodes and compares the Access JWT payloads recorded while following
// `docs/educateos/runbooks/access-sub-stability.md` (SCHO-37), and prints which ADR-0003 outcome
// they support.
//
// Usage (operator machine, offline, Node 24+):
//   node packages/educateos-identity/scripts/compare-access-jwts.ts <recording.json>
//
// The recording is the JSON file the runbook has the operator fill in:
//   { "observations": [ { "step": "s1-baseline", "person": "a", "jwt": "<CF_Authorization>",
//                          "identity": <get-identity JSON, optional> }, ... ] }
// `jwt` may instead be `payload`, an already-decoded claims object.
//
// Signatures are not verified: the tokens come from the operator's own test organization and only
// their claims are compared. The output never contains a token, a signature or an email address.
// The recording itself does hold live tokens, so delete it once the results are recorded.
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  AccessIdentityFields,
  AccessTokenClaims,
  analyzeStudy,
  StudyPerson,
  StudyStep,
  type StudyObservation,
} from "./access-sub-comparison.ts";

const RecordedObservation = z.strictObject({
  step: StudyStep,
  person: StudyPerson,
  jwt: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  identity: z.record(z.string(), z.unknown()).optional(),
  /** Free-text operator note, e.g. the time of the IdP change. Not interpreted. */
  note: z.string().optional(),
});

const Recording = z.strictObject({ observations: z.array(RecordedObservation).min(1) });

/** The payload segment of a compact JWS, decoded. Throws on anything that is not three segments. */
function decodeJwtPayload(jwt: string): unknown {
  const segments = jwt.trim().split(".");
  if (segments.length !== 3 || segments[1] === undefined) throw new Error("expected a compact JWT (three dot-separated segments)");
  return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
}

function decode(entry: z.infer<typeof RecordedObservation>): StudyObservation {
  if ((entry.jwt === undefined) === (entry.payload === undefined)) {
    throw new Error(`${entry.step}: give exactly one of "jwt" or "payload"`);
  }
  const claims = AccessTokenClaims.parse(entry.jwt === undefined ? entry.payload : decodeJwtPayload(entry.jwt));
  const identity = entry.identity === undefined ? undefined : AccessIdentityFields.parse(entry.identity);
  return { step: entry.step, person: entry.person, claims, ...(identity === undefined ? {} : { identity }) };
}

const path = process.argv[2];
if (path === undefined) {
  console.error("usage: node compare-access-jwts.ts <recording.json>");
  process.exit(2);
}
const recording = Recording.parse(JSON.parse(readFileSync(path, "utf8")));
const report = analyzeStudy(recording.observations.map(decode));
console.log(JSON.stringify(report, null, 2));
process.exit(report.outcome === "invalid-run" ? 1 : 0);
