import { Digest, freezeJson } from "@educateos/assessment-sdk";
import { z } from "zod";
import { Assistance, Id, type EvidenceBundle } from "./contracts.ts";
import { verifyEvidence } from "./evidence.ts";

/** Teacher assessment of the learner; artifact behavior alone never satisfies this contract. */
export const TeacherVerification = z.strictObject({
  evidenceDigest: Digest, decision: z.enum(["hold", "verify"]),
  basis: z.enum(["artifact-only", "independent-assessment"]),
  assistance: Assistance,
  rationale: z.string().trim().min(1).max(2000),
  assessment: z.strictObject({
    responseDigest: Digest, assessedAt: z.iso.datetime(),
    context: z.string().trim().min(1).max(2000),
    criteria: z.array(z.strictObject({ id: Id, met: z.boolean() })).min(1).max(100),
  }).optional(),
});
/**
 * Authenticate the current teacher and their active offering access outside this library. This
 * is a trusted host callback, not a client-provided teacherId or role. Authenticate the bundle's
 * producer/receipt too, and recheck the pinned registry release remains approved.
 */
export interface TeacherAuthority {
  authorize(bundle: EvidenceBundle): Promise<{ teacherId: string } | null>;
}
/**
 * Return an append-only verification record pinned to one bundle. Never changes grades, mastery,
 * assistance history or the artifact. The planner's existing review policy owns recommendations.
 */
export async function verifyWithTeacher(rawBundle: unknown, rawReview: unknown, authority: TeacherAuthority,
  now: () => Date = () => new Date()) {
  const bundle = await verifyEvidence(rawBundle);
  const review = TeacherVerification.parse(rawReview);
  if (review.evidenceDigest !== bundle.digest) throw new Error("Review evidence mismatch");
  const actor = await authority.authorize(bundle);
  if (!actor || !Id.safeParse(actor.teacherId).success) throw new Error("Teacher verification unauthorized");
  if (review.decision === "verify") {
    const assessment = review.assessment;
    if (review.basis !== "independent-assessment" || !assessment
        || review.assistance.length !== 1 || review.assistance[0] !== "independent"
        || assessment.responseDigest === bundle.digest
        || bundle.body.observations.some((o) => o.artifacts.some((a) => a.digest === assessment.responseDigest))) {
      throw new Error("Artifact success, photos and AI output alone cannot verify learning");
    }
    if (bundle.body.status !== "complete") throw new Error("Resolve missing evidence surfaces before verification");
    const criteria = bundle.body.request.contract.criteria.map((c) => c.id);
    if (new Set(assessment.criteria.map((c) => c.id)).size !== assessment.criteria.length
        || assessment.criteria.length !== criteria.length
        || assessment.criteria.some((c) => !criteria.includes(c.id) || !c.met)) throw new Error("Assessment must address every pinned criterion");
    if (Date.parse(assessment.assessedAt) < Date.parse(bundle.body.completedAt)
        || Date.parse(assessment.assessedAt) > now().getTime()) throw new Error("Independent assessment must follow the submitted evidence");
  }
  return freezeJson({ ...review, by: actor.teacherId, at: now().toISOString(),
    learningClaim: "requires-planner-review" as const, changesProficiency: false as const });
}
