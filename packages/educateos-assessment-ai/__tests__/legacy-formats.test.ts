// SCHO-232: optional runs requested before the EducateOS rename were keyed, and their reports
// stored, under `schoolos.*` format names. Requesting the same run again finds the stored one
// instead of paying for another, and new runs still use the new names.
import { canonicalDigest, legacyAssessmentRunIdFor } from "@educateos/assessment-ci";
import { describe, expect, it } from "vitest";
import { AiFeedbackReport, SandboxReport, type OptionalRun } from "../src/index.ts";
import { P, quote, setup } from "./setup.ts";

describe("runs from before the EducateOS rename", () => {
  it("are found again by the same request, not requested and paid for again", async () => {
    const env = await setup();
    env.model.respond = (prompt) => ({
      findings: [{ criterionId: "structure", observation: "Clear sections.", suggestedLevel: "proficient", excerpts: [quote(prompt, "## Analysis")], uncertainty: "low" }],
    });
    const request = { submissionId: env.submissionId, executionProfile: "ai-feedback@1" };
    const fresh = await env.ai.requestAiFeedback(P.rivera, { ...request, idempotencyKey: "fresh" });
    expect(fresh.report?.format).toBe("educateos.ai-feedback-report.v2");
    const paid = env.model.requests.length;

    // The run the code before the rename stored for the request keyed "before-rename".
    const legacyEvaluator = await canonicalDigest({ format: "schoolos.optional-evaluator.v1", spec: fresh.spec });
    const newKey = { ...fresh.key, idempotencyKey: "before-rename" };
    const legacyKey = { ...newKey, evaluatorRelease: legacyEvaluator };
    const legacyId = await legacyAssessmentRunIdFor(newKey, legacyEvaluator);
    expect(legacyId).toBe(`asr_${(await canonicalDigest({ format: "schoolos.assessment-run-key.v1", key: legacyKey })).slice(7, 47)}`);
    const stored = {
      ...fresh,
      id: legacyId,
      key: legacyKey,
      report: { ...fresh.report!, runId: legacyId, key: legacyKey, format: "schoolos.ai-feedback-report.v2" },
    } as OptionalRun;
    await env.store.insertRun(stored);

    const again = await env.ai.requestAiFeedback(P.rivera, { ...request, idempotencyKey: "before-rename" });
    expect(again.id).toBe(legacyId);
    expect(again.report?.format).toBe("schoolos.ai-feedback-report.v2");
    expect(env.model.requests.length).toBe(paid);
  });

  it("parse stored reports with the legacy formats", () => {
    const ai = AiFeedbackReport.shape.format;
    expect(ai.parse("schoolos.ai-feedback-report.v2")).toBe("schoolos.ai-feedback-report.v2");
    expect(ai.safeParse("other.ai-feedback-report.v2").success).toBe(false);
    expect(SandboxReport.shape.format.parse("schoolos.sandbox-report.v2")).toBe("schoolos.sandbox-report.v2");
  });
});
