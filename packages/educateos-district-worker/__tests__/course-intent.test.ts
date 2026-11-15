import { describe, expect, it } from "vitest";
import { boundCourseIntentProvider } from "../src/course-intent.ts";

const configuration = JSON.stringify({
  model: { provider: "cloudflare", modelId: "synthetic-model" },
  estimatedMaxUsdNano: "50000000",
});
const payload = {
  source: { packageId: "example.org/science", version: "1.0.0", digest: "sha256:" + "a".repeat(64), unitKey: "one" },
  title: "Observations",
  summary: "Use evidence to explain a pattern.",
  learningStandards: [],
  goal: "low-equipment" as const,
  maxOutputTokens: 750 as const,
};

describe("private district inference service-binding adapter", () => {
  it("sends bounded metadata to the trusted binding and reads declared usage", async () => {
    const received: unknown[] = [];
    const binding = {
      async fetch(request: Request) {
        received.push(await request.json());
        return Response.json({
          intent: { profile: "educateos.pedagogical-intent/0.1" },
          usage: { inputTokens: 12, outputTokens: 34, cacheReadTokens: 0, cacheWriteTokens: 0 },
          actualUsdNano: "20000000",
        });
      },
    } as unknown as Pick<Fetcher, "fetch">;
    const provider = boundCourseIntentProvider(binding, configuration);
    const result = await provider.generate(payload);
    expect(provider.model).toStrictEqual({ provider: "cloudflare", modelId: "synthetic-model" });
    expect(result.actualUsdNano).toBe("20000000");
    expect(received).toStrictEqual([{ ...payload, model: provider.model }]);
    expect(JSON.stringify(received)).not.toContain("Amara");
  });

  it("refuses missing or malformed deploy settings and invalid inference cost records", async () => {
    const valid = { fetch: async () => Response.json({ usage: {}, intent: {}, actualUsdNano: "-1" }) } as unknown as Pick<Fetcher, "fetch">;
    expect(() => boundCourseIntentProvider(valid, undefined)).toThrow(/COURSE_INTENT_MODEL/);
    expect(() => boundCourseIntentProvider(valid, "not-json")).toThrow(/JSON/);
    expect(() => boundCourseIntentProvider(valid, JSON.stringify({
      model: { provider: "unknown", modelId: "x" }, estimatedMaxUsdNano: "50000000",
    }))).toThrow();
    await expect(boundCourseIntentProvider(valid, configuration).generate(payload)).rejects.toThrow(/invalid billing/);
  });

  it("refuses oversized or failed provider responses", async () => {
    const big = { fetch: async () => new Response("x", { headers: { "content-length": "131073" } }) } as unknown as Pick<Fetcher, "fetch">;
    await expect(boundCourseIntentProvider(big, configuration).generate(payload)).rejects.toThrow(/too large/);
    const failed = { fetch: async () => new Response("upstream failed", { status: 503 }) } as unknown as Pick<Fetcher, "fetch">;
    await expect(boundCourseIntentProvider(failed, configuration).generate(payload)).rejects.toThrow(/failed/);
  });
});
