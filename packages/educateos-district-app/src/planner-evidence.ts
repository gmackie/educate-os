import { z } from "zod";
import { EducateOsError, OfferingId, PrincipalId } from "@educateos/contracts";
import type { PlannerPlan, PlannerReviewInput } from "./planner.ts";

/** Advisory knowledge, recomputed from evidence rather than an editable score or model impression. */
export const PlannerKnowledge = z.strictObject({
  version: z.literal(1), offeringId: OfferingId, studentId: PrincipalId,
  competencies: z.array(z.strictObject({
    competencyUri: z.string(), releaseDigest: z.string(), code: z.string(),
    status: z.enum(["unverified", "practiced", "demonstrated", "retained", "transferred"]),
    evidenceIds: z.array(z.string()), reviewedAt: z.iso.datetime().optional(),
    /** Historical recommendations stay intact but are not criterion-verified evidence. */
    needsCriterionReconfirmation: z.boolean().optional(),
  })),
});

type Opportunity = PlannerPlan["opportunities"][number];
type Review = z.infer<typeof PlannerReviewInput>;
/** A review must cover exactly the pinned contract, with observed evidence for every criterion. */
export const plannerRubricMet = (review: Review, opportunity: Opportunity): boolean => {
  const rubric = review.assessment?.rubric;
  return rubric !== undefined && rubric.contractId === opportunity.contract.id && rubric.contractVersion === opportunity.contract.version
    && opportunity.contract.criteria.length > 0 && rubric.criteria.length === opportunity.contract.criteria.length
    && new Set(rubric.criteria.map((c) => c.criterionId)).size === rubric.criteria.length
    && opportunity.contract.criteria.every((c) => rubric.criteria.some((r) => r.criterionId === c.id && r.rating === "met" && r.sourceSnippet.trim() !== ""));
};
/** The common evidence floor for learner knowledge, teacher coverage and family progress. */
export const independentlyReviewedPlannerEvidence = (o: Opportunity) => {
  const r = o.reviews.at(-1);
  return o.response !== undefined && o.challenge?.assistance === "independent" && r?.decision === "recommend" && r.assistance === "independent" && r.independentlyAssessed && plannerRubricMet(r, o) && ["demonstrated", "retained", "transferred"].includes(r.level);
};

/** Requires a separately observed, unseen teacher assessment; student practice is never its own test. */
export function assertPlannerAssessment(review: Review, opportunity: Opportunity, prior: PlannerPlan[], at: string): void {
  const rubric = review.assessment?.rubric;
  if (rubric !== undefined && (rubric.contractId !== opportunity.contract.id || rubric.contractVersion !== opportunity.contract.version
    || rubric.criteria.length !== opportunity.contract.criteria.length || new Set(rubric.criteria.map((c) => c.criterionId)).size !== rubric.criteria.length
    || !opportunity.contract.criteria.every((c) => rubric.criteria.some((r) => r.criterionId === c.id)))) {
    throw new EducateOsError("conflict", "The rubric must name this opportunity's exact contract version and each criterion exactly once.");
  }
  if (review.decision !== "recommend") return;
  const assessment = review.assessment;
  if (opportunity.challenge?.assistance !== "independent" || assessment === undefined) {
    throw new EducateOsError("conflict", "Share an independent practice challenge, then record a separate unseen teacher assessment before recommending mastery.");
  }
  if (!plannerRubricMet(review, opportunity)) {
    throw new EducateOsError("conflict", "Review every criterion of the pinned evidence contract with a rating and an observed excerpt from the separate teacher check. Only all-met evidence supports a recommendation.");
  }
  if (Date.parse(assessment.observedAt) < Date.parse(opportunity.challenge.sharedAt) || Date.parse(assessment.observedAt) > Date.parse(at)) {
    throw new EducateOsError("conflict", "The teacher assessment must follow the shared practice and cannot be in the future.");
  }
  const method = review.level === "retained" ? "delayed-check" : review.level === "transferred" ? "new-context" : "independent-task";
  if (assessment.method !== method) throw new EducateOsError("conflict", "The assessment conditions must match the claimed evidence level.");
  if (review.level === "demonstrated") return;
  const baseline = prior.flatMap((p) => p.opportunities).filter((o) => o.id !== opportunity.id && o.node.uri === opportunity.node.uri && o.releaseDigest === opportunity.releaseDigest && independentlyReviewedPlannerEvidence(o)).map((o) => o.reviews.at(-1)!).filter((r) => Date.parse(r.assessment!.observedAt) < Date.parse(assessment.observedAt));
  if (review.level === "retained" && !baseline.some((r) => Date.parse(assessment.observedAt) - Date.parse(r.assessment!.observedAt) >= 7 * 86400000)) {
    throw new EducateOsError("conflict", "Retention requires a prior independently reviewed demonstration and a delayed check at least seven days later.");
  }
  if (review.level === "transferred" && !baseline.some((r) => r.assessment!.context.toLowerCase() !== assessment.context.toLowerCase())) {
    throw new EducateOsError("conflict", "Transfer requires a prior independently reviewed demonstration and a different assessment context.");
  }
}

/** Scope is supplied by authenticated enrollment; only the latest review controls each competency. */
export function plannerKnowledge(plans: PlannerPlan[], offeringId: z.infer<typeof OfferingId>, studentId: z.infer<typeof PrincipalId>): z.infer<typeof PlannerKnowledge> {
  const grouped = new Map<string, Opportunity[]>();
  for (const plan of plans.filter((p) => p.offeringId === offeringId && p.studentId === studentId)) {
    for (const o of plan.opportunities) {
      const key = `${o.node.uri}:${o.releaseDigest}`;
      grouped.set(key, [...(grouped.get(key) ?? []), o]);
    }
  }
  return {
    version: 1, offeringId, studentId,
    competencies: [...grouped.values()].map((opportunities) => {
      const first = opportunities[0]!;
      const reviewed = opportunities.filter((o) => o.reviews.length > 0).toSorted((a, b) => a.reviews.at(-1)!.at.localeCompare(b.reviews.at(-1)!.at) || Number(a.reviews.at(-1)!.decision === "hold") - Number(b.reviews.at(-1)!.decision === "hold"));
      const latest = reviewed.at(-1);
      const status = latest && independentlyReviewedPlannerEvidence(latest) ? latest.reviews.at(-1)!.level as "demonstrated" | "retained" | "transferred" : opportunities.some((o) => o.response !== undefined) ? "practiced" as const : "unverified" as const;
      return { competencyUri: first.node.uri, releaseDigest: first.releaseDigest, code: first.code, status, evidenceIds: opportunities.filter((o) => o.response !== undefined).map((o) => o.id), ...(latest ? { reviewedAt: latest.reviews.at(-1)!.at, ...(latest.reviews.at(-1)!.decision === "recommend" && latest.reviews.at(-1)!.assessment?.rubric === undefined ? { needsCriterionReconfirmation: true } : {}) } : {}) };
    }),
  };
}
