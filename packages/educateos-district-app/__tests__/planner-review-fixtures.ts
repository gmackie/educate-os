import type { PlannerPlan } from "../src/planner.ts";

/** Synthetic teacher-transcribed common-check observations; never inferred from student project text. */
export const observedRubric = (o: PlannerPlan["opportunities"][number]) => ({
  source: "teacher-observed-common-check" as const,
  contractId: o.contract.id,
  contractVersion: o.contract.version,
  criteria: o.contract.criteria.map((c, index) => ({
    criterionId: c.id, rating: "met" as const,
    sourceSnippet: (o.code.startsWith("W.") ? [
      "Source packet p1: I recommend repair. The materials list records four replacement boards; repair uses fewer new boards than replacement.",
      "Source packet p2: According to the dated supplier list, repair costs $24 versus $60 to replace. Therefore, repair reduces this cost. In conclusion, repair fits our materials budget.",
      "Oral check: the supplier quote supports the cost reason, while the materials list supports the quantity reason; neither alone proves the bed is safe.",
    ] : [
      "Common check p1: 24 liters / 6 minutes = 4 L/min; 30 / 10 = 3 L/min.",
      "Common check p1: after 15 minutes, 4 x 15 = 60 L and 3 x 15 = 45 L, assuming constant flow.",
      "Oral check: divide volume by time to compare per minute; the first tap is faster. Multiplying the rate by minutes cancels minutes.",
      "Fraction check p2: (3/4) / (1/8) = 6 miles/hour, with 3 miles in half an hour.",
    ])[index] ?? "Teacher observed this additional criterion independently on the synthetic check.",
  })),
});
