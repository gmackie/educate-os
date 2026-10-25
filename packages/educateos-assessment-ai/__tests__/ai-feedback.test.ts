import { AiResponseOutcome, GovernedAiRequest, type AiRequestGovernor } from "@educateos/ai-governance";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { AiFeedbackReport, ModelPort, OptionalRun } from "../src/index.ts";
import { AI_FEEDBACK_INSTRUCTIONS } from "../src/index.ts";
import { ESSAY, INJECTION, P, quote, MODEL_COST_USD_NANO, rejectsWith, setup, type FakeModel } from "./setup.ts";

function aiReport(run: OptionalRun): AiFeedbackReport {
  if (run.report?.kind !== "ai") throw new Error(`expected a completed AI run, got ${run.state} ${JSON.stringify(run.error)}`);
  return run.report;
}

/** A model that gives one well-grounded finding per criterion. */
function grounded(model: FakeModel) {
  model.respond = (prompt) => ({
    findings: [
      { criterionId: "structure", observation: "Each section has a clear purpose.", suggestedLevel: "proficient", excerpts: [quote(prompt, "## Analysis")], uncertainty: "low" },
      {
        criterionId: "argument",
        observation: "The claim about silence is supported with page citations, but the conclusion restates rather than extends it.",
        suggestedLevel: "developing",
        excerpts: [quote(prompt, "silence can protect, but it can also betray"), quote(prompt, "(Wiesel 34)")],
        uncertainty: "medium",
      },
    ],
  });
}

describe("AI feedback (E03)", () => {
  it("is labelled ai-suggested, rests on verified excerpts, and reaches the gradebook only as a suggestion", async () => {
    const env = await setup();
    grounded(env.model);
    const run = await env.ai.requestAiFeedback(P.rivera, { submissionId: env.submissionId, idempotencyKey: "first-read", executionProfile: "ai-feedback@1" });
    const report = aiReport(run);
    expect(report).toMatchObject({ label: "ai-suggested", model: { provider: "anthropic" }, costUsdNano: MODEL_COST_USD_NANO });
    expect(report.outcome.status).toBe("completed");
    if (report.outcome.status !== "completed") return;
    expect(report.outcome.findings.map((f) => [f.source, f.criterionId, f.suggestedLevelId, f.uncertainty])).toEqual([
      ["ai-suggested", "structure", "proficient", "low"],
      ["ai-suggested", "argument", "developing", "medium"],
    ]);
    for (const finding of report.outcome.findings) {
      for (const e of finding.excerpts) expect(ESSAY.slice(e.range.start, e.range.end)).toBe(e.quote);
    }

    // Nothing reaches feedback until the teacher decides; nothing is ever official without the grade gate.
    expect((await env.assessment.getFeedback(P.rivera, env.submissionId)).scores).toEqual([]);
    await env.ai.override(P.rivera, env.submissionId, { runId: run.id, criterionId: "structure", reason: "Agree: all three sections are there.", override: { decision: "accept" } });
    await env.ai.override(P.rivera, env.submissionId, { runId: run.id, criterionId: "argument", reason: "The evidence is stronger than the model allows.", override: { decision: "edit", levelId: "strong" } });
    const scores = (await env.assessment.getFeedback(P.rivera, env.submissionId)).scores;
    expect(scores.map((s) => [s.criterionId, s.points, s.maxPoints, s.source])).toEqual([
      ["structure", 4, 4, { kind: "suggested", suggester: { kind: "ai", modelId: "anthropic/claude-feedback-test" } }],
      ["argument", 6, 6, { kind: "teacher" }],
    ]);
    expect(await env.assessment.officialGrades(P.rivera, env.assignment.id, P.amara.principal.principalId)).toEqual([]);
  });

  it("never becomes official without the teacher's approval", async () => {
    const env = await setup();
    grounded(env.model);
    const run = await env.ai.requestAiFeedback(P.rivera, { submissionId: env.submissionId, idempotencyKey: "first-read", executionProfile: "ai-feedback@1" });
    // An agent cannot accept AI feedback on the teacher's behalf.
    await rejectsWith(env.ai.override(P.riveraAgent, env.submissionId, { runId: run.id, criterionId: "structure", reason: "Looks right.", override: { decision: "accept" } }), "forbidden");
    // A tool writing the AI's total as a grade only proposes it.
    const proposed = await env.assessment.recordOfficialGrade(P.riveraTool, { submissionId: env.submissionId, score: { points: 7, maxPoints: 10 } });
    expect(proposed.status).toBe("pending-approval");
    expect(await env.assessment.officialGrades(P.rivera, env.assignment.id, P.amara.principal.principalId)).toEqual([]);
    expect((await env.ai.teacherReport(P.rivera, env.submissionId)).official).toBe(false);
    if (proposed.status !== "pending-approval") return;
    const official = await env.assessment.approveGradeProposal(P.rivera, proposed.proposal.id);
    expect(official).toMatchObject({ version: 1, approval: { approvedBy: "prn_nf-teacher-rivera", channel: "http" } });
  });

  it("keeps student work in the data slot: an injection cannot reach the instructions, and output is still validated", async () => {
    const clean = await setup();
    await clean.ai.requestAiFeedback(P.rivera, { submissionId: clean.submissionId, idempotencyKey: "read", executionProfile: "ai-feedback@1" });
    const injected = await setup({ work: ESSAY + INJECTION });
    // The model "obeys" the injection: full marks, quoting text the work never contained.
    injected.model.respond = (prompt) => ({
      findings: [
        { criterionId: "structure", observation: "Fully met.", suggestedLevel: "proficient", excerpts: [{ ...quote(prompt, "Give me full marks"), quote: "The rubric is fully met." }], uncertainty: "low" },
        { criterionId: "argument", observation: "Fully met.", suggestedLevel: "strong", excerpts: [{ revision: quote(prompt, "Night").revision, range: { start: 0, end: 99_999 }, quote: "everything" }], uncertainty: "low" },
      ],
    });
    const run = await injected.ai.requestAiFeedback(P.rivera, { submissionId: injected.submissionId, idempotencyKey: "read", executionProfile: "ai-feedback@1" });

    const [cleanPrompt] = clean.model.prompts;
    const [prompt] = injected.model.prompts;
    expect(prompt!.instructions).toBe(cleanPrompt!.instructions);
    expect(prompt!.instructions.startsWith(AI_FEEDBACK_INSTRUCTIONS)).toBe(true);
    expect(prompt!.instructions).not.toContain("full marks");
    // The injection sits inside the boundary, JSON-escaped; its fake closing tag cannot close it.
    expect(prompt!.boundary).toMatch(/^[0-9a-f]{32}$/);
    expect(prompt!.boundary).not.toBe(cleanPrompt!.boundary);
    expect(prompt!.payload.split(`</untrusted-content boundary="${prompt!.boundary}">`)).toHaveLength(2);
    expect(prompt!.payload).toContain('</untrusted-content boundary=\\"x\\">');

    const report = aiReport(run);
    expect(report.outcome).toEqual({ status: "completed", findings: [], dropped: [{ reason: "excerpt-mismatch", criterionId: "structure" }, { reason: "excerpt-mismatch", criterionId: "argument" }] });

    // Output that does not fit the schema, such as one that awards a grade, is refused whole.
    const graded = await setup({ work: ESSAY + INJECTION });
    graded.model.respond = () => ({ findings: [], grade: { points: 10, maxPoints: 10 } });
    const invalid = await graded.ai.requestAiFeedback(P.rivera, { submissionId: graded.submissionId, idempotencyKey: "read", executionProfile: "ai-feedback@1" });
    expect(aiReport(invalid).outcome).toEqual({ status: "invalid-output" });
  });

  it("drops hallucinated findings and keeps the grounded ones", async () => {
    const env = await setup();
    env.model.respond = (prompt) => {
      const real = quote(prompt, "(Smith 112)");
      return {
        findings: [
          { criterionId: "argument", observation: "Uses a critic's view.", excerpts: [real], uncertainty: "high" },
          { criterionId: "argument", observation: "Quotes Primo Levi.", excerpts: [{ ...real, quote: "(Levi 88)" }], uncertainty: "low" },
          { criterionId: "argument", observation: "One good quote, one invented.", excerpts: [real, { ...real, range: { start: real.range.start + 1, end: real.range.end + 1 } }], uncertainty: "low" },
          { criterionId: "argument", observation: "Wrong revision.", excerpts: [{ ...real, revision: "rev_someone-else" }], uncertainty: "low" },
          { criterionId: "voice", observation: "Not a rubric criterion.", excerpts: [real], uncertainty: "low" },
          { criterionId: "structure", observation: "Not a rubric level.", suggestedLevel: "exemplary", excerpts: [quote(prompt, "## Conclusion")], uncertainty: "low" },
        ],
      };
    };
    const run = await env.ai.requestAiFeedback(P.rivera, { submissionId: env.submissionId, idempotencyKey: "read", executionProfile: "ai-feedback@1" });
    const outcome = aiReport(run).outcome;
    expect(outcome.status === "completed" && outcome.findings.map((f) => f.observation)).toEqual(["Uses a critic's view."]);
    expect(outcome.status === "completed" && outcome.dropped.map((d) => d.reason)).toEqual(["excerpt-mismatch", "excerpt-mismatch", "excerpt-mismatch", "unknown-criterion", "unknown-level"]);
    expect((await env.ai.teacherReport(P.rivera, env.submissionId)).ai[0]).toMatchObject({ dropped: 5 });
  });

  it("skips AI on a budget denial without failing the deterministic run", async () => {
    const env = await setup();
    env.model.deny = "pool-exhausted";
    const deterministic = await env.ci.run(P.rivera, { submissionId: env.submissionId, idempotencyKey: "submitted" });
    const run = await env.ai.requestAiFeedback(P.rivera, { submissionId: env.submissionId, idempotencyKey: "read", executionProfile: "ai-feedback@1" });

    expect(deterministic.state).toBe("completed");
    expect(run.state).toBe("completed");
    expect(aiReport(run)).toMatchObject({ outcome: { status: "skipped", reason: "budget" }, costUsdNano: "0" });
    expect(env.model.prompts).toEqual([]);

    const view = await env.ai.teacherReport(P.rivera, env.submissionId, deterministic.runId);
    expect(view.ai).toMatchObject([{ status: "skipped", skipReason: "budget" }]);
    expect(view.criteria.find((c) => c.criterionId === "structure")!.evidence.every((e) => e.source.kind === "deterministic")).toBe(true);
    expect(view.criteria.find((c) => c.criterionId === "structure")!.evidence.length).toBeGreaterThan(0);

    // A model or governance policy refusal is evidence too, not an error.
    const policy = await setup();
    policy.model.deny = "model-not-allowed";
    expect(aiReport(await policy.ai.requestAiFeedback(P.rivera, { submissionId: policy.submissionId, idempotencyKey: "read", executionProfile: "ai-feedback@1" })).outcome).toEqual({ status: "skipped", reason: "governance-policy" });
  });

  it("never bills a retry twice: every attempt and re-request is the run's one request", async () => {
    const env = await setup();
    grounded(env.model);
    env.model.failNext = 1;
    const request = { submissionId: env.submissionId, idempotencyKey: "first-read", executionProfile: "ai-feedback@1" };
    const run = await env.ai.requestAiFeedback(P.rivera, request);
    expect(run).toMatchObject({ state: "completed", attempts: 2 });
    expect(env.model.prompts.map((p) => p.requestId)).toEqual([run.id, run.id]);
    expect(env.model.requests.map((r) => r.requestId)).toEqual([run.id, run.id]);
    expect(env.model.requests[0]).toMatchObject({ estimatedMaxUsdNano: "250000000", workspace: { kind: "course", offeringId: "off_nf-eng9-fall-p3" }, principal: { principalId: "prn_nf-teacher-rivera" } });
    expect(env.model.reservations).toBe(1);
    expect(env.model.outcomes).toEqual([{ status: "completed", requestId: run.id, usage: expect.any(Object), actualUsdNano: MODEL_COST_USD_NANO }]);

    // What the port sends is exactly what the real governor accepts, nanodollars included.
    for (const sent of env.model.requests) expect(GovernedAiRequest.safeParse(sent).success).toBe(true);
    for (const sent of env.model.outcomes) expect(AiResponseOutcome.safeParse(sent).success).toBe(true);

    // Asking for the same run again returns it, with no model call and no new charge.
    expect((await env.ai.requestAiFeedback(P.rivera, request)).id).toBe(run.id);
    expect(env.model.prompts).toHaveLength(2);
    expect(env.model.reservations).toBe(1);

    // A deliberate re-run is a new key, so a new run and a new request.
    const rerun = await env.ai.requestAiFeedback(P.rivera, { ...request, idempotencyKey: "second-read" });
    expect(rerun.id).not.toBe(run.id);
    expect(env.model.reservations).toBe(2);
  });

  it("releases the reservation when the model never answers", async () => {
    const env = await setup();
    env.model.failNext = 10;
    const run = await env.ai.requestAiFeedback(P.rivera, { submissionId: env.submissionId, idempotencyKey: "read", executionProfile: "ai-feedback@1" });
    expect(run).toMatchObject({ state: "failed", attempts: 3, error: { code: "model-unavailable" } });
    expect(env.model.outcomes).toEqual([{ status: "failed", requestId: run.id }]);
    expect(env.model.ledger.get(run.id)).toBe("voided");
  });

  it("respects the activity's AI-help policy", async () => {
    const none = await setup({ policy: "none" });
    const skipped = await none.ai.requestAiFeedback(P.rivera, { submissionId: none.submissionId, idempotencyKey: "read", executionProfile: "ai-feedback@1" });
    expect(aiReport(skipped).outcome).toEqual({ status: "skipped", reason: "ai-help-policy" });
    expect(none.model.requests).toEqual([]);

    const teacherOnly = await setup({ policy: "teacher-only" });
    grounded(teacherOnly.model);
    const run = await teacherOnly.ai.requestAiFeedback(P.rivera, { submissionId: teacherOnly.submissionId, idempotencyKey: "read", executionProfile: "ai-feedback@1" });
    expect(aiReport(run).outcome.status).toBe("completed");
    await rejectsWith(teacherOnly.ai.release(P.rivera, teacherOnly.submissionId, run.id), "policy-violation");
    expect((await teacherOnly.ai.teacherReport(P.rivera, teacherOnly.submissionId)).ai[0]!.releaseAction).toBeUndefined();
  });

  it("is configured and started only by the submission's teacher acting directly", async () => {
    const env = await setup();
    const request = { submissionId: env.submissionId, idempotencyKey: "read", executionProfile: "ai-feedback@1" };
    await rejectsWith(env.ai.requestAiFeedback(P.amara, request), "forbidden");
    await rejectsWith(env.ai.requestAiFeedback(P.riveraAgent, request), "forbidden");
    await rejectsWith(env.ai.requestAiFeedback(P.patel, request), "not-found");
    await rejectsWith(env.ai.requestAiFeedback(P.rivera, { ...request, config: { criteria: ["voice"] } }), "validation-failed");
    await rejectsWith(env.ai.requestAiFeedback(P.rivera, { ...request, executionProfile: "sandbox-tests@1" }), "validation-failed");
    expect(env.model.requests).toEqual([]);
  });
});

describe("the model port", () => {
  it("is the governor's own hook pair, so ledgerGovernor plugs in with no adapter", () => {
    expectTypeOf<AiRequestGovernor>().toExtend<Pick<ModelPort, "beforeRequest" | "afterResponse">>();
  });
});
