// The LTI Platform's token endpoint (SCHO-179): a tool gets an access token only with a fresh,
// single-use RS256 client assertion addressed to this endpoint and signed by a key at its
// registered JWKS URL, for scopes its active deployments allow. Errors are RFC 6749 §5.2 codes,
// nothing is cached, and a token stops working the moment its tool, deployment or service does.
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { DistrictId, OfferingId } from "@educateos/contracts";
import {
  CLIENT_ASSERTION_TYPE_JWT_BEARER,
  createToolKeySet,
  generateToolKey,
  importToolKey,
  InMemoryPlatformServiceTokenStore,
  LTI_SCOPES,
  LtiServiceClient,
  newPlatformDeploymentId,
  newPlatformToolId,
  PlatformDeployment,
  PlatformJwksCache,
  PlatformTokenEndpoint,
  PlatformTool,
  toolJwks,
  type PlatformToolLookup,
  type PlatformToolServices,
  type ToolKey,
} from "../src/index.ts";
import { TestClock } from "./helpers.ts";

const ORIGIN = "https://district.example";
const TOKEN_URL = `${ORIGIN}/lti/platform/token`;
const JWKS_URL = "https://tool.example/.well-known/jwks.json";
const AT = "2026-10-31T12:00:00.000Z";
const ADMIN = "prn_nf-district-admin";
const NRPS = LTI_SCOPES.contextMembershipReadonly;
const SCORE = LTI_SCOPES.score;
const NO_SERVICES: PlatformToolServices = { nrps: false, agsLineItems: false, agsResults: false, agsScores: false, deepLinking: false };

/** One registered tool, its deployments, its signing key, and the endpoint, on a test clock. */
async function world(services: Partial<PlatformToolServices> = { nrps: true }) {
  const clock = new TestClock();
  const key = await importToolKey(await generateToolKey());
  let tool = PlatformTool.parse({
    id: newPlatformToolId(), districtId: "dst_northfield", name: "Quiz Garden",
    loginInitiationUrl: "https://tool.example/lti/login", redirectUris: ["https://tool.example/lti/launch"],
    targetLinkUri: "https://tool.example/lti/launch", jwksUrl: JWKS_URL, status: "active",
    registeredBy: ADMIN, registeredAt: AT, updatedBy: ADMIN, updatedAt: AT,
  });
  let deployments = [PlatformDeployment.parse({
    id: newPlatformDeploymentId(), districtId: DistrictId.parse("dst_northfield"), toolId: tool.id,
    offerings: [OfferingId.parse("off_nf-bio-fall-p2")], services: { ...NO_SERVICES, ...services }, privacy: { name: false, email: false },
    status: "active", createdBy: ADMIN, createdAt: AT, updatedBy: ADMIN, updatedAt: AT,
  })];
  const tools: PlatformToolLookup = {
    tool: async (id) => (id === tool.id ? tool : undefined),
    deployments: async () => deployments,
  };
  const jwksFetches: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    jwksFetches.push(String(input));
    return String(input) === JWKS_URL ? Response.json(toolJwks(createToolKeySet(key))) : new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
  const store = new InMemoryPlatformServiceTokenStore(clock.now);
  const endpoint = new PlatformTokenEndpoint({ tokenUrl: TOKEN_URL, tools, store, keys: new PlatformJwksCache({ fetch, now: clock.now }), now: clock.now });
  return {
    clock, key, endpoint, jwksFetches, fetch,
    get tool() { return tool; },
    revokeTool: () => { tool = { ...tool, status: "revoked" }; },
    setDeployments: (change: (all: PlatformDeployment[]) => PlatformDeployment[]) => { deployments = change(deployments); },
  };
}

type World = Awaited<ReturnType<typeof world>>;

interface AssertionOptions {
  readonly key?: ToolKey;
  readonly alg?: string;
  readonly iss?: string;
  readonly sub?: string;
  readonly aud?: string | string[];
  readonly iat?: number;
  readonly lifetime?: number;
  readonly jti?: string;
}

/** A client assertion for `w`'s tool, as a well-behaved tool signs one unless told otherwise. */
async function assertion(w: World, options: AssertionOptions = {}): Promise<string> {
  const key = options.key ?? w.key;
  const iat = options.iat ?? Math.floor(w.clock.now() / 1000);
  return new SignJWT({ jti: options.jti ?? crypto.randomUUID() })
    .setProtectedHeader({ alg: options.alg ?? "RS256", kid: key.kid })
    .setIssuer(options.iss ?? w.tool.id)
    .setSubject(options.sub ?? w.tool.id)
    .setAudience(options.aud ?? TOKEN_URL)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (options.lifetime ?? 300))
    .sign(key.privateKey);
}

function tokenRequest(params: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
}

async function requestToken(w: World, jwt: string, scope: string = NRPS, extra: Record<string, string> = {}) {
  const { response, outcome } = await w.endpoint.handle(tokenRequest({
    grant_type: "client_credentials", client_assertion_type: CLIENT_ASSERTION_TYPE_JWT_BEARER, client_assertion: jwt, scope, ...extra,
  }));
  return { status: response.status, cacheControl: response.headers.get("cache-control"), body: (await response.json()) as Record<string, unknown>, outcome };
}

describe("the LTI Platform token endpoint", () => {
  it("issues a short-lived bearer token for the scopes the deployment allows, uncached", async () => {
    const w = await world({ nrps: true, agsLineItems: true, agsResults: true });
    const result = await requestToken(w, await assertion(w), `${NRPS} ${LTI_SCOPES.lineItem} ${LTI_SCOPES.resultReadonly}`);
    expect(result.status).toBe(200);
    expect(result.cacheControl).toBe("no-store");
    expect(result.body).toMatchObject({ token_type: "Bearer", expires_in: 900, scope: `${NRPS} ${LTI_SCOPES.lineItem} ${LTI_SCOPES.resultReadonly}` });
    expect(result.body.access_token).toMatch(/^lst_/);
    expect(result.outcome).toEqual({ issued: true, toolId: w.tool.id, scopes: [NRPS, LTI_SCOPES.lineItem, LTI_SCOPES.resultReadonly] });
    expect(JSON.stringify(result.outcome)).not.toContain(result.body.access_token as string);

    const grant = await w.endpoint.verify(result.body.access_token as string);
    expect(grant?.tool.id).toBe(w.tool.id);
    expect(grant?.scopes).toEqual([NRPS, LTI_SCOPES.lineItem, LTI_SCOPES.resultReadonly]);
    expect(grant?.deployments).toHaveLength(1);
    expect(await w.endpoint.verifyRequest(new Request(ORIGIN, { headers: { authorization: `Bearer ${result.body.access_token as string}` } }))).toEqual(grant);
  });

  it("issues a token to EducateOS's own LTI service client, as a tool would ask for one", async () => {
    const w = await world();
    const platform = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      return url === TOKEN_URL ? (await w.endpoint.handle(new Request(url, init))).response : w.fetch(url);
    }) as typeof fetch;
    const client = new LtiServiceClient({ fetch: platform, toolKeys: () => createToolKeySet(w.key), now: w.clock.now });
    const registration = { authTokenUrl: TOKEN_URL, clientId: w.tool.id, issuer: ORIGIN } as Parameters<LtiServiceClient["accessToken"]>[0];
    const token = await client.accessToken(registration, [NRPS]);
    expect((await w.endpoint.verify(token))?.scopes).toEqual([NRPS]);
  });

  it("refuses an assertion for another audience, issuer or subject", async () => {
    const w = await world();
    for (const options of [
      { aud: "https://district.example/lti/platform/other" },
      { aud: [TOKEN_URL, "https://elsewhere.example"] },
      { iss: newPlatformToolId() },
      { sub: newPlatformToolId() },
      { iss: "https://tool.example", sub: "https://tool.example" },
    ] satisfies AssertionOptions[]) {
      const result = await requestToken(w, await assertion(w, options));
      expect(result.status, JSON.stringify(options)).toBe(401);
      expect(result.body.error).toBe("invalid_client");
    }
    // A client_id that disagrees with the assertion is refused too.
    expect((await requestToken(w, await assertion(w), NRPS, { client_id: newPlatformToolId() })).body.error).toBe("invalid_client");
  });

  it("refuses HS256 and an unsigned assertion, whatever key they claim", async () => {
    const w = await world();
    const iat = Math.floor(w.clock.now() / 1000);
    const hs256 = await new SignJWT({ jti: "hs" })
      .setProtectedHeader({ alg: "HS256", kid: w.key.kid })
      .setIssuer(w.tool.id).setSubject(w.tool.id).setAudience(TOKEN_URL).setIssuedAt(iat).setExpirationTime(iat + 60)
      .sign(new TextEncoder().encode("a shared secret anyone could guess"));
    expect((await requestToken(w, hs256)).body).toMatchObject({ error: "invalid_client", error_description: "The client assertion must be signed with RS256." });
    const payload = hs256.split(".")[1]!;
    const none = `${btoa(JSON.stringify({ alg: "none", kid: w.key.kid })).replaceAll("=", "")}.${payload}.`;
    expect((await requestToken(w, none)).body.error).toBe("invalid_client");
  });

  it("refuses a key the tool does not publish, and a forged signature under a published kid", async () => {
    const w = await world();
    const rogue = await importToolKey(await generateToolKey());
    expect((await requestToken(w, await assertion(w, { key: rogue }))).body.error).toBe("invalid_client");
    const forged = await assertion(w, { key: { ...rogue, kid: w.key.kid } });
    expect((await requestToken(w, forged)).body.error).toBe("invalid_client");
  });

  it("refuses an expired assertion, one living past five minutes, and one issued in the future", async () => {
    const w = await world();
    const now = Math.floor(w.clock.now() / 1000);
    expect((await requestToken(w, await assertion(w, { iat: now - 400, lifetime: 300 }))).body.error).toBe("invalid_client");
    expect((await requestToken(w, await assertion(w, { lifetime: 301 }))).body.error).toBe("invalid_client");
    expect((await requestToken(w, await assertion(w, { lifetime: 3600 }))).body.error).toBe("invalid_client");
    expect((await requestToken(w, await assertion(w, { iat: now + 120, lifetime: 60 }))).body.error).toBe("invalid_client");
    // Within 30 seconds of skew either way, it is accepted.
    expect((await requestToken(w, await assertion(w, { iat: now + 20, lifetime: 60 }))).status).toBe(200);
    expect((await requestToken(w, await assertion(w, { iat: now - 310, lifetime: 300 }))).status).toBe(200);
  });

  it("accepts each assertion once, until it expires", async () => {
    const w = await world();
    const jwt = await assertion(w);
    expect((await requestToken(w, jwt)).status).toBe(200);
    const replay = await requestToken(w, jwt);
    expect(replay.body).toMatchObject({ error: "invalid_client", error_description: "The client assertion was already used." });
    // A refused scope still uses up the assertion.
    const refused = await assertion(w);
    expect((await requestToken(w, refused, SCORE)).body.error).toBe("invalid_scope");
    expect((await requestToken(w, refused)).body.error).toBe("invalid_client");
    // The same jti in a new assertion is a replay too, while the first could still be accepted.
    const reused = await assertion(w, { jti: "same-jti" });
    expect((await requestToken(w, reused)).status).toBe(200);
    w.clock.advance(60);
    expect((await requestToken(w, await assertion(w, { jti: "same-jti" }))).body.error).toBe("invalid_client");
  });

  it("refuses a revoked tool, and one with no deployment allowing a service", async () => {
    const w = await world();
    const issued = await requestToken(w, await assertion(w));
    w.revokeTool();
    expect((await requestToken(w, await assertion(w))).body.error).toBe("invalid_client");
    expect(await w.endpoint.verify(issued.body.access_token as string)).toBeUndefined();

    const idle = await world(NO_SERVICES);
    expect((await requestToken(idle, await assertion(idle))).body.error).toBe("unauthorized_client");
  });

  it("refuses unknown scopes and scopes beyond the deployment's services", async () => {
    const w = await world({ nrps: true });
    for (const scope of ["", "openid", `${NRPS} https://purl.imsglobal.org/spec/lti-ags/scope/everything`, SCORE, `${NRPS} ${LTI_SCOPES.lineItem}`]) {
      const result = await requestToken(w, await assertion(w), scope);
      expect(result.status, scope).toBe(400);
      expect(result.body.error, scope).toBe("invalid_scope");
    }
  });

  it("grants reading results, which are students' grades, only with the results service", async () => {
    const lineItemsOnly = await world({ agsLineItems: true });
    expect((await requestToken(lineItemsOnly, await assertion(lineItemsOnly), `${LTI_SCOPES.lineItem} ${LTI_SCOPES.resultReadonly}`)).body.error).toBe("invalid_scope");
    const scoresOnly = await world({ agsScores: true });
    expect((await requestToken(scoresOnly, await assertion(scoresOnly), `${SCORE} ${LTI_SCOPES.resultReadonly}`)).body.error).toBe("invalid_scope");
    const results = await world({ agsResults: true });
    expect((await requestToken(results, await assertion(results), LTI_SCOPES.resultReadonly)).body).toMatchObject({ scope: LTI_SCOPES.resultReadonly });
  });

  it("answers malformed requests with RFC 6749 errors", async () => {
    const w = await world();
    const jwt = await assertion(w);
    const answer = async (request: Request) => {
      const { response } = await w.endpoint.handle(request);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return { status: response.status, error: ((await response.json()) as { error: string }).error };
    };
    const base = { grant_type: "client_credentials", client_assertion_type: CLIENT_ASSERTION_TYPE_JWT_BEARER, client_assertion: jwt, scope: NRPS };
    expect(await answer(tokenRequest({ ...base, grant_type: "authorization_code" }))).toEqual({ status: 400, error: "unsupported_grant_type" });
    expect(await answer(tokenRequest({ scope: NRPS }))).toEqual({ status: 400, error: "invalid_request" });
    expect(await answer(tokenRequest({ ...base, client_assertion_type: "urn:other" }))).toEqual({ status: 401, error: "invalid_client" });
    expect(await answer(tokenRequest({ ...base, client_secret: "s3cret" }))).toEqual({ status: 401, error: "invalid_client" });
    expect(await answer(tokenRequest(base, { authorization: "Basic eDp5" }))).toEqual({ status: 400, error: "invalid_request" });
    expect(await answer(new Request(TOKEN_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base) }))).toEqual({ status: 400, error: "invalid_request" });
    expect(await answer(new Request(TOKEN_URL, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `${new URLSearchParams(base).toString()}&scope=${encodeURIComponent(NRPS)}`,
    }))).toEqual({ status: 400, error: "invalid_request" });
    expect(await answer(tokenRequest({ ...base, padding: "x".repeat(20_000) }))).toEqual({ status: 400, error: "invalid_request" });
    // None of those used the assertion.
    expect((await requestToken(w, jwt)).status).toBe(200);
  });

  it("verifies a token until it expires, and only for the scopes its deployments still allow", async () => {
    const w = await world({ nrps: true, agsScores: true });
    const token = (await requestToken(w, await assertion(w), `${NRPS} ${SCORE}`)).body.access_token as string;
    w.setDeployments((all) => all.map((d) => ({ ...d, services: { ...d.services, agsScores: false } })));
    expect((await w.endpoint.verify(token))?.scopes).toEqual([NRPS]);
    w.setDeployments((all) => all.map((d) => ({ ...d, status: "revoked" as const })));
    expect(await w.endpoint.verify(token)).toBeUndefined();
    w.setDeployments((all) => all.map((d) => ({ ...d, status: "active" as const })));
    expect(await w.endpoint.verify(token)).toBeDefined();
    w.clock.advance(900);
    expect(await w.endpoint.verify(token)).toBeUndefined();
    expect(await w.endpoint.verify("lst_not-a-token")).toBeUndefined();
    expect(await w.endpoint.verifyRequest(new Request(ORIGIN))).toBeUndefined();
  });
});
