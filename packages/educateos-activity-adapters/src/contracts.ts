import { z } from "zod";
import { EvidenceContract } from "@educateos/registry";
import { Digest } from "@educateos/assessment-sdk";

/** Opaque identifiers, not URLs, credentials, executable text or authority. */
export const Id = z.string().trim().min(1).max(200);
/** Observe and collect never drive an application; scenarios are explicit side effects. */
export const Operation = z.enum(["observe", "run-scenario", "collect-evidence", "mutate"]);
/** A missing surface is never equivalent to a successful empty observation. */
export const Surface = z.enum(["source", "editor", "server", "client", "test", "physical"]);
/** Assistance is disclosed separately from the observed outcome. */
export const Assistance = z.array(z.enum(["independent", "adult", "peer", "ai", "unknown"]))
  .min(1).max(5).refine((values) => new Set(values).size === values.length
    && (!values.includes("independent") || values.length === 1));
/** Host-resolved ownership and immutable source pin. Never derive this from an arbitrary client URL. */
export const ActivityScope = z.strictObject({
  districtId: Id, offeringId: Id, studentId: Id, projectId: Id,
  sourceId: Id, revision: Id,
});
/** An activity scope carries no execution permission. */
export type ActivityScope = z.infer<typeof ActivityScope>;
/** One explicit action, bound to a session, project revision and existing registry contract. */
export const ActivityRequest = z.strictObject({
  runId: z.uuid(), sessionId: Id, adapterId: Id, actionId: Id, operation: Operation,
  scope: ActivityScope,
  contract: EvidenceContract,
  requiredSurfaces: z.array(Surface).min(1).max(6)
    .refine((surfaces) => new Set(surfaces).size === surfaces.length),
  assistance: Assistance,
});
/** No free-form code, arbitrary tool name, URL, credential or approval flag is accepted. */
export type ActivityRequest = z.infer<typeof ActivityRequest>;
/** Only allowlisted numeric/boolean measurements; never raw logs, chat or profiling text. */
export const Measurement = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),
  value: z.union([z.number().finite(), z.boolean()]),
  unit: z.enum(["count", "seconds", "milliseconds", "meters", "grams", "ratio", "boolean"]),
});
/** Artifact contents stay in the user's sanctioned store; references are opaque and digest-pinned. */
export const Artifact = z.strictObject({
  id: Id, digest: Digest,
  kind: z.enum(["code", "photo", "video", "test-report", "worksheet"]),
});
/** Each surface reports its own capture time, revision and actual availability. */
export const Observation = z.strictObject({
  surface: Surface, sourceId: Id, revision: Id, observedAt: z.iso.datetime(),
  status: z.enum(["observed", "unavailable", "unsupported", "error"]),
  code: z.enum(["ok", "not-connected", "not-supported", "transport-failed", "invalid-response", "stale", "source-mismatch", "empty", "missing", "denied", "replay"]),
  measurements: z.array(Measurement).max(100),
  artifacts: z.array(Artifact).max(32),
}).superRefine((value, ctx) => {
  if (value.status === "observed") {
    if (value.code !== "ok" || value.measurements.length + value.artifacts.length === 0) {
      ctx.addIssue({ code: "custom", message: "An observation needs actual evidence and an ok code" });
    }
  } else if (value.code === "ok" || value.measurements.length + value.artifacts.length !== 0) {
    ctx.addIssue({ code: "custom", message: "An unavailable surface cannot carry successful evidence" });
  }
});
/** Validated, privacy-minimized surface observation. */
export type Observation = z.infer<typeof Observation>;
/** Portable evidence; completion is coverage, never a passing test or a mastery claim. */
export const EvidenceBody = z.strictObject({
  format: z.literal("educateos.activity-evidence.v1"),
  request: ActivityRequest, requestDigest: Digest,
  adapterVersion: Id, producerId: Id,
  startedAt: z.iso.datetime(), completedAt: z.iso.datetime(),
  approval: z.strictObject({ actorId: Id, decisionId: Id }).nullable(),
  status: z.enum(["complete", "partial", "unavailable", "unsupported", "error", "denied", "replay"]),
  observations: z.array(Observation).min(1).max(6),
  learningClaim: z.literal("requires-teacher-verification"),
});
/** SHA-256 detects tampering; source authenticity additionally requires a trusted receipt. */
export const EvidenceBundle = z.strictObject({ body: EvidenceBody, digest: Digest });
/** Serializable evidence envelope. */
export type EvidenceBundle = z.infer<typeof EvidenceBundle>;
