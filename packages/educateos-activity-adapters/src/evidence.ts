import { digestJson, freezeJson } from "@educateos/assessment-sdk";
import { ActivityRequest, EvidenceBundle } from "./contracts.ts";
import { coverage, type ReplayStore } from "./runtime.ts";

/** Verify integrity and semantic consistency; a self-computed hash is NOT proof of authorship. */
export async function verifyEvidence(raw: unknown): Promise<EvidenceBundle> {
  const bundle = EvidenceBundle.parse(raw);
  const { body } = bundle;
  if (bundle.digest !== await digestJson(body) || body.requestDigest !== await digestJson(body.request)) throw new Error("Evidence digest mismatch");
  const surfaces = body.observations.map((o) => o.surface);
  if (new Set(surfaces).size !== surfaces.length || surfaces.length !== body.request.requiredSurfaces.length
      || body.request.requiredSurfaces.some((s) => !surfaces.includes(s))) throw new Error("Evidence coverage mismatch");
  if (Date.parse(body.completedAt) < Date.parse(body.startedAt)) throw new Error("Invalid evidence time range");
  for (const observation of body.observations) {
    if (observation.sourceId !== body.request.scope.sourceId || observation.revision !== body.request.scope.revision) throw new Error("Evidence source mismatch");
    if (Date.parse(observation.observedAt) < Date.parse(body.startedAt)
        || Date.parse(observation.observedAt) > Date.parse(body.completedAt)) throw new Error("Evidence time mismatch");
  }
  if (body.status === "denied" || body.status === "replay") {
    if (body.observations.some((o) => o.status !== "error" || o.code !== body.status)) throw new Error("Invalid refusal");
  } else if (body.status !== coverage(body.observations)) throw new Error("Evidence status mismatch");
  if (body.observations.some((o) => o.status === "observed") && !body.approval) throw new Error("Missing consent receipt");
  return freezeJson(bundle);
}
/** Trusted host boundary for accepting external evidence. Every method must fail closed. */
export interface EvidenceInbox {
  /** Authenticate the exact digest and producer via a paired transport receipt or signature. */
  authenticate(bundle: EvidenceBundle): Promise<boolean>;
  /** Atomically reject already-ingested run IDs across restarts, students and sessions. */
  replay: ReplayStore;
}
/**
 * Bind ingestion to the host's expected request, verify authenticity, and reject replay. Hashes
 * alone are insufficient: a student could recompute one over forged measurements/assistance.
 */
export async function acceptEvidence(raw: unknown, expected: ActivityRequest, inbox: EvidenceInbox): Promise<EvidenceBundle> {
  const bundle = await verifyEvidence(raw);
  if (bundle.body.requestDigest !== await digestJson(ActivityRequest.parse(expected))) throw new Error("Unexpected evidence request");
  if (!await inbox.authenticate(bundle)) throw new Error("Unauthenticated evidence producer");
  const key = await digestJson(["activity-evidence", bundle.body.request.scope.districtId, bundle.body.request.runId]);
  if (!await inbox.replay.claim(key)) throw new Error("Evidence replay");
  return bundle;
}
