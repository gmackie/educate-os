import { z } from "zod";
import { Assistance, Surface, type ActivityRequest } from "@educateos/activity-adapters/contracts";
import { acceptEvidence, type EvidenceInbox } from "@educateos/activity-adapters/evidence";
import { Digest, digestJson } from "@educateos/assessment-sdk";
import { EducateOsError } from "@educateos/contracts";
import type { PlannerPlan } from "./planner.ts";

/** Only explicitly shared provenance crosses into planner views; source data stays in its host. */
export const PlannerActivityEvidence = z.strictObject({
  digest: Digest,
  status: z.enum(["complete", "partial", "unavailable", "unsupported", "error", "denied", "replay"]),
  assistance: Assistance,
  surfaces: z.array(z.strictObject({ surface: Surface, status: z.enum(["observed", "unavailable", "unsupported", "error"]) })),
  learningClaim: z.literal("requires-teacher-verification"),
});

/** Server-owned paired evidence lookup. Requests cannot supply an adapter, authority or expected scope. */
export interface PlannerActivityEvidenceSource {
  /** Recheck session consent and source access; the inbox must authenticate receipts and durably reject replay. */
  resolve(reference: string, scope: {
    districtId: string; offeringId: string; studentId: string; opportunityId: string;
  }): Promise<{ bundle: unknown; expected: ActivityRequest; inbox: EvidenceInbox } | undefined>;
}

/** Accept a voluntarily shared bundle without treating observed activity as independent assessment. */
export async function plannerActivityEvidence(input: {
  source?: PlannerActivityEvidenceSource; reference: string; districtId: string;
  plan: PlannerPlan; opportunity: PlannerPlan["opportunities"][number]; assistance: string;
}): Promise<z.infer<typeof PlannerActivityEvidence>> {
  if (!input.source) throw new EducateOsError("unavailable", "Activity evidence is not connected in this district.");
  const scope = { districtId: input.districtId, offeringId: input.plan.offeringId, studentId: input.plan.studentId, opportunityId: input.opportunity.id };
  try {
    const resolved = await input.source.resolve(input.reference, scope);
    if (!resolved || Object.entries(scope).some(([key, value]) => key !== "opportunityId" && resolved.expected.scope[key as "districtId" | "offeringId" | "studentId"] !== value)
        || await digestJson(resolved.expected.contract) !== await digestJson(input.opportunity.contract)) throw new Error("Evidence scope mismatch");
    // A single planner label may summarize mixed help as unknown, but must never erase it.
    const disclosed = resolved.expected.assistance;
    if (input.assistance !== (disclosed.length === 1 ? disclosed[0] : "unknown")) throw new Error("Assistance mismatch");
    const bundle = await acceptEvidence(resolved.bundle, resolved.expected, resolved.inbox);
    return PlannerActivityEvidence.parse({ digest: bundle.digest, status: bundle.body.status,
      assistance: bundle.body.request.assistance, learningClaim: bundle.body.learningClaim,
      surfaces: bundle.body.observations.map(({ surface, status }) => ({ surface, status })) });
  } catch {
    throw new EducateOsError("conflict", "Activity evidence could not be verified for this response. Check its sharing, source, contract and assistance.");
  }
}
