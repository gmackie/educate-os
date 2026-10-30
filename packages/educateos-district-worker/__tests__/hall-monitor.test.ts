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
    ["no URL", { url: undefined, signingKey: "{}", issuer: "educateos", audience: undefined }],
    ["no signing key", { url: HALL_MONITOR_URL, signingKey: undefined, issuer: "educateos", audience: undefined }],
    ["no issuer", { url: HALL_MONITOR_URL, signingKey: "{}", issuer: undefined, audience: undefined }],
    ["a key that is not JSON", { url: HALL_MONITOR_URL, signingKey: "not json", issuer: "educateos", audience: undefined }],
    ["a public or unsupported key", { url: HALL_MONITOR_URL, signingKey: JSON.stringify({ kty: "RSA", n: "x", e: "AQAB" }), issuer: "educateos", audience: undefined }],
    ["a URL that is not https", { url: "http://hall-monitor.example", signingKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "x", d: "d" }), issuer: "educateos", audience: undefined }],
  ])("refuses every evaluation with %s, so no post is published unscreened", async (_label, inputs) => {
    await expect(discussionHallMonitor(inputs, settings).evaluate(request)).rejects.toThrow();
  });
});
