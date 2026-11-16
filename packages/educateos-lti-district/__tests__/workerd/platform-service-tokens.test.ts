// The LTI Platform's token endpoint state (SCHO-179) over `DurableObjectRecordTable`, in workerd,
// against real Durable Object SQLite storage: a client assertion's `jti` is accepted by exactly one
// of many concurrent requests and stays used across a restart, and an issued access token verifies
// after a restart until it expires or its tool is revoked.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DistrictId, OfferingId, PrincipalId } from "@educateos/contracts";
import {
  createToolKeySet,
  generateToolKey,
  importToolKey,
  LTI_SCOPES,
  LtiServiceClient,
  newPlatformDeploymentId,
  newPlatformToolId,
  PlatformJwksCache,
  PlatformTokenEndpoint,
  toolJwks,
  type Clock,
  type PlatformRegistration,
  type PlatformTool,
  type StoredToolKey,
} from "@educateos/lti";
import { DurableObjectRecordTable } from "../../src/durable-object.ts";
import { TablePlatformServiceTokenStore } from "../../src/platform-service-tokens.ts";
import { TablePlatformToolStore } from "../../src/platform-tools.ts";

const NF = DistrictId.parse("dst_northfield");
const ADMIN = PrincipalId.parse("prn_nf-district-admin");
const AT = "2026-10-31T12:00:00.000Z";
const TOKEN_URL = "https://district.example/lti/platform/token";
const JWKS_URL = "https://tool.example/.well-known/jwks.json";

let objects = 0;
const fresh = () => env.LTI.getByName(`platform-tokens-${objects++}`);

const tool: PlatformTool = {
  id: newPlatformToolId(),
  districtId: NF,
  name: "Quiz Garden",
  loginInitiationUrl: "https://tool.example/lti/login",
  redirectUris: ["https://tool.example/lti/launch"],
  targetLinkUri: "https://tool.example/lti/launch",
  jwksUrl: JWKS_URL,
  status: "active",
  registeredBy: ADMIN,
  registeredAt: AT,
  updatedBy: ADMIN,
  updatedAt: AT,
};

/**
 * Runs `step` with the token endpoint and tool store over the object's own SQLite storage, and a
 * tool-side service client that signs with `toolKey` and reaches the endpoint directly.
 */
function withEndpoint<T>(
  stub: ReturnType<typeof fresh>,
  toolKey: StoredToolKey,
  now: Clock,
  step: (world: { endpoint: PlatformTokenEndpoint; tools: TablePlatformToolStore; client: LtiServiceClient }) => Promise<T>,
): Promise<T> {
  return runInDurableObject(stub, async (_instance, state) => {
    const table = new DurableObjectRecordTable(state.storage);
    const tools = new TablePlatformToolStore(table);
    const keys = createToolKeySet(await importToolKey(toolKey));
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === JWKS_URL) return Response.json(toolJwks(keys));
      if (request.url === TOKEN_URL) return (await endpoint.handle(request)).response;
      return new Response(null, { status: 404 });
    }) as typeof globalThis.fetch;
    const endpoint = new PlatformTokenEndpoint({
      tokenUrl: TOKEN_URL,
      tools,
      store: new TablePlatformServiceTokenStore(table, now),
      keys: new PlatformJwksCache({ fetch }),
      now,
    });
    return step({ endpoint, tools, client: new LtiServiceClient({ fetch, toolKeys: () => keys, now }) });
  });
}

/** The registration EducateOS's own service client would hold for the tool: what it signs as. */
const registration = { issuer: "https://district.example", clientId: tool.id, authTokenUrl: TOKEN_URL } as PlatformRegistration;

describe("LTI Platform service tokens in a Durable Object", () => {
  it("accepts an assertion's jti for exactly one of 50 concurrent requests, and still refuses it after a restart", async () => {
    const district = fresh();
    const claims = await Promise.all(Array.from({ length: 50 }, () => district.claimAssertion(tool.id, "jti-1", 60_000)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await evictDurableObject(district);
    expect(await district.claimAssertion(tool.id, "jti-1", 60_000)).toBe(false);
    // Another tool's assertion may use the same jti, and an expired record no longer counts.
    expect(await district.claimAssertion(newPlatformToolId(), "jti-1", 60_000)).toBe(true);
    expect(await district.claimAssertion(tool.id, "jti-2", -1)).toBe(true);
    expect(await district.claimAssertion(tool.id, "jti-2", 60_000)).toBe(true);
  });

  it("verifies an issued token across a restart, until its tool is revoked", async () => {
    const district = fresh();
    const toolKey = await generateToolKey();
    const token = await withEndpoint(district, toolKey, Date.now, async ({ tools, client }) => {
      await tools.addTool(tool);
      await tools.putDeployment({
        id: newPlatformDeploymentId(), districtId: NF, toolId: tool.id, offerings: [OfferingId.parse("off_nf-bio-fall-p2")],
        services: { nrps: true, agsLineItems: false, agsResults: false, agsScores: false, deepLinking: false }, privacy: { name: false, email: false },
        status: "active", createdBy: ADMIN, createdAt: AT, updatedBy: ADMIN, updatedAt: AT,
      });
      return client.accessToken(registration, [LTI_SCOPES.contextMembershipReadonly]);
    });
    await evictDurableObject(district);
    await withEndpoint(district, toolKey, Date.now, async ({ endpoint, tools }) => {
      expect((await endpoint.verify(token))?.scopes).toEqual([LTI_SCOPES.contextMembershipReadonly]);
      await tools.revokeTool(tool.id, ADMIN, AT);
      expect(await endpoint.verify(token)).toBeUndefined();
    });
  });

  it("stops verifying a token once it expires, restart or not", async () => {
    const district = fresh();
    const toolKey = await generateToolKey();
    let offset = 0;
    const now = () => Date.now() + offset;
    const token = await withEndpoint(district, toolKey, now, async ({ tools, client }) => {
      await tools.addTool(tool);
      await tools.putDeployment({
        id: newPlatformDeploymentId(), districtId: NF, toolId: tool.id, offerings: [OfferingId.parse("off_nf-bio-fall-p2")],
        services: { nrps: false, agsLineItems: false, agsResults: false, agsScores: true, deepLinking: false }, privacy: { name: false, email: false },
        status: "active", createdBy: ADMIN, createdAt: AT, updatedBy: ADMIN, updatedAt: AT,
      });
      return client.accessToken(registration, [LTI_SCOPES.score]);
    });
    offset = 14 * 60_000;
    await evictDurableObject(district);
    await withEndpoint(district, toolKey, now, async ({ endpoint }) => {
      expect((await endpoint.verify(token))?.scopes).toEqual([LTI_SCOPES.score]);
      offset = 15 * 60_000;
      expect(await endpoint.verify(token)).toBeUndefined();
    });
  });
});
