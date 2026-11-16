import type { PilotPlan } from "./district.ts";

/** Fake teacher observations for software replay only, never automatic assessment. */
export const syntheticCheckRubric = (o: PilotPlan["opportunities"][number]) => ({
  source: "teacher-observed-common-check" as const, contractId: o.contract.id, contractVersion: o.contract.version,
  criteria: o.contract.criteria.map((c) => ({ criterionId: c.id, rating: "met" as const, sourceSnippet: "Synthetic teacher observation on a separate unseen check; not live student evidence." })),
});
