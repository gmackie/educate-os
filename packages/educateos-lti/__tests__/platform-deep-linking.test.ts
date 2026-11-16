// The LTI Platform's Deep Linking response verification (SCHO-179): only an RS256 response signed by
// a key the tool publishes, from the tool, to this platform, current within thirty seconds, through
// the flow's deployment and echoing its data counts; only resource links on the tool's origin are
// kept, with their title, text and URL alone.
import { importJWK, SignJWT, type JWTPayload } from "jose";
import { describe, expect, it } from "vitest";
import {
  generateToolKey,
  importToolKey,
  LTI_CLAIM,
  newPlatformDeploymentId,
  newPlatformToolId,
  platformDeepLinkingSettings,
  PlatformDeepLinkingError,
  PlatformTool,
  verifyPlatformDeepLinkingResponse,
  type PlatformDeepLinkingExpectation,
} from "../src/index.ts";

const ISSUER = "https://district.example";
const AT = "2026-10-31T12:00:00.000Z";
const ADMIN = "prn_nf-district-admin";
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

async function world() {
  const key = await importToolKey(await generateToolKey());
  const publicKey = (await importJWK({ ...key.publicJwk }, "RS256")) as CryptoKey;
  const tool = PlatformTool.parse({
    id: newPlatformToolId(), districtId: "dst_northfield", name: "Quiz Garden",
    loginInitiationUrl: "https://tool.example/lti/login", redirectUris: ["https://tool.example/lti/launch"],
    targetLinkUri: "https://tool.example/lti/launch", jwksUrl: "https://tool.example/.well-known/jwks.json", status: "active",
    registeredBy: ADMIN, registeredAt: AT, updatedBy: ADMIN, updatedAt: AT,
  });
  const deploymentId = newPlatformDeploymentId();
  const expected: PlatformDeepLinkingExpectation = {
    tool,
    deploymentId,
    issuer: ISSUER,
    data: "flow-data",
    nowMs: NOW,
    getKey: async (url, kid) => {
      if (url !== tool.jwksUrl || kid !== key.kid) throw new PlatformDeepLinkingError("unknown-key");
      return publicKey;
    },
  };
  const sign = (items: unknown[], overrides: JWTPayload = {}) => {
    const iat = Math.floor(NOW / 1000);
    return new SignJWT({
      iss: tool.id, aud: ISSUER, iat, exp: iat + 300, nonce: "n-1",
      [LTI_CLAIM.messageType]: "LtiDeepLinkingResponse",
      [LTI_CLAIM.version]: "1.3.0",
      [LTI_CLAIM.deploymentId]: deploymentId,
      [LTI_CLAIM.data]: "flow-data",
      [LTI_CLAIM.contentItems]: items,
      ...overrides,
    }).setProtectedHeader({ alg: "RS256", kid: key.kid }).sign(key.privateKey);
  };
  const reason = async (jwt: string) => {
    try {
      await verifyPlatformDeepLinkingResponse(jwt, expected);
    } catch (error) {
      if (error instanceof PlatformDeepLinkingError) return error.reason;
      throw error;
    }
    return "accepted";
  };
  return { tool, expected, sign, reason };
}

describe("verifying a deep linking response", () => {
  it("advertises resource links only, never auto-created, with the flow's return URL and data", () => {
    expect(platformDeepLinkingSettings({ returnUrl: `${ISSUER}/lti/platform/deep-links/f`, data: "d" })).toEqual({
      deep_link_return_url: `${ISSUER}/lti/platform/deep-links/f`,
      accept_types: ["ltiResourceLink"],
      accept_presentation_document_targets: ["iframe", "window"],
      accept_multiple: true,
      accept_lineitem: false,
      auto_create: false,
      data: "d",
    });
  });

  it("keeps resource links' title, text and URL only, drops other items, and defaults the title", async () => {
    const { tool, expected, sign } = await world();
    const verified = await verifyPlatformDeepLinkingResponse(await sign([
      { type: "ltiResourceLink", title: " Cells ", text: "About cells", url: "https://tool.example/cells", custom: { a: "b" }, lineItem: { scoreMaximum: 5 }, iframe: { src: "x" } },
      { type: "ltiResourceLink" },
      { type: "html", html: "<b>hi</b>" },
      { type: "file", url: "https://tool.example/f.pdf" },
      "not an object",
    ]), expected);
    expect(verified.items).toEqual([{ title: "Cells", text: "About cells", url: "https://tool.example/cells" }, { title: tool.name }]);
    expect(verified.ignored).toBe(3);
    expect(verified.nonce).toBe("n-1");
    expect(verified.expiresAt).toBe((Math.floor(NOW / 1000) + 300 + 30) * 1000);
    // No content items at all is a teacher who chose nothing.
    expect((await verifyPlatformDeepLinkingResponse(await sign([], { [LTI_CLAIM.contentItems]: undefined }), expected)).items).toEqual([]);
  });

  it("refuses every response that does not match the flow, the tool or the platform", async () => {
    const { expected, sign, reason } = await world();
    const now = Math.floor(NOW / 1000);
    expect(await reason(await sign([], { aud: "https://other.example" }))).toBe("audience");
    expect(await reason(await sign([], { aud: [ISSUER, "https://other.example"] }))).toBe("audience");
    expect(await reason(await sign([], { iss: newPlatformToolId() }))).toBe("issuer");
    expect(await reason(await sign([], { [LTI_CLAIM.data]: "other" }))).toBe("data");
    expect(await reason(await sign([], { [LTI_CLAIM.data]: undefined }))).toBe("data");
    expect(await reason(await sign([], { [LTI_CLAIM.deploymentId]: newPlatformDeploymentId() }))).toBe("deployment");
    expect(await reason(await sign([], { [LTI_CLAIM.messageType]: "LtiResourceLinkRequest" }))).toBe("message-type");
    expect(await reason(await sign([], { nonce: undefined }))).toBe("signature-or-expiry");
    expect(await reason(await sign([], { iat: now + 60, exp: now + 300 }))).toBe("issued-in-future");
    expect(await reason(await sign([], { iat: now - 600, exp: now - 40 }))).toBe("signature-or-expiry");
    // Thirty seconds of skew either way are allowed.
    expect(await reason(await sign([], { iat: now - 600, exp: now - 20 }))).toBe("accepted");
    expect(await reason(await sign([], { iat: now + 20, exp: now + 300 }))).toBe("accepted");
    expect(await reason(await sign([{ type: "ltiResourceLink", url: "https://elsewhere.example/x" }]))).toBe("foreign-url");
    expect(await reason(await sign([{ type: "ltiResourceLink", url: "http://tool.example/x" }]))).toBe("content-item");
    expect(await reason(await sign([{ type: "ltiResourceLink", title: "x".repeat(201) }]))).toBe("content-item");
    expect(await reason(await sign(Array.from({ length: 11 }, () => ({ type: "ltiResourceLink" }))))).toBe("too-many-items");
    expect(await reason(await sign(Array.from({ length: 51 }, () => ({ type: "html" }))))).toBe("content-items");
    expect(await reason(await sign([], { [LTI_CLAIM.contentItems]: "nope" }))).toBe("content-items");
    expect(await reason("not.a.jwt")).toBe("not-a-jwt");
    const header = (alg: string) => Buffer.from(JSON.stringify({ alg, kid: "k" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ iss: expected.tool.id })).toString("base64url");
    expect(await reason(`${header("none")}.${body}.`)).toBe("algorithm");
    expect(await reason(`${header("HS256")}.${body}.c2ln`)).toBe("algorithm");
    expect(await reason(`${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${body}.c2ln`)).toBe("no-kid");
    expect(await reason("x".repeat(64 * 1024 + 1))).toBe("too-large");
  });
});
