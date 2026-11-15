import { digestJson } from "@educateos/assessment-sdk";
import { z } from "zod";
import { ActivityScope, Artifact, Assistance, Id, Measurement, type Observation } from "./contracts.ts";
import { missingObservation, type LearningActivityAdapter } from "./runtime.ts";

/** Explicit learner submission. No automatic photo capture, private chat or inferred assistance. */
export const OfflineSubmission = z.strictObject({
  id: Id, sessionId: Id, scope: ActivityScope,
  domain: z.enum(["sports", "baking", "cooking", "crafts", "other"]),
  performedAt: z.iso.datetime(),
  explanation: z.string().trim().min(1).max(5000),
  assistance: Assistance,
  measurements: z.array(Measurement).max(100),
  artifacts: z.array(Artifact).max(31),
  explicitlyShared: z.literal(true),
});
/** Offline submissions are learner assertions until an authorized teacher verifies them. */
export type OfflineSubmission = z.infer<typeof OfflineSubmission>;
/**
 * Normalize a voluntary offline submission. The worksheet hash pins its original occurrence time,
 * explanation, assistance and measurements; observedAt is the time the submission was collected.
 * Keep the submission in authorized district storage so a teacher can inspect the pinned bytes.
 */
export function offlineAdapter(raw: unknown, now: () => Date = () => new Date()): LearningActivityAdapter {
  const submission = OfflineSubmission.parse(raw);
  return {
    descriptor: { id: "offline-activity", version: "1", actions: [
      { id: "shared-submission", operation: "collect-evidence", surfaces: ["physical"] },
    ] },
    async execute(request) {
      const at = now().toISOString();
      const fail = (code: Observation["code"]) => [missingObservation(request, "physical", "error", code, at)];
      if (request.sessionId !== submission.sessionId || await digestJson(request.scope) !== await digestJson(submission.scope)
          || await digestJson(request.assistance) !== await digestJson(submission.assistance)) return fail("source-mismatch");
      if (Date.parse(submission.performedAt) > Date.parse(at)) return fail("stale");
      return [{ surface: "physical", sourceId: submission.scope.sourceId, revision: submission.scope.revision,
        observedAt: at, status: "observed", code: "ok", measurements: submission.measurements,
        artifacts: [...submission.artifacts, { id: submission.id, digest: await digestJson(submission), kind: "worksheet" }] }];
    },
  };
}
