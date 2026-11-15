import { describe, expect, it } from "vitest";
import {
  COURSE_INTENT_WORKERS_AI_MODEL,
  COURSE_INTENT_PRICE_BOOK,
  serveCourseIntentInference,
} from "../src/course-intent-inference.ts";

const source = {
  packageId: "example.org/science",
  version: "1.0.0",
  digest: "sha256:" + "a".repeat(64),
  unitKey: "cells",
};
const body = {
  model: { provider: "cloudflare", modelId: COURSE_INTENT_WORKERS_AI_MODEL },
  source,
  title: "Cells",
  summary: "Help learners understand cell structure.",
  learningStandards: [{ frameworkKey: "demo-std", competencyUri: "https://example.org/cells" }],
  goal: "low-equipment",
  maxOutputTokens: 750,
};
const validIntent = {
  profile: "educateos.pedagogical-intent/0.1",
  id: "ai-course-suggestion",
  revision: "0.1.0",
  source,
  origin: "machine-suggestion",
  learningGoals: [{ id: "explain-cells", statement: "Explain the purpose of a cell membrane.", alignments: [] }],
  prerequisites: ["Recognize a biological cell."],
  misconceptions: ["Cell walls and cell membranes are identical."],
  strategies: [{ id: "card-model", approach: "Build a paper diagram of a cell.", rationale: "Supports visual structure.", conditions: [] }],
  expectedDemonstrations: [{ id: "label-cell", goalId: "explain-cells", observable: "Label cell parts.", modality: "explain" }],
};
const req = (value: unknown) => new Request("https://course-intent.internal/propose", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
});

describe("service-only Workers AI course intent inference", () => {
  it("calls only the pinned Workers AI model and reports pinned gross pricing", async () => {
    const calls: { model: string; options: unknown }[] = [];
    const mock = {
      async run(model: string, options: unknown) {
        calls.push({ model, options });
        return { response: validIntent, usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } };
      },
    };
    const result = await serveCourseIntentInference(req(body), mock);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const data = await result.json() as Record<string, any>;
    expect(data.intent).toMatchObject({ source, origin: "machine-suggestion" });
    expect(data.usage).toStrictEqual({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(data.actualUsdNano).toBe("518300");
    expect(COURSE_INTENT_PRICE_BOOK.inputNanoPerToken).toBe(293n);
    expect(COURSE_INTENT_PRICE_BOOK.outputNanoPerToken).toBe(2253n);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(COURSE_INTENT_WORKERS_AI_MODEL);
    const options = calls[0]!.options as { messages: { role: string; content: string }[]; response_format: { type: string }; max_tokens: number };
    expect(options.response_format.type).toBe("json_schema");
    expect(options.max_tokens).toBe(750);
    expect(options.messages[0]?.content).toContain("untrusted data");
    expect(JSON.stringify(options)).not.toContain("Amara");
    expect(JSON.stringify(options)).not.toContain("studentId");
  });

  it("rejects forged model names, unexpected fields and overlong requests before inference", async () => {
    let called = 0;
    const mock = { async run() { called++; return { response: validIntent }; } };
    const cases = [
      { ...body, model: { provider: "cloudflare", modelId: "any-other-model" } },
      { ...body, studentName: "Do not disclose" },
      { ...body, maxOutputTokens: 1200 },
    ];
    for (const attempt of cases) {
      expect((await serveCourseIntentInference(req(attempt), mock)).status).toBe(400);
    }
    expect((await serveCourseIntentInference(req({ ...body, summary: "X".repeat(15000) }), mock)).status).toBe(413);
    expect(called).toBe(0);
  });

  it("fails closed on missing billing usage, malformed JSON and mismatched OCS pins", async () => {
    const missing = await serveCourseIntentInference(req(body), {
      async run() { return { response: validIntent }; },
    });
    expect(missing.status).toBe(502);
    const changed = await serveCourseIntentInference(req(body), {
      async run() { return { response: { ...validIntent, source: { ...source, digest: "sha256:" + "b".repeat(64) } }, usage: { prompt_tokens: 10, completion_tokens: 10 } }; },
    });
    expect(changed.status).toBe(502);
    const bad = await serveCourseIntentInference(req(body), {
      async run() { return { response: "{invalid", usage: { prompt_tokens: 10, completion_tokens: 10 } }; },
    });
    expect(bad.status).toBe(502);
    expect(JSON.stringify(await changed.json())).not.toContain("Cells");
  });

  it("does not accept oversize reported completions or echo provider errors", async () => {
    const oversize = await serveCourseIntentInference(req(body), {
      async run() { return { response: validIntent, usage: { prompt_tokens: 1, completion_tokens: 900 } }; },
    });
    expect(oversize.status).toBe(502);
    const errored = await serveCourseIntentInference(req(body), {
      async run() { throw new Error("Provider request contained sensitive content."); },
    });
    expect(errored.status).toBe(503);
    expect(JSON.stringify(await errored.json())).not.toContain("sensitive");
  });
});
