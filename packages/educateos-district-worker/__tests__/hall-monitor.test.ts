import { env } from "cloudflare:test";
import { fakeHallMonitor } from "@educateos/ai-guard/src/fake-hall-monitor.ts";
import { describe, expect, it } from "vitest";
import { discussionHallMonitor } from "../src/hall-monitor.ts";
import { HALL_MONITOR_URL, TEST_CONFIG } from "./fixtures.ts";

const settings = TEST_CONFIG.discussionScreening!;
const request = {
  schemaVersion: "1.0", requestId: "p1.c0", idempotencyKey: "p1.c0",
  source: { product: "educateos", tenantId: "northfield", surface: "discussion.post" },
  policy: { profileId: "discussion-posts", revision: "r1" },
  context: { audience: "student", gradeBand: "9-12", costCenterId: "cc-discussions" },
  evaluationKind: "interaction.input", content: { type: "text", text: "Hello" },
} as Parameters<ReturnType<typeof discussionHallMonitor>["evaluate"]>[0];

describe("discussionHallMonitor (SCHO-305)", () => {
  it.each([
    ["no URL or binding", { url: undefined, signingKey: "{}", issuer: "educateos", audience: undefined }],
    ["a binding but no signing key", { binding: { fetch: fakeHallMonitor }, url: undefined, signingKey: undefined, issuer: "educateos", audience: undefined }],
    ["no signing key", { url: HALL_MONITOR_URL, signingKey: undefined, issuer: "educateos", audience: undefined }],
    ["no issuer", { url: HALL_MONITOR_URL, signingKey: "{}", issuer: undefined, audience: undefined }],
    ["a key that is not JSON", { url: HALL_MONITOR_URL, signingKey: "not json", issuer: "educateos", audience: undefined }],
    ["a public or unsupported key", { url: HALL_MONITOR_URL, signingKey: JSON.stringify({ kty: "RSA", n: "x", e: "AQAB" }), issuer: "educateos", audience: undefined }],
    ["a URL that is not https", { url: "http://hall-monitor.example", signingKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "x", d: "d" }), issuer: "educateos", audience: undefined }],
  ])("refuses every evaluation with %s, so no post is published unscreened", async (_label, inputs) => {
    await expect(discussionHallMonitor(inputs, settings).evaluate(request)).rejects.toThrow();
  });
});

describe("discussionHallMonitor over a service binding (SCHO-308)", () => {
  it("prefers the binding to the URL, with a fresh service token on each evaluation", async () => {
    const seen: Request[] = [];
    const binding = { fetch: (request: Request) => (seen.push(request), fakeHallMonitor(request)) };
    const fetch = () => Promise.reject(new Error("the URL must not be called when a binding is configured"));
    const client = discussionHallMonitor({
      binding, url: HALL_MONITOR_URL, fetch,
      signingKey: env.HALL_MONITOR_SIGNING_KEY, issuer: "educateos", audience: undefined,
    }, settings);
    await client.evaluate(request);
    await client.evaluate({ ...request, requestId: "p1.c1", idempotencyKey: "p1.c1" });
    expect(seen.map((r) => new URL(r.url).pathname)).toEqual(["/v1/evaluations", "/v1/evaluations"]);
    const tokens = seen.map((r) => r.headers.get("authorization"));
    expect(tokens.every((t) => t?.startsWith("Bearer "))).toBe(true);
    expect(new Set(tokens).size).toBe(2);
  });
});
