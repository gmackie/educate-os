import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineEvaluator,
  type CriterionEvidence,
  type EvaluationInput,
  type EvaluationKit,
} from "@educateos/assessment-ci";
import { sha256Digest } from "@educateos/learning-artifacts";
import { adaptEvaluator } from "./assessmentCi.ts";
import type { EvaluationProvider } from "./runtime.ts";

const implementationDigest = `sha256:${"a".repeat(64)}`;
const result = (work: EvaluationInput): CriterionEvidence[] => [{
  criterionId: work.criterionId,
  observation: "Five characters observed",
  explanation: "The submitted text contains five UTF-16 code units.",
  score: 1,
  excerpts: [{
    artifact: work.artifacts[0]!.artifactId,
    revision: work.artifacts[0]!.revisionId,
    range: { start: 0, end: 5 },
  }],
}];

function evaluator(evaluate: (input: EvaluationInput, config: { minimum: number }, kit: EvaluationKit) => readonly CriterionEvidence[] = result, answerKeyed = false) {
  return defineEvaluator({
    id: "portable.length",
    release: "1.0.0",
    accepts: { artifactTypes: ["document"], mediaTypes: ["text/plain"] },
    answerKeyed,
    config: z.strictObject({ minimum: z.int().nonnegative() }),
    evaluate,
  });
}

async function input(): Promise<Parameters<EvaluationProvider["evaluate"]>[0]> {
  return {
    task: {
      id: "write",
      kind: "writing",
      prompt: "Write a short response.",
      evidence: [{ id: "response", description: "Your response", mediaTypes: ["text/plain"], maxBytes: 1000 }],
      aiAssistance: { allowedUses: [], disclosureRequired: true },
    },
    evidence: [{
      id: "evidence-1",
      requirementId: "response",
      artifactId: "portable-file",
      revisionId: "portable-revision",
      digest: await sha256Digest(new TextEncoder().encode("Hello")),
      mediaType: "text/plain",
    }],
    texts: new Map([["evidence-1", "Hello"]]),
  };
}

const bind = (definition = evaluator()) => adaptEvaluator({ evaluator: definition, implementationDigest, criterionId: "length", config: { minimum: 5 } });

describe("the existing deterministic evaluator adapter", () => {
  it("maps legacy excerpts to portable evidence IDs and repeats deterministically", async () => {
    const provider = await bind();
    const work = await input();
    const findings = await provider.evaluate(work);
    expect(findings).toEqual([{
      criterionId: "length", observation: "Five characters observed", explanation: "The submitted text contains five UTF-16 code units.", score: 1, evidenceIds: ["evidence-1"],
    }]);
    expect(await provider.evaluate(work)).toEqual(findings);
  });

  it("pins config, criterion and implementation while keeping config out of the manifest", async () => {
    const first = await bind();
    const same = await bind();
    expect(first.release).toEqual(same.release);
    expect(Object.keys(first.release).toSorted()).toEqual(["digest", "id", "version"]);
    const changed = await adaptEvaluator({ evaluator: evaluator(), implementationDigest, criterionId: "length", config: { minimum: 6 } });
    expect(changed.release.digest).not.toBe(first.release.digest);
    await expect(adaptEvaluator({ evaluator: evaluator(), implementationDigest, criterionId: "length", config: { minimum: 6 }, expectedRelease: first.release })).rejects.toThrow("pinned release");
    await expect(adaptEvaluator({ evaluator: evaluator(), implementationDigest, criterionId: "length", config: { minimum: 5 }, expectedRelease: first.release })).resolves.toMatchObject({ release: first.release });
  });

  it("rejects answer-keyed evaluators before their configuration or evidence can be exposed", async () => {
    await expect(bind(evaluator(result, true))).rejects.toThrow("teacher-only");
  });

  it("refuses changed bytes, missing text and unsupported media types", async () => {
    const provider = await bind();
    const changed = await input();
    await expect(provider.evaluate({ ...changed, texts: new Map([["evidence-1", "Wrong"]]) })).rejects.toThrow("digest mismatch");
    await expect(provider.evaluate({ ...changed, texts: new Map() })).rejects.toThrow("unavailable");
    changed.evidence[0]!.mediaType = "text/markdown";
    await expect(provider.evaluate(changed)).rejects.toThrow("media type");
  });

  it("rejects excerpts outside verified work and evidence for another criterion", async () => {
    const outside = await bind(evaluator((work) => [{ ...result(work)[0]!, excerpts: [{ ...result(work)[0]!.excerpts[0]!, range: { start: 0, end: 999 } }] }]));
    await expect(outside.evaluate(await input())).rejects.toThrow("outside");
    const different = await bind(evaluator((work) => [{ ...result(work)[0]!, criterionId: "elsewhere" }]));
    await expect(different.evaluate(await input())).rejects.toThrow("another criterion");
  });

  it("grounds aggregate observations in all supplied evidence", async () => {
    const provider = await bind(evaluator((work) => [{ ...result(work)[0]!, excerpts: [] }]));
    expect((await provider.evaluate(await input()))[0]!.evidenceIds).toEqual(["evidence-1"]);
  });

  it("rejects clock access even when the evaluator catches the guard's error", async () => {
    const provider = await bind(evaluator((work) => {
      try { Date.now(); } catch { /* A caught violation is still refused. */ }
      return result(work);
    }));
    await expect(provider.evaluate(await input())).rejects.toThrow("clock");
    expect(typeof Date.now()).toBe("number");
  });

  it("refuses an exhausted step budget even when the evaluator catches it", async () => {
    const provider = await bind(evaluator((work, _config, kit) => {
      try { kit.step(10_001); } catch { /* A caught budget error is still refused. */ }
      return result(work);
    }));
    await expect(provider.evaluate(await input())).rejects.toThrow("budget");
  });

  it("freezes config and input before evaluation", async () => {
    const provider = await bind(evaluator((work, config) => {
      config.minimum = 0;
      return result(work);
    }));
    await expect(provider.evaluate(await input())).rejects.toThrow();
  });

  it("refuses asynchronous evaluator work", async () => {
    const provider = await bind(evaluator((work) => Promise.resolve(result(work)) as unknown as CriterionEvidence[]));
    await expect(provider.evaluate(await input())).rejects.toThrow("asynchronous");
  });

  it("rejects malformed configs and duplicate evidence", async () => {
    await expect(adaptEvaluator({ evaluator: evaluator(), implementationDigest, criterionId: "length", config: { minimum: 5, hiddenAnswer: "x" } })).rejects.toThrow();
    const provider = await bind();
    const work = await input();
    work.evidence.push(work.evidence[0]!);
    await expect(provider.evaluate(work)).rejects.toThrow("Duplicate");
  });
});
