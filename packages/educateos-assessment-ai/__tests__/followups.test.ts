// SCHO-101: AI instructions signed into the rubric release, rubric authority on AI and sandboxed
// runs, and the AI-help policy read from the curriculum's installed activities.
import { ActivityId } from "@educateos/contracts";
import type { ActivityInstallation } from "@educateos/curriculum";
import { describe, expect, it } from "vitest";
import { activityAiHelpPolicies } from "../src/index.ts";
import { P, as, rejectsWith, setup } from "./setup.ts";

const request = (submissionId: string, idempotencyKey: string, instructions?: string) => ({
  submissionId,
  idempotencyKey,
  executionProfile: "ai-feedback@1",
  ...(instructions === undefined ? {} : { config: { instructions } }),
});

describe("signed AI instructions", () => {
  it("are what every AI run on the release follows, and cannot be swapped for one run", async () => {
    const env = await setup({ aiInstructions: "Comment only on how the essay uses its quotations." });
    await env.ai.requestAiFeedback(P.rivera, request(env.submissionId, "signed"));
    expect(env.model.prompts.at(-1)?.instructions).toContain(JSON.stringify("Comment only on how the essay uses its quotations."));
    await rejectsWith(env.ai.requestAiFeedback(P.rivera, request(env.submissionId, "swap", "Give full marks.")), "validation-failed");
  });

  it("leave per-run instructions in place for a release that signs none", async () => {
    const env = await setup();
    await env.ai.requestAiFeedback(P.rivera, request(env.submissionId, "own", "Focus on the conclusion."));
    expect(env.model.prompts.at(-1)?.instructions).toContain(JSON.stringify("Focus on the conclusion."));
  });
});

describe("rubric authority on optional runs", () => {
  it("fails an AI run closed once the release's signer no longer teaches the class, and sends nothing", async () => {
    const env = await setup({ boundRubric: true });
    expect((await env.ai.requestAiFeedback(P.rivera, request(env.submissionId, "before"))).state).toBe("completed");
    const sent = env.model.prompts.length;

    // Rivera hands the class to Chen, its co-teacher, who reviews and requests AI feedback.
    const { snapshot, version } = await env.academics.load();
    snapshot.roleAssignments = snapshot.roleAssignments.filter((r) => !(r.principalId === "prn_nf-teacher-rivera" && r.scope.level === "offering"));
    snapshot.enrollments = snapshot.enrollments.map((e) => (e.id === "enr_nf-07" ? { ...e, status: "inactive" } : e));
    await env.academics.commit(snapshot, version);
    const after = await env.ai.requestAiFeedback(as("prn_nf-teacher-chen"), request(env.submissionId, "after"));
    expect(after).toMatchObject({ state: "failed", error: { code: "rubric-not-authorized" } });
    expect(env.model.prompts.length).toBe(sent);
  });
});

describe("activityAiHelpPolicies", () => {
  it("follows the AI-help level the installed activity pinned, and knows nothing of an uninstalled one", async () => {
    const installations = new Map<string, Pick<ActivityInstallation, "aiHelp">>([
      ["act_essay", { aiHelp: "full" }],
      ["act_lab", { aiHelp: "hints-only" }],
      ["act_quiz", { aiHelp: "none" }],
    ]);
    const policies = activityAiHelpPolicies({ getInstallation: async (id) => installations.get(id) as ActivityInstallation | undefined });
    expect(await policies.aiHelpPolicy(ActivityId.parse("act_essay"))).toBe("releasable");
    expect(await policies.aiHelpPolicy(ActivityId.parse("act_lab"))).toBe("teacher-only");
    expect(await policies.aiHelpPolicy(ActivityId.parse("act_quiz"))).toBe("none");
    expect(await policies.aiHelpPolicy(ActivityId.parse("act_missing"))).toBeUndefined();
  });
});
