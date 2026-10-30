import { z } from "zod";

/** Portable local identifiers; never carry authorization. */
export const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
/** Exact SHA-256 of UTF-8 canonical JSON or artifact bytes, as specified by the containing record. */
export const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Immutable release pins. No floating versions or remote fetch URLs. */
export const ReleaseRef = z.strictObject({ id: Id, version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/).max(40), digest: Digest });
/** A release pin. */
export type ReleaseRef = z.infer<typeof ReleaseRef>;
const prose = z.string().min(1).max(10000);
const mediaType = z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/).max(128);
/** Public evidence intent: explicit submitted work only, with bounded size and media types. */
export const EvidenceRequirement = z.strictObject({
  id: Id, description: prose, mediaTypes: z.array(mediaType).min(1).max(20), maxBytes: z.int().min(1).max(10_000_000),
});
/** Uses permitted for the learner; no blanket AI permission or implicit monitoring. */
export const AiAssistance = z.strictObject({
  allowedUses: z.array(z.enum(["brainstorm", "feedback", "revision", "translation"])).max(4), disclosureRequired: z.boolean(),
});
const task = {
  id: Id, prompt: prose, evidence: z.array(EvidenceRequirement).min(1).max(20), aiAssistance: AiAssistance,
};
/** Task kinds express intent; they do not imply an installed executor or surveillance capability. */
export const AssessmentTask = z.discriminatedUnion("kind", [
  z.strictObject({ ...task, kind: z.literal("quiz") }),
  z.strictObject({ ...task, kind: z.literal("writing") }),
  z.strictObject({ ...task, kind: z.literal("gadget") }),
  z.strictObject({ ...task, kind: z.literal("programming") }),
  z.strictObject({ ...task, kind: z.literal("simulation") }),
  z.strictObject({ ...task, kind: z.literal("conversation") }),
  z.strictObject({ ...task, kind: z.literal("multimedia") }),
  z.strictObject({ ...task, kind: z.literal("portfolio") }),
]);
/** A strictly parsed public task. */
export type AssessmentTask = z.infer<typeof AssessmentTask>;
/** A portable assessment contains public instructions and pins, never records or evaluator config. */
export const AssessmentDefinition = z.strictObject({
  format: z.literal("educateos.assessment.v1"), id: Id, version: ReleaseRef.shape.version,
  title: z.string().min(1).max(200), intent: prose,
  outcomes: z.array(z.strictObject({ id: Id, description: prose, caseUri: z.url().refine((u) => new URL(u).protocol === "https:", "CASE references use HTTPS").optional() })).min(1).max(100),
  tasks: z.array(AssessmentTask).min(1).max(100), rubric: ReleaseRef, evaluator: ReleaseRef,
}).superRefine((value, ctx) => {
  const unique = (ids: string[], path: (string | number)[]) => {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "IDs must be unique", path });
  };
  unique(value.tasks.map((t) => t.id), ["tasks"]);
  unique(value.outcomes.map((o) => o.id), ["outcomes"]);
  value.tasks.forEach((t, i) => unique(t.evidence.map((e) => e.id), ["tasks", i, "evidence"]));
});
/** The v1 assessment definition. */
export type AssessmentDefinition = z.infer<typeof AssessmentDefinition>;
/** Submitted evidence refers to exact revisions, never arbitrary URLs or credentials. */
export const Evidence = z.strictObject({
  id: Id, requirementId: Id, artifactId: Id, revisionId: Id, digest: Digest, mediaType,
});
/** A submitted revision reference. */
export type Evidence = z.infer<typeof Evidence>;
/** Observable findings are suggestions grounded in submitted evidence, never invented model reasoning. */
export const Finding = z.strictObject({
  criterionId: Id, observation: prose, explanation: prose, evidenceIds: z.array(Id).min(1).max(100), score: z.number().min(0).max(1).optional(),
});
/** A suggested observation. */
export type Finding = z.infer<typeof Finding>;
/** Host-local instance; district identifiers do not confer authority. Kept out of blueprint exports. */
export const BoundInstance = z.strictObject({ districtId: Id, instanceId: Id, assessmentDigest: Digest });
/** A district-local assessment binding. */
export type BoundInstance = z.infer<typeof BoundInstance>;
/** Evidence-grounded report. Official grades are deliberately absent. */
export const AssessmentReport = z.strictObject({
  format: z.literal("educateos.assessment-report.v1"), assessmentDigest: Digest,
  districtId: Id, instanceId: Id, subjectId: Id, taskId: Id,
  evidence: z.array(Evidence).min(1).max(100), findings: z.array(Finding).max(500),
  authority: z.literal("suggestion"),
  provenance: z.strictObject({ evaluator: ReleaseRef, rubric: ReleaseRef, inputDigest: Digest, assistanceUsed: AiAssistance.shape.allowedUses }),
}).superRefine((value, ctx) => {
  const ids = new Set(value.evidence.map((e) => e.id));
  if (ids.size !== value.evidence.length || value.findings.some((f) => f.evidenceIds.some((id) => !ids.has(id)))) {
    ctx.addIssue({ code: "custom", message: "Findings must reference unique submitted evidence" });
  }
});
/** A portable suggestion report, containing host-local data; never export in a blueprint. */
export type AssessmentReport = z.infer<typeof AssessmentReport>;
