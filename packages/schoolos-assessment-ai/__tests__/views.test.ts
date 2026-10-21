import { describe, expect, it } from "vitest";
import { FakeExecutionSandbox, studentReportView } from "../src/index.ts";
import { ESSAY, P, quote, rejectsWith, setup } from "./setup.ts";

/** A full environment: a deterministic run, sandboxed checks and one AI run, nothing released yet. */
async function everything() {
  const sandbox = new FakeExecutionSandbox({
    "tests/hidden.py": (ctx) => {
      ctx.cpu(100);
      ctx.test("hidden-answer-check", false);
    },
    "tests/visible.py": (ctx) => {
      ctx.cpu(100);
      ctx.test("runs", true);
    },
  });
  const env = await setup({ sandbox });
  env.model.respond = (prompt) => ({
    findings: [
      { criterionId: "structure", observation: "AI-STRUCTURE: sections are clear.", suggestedLevel: "proficient", excerpts: [quote(prompt, "## Introduction")], uncertainty: "low" },
      { criterionId: "argument", observation: "AI-ARGUMENT: claim is well supported.", suggestedLevel: "strong", excerpts: [quote(prompt, "(Wiesel 7)")], uncertainty: "medium" },
    ],
  });
  const deterministic = await env.ci.run(P.rivera, { submissionId: env.submissionId, idempotencyKey: "submitted" });
  await env.ai.runSandbox(P.rivera, {
    submissionId: env.submissionId,
    idempotencyKey: "tests",
    executionProfile: "sandbox-tests@1",
    checks: [
      { id: "hidden", criterionId: "argument", entrypoint: "tests/hidden.py", visibility: "teacher-only" },
      { id: "visible", criterionId: "structure", entrypoint: "tests/visible.py", visibility: "student-visible" },
    ],
  });
  const aiRun = await env.ai.requestAiFeedback(P.rivera, { submissionId: env.submissionId, idempotencyKey: "read", executionProfile: "ai-feedback@1", config: { instructions: "Focus on use of evidence." } });
  return { ...env, deterministicRunId: deterministic.runId, aiRun };
}

/** What must never reach a student before the teacher releases it, or ever. */
const TEACHER_ONLY = ["content.required", "Discusses silence", "hidden-answer-check", "suggestions", "suggestedLevel", "points", "anthropic", "costCents", "proficient", "strong"];

function expectNoTeacherOnly(value: unknown, also: string[] = []): void {
  const json = JSON.stringify(value);
  for (const secret of [...TEACHER_ONLY, ...also]) expect(json, secret).not.toContain(secret);
}

describe("rubric report views", () => {
  it("shows the teacher every source, labelled, with excerpts linked to revision ranges and open actions", async () => {
    const env = await everything();
    const view = await env.ai.teacherReport(P.rivera, env.submissionId, env.deterministicRunId);
    const structure = view.criteria.find((c) => c.criterionId === "structure")!;
    expect([...new Set(structure.evidence.map((e) => e.source.kind))]).toEqual(["deterministic", "sandbox", "ai-suggested"]);
    expect(structure.evidence.find((e) => e.source.kind === "deterministic")!.source).toMatchObject({ label: "writing.structure@1.0.0", visibility: "student-visible" });
    const ai = structure.evidence.find((e) => e.source.kind === "ai-suggested")!;
    expect(ai).toMatchObject({ source: { label: "anthropic/claude-feedback-test", runId: env.aiRun.id }, uncertainty: "low" });
    const [excerpt] = ai.excerpts;
    expect(excerpt!.anchor).toEqual({ artifactId: env.essay.artifact.id, revisionId: env.essay.head.id, region: { kind: "text-range", start: excerpt!.range.start, end: excerpt!.range.end } });
    expect(ESSAY.slice(excerpt!.range.start, excerpt!.range.end)).toBe("## Introduction");
    expect(structure.suggestions.map((s) => [s.source, s.label, s.levelId])).toEqual([
      ["deterministic", "writing.structure@1.0.0", "proficient"],
      ["ai-suggested", "anthropic/claude-feedback-test", "proficient"],
    ]);
    expect(structure.actions.map((a) => a.action)).toEqual(["accept", "reject", "edit"]);
    expect(view.ai).toMatchObject([{ label: "ai-suggested", status: "completed", costCents: 3, released: false, releaseAction: { action: "release" } }]);
    expect(view.official).toBe(false);

    // Once the teacher decides, the decision replaces the actions.
    await env.ai.override(P.rivera, env.submissionId, { runId: env.aiRun.id, criterionId: "structure", reason: "Agree.", override: { decision: "accept" } });
    const after = (await env.ai.teacherReport(P.rivera, env.submissionId)).criteria.find((c) => c.criterionId === "structure")!;
    expect(after.actions).toEqual([]);
    expect(after.overrides).toEqual([{ runId: env.aiRun.id, override: { decision: "accept" }, reason: "Agree.", decidedBy: "prn_nf-teacher-rivera" }]);
  });

  it("never shows the student teacher-only checks or unreleased AI feedback", async () => {
    const env = await everything();
    const before = await env.ai.studentReport(P.amara, env.submissionId, env.deterministicRunId);
    expect(before.criteria.map((c) => [c.criterionId, c.evidence.map((e) => e.source.kind)])).toEqual([["structure", ["deterministic", "deterministic", "deterministic", "deterministic", "sandbox"]]]);
    expect(before.aiNotice).toBeUndefined();
    expectNoTeacherOnly(before, ["AI-STRUCTURE", "AI-ARGUMENT", "ai-suggested"]);

    // The teacher rejects the argument feedback and releases the run: the student sees the rest, labelled, with no levels.
    await env.ai.override(P.rivera, env.submissionId, { runId: env.aiRun.id, criterionId: "argument", reason: "Too generous.", override: { decision: "reject" } });
    await env.ai.release(P.rivera, env.submissionId, env.aiRun.id);
    const after = await env.ai.studentReport(P.amara, env.submissionId, env.deterministicRunId);
    const aiItems = after.criteria.flatMap((c) => c.evidence).filter((e) => e.source.kind === "ai-suggested");
    expect(aiItems.map((e) => [e.source.label, e.observation])).toEqual([["ai-suggested", "AI-STRUCTURE: sections are clear."]]);
    expect(after.aiNotice).toMatch(/not a grade/);
    expectNoTeacherOnly(after, ["AI-ARGUMENT", "Too generous"]);

    // Releasing is the teacher's decision alone, and the builder filters whatever it is handed.
    await rejectsWith(env.ai.release(P.riveraAgent, env.submissionId, env.aiRun.id), "forbidden");
    await rejectsWith(env.ai.teacherReport(P.amara, env.submissionId), "forbidden");
    const runs = await env.store.runsFor(env.submissionId);
    const raw = studentReportView({ submissionId: env.submissionId, rubric: env.release, runs, overrides: [], releases: [], aiHelpPolicy: "releasable" });
    expectNoTeacherOnly(raw, ["AI-STRUCTURE", "AI-ARGUMENT"]);
  });

  it("withdraws released AI feedback from the student when the policy no longer allows it", async () => {
    const env = await everything();
    await env.ai.release(P.rivera, env.submissionId, env.aiRun.id);
    expect(JSON.stringify(await env.ai.studentReport(P.amara, env.submissionId))).toContain("AI-STRUCTURE");
    env.policies.current = "teacher-only";
    expectNoTeacherOnly(await env.ai.studentReport(P.amara, env.submissionId), ["AI-STRUCTURE"]);
  });

  it("is not available to another student", async () => {
    const env = await everything();
    await rejectsWith(env.ai.studentReport(P.elena, env.submissionId), "not-found");
  });
});
