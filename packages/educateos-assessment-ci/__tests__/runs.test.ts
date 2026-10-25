import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ArtifactId, RevisionId, RubricId, type ArtifactType } from "@educateos/contracts";
import { submissionDigest, type SubmissionItem } from "@educateos/assessment";
import { canonicalTextBytes, sha256Digest } from "@educateos/learning-artifacts";
import {
  AssessmentRuns,
  builtinRegistry,
  contentRequired,
  defineEvaluator,
  DETERMINISTIC_PROFILE,
  EvaluatorRegistry,
  InMemoryAssessmentRunStore,
  InMemoryRubricReleaseStore,
  rubricRef,
  signRubricRelease,
  type AssessmentRun,
  type Evaluator,
  type ExecutionProfile,
  type RubricDraft,
  type SubmittedWork,
} from "../src/index.ts";
import { ESSAY, NOW, P, essayRubric, rejectsWith, setup, threeSubjects } from "./setup.ts";

/** Synthetic submitted work with fixed IDs, so that two environments assess byte-identical submissions. */
async function workOf(texts: { text: string; type?: ArtifactType; mediaType?: string }[], read?: (item: SubmissionItem) => Promise<string>) {
  const items: SubmissionItem[] = [];
  for (const [i, t] of texts.entries()) {
    const bytes = canonicalTextBytes(t.text);
    items.push({
      artifactId: ArtifactId.parse(`art_work-${i}`),
      revisionId: RevisionId.parse(`rev_work-${i}`),
      digest: await sha256Digest(bytes),
      artifactType: t.type ?? "document",
      mediaType: t.mediaType ?? "text/markdown",
      sizeBytes: bytes.byteLength,
      aiAssistance: { level: "none" },
    });
  }
  const work: SubmittedWork = { items, readText: read ?? (async (item) => texts[items.indexOf(item)]!.text) };
  return { work, digest: await submissionDigest(items) };
}

/** A runs engine over fresh stores with `rubric` published. */
async function engine(rubric: RubricDraft, options: { registry?: EvaluatorRegistry; profiles?: readonly ExecutionProfile[] } = {}) {
  const registry = options.registry ?? builtinRegistry();
  const rubrics = new InMemoryRubricReleaseStore();
  await rubrics.put(await signRubricRelease(rubric, P.rivera, registry, NOW));
  const store = new InMemoryAssessmentRunStore();
  const clock = { now: NOW };
  const runs = new AssessmentRuns({ runs: store, rubrics, registry, profiles: options.profiles ?? [DETERMINISTIC_PROFILE], now: () => clock.now });
  return { runs, store, rubrics, clock, ref: rubricRef(rubric) };
}

/** A rubric with one criterion and one check. */
function oneCheck(evaluatorId: string, config: unknown = {}): RubricDraft {
  return {
    rubricId: RubricId.parse("rbr_one-check"),
    version: 1,
    title: "One check",
    criteria: [{ id: "only", title: "Only", levels: [{ id: "no", label: "No", points: 0 }, { id: "yes", label: "Yes", points: 1 }], checks: [{ id: "check", evaluatorId, visibility: "teacher-only", config: config as RubricDraft["criteria"][number]["checks"][number]["config"] }] }],
  };
}

/** A test evaluator release: reads documents, takes no config. */
function testEvaluator(id: string, evaluate: Evaluator["evaluate"], release = "1.0.0"): Evaluator {
  return defineEvaluator({ id, release, accepts: { artifactTypes: ["document"], mediaTypes: ["text/markdown"] }, answerKeyed: false, config: z.strictObject({}), evaluate });
}

function registryWith(...evaluators: Evaluator[]): EvaluatorRegistry {
  return new EvaluatorRegistry(evaluators, Object.fromEntries(evaluators.map((e) => [e.id, e.release])));
}

const TINY: ExecutionProfile = { id: "tiny@1", kind: "deterministic", limits: { maxSteps: 50, maxInputBytes: 64, maxRetries: 1, maxCostUsdNano: "0" } };

describe("assessment runs", () => {
  it("are idempotent on their key: the same key is the same run, evaluated once", async () => {
    let calls = 0;
    const counter = testEvaluator("test.counter", (input) => {
      calls += 1;
      return [{ criterionId: input.criterionId, observation: "counted", passed: true, excerpts: [], explanation: "Counted the call." }];
    });
    const { runs } = await engine(oneCheck("test.counter"), { registry: registryWith(counter) });
    const { work, digest } = await workOf([{ text: "Some work." }]);
    const request = { submissionDigest: digest, rubricRelease: { rubricId: RubricId.parse("rbr_one-check"), version: 1 }, executionProfile: "deterministic@1", idempotencyKey: "submitted" };

    const first = await runs.request(request);
    expect(first).toMatchObject({ state: "queued", attempts: 0 });
    expect((await runs.execute(first.id, work)).state).toBe("completed");
    const again = await runs.request(request);
    expect(again.id).toBe(first.id);
    expect(again.state).toBe("completed");
    expect(await runs.execute(again.id, work)).toEqual(await runs.get(first.id));
    expect(calls).toBe(1);

    // A different idempotency key is a deliberate re-run.
    expect((await runs.request({ ...request, idempotencyKey: "rerun" })).id).not.toBe(first.id);
  });

  it("gives a new evaluator release a new run, and leaves the old run as it was", async () => {
    const env = await threeSubjects();
    const submissionId = env.essay.receipt.submissionId;
    const before = await env.ci.run(P.rivera, { submissionId, idempotencyKey: "submitted" });

    const upgraded = defineEvaluator({
      id: "content.required",
      release: "1.1.0",
      accepts: contentRequired.accepts,
      answerKeyed: false,
      config: contentRequired.config,
      evaluate: (input, config, kit) => contentRequired.evaluate(input, config, kit),
    });
    const { ci } = env.ciWith({ registry: builtinRegistry([upgraded]).withPin("content.required", "1.1.0") });
    const after = await ci.run(P.rivera, { submissionId, idempotencyKey: "submitted" });

    expect(after.runId).not.toBe(before.runId);
    expect(after.view === "teacher" && after.report?.evaluatorReleases.find((r) => r.id === "content.required")?.release).toBe("1.1.0");
    expect(after.view === "teacher" && after.report?.key.evaluatorRelease).not.toBe(before.view === "teacher" && before.report?.key.evaluatorRelease);
    const old = await env.runs.get(before.runId);
    expect(old.evaluators.find((r) => r.id === "content.required")?.release).toBe("1.0.0");
    // The old run, requested again under the old pins, is still the old run.
    expect((await env.ci.run(P.rivera, { submissionId, idempotencyKey: "submitted" })).runId).toBe(before.runId);
  });

  it("gives a new rubric release a new run, and only as an explicit re-evaluation", async () => {
    const env = await threeSubjects();
    const submissionId = env.essay.receipt.submissionId;
    const original = await env.ci.run(P.rivera, { submissionId, idempotencyKey: "submitted" });

    // The submission's rubric is locked by the assessment service, and a release never changes.
    const submission = await env.assessment.getSubmission(P.rivera, submissionId);
    const assignmentId = submission.assignmentId;
    const v2 = await env.publishRubric(P.rivera, { ...essayRubric(2), title: "Night: literary essay (revised)" });
    await rejectsWith(env.assessment.updateAssignment(P.rivera, assignmentId, { rubric: rubricRef(v2) }), "policy-violation");
    await rejectsWith(env.publishRubric(P.rivera, { ...essayRubric(1), title: "Rewritten after submission" }), "conflict");

    const reEvaluation = await env.ci.run(P.rivera, { submissionId, idempotencyKey: "submitted", reEvaluateWith: rubricRef(v2) });
    expect(reEvaluation.runId).not.toBe(original.runId);
    expect(reEvaluation.view === "teacher" && reEvaluation.report?.key.rubricRelease).toEqual({ rubricId: "rbr_eng9-night-essay", version: 2 });
    // Its suggestions belong to another rubric release, so they are not posted to this submission's feedback.
    await rejectsWith(env.ci.suggestScores(P.rivera, submissionId, reEvaluation.runId), "conflict");
  });

  it("fails a run that exceeds its step budget, with a clear reason, and does not retry it", async () => {
    let calls = 0;
    const spin = testEvaluator("test.spin", (input, _config, kit) => {
      calls += 1;
      for (;;) kit.step();
    });
    const { runs, ref } = await engine(oneCheck("test.spin"), { registry: registryWith(spin), profiles: [TINY] });
    const { work, digest } = await workOf([{ text: "Short." }]);
    const run = await runs.execute((await runs.request({ submissionDigest: digest, rubricRelease: ref, executionProfile: "tiny@1", idempotencyKey: "k" })).id, work);
    expect(run.state).toBe("failed");
    expect(run.error).toEqual({ code: "step-budget-exceeded", message: "The run used more than its budget of 50 evaluation steps. It ran out in check check (test.spin@1.0.0)." });
    expect(run.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it("fails the run even when the evaluator swallows the budget error", async () => {
    const stubborn = testEvaluator("test.stubborn", (input, _config, kit) => {
      try {
        for (;;) kit.step();
      } catch {
        return [{ criterionId: input.criterionId, observation: "carried on", passed: true, excerpts: [], explanation: "Ignored the budget." }];
      }
    });
    const { runs, ref } = await engine(oneCheck("test.stubborn"), { registry: registryWith(stubborn), profiles: [TINY] });
    const { work, digest } = await workOf([{ text: "Short." }]);
    const run = await runs.execute((await runs.request({ submissionDigest: digest, rubricRelease: ref, executionProfile: "tiny@1", idempotencyKey: "k" })).id, work);
    expect(run.error?.code).toBe("step-budget-exceeded");
  });

  it("fails work larger than the profile reads before evaluating it", async () => {
    const { runs, ref } = await engine(oneCheck("writing.structure", { minWords: 1 }), { profiles: [TINY] });
    const { work, digest } = await workOf([{ text: "word ".repeat(40) }]);
    const run = await runs.execute((await runs.request({ submissionDigest: digest, rubricRelease: ref, executionProfile: "tiny@1", idempotencyKey: "k" })).id, work);
    expect(run.error).toEqual({ code: "input-too-large", message: "The submitted work is 200 bytes; this profile reads at most 64." });
  });

  it("retries work that could not be read, within the profile's limit", async () => {
    const rubric = oneCheck("writing.structure", { minWords: 1 });
    let reads = 0;
    const flaky = await workOf([{ text: "Two words." }], async () => {
      reads += 1;
      if (reads < 3) throw new Error("storage hiccup");
      return "Two words.";
    });
    const { runs, ref } = await engine(rubric);
    const recovered = await runs.execute((await runs.request({ submissionDigest: flaky.digest, rubricRelease: ref, executionProfile: "deterministic@1", idempotencyKey: "k" })).id, flaky.work);
    expect(recovered).toMatchObject({ state: "completed", attempts: 3, lastAttemptError: "Artifact art_work-0 could not be read." });

    const broken = await workOf([{ text: "Two words." }], () => Promise.reject(new Error("gone")));
    const again = await engine(rubric);
    const exhausted = await again.runs.execute((await again.runs.request({ submissionDigest: broken.digest, rubricRelease: again.ref, executionProfile: "deterministic@1", idempotencyKey: "k" })).id, broken.work);
    expect(exhausted).toMatchObject({ state: "failed", attempts: 3, error: { code: "retries-exhausted" } });
  });

  it("refuses work that is not what the run's key names", async () => {
    const { runs, ref } = await engine(oneCheck("writing.structure", { minWords: 1 }));
    const { digest } = await workOf([{ text: "The real essay." }]);
    const other = await workOf([{ text: "Different work." }]);
    const run = await runs.execute((await runs.request({ submissionDigest: digest, rubricRelease: ref, executionProfile: "deterministic@1", idempotencyKey: "k" })).id, other.work);
    expect(run.error?.code).toBe("integrity");

    // Content that does not match its item's digest is refused too.
    const tampered = await workOf([{ text: "The real essay." }], async () => "A substituted essay.");
    const second = await runs.execute((await runs.request({ submissionDigest: tampered.digest, rubricRelease: ref, executionProfile: "deterministic@1", idempotencyKey: "k2" })).id, tampered.work);
    expect(second.error).toEqual({ code: "integrity", message: "Artifact art_work-0 does not match the digest it was submitted with." });
  });

  it("reclaims a run whose worker stopped, once its lease has passed", async () => {
    const { runs, store, clock, ref } = await engine(oneCheck("writing.structure", { minWords: 1 }));
    const { work, digest } = await workOf([{ text: "Two words." }]);
    const queued = await runs.request({ submissionDigest: digest, rubricRelease: ref, executionProfile: "deterministic@1", idempotencyKey: "k" });
    // A worker claimed it and then disappeared.
    await store.replace({ ...queued, state: "running", attempts: 1, startedAt: NOW.toISOString(), revision: 1 }, 0);
    expect((await runs.execute(queued.id, work)).state).toBe("running");
    clock.now = new Date(NOW.getTime() + 6 * 60 * 1000);
    expect(await runs.execute(queued.id, work)).toMatchObject({ state: "completed", attempts: 2 });
  });

  it("never lets a finished run change", async () => {
    const { runs, store, ref } = await engine(oneCheck("writing.structure", { minWords: 1 }));
    const { work, digest } = await workOf([{ text: "Two words." }]);
    const done = await runs.execute((await runs.request({ submissionDigest: digest, rubricRelease: ref, executionProfile: "deterministic@1", idempotencyKey: "k" })).id, work);
    const rewritten: AssessmentRun = { ...done, state: "running", revision: done.revision + 1 };
    await rejectsWith(store.replace(rewritten, done.revision), "policy-violation");
    await rejectsWith(store.replace({ ...done, key: { ...done.key, idempotencyKey: "other" }, revision: done.revision + 1 }, done.revision), "policy-violation");
    await rejectsWith(store.replace({ ...done, revision: done.revision + 1 }, done.revision - 1), "conflict");
  });

  it("are deterministic across separate deployments: the same work and key give the same report", async () => {
    const reports = [];
    for (let i = 0; i < 2; i++) {
      const { runs, ref } = await engine(essayRubric());
      const { work, digest } = await workOf([{ text: ESSAY }]);
      const run = await runs.execute((await runs.request({ submissionDigest: digest, rubricRelease: ref, executionProfile: "deterministic@1", idempotencyKey: "submitted" })).id, work);
      reports.push(JSON.stringify(run.report));
    }
    expect(reports[0]).toBeDefined();
    expect(reports[1]).toBe(reports[0]);
  });

  it("refuse an unknown profile, and a rubric that names an evaluator with no pinned release", async () => {
    const env = setup();
    const { digest } = await workOf([{ text: "Work." }]);
    await rejectsWith(env.runs.request({ submissionDigest: digest, rubricRelease: { rubricId: RubricId.parse("rbr_none"), version: 1 }, executionProfile: "deterministic@1", idempotencyKey: "k" }), "not-found");
    const { runs, ref } = await engine(oneCheck("writing.structure", { minWords: 1 }));
    await rejectsWith(runs.request({ submissionDigest: digest, rubricRelease: ref, executionProfile: "unlimited@1", idempotencyKey: "k" }), "validation-failed");
    await rejectsWith(signRubricRelease(oneCheck("essay.vibes"), P.rivera, builtinRegistry(), NOW), "validation-failed");
  });
});
