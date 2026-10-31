// The tools and deployments EducateOS hosts as an LTI Platform (SCHO-179): a tool's URLs are https
// on one trusted origin, a deployment names its offerings once each and turns on no service and no
// personal data unless asked, and `deploymentAllows` refuses a revoked tool or deployment, another
// offering, and a service the deployment was not given.
import { describe, expect, it } from "vitest";
import { OfferingId } from "@educateos/contracts";
import {
  deploymentAllows,
  newPlatformDeploymentId,
  newPlatformToolId,
  PlatformDeployment,
  PlatformDeploymentId,
  PlatformDeploymentInput,
  PlatformTool,
  PlatformToolId,
  PlatformToolInput,
  redirectUriAllowed,
} from "../src/index.ts";

const TOOL_INPUT = {
  name: "Quiz Garden",
  loginInitiationUrl: "https://tool.example/lti/login",
  redirectUris: ["https://tool.example/lti/launch"],
  targetLinkUri: "https://tool.example/lti/launch",
  jwksUrl: "https://tool.example/.well-known/jwks.json",
};
const AT = "2026-10-31T12:00:00.000Z";
const BIO = OfferingId.parse("off_nf-bio-fall-p2");

function tool(overrides: Partial<PlatformTool> = {}): PlatformTool {
  return PlatformTool.parse({
    id: newPlatformToolId(), districtId: "dst_northfield", ...TOOL_INPUT, status: "active",
    registeredBy: "prn_nf-district-admin", registeredAt: AT, updatedBy: "prn_nf-district-admin", updatedAt: AT, ...overrides,
  });
}

function deployment(of: PlatformTool, overrides: Partial<PlatformDeployment> = {}): PlatformDeployment {
  return PlatformDeployment.parse({
    id: newPlatformDeploymentId(), districtId: of.districtId, toolId: of.id, offerings: [BIO],
    services: { nrps: true, agsLineItems: false, agsScores: false, deepLinking: false }, privacy: { name: false, email: false },
    status: "active", createdBy: "prn_nf-district-admin", createdAt: AT, updatedBy: "prn_nf-district-admin", updatedAt: AT, ...overrides,
  });
}

describe("platform tool registrations", () => {
  it("accepts a tool whose URLs are https on one origin", () => {
    expect(PlatformToolInput.parse(TOOL_INPUT)).toEqual(TOOL_INPUT);
    expect(PlatformToolId.safeParse(newPlatformToolId()).success).toBe(true);
    expect(PlatformDeploymentId.safeParse(newPlatformDeploymentId()).success).toBe(true);
  });

  it("refuses http, a second origin, a duplicated redirect URI and unknown fields", () => {
    expect(PlatformToolInput.safeParse({ ...TOOL_INPUT, loginInitiationUrl: "http://tool.example/lti/login" }).success).toBe(false);
    expect(PlatformToolInput.safeParse({ ...TOOL_INPUT, jwksUrl: "https://keys.elsewhere.example/jwks" }).success).toBe(false);
    expect(PlatformToolInput.safeParse({ ...TOOL_INPUT, redirectUris: ["https://evil.example/steal"] }).success).toBe(false);
    expect(PlatformToolInput.safeParse({ ...TOOL_INPUT, redirectUris: [TOOL_INPUT.targetLinkUri, TOOL_INPUT.targetLinkUri] }).success).toBe(false);
    expect(PlatformToolInput.safeParse({ ...TOOL_INPUT, clientId: "chosen-by-the-tool" }).success).toBe(false);
  });

  it("matches redirect URIs exactly", () => {
    const registered = tool();
    expect(redirectUriAllowed(registered, "https://tool.example/lti/launch")).toBe(true);
    expect(redirectUriAllowed(registered, "https://tool.example/lti/launch/")).toBe(false);
    expect(redirectUriAllowed(registered, "https://tool.example/lti/launch?x=1")).toBe(false);
  });
});

describe("platform deployments", () => {
  it("turns on no service and no personal data unless asked", () => {
    const input = PlatformDeploymentInput.parse({ toolId: newPlatformToolId(), offerings: [BIO] });
    expect(input.services).toEqual({ nrps: false, agsLineItems: false, agsScores: false, deepLinking: false });
    expect(input.privacy).toEqual({ name: false, email: false });
  });

  it("refuses no offerings, a repeated offering and an unknown service", () => {
    const toolId = newPlatformToolId();
    expect(PlatformDeploymentInput.safeParse({ toolId, offerings: [] }).success).toBe(false);
    expect(PlatformDeploymentInput.safeParse({ toolId, offerings: [BIO, BIO] }).success).toBe(false);
    expect(PlatformDeploymentInput.safeParse({ toolId, offerings: [BIO], services: { gradebookAdmin: true } }).success).toBe(false);
  });

  it("allows only its own active tool, in its offerings, with its services", () => {
    const registered = tool();
    const deployed = deployment(registered);
    expect(deploymentAllows(registered, deployed, BIO)).toBe(true);
    expect(deploymentAllows(registered, deployed, BIO, "nrps")).toBe(true);
    expect(deploymentAllows(registered, deployed, BIO, "agsScores")).toBe(false);
    expect(deploymentAllows(registered, deployed, OfferingId.parse("off_nf-eng9-fall-p3"))).toBe(false);
    expect(deploymentAllows({ ...registered, status: "revoked" }, deployed, BIO)).toBe(false);
    expect(deploymentAllows(registered, { ...deployed, status: "revoked" }, BIO)).toBe(false);
    expect(deploymentAllows(tool(), deployed, BIO)).toBe(false);
  });
});
