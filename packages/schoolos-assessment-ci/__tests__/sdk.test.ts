import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ArtifactId, RevisionId, RubricId } from "@schoolos/contracts";
import { submissionDigest, type SubmissionItem } from "@schoolos/assessment";
import { canonicalTextBytes, sha256Digest } from "@schoolos/learning-artifacts";
import {
  ArithmeticError,
  AssessmentRuns,
  builtinRegistry,
  defineEvaluator,
  DETERMINISTIC_PROFILE,
  evaluateArithmetic,
  EvaluatorRegistry,
  InMemoryAssessmentRunStore,
  InMemoryRubricReleaseStore,
  rubricRef,
  signRubricRelease,
  standaloneKit,
  verifyRubricRelease,
  writingStructure,
  type CriterionEvidence,
  type EvaluationInput,
  type EvaluationKit,
  type RubricDraft,
} from "../src/index.ts";
import { NOW, P, essayRubric, mathRubric, rejectsWith, threeSubjects } from "./setup.ts";

const arithmetic = (source: string) => evaluateArithmetic(source, standaloneKit());

describe("the safe arithmetic reader", () => {
  it("reads numbers and simple expressions", () => {
    expect(arithmetic("3/4")).toBe(0.75);
    expect(arithmetic("2^3^2")).toBe(512);
    expect(arithmetic("-(1 + 2) * 3")).toBe(-9);
    expect(arithmetic("6 ÷ 4 × 2")).toBe(3);
    expect(arithmetic(".5 + 1.25")).toBe(1.75);
  });

  it("rejects code and anything else outside the subset", () => {
    for (const source of [
      "process.exit(1)",
      "constructor",
      "alert(1)",
      "Math.PI",
      "globalThis",
      "1; 2",
      "2**3",
      "[1]",
      "'1'",
      "`${1}`",
      "1e3",
      "2(3)",
      "(1 + 2",
      "",
    ]) {
      expect(() => arithmetic(source), source).toThrow(ArithmeticError);
    }
  });

  it("refuses expressions without a finite value, or too long or deep to read", () => {
    expect(() => arithmetic("1/0")).toThrow("Division by zero.");
    expect(() => arithmetic("10^400")).toThrow("no finite value");
    expect(() => arithmetic("(".repeat(40) + "1" + ")".repeat(40))).toThrow("nested too deeply");
    expect(() => arithmetic("1+".repeat(150) + "1")).toThrow("at most 200 characters");
  });

  it("spends a step for every token, so a run's budget bounds it", () => {
    let steps = 0;
    const kit: EvaluationKit = { step: (units = 1) => void (steps += units) };
    evaluateArithmetic("1 + 2 * 3", kit);
    expect(steps).toBe(9);
  });
});

function oneCheck(evaluatorId: string): RubricDraft {
  return {
    rubricId: RubricId.parse("rbr_sdk"),
    version: 1,
    title: "SDK",
    criteria: [{ id: "only", title: "Only", levels: [{ id: "no", label: "No", points: 0 }, { id: "yes", label: "Yes", points: 1 }], checks: [{ id: "check", evaluatorId, visibility: "teacher-only", config: {} }] }],
  };
}

/** Runs one test evaluator on one document and returns the finished run. */
async function runWith(evaluate: (input: EvaluationInput, config: unknown, kit: EvaluationKit) => readonly CriterionEvidence[]) {
  const evaluator = defineEvaluator({ id: "test.probe", release: "1.0.0", accepts: { artifactTypes: ["document"], mediaTypes: ["text/markdown"] }, answerKeyed: false, config: z.strictObject({}), evaluate });
  const registry = new EvaluatorRegistry([evaluator], { "test.probe": "1.0.0" });
  const rubrics = new InMemoryRubricReleaseStore();
  const rubric = oneCheck("test.probe");
  await rubrics.put(await signRubricRelease(rubric, P.rivera, registry, NOW));
  const runs = new AssessmentRuns({ runs: new InMemoryAssessmentRunStore(), rubrics, registry, profiles: [DETERMINISTIC_PROFILE], now: () => NOW });
  const text = "Hello.";
  const items: SubmissionItem[] = [{
    artifactId: ArtifactId.parse("art_probe"),
    revisionId: RevisionId.parse("rev_probe"),
    digest: await sha256Digest(canonicalTextBytes(text)),
    artifactType: "document",
    mediaType: "text/markdown",
    sizeBytes: 6,
    aiAssistance: { level: "none" },
  }];
  const work = { items, readText: async () => text };
  const digest = await submissionDigest(items);
  const queued = await runs.request({ submissionDigest: digest, rubricRelease: rubricRef(rubric), executionProfile: "deterministic@1", idempotencyKey: "k" });
  return runs.execute(queued.id, work);
}

const ok = (input: EvaluationInput): CriterionEvidence[] => [{ criterionId: input.criterionId, observation: "fine", passed: true, excerpts: [], explanation: "Fine." }];

describe("deterministic evaluation", () => {
  it("withdraws the clock, randomness, timers and the network from evaluators", async () => {
    const attempts: Record<string, () => unknown> = {
      "Date.now": () => Date.now(),
      "new Date()": () => new Date(),
      "Date()": () => (Date as unknown as () => string)(),
      "Math.random": () => Math.random(),
      "crypto.randomUUID": () => crypto.randomUUID(),
      "crypto.getRandomValues": () => crypto.getRandomValues(new Uint8Array(4)),
      "performance.now": () => performance.now(),
      fetch: () => fetch("https://example.example/"),
      setTimeout: () => setTimeout(() => undefined, 1),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      const run = await runWith((input) => {
        try {
          attempt();
        } catch {
          // Catching the refusal does not hide it.
        }
        return ok(input);
      });
      expect(run.error?.code, name).toBe("nondeterministic-evaluator");
    }
    // Everything is put back afterwards.
    expect(typeof Date.now()).toBe("number");
    expect(typeof Math.random()).toBe("number");
    expect(typeof crypto.randomUUID()).toBe("string");
  });

  it("leaves dates built from explicit values, and refuses asynchronous work", async () => {
    expect((await runWith((input) => (new Date("2026-01-01T00:00:00Z").getUTCFullYear() === 2026 ? ok(input) : []))).state).toBe("completed");
    const run = await runWith((input) => Promise.resolve(ok(input)) as unknown as CriterionEvidence[]);
    expect(run.error?.code).toBe("nondeterministic-evaluator");
  });

  it("passes frozen input and config", async () => {
    const run = await runWith((input, config) => {
      (input.artifacts as unknown as unknown[]).push("extra");
      (config as Record<string, unknown>).changed = true;
      return ok(input);
    });
    expect(run.error?.code).toBe("evaluator-error");
    expect(run.error?.message).toMatch(/not extensible|read.only|frozen/i);
  });

  it("rejects evidence for another criterion, or citing text the evaluator was not given", async () => {
    expect((await runWith((input) => [{ ...ok(input)[0]!, criterionId: "elsewhere" }])).error?.message).toContain("another criterion");
    const outside = await runWith((input) => [{ ...ok(input)[0]!, excerpts: [{ artifact: input.artifacts[0]!.artifactId, revision: input.artifacts[0]!.revisionId, range: { start: 0, end: 999 } }] }]);
    expect(outside.error?.message).toContain("outside the work");
    expect((await runWith(() => [{ observation: "no criterion" } as unknown as CriterionEvidence])).error?.message).toContain("malformed evidence");
  });

  it("gives identical reports when the same run is evaluated twice", async () => {
    const one = await threeSubjects();
    const two = await threeSubjects();
    // Different environments mint different artifact IDs, so compare what depends only on the work.
    const shape = async (env: typeof one) => {
      const view = await env.ci.run(P.patel, { submissionId: env.math.receipt.submissionId, idempotencyKey: "k" });
      if (view.view !== "teacher" || view.report === undefined) throw new Error("expected a report");
      return view.report.criteria.map((c) => ({ ...c, checks: c.checks.map((k) => ({ ...k, evidence: k.evidence.map((e) => ({ ...e, excerpts: e.excerpts.map((x) => x.range) })) })) }));
    };
    expect(await shape(two)).toEqual(await shape(one));
  });
});

describe("the evaluator registry", () => {
  it("registers a release once and pins only registered releases", () => {
    expect(() => new EvaluatorRegistry([writingStructure, writingStructure], {})).toThrow("registered twice");
    expect(() => new EvaluatorRegistry([writingStructure], { "writing.structure": "2.0.0" })).toThrow("names no registered release");
    expect(() => new EvaluatorRegistry([writingStructure], {}).pinned("writing.structure")).toThrow(/No release/);
    expect(Object.isFrozen(writingStructure)).toBe(true);
  });
});

describe("rubric releases", () => {
  it("are signed only by a teacher acting directly", async () => {
    await rejectsWith(signRubricRelease(essayRubric(), P.riveraTool, builtinRegistry(), NOW), "forbidden");
    const release = await signRubricRelease(essayRubric(), P.rivera, builtinRegistry(), NOW);
    expect(release.signature).toMatchObject({ signedBy: "prn_nf-teacher-rivera", channel: "http", signedAt: NOW.toISOString() });
    expect(release.signature.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("detect any change after signing", async () => {
    const release = await signRubricRelease(mathRubric(), P.patel, builtinRegistry(), NOW);
    await verifyRubricRelease(release);
    const loosened = structuredClone(release);
    (loosened.criteria[0]!.checks[0]!.config as { problems: { answer: string }[] }).problems[3]!.answer = "4";
    await rejectsWith(verifyRubricRelease(loosened), "policy-violation");
    await rejectsWith(new InMemoryRubricReleaseStore().put(loosened), "policy-violation");
  });

  it("refuse an invalid config, and an answer key that is not arithmetic", async () => {
    const draft = essayRubric();
    draft.criteria[0]!.checks[0]!.config = { minWords: 500, maxWords: 100 };
    await rejectsWith(signRubricRelease(draft, P.rivera, builtinRegistry(), NOW), "validation-failed");
    const math = mathRubric();
    math.criteria[0]!.checks[0]!.config = { problems: [{ id: "1", answer: "require('fs')" }] };
    await rejectsWith(signRubricRelease(math, P.patel, builtinRegistry(), NOW), "validation-failed");
  });
});
