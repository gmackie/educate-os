// Contract tests of the LTI 1.3 platform fakes, both flavours: OIDC login and launch, JWKS, the
// token endpoint, Deep Linking returns, AGS, NRPS, Dynamic Registration (Canvas) and faults.
import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK } from "jose";
import {
  canvasFlavour,
  LIS_ROLES,
  LTI_CLAIMS,
  LTI_MEDIA_TYPES,
  LTI_SCOPES,
  LtiPlatformFake,
  parseAutoSubmitForm,
  schoologyFlavour,
  type LtiFlavour,
  type LtiPlatformFakeOptions,
} from "../src/lti/index.ts";
import { SAMPLE_DISTRICT } from "../src/sample.ts";

const TOOL = "https://tool.example";
const LAUNCH = `${TOOL}/lti/launch`;
const BIO = "mw-bio-p2";
const ADA = "mw-s-01";
const OKAFOR = "mw-t-okafor";

const flavours: [string, () => LtiFlavour][] = [
  ["canvas", () => canvasFlavour({ issuer: "https://canvas.test.example", sso: "https://sso.test.example", domain: "https://maplewood.test.example" })],
  ["schoology", () => schoologyFlavour({ issuer: "https://schoology.test.example", service: "https://lti-service.test.example" })],
];

class Clock {
  ms = Date.UTC(2026, 9, 20, 15, 0, 0);
  readonly now = (): number => this.ms;
}

async function toolKey(kid = "tool-key-1") {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return { kid, privateKey, jwks: { keys: [jwk] } };
}

async function setup(flavour: () => LtiFlavour, options: Partial<LtiPlatformFakeOptions> = {}) {
  const clock = new Clock();
  const key = await toolKey();
  const fake = await LtiPlatformFake.create({
    flavour: flavour(),
    seed: SAMPLE_DISTRICT,
    now: clock.now,
    tools: [{ name: "Tool", initiateLoginUri: `${TOOL}/lti/login`, redirectUris: [LAUNCH], jwks: () => key.jwks, custom: { CourseKey: "bio" } }],
    ...options,
  });
  const tool = [...fake.tools.values()][0]!;
  return { clock, key, fake, tool };
}

type World = Awaited<ReturnType<typeof setup>>;

/** The tool's authentication request for a login initiation. */
function authRequest(world: World, params: Record<string, string>, extra: Record<string, string | undefined> = {}): string {
  const url = new URL(world.fake.flavour.authorizationEndpoint);
  const query: Record<string, string | undefined> = {
    scope: "openid",
    response_type: "id_token",
    response_mode: "form_post",
    prompt: "none",
    client_id: params.client_id,
    redirect_uri: LAUNCH,
    login_hint: params.login_hint,
    lti_message_hint: params.lti_message_hint,
    state: "state-1",
    nonce: "nonce-1",
    ...extra,
  };
  for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, value);
  return url.toString();
}

async function launch(world: World, input: Partial<Parameters<LtiPlatformFake["initiateLogin"]>[0]> = {}) {
  const login = world.fake.initiateLogin({ personId: ADA, sectionId: BIO, ...input });
  const result = await world.fake.authorize(authRequest(world, login.params));
  return { login, result };
}

async function token(world: World, scopes: readonly string[], overrides: { aud?: string; jti?: string } = {}) {
  const now = Math.floor(world.clock.ms / 1000);
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: world.key.kid })
    .setIssuer(world.tool.clientId)
    .setSubject(world.tool.clientId)
    .setAudience(overrides.aud ?? world.fake.flavour.tokenEndpoint)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setJti(overrides.jti ?? crypto.randomUUID())
    .sign(world.key.privateKey);
  return world.fake.fetch(world.fake.flavour.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
      scope: scopes.join(" "),
    }).toString(),
  });
}

async function accessToken(world: World, scopes: readonly string[]): Promise<string> {
  const response = await token(world, scopes);
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

describe.each(flavours)("LTI platform fake (%s)", (name, flavour) => {
  describe("OIDC login and launch", () => {
    it("initiates login with the LTI Core 1.3 §5.1.1 parameters", async () => {
      const world = await setup(flavour);
      const login = world.fake.initiateLogin({ personId: ADA, sectionId: BIO });
      expect(login.url.startsWith(`${TOOL}/lti/login?`)).toBe(true);
      expect(login.params).toMatchObject({
        iss: world.fake.issuer,
        login_hint: world.fake.userOf(ADA).loginHint,
        target_link_uri: LAUNCH,
        lti_message_hint: login.messageHint,
        lti_deployment_id: world.tool.deploymentIds[0],
        client_id: world.tool.clientId,
      });
      expect("canvas_region" in login.params).toBe(name === "canvas");
    });

    it("answers the authentication request with a form_post of a signed id_token", async () => {
      const world = await setup(flavour);
      const { result } = await launch(world);
      expect(result.status).toBe(200);
      expect(result.form).toMatchObject({ action: LAUNCH, method: "POST", fields: { state: "state-1" } });
      const { payload, protectedHeader } = await jwtVerify(result.idToken!, createLocalJWKSet(world.fake.jwks()), {
        issuer: world.fake.issuer,
        audience: world.tool.clientId,
        algorithms: ["RS256"],
        currentDate: new Date(world.clock.ms),
      });
      expect(protectedHeader.kid).toBe(world.fake.keys.signingKey.kid);
      const context = world.fake.contextOf(BIO);
      expect(payload).toMatchObject({
        sub: world.fake.userOf(ADA).sub,
        nonce: "nonce-1",
        [LTI_CLAIMS.messageType]: "LtiResourceLinkRequest",
        [LTI_CLAIMS.version]: "1.3.0",
        [LTI_CLAIMS.deploymentId]: world.tool.deploymentIds[0],
        [LTI_CLAIMS.targetLinkUri]: LAUNCH,
        [LTI_CLAIMS.context]: { id: context.contextId, label: "SCI-110", title: "Biology, period 2" },
        [LTI_CLAIMS.agsEndpoint]: { lineitems: context.lineItemsUrl },
        [LTI_CLAIMS.nrpsService]: { context_memberships_url: context.membershipsUrl, service_versions: ["2.0"] },
      });
      expect(payload[LTI_CLAIMS.roles]).toEqual([LIS_ROLES.institutionStudent, LIS_ROLES.learner, LIS_ROLES.systemUser]);
      expect(payload).not.toHaveProperty("name");
      expect(payload).not.toHaveProperty("email");
      if (name === "canvas") {
        expect(payload.azp).toBe(world.tool.clientId);
        expect(payload["https://www.instructure.com/placement"]).toBe("course_navigation");
        expect(payload[LTI_CLAIMS.lti11LegacyUserId]).toMatch(/^[0-9a-f]{40}$/);
        expect(payload[LTI_CLAIMS.resourceLink]).toMatchObject({ id: context.contextId });
        expect(payload[LTI_CLAIMS.custom]).toEqual({ CourseKey: "bio" });
      } else {
        expect(payload).not.toHaveProperty("azp");
        // Schoology loses the case of custom parameter keys.
        expect(payload[LTI_CLAIMS.custom]).toEqual({ coursekey: "bio" });
        expect(payload[LTI_CLAIMS.toolPlatform]).toMatchObject({ product_family_code: "schoology" });
      }
    });

    it("gives teachers instructor roles, and names and emails only at a public privacy level", async () => {
      const world = await setup(flavour, {
        tools: [{ initiateLoginUri: `${TOOL}/lti/login`, redirectUris: [LAUNCH], privacyLevel: "public", scopes: [] }],
      });
      const { result } = await launch(world, { personId: OKAFOR });
      expect(result.claims).toMatchObject({ name: "Nia Okafor", given_name: "Nia", family_name: "Okafor", email: "nia.okafor@maplewood.example" });
      expect(result.claims![LTI_CLAIMS.roles]).toContain(LIS_ROLES.instructor);
      expect(result.claims).not.toHaveProperty(LTI_CLAIMS.agsEndpoint);
      expect(result.claims).not.toHaveProperty(LTI_CLAIMS.nrpsService);
    });

    it("refuses bad authentication requests the way the spec and the platform do", async () => {
      const world = await setup(flavour);
      const login = world.fake.initiateLogin({ personId: ADA, sectionId: BIO });
      const invalid = name === "canvas" ? "invalid_request_object" : "invalid_request";
      expect((await world.fake.authorize(authRequest(world, login.params, { scope: "profile" }))).error).toBe(invalid);
      expect((await world.fake.authorize(authRequest(world, login.params, { response_mode: "query" }))).error).toBe(invalid);
      expect((await world.fake.authorize(authRequest(world, login.params, { nonce: undefined }))).error).toBe(invalid);
      expect((await world.fake.authorize(authRequest(world, login.params, { login_hint: "someone-else" }))).error).toBe("login_required");
      // An unregistered redirect URI gets no form at all.
      const elsewhere = await world.fake.authorize(authRequest(world, login.params, { redirect_uri: "https://attacker.example/launch" }));
      expect([elsewhere.status, elsewhere.form]).toEqual([400, undefined]);
      // The launch is single use.
      expect((await world.fake.authorize(authRequest(world, login.params))).idToken).toBeDefined();
      const again = await world.fake.authorize(authRequest(world, login.params));
      expect([again.error, again.form?.fields.state]).toEqual(["launch_no_longer_valid", "state-1"]);
    });

    if (name === "canvas") {
      it("redirects from the shared OIDC host to the institution's domain first", async () => {
        const world = await setup(flavour);
        const login = world.fake.initiateLogin({ personId: ADA, sectionId: BIO });
        const first = await world.fake.fetch(authRequest(world, login.params));
        expect(first.status).toBe(302);
        expect(new URL(first.headers.get("location")!).origin).toBe("https://maplewood.test.example");
      });
    }

    it("publishes its keys and keeps the rotation, withdrawal and forging abilities", async () => {
      const world = await setup(flavour);
      const jwks = await (await world.fake.fetch(world.fake.flavour.jwksUri)).json();
      expect(jwks).toEqual(world.fake.jwks());
      const old = world.fake.keys.signingKey;
      await world.fake.keys.rotate(false);
      expect(world.fake.jwks().keys.map((k) => k.kid)).toEqual([world.fake.keys.signingKey.kid, old.kid]);
      world.fake.keys.withdraw(old.kid);
      expect(world.fake.jwks().keys).toHaveLength(1);
      const forged = await world.fake.signIdToken(world.fake.launchClaims({ personId: ADA, sectionId: BIO }, "n"), { key: old, kid: world.fake.keys.signingKey.kid });
      await expect(jwtVerify(forged, createLocalJWKSet(world.fake.jwks()))).rejects.toThrow();
    });
  });

  describe("OAuth 2 token endpoint", () => {
    it("grants the requested scopes the tool may have, once per assertion", async () => {
      const world = await setup(flavour, {
        tools: [{ initiateLoginUri: `${TOOL}/lti/login`, redirectUris: [LAUNCH], jwks: () => key.jwks, scopes: [LTI_SCOPES.score] }],
      });
      const key = world.key;
      const granted = await token(world, [LTI_SCOPES.score, LTI_SCOPES.lineItem], { jti: "jti-1" });
      expect(await granted.json()).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: LTI_SCOPES.score });
      expect((await (await token(world, [LTI_SCOPES.score], { jti: "jti-1" })).json()) as object).toMatchObject({ error: "invalid_grant" });
      expect(await (await token(world, [LTI_SCOPES.lineItem])).json()).toMatchObject({ error: "invalid_scope" });
      const wrongAud = await token(world, [LTI_SCOPES.score], { aud: world.fake.issuer });
      expect([wrongAud.status, ((await wrongAud.json()) as { error: string }).error]).toEqual([401, "invalid_client"]);
      const basic = await world.fake.fetch(world.fake.flavour.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code",
      });
      expect(await basic.json()).toMatchObject({ error: "unsupported_grant_type" });
    });

    it("fetches the tool's JWKS from its URL through the injected fetch", async () => {
      const key = await toolKey();
      const fetched: string[] = [];
      const clock = new Clock();
      const fake = await LtiPlatformFake.create({
        flavour: flavour(),
        seed: SAMPLE_DISTRICT,
        now: clock.now,
        fetch: (async (input: string | URL | Request) => {
          fetched.push(String(input));
          return Response.json(key.jwks);
        }) as typeof fetch,
        tools: [{ initiateLoginUri: `${TOOL}/lti/login`, redirectUris: [LAUNCH], jwksUri: `${TOOL}/lti/jwks` }],
      });
      const world = { clock, key, fake, tool: [...fake.tools.values()][0]! };
      expect((await token(world, [LTI_SCOPES.score])).status).toBe(200);
      expect(fetched).toEqual([`${TOOL}/lti/jwks`]);
    });
  });

  describe("NRPS 2.0", () => {
    it("pages the membership with limit and Link rel=next, in the NRPS media type", async () => {
      const world = await setup(flavour);
      const bearer = await accessToken(world, [LTI_SCOPES.contextMembershipReadonly]);
      const members: Record<string, unknown>[] = [];
      let url: string | undefined = `${world.fake.contextOf(BIO).membershipsUrl}?limit=3`;
      let pages = 0;
      while (url !== undefined) {
        const response: Response = await world.fake.fetch(url, { headers: { authorization: `Bearer ${bearer}`, accept: LTI_MEDIA_TYPES.membershipContainer } });
        expect(response.headers.get("content-type")).toBe(LTI_MEDIA_TYPES.membershipContainer);
        const body = (await response.json()) as { context: { id: string }; members: Record<string, unknown>[] };
        expect(body.context.id).toBe(world.fake.contextOf(BIO).contextId);
        members.push(...body.members);
        url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
        pages += 1;
      }
      expect(pages).toBe(3);
      expect(members).toHaveLength(7);
      expect(members[0]).toMatchObject({ status: "Active", user_id: world.fake.userOf(OKAFOR).sub, roles: [LIS_ROLES.instructor] });
      expect(members[0]).not.toHaveProperty("email");
    });

    it("filters by role, refuses a token without the scope, and serves a malformed member on request", async () => {
      const world = await setup(flavour);
      const url = world.fake.contextOf(BIO).membershipsUrl;
      const nrps = await accessToken(world, [LTI_SCOPES.contextMembershipReadonly]);
      const learners = (await (await world.fake.fetch(`${url}?role=Learner`, { headers: { authorization: `Bearer ${nrps}` } })).json()) as { members: unknown[] };
      expect(learners.members).toHaveLength(6);
      const instructors = (await (await world.fake.fetch(`${url}?role=${encodeURIComponent(LIS_ROLES.instructor)}`, { headers: { authorization: `Bearer ${nrps}` } })).json()) as { members: unknown[] };
      expect(instructors.members).toHaveLength(1);

      const ags = await accessToken(world, [LTI_SCOPES.score]);
      expect((await world.fake.fetch(url, { headers: { authorization: `Bearer ${ags}` } })).status).toBe(name === "canvas" ? 401 : 403);
      expect((await world.fake.fetch(url)).status).toBe(401);

      world.fake.inject({ kind: "malformed-record", times: 1, match: { path: "memberships" } });
      world.fake.inject({ kind: "malformed-record", times: 1, match: { path: "names_and_roles" } });
      const broken = (await (await world.fake.fetch(url, { headers: { authorization: `Bearer ${nrps}` } })).json()) as { members: Record<string, unknown>[] };
      expect(broken.members[0]).not.toHaveProperty("user_id");
      expect(broken.members[1]).toHaveProperty("user_id");
    });

    it("drops a large share of the students on a large-removal fault", async () => {
      const world = await setup(flavour);
      world.fake.inject({ kind: "large-removal", fraction: 0.5 });
      const nrps = await accessToken(world, [LTI_SCOPES.contextMembershipReadonly]);
      const body = (await (await world.fake.fetch(world.fake.contextOf(BIO).membershipsUrl, { headers: { authorization: `Bearer ${nrps}` } })).json()) as { members: unknown[] };
      // Students 01–05 are gone; Biology period 2 keeps its teacher and student 06.
      expect(body.members).toHaveLength(2);
    });
  });

  describe("AGS 2.0", () => {
    const AGS = [LTI_SCOPES.lineItem, LTI_SCOPES.lineItemReadonly, LTI_SCOPES.resultReadonly, LTI_SCOPES.score];

    it("lists the tool's line items with filters, creates, reads, updates and deletes them", async () => {
      const world = await setup(flavour);
      const bearer = await accessToken(world, AGS);
      const auth = { authorization: `Bearer ${bearer}` };
      const container = world.fake.contextOf(BIO).lineItemsUrl;
      const listed = await world.fake.fetch(container, { headers: { ...auth, accept: LTI_MEDIA_TYPES.lineItemContainer } });
      expect(listed.headers.get("content-type")).toBe(LTI_MEDIA_TYPES.lineItemContainer);
      // Only the integration-made seed assignment is the tool's; the teacher-made quiz is not.
      expect(await listed.json()).toEqual([{ id: `${container}/1`, label: "Cell lab report", scoreMaximum: 100, resourceId: "mw-bio-p2-lab", endDateTime: "2026-10-30T23:59:00.000Z" }]);

      const created = await world.fake.fetch(container, {
        method: "POST",
        headers: { ...auth, "content-type": LTI_MEDIA_TYPES.lineItem },
        body: JSON.stringify({ label: "Quiz 1", scoreMaximum: 10, tag: "quiz", resourceId: "act_quiz" }),
      });
      expect(created.status).toBe(201);
      const item = (await created.json()) as { id: string };
      expect(item.id.startsWith(`${container}/`)).toBe(true);
      const byTag = (await (await world.fake.fetch(`${container}?tag=quiz`, { headers: auth })).json()) as unknown[];
      expect(byTag).toEqual([item]);
      expect(await (await world.fake.fetch(`${container}?resource_id=nothing`, { headers: auth })).json()).toEqual([]);

      const paged = await world.fake.fetch(`${container}?limit=1`, { headers: auth });
      expect(paged.headers.get("link")).toMatch(/rel="next"/);

      expect(await (await world.fake.fetch(item.id, { headers: auth })).json()).toEqual(item);
      const put = await world.fake.fetch(item.id, { method: "PUT", headers: { ...auth, "content-type": LTI_MEDIA_TYPES.lineItem }, body: JSON.stringify({ ...item, label: "Quiz one", scoreMaximum: 12 }) });
      expect(await put.json()).toMatchObject({ id: item.id, label: "Quiz one", scoreMaximum: 12 });
      expect((await world.fake.fetch(item.id, { method: "DELETE", headers: auth })).status).toBe(204);
      expect((await world.fake.fetch(item.id, { headers: auth })).status).toBe(404);

      const bad = await world.fake.fetch(container, { method: "POST", headers: { ...auth, "content-type": LTI_MEDIA_TYPES.lineItem }, body: JSON.stringify({ label: "" }) });
      expect(bad.status).toBe(400);
      const readonly = await accessToken(world, [LTI_SCOPES.lineItemReadonly]);
      const refused = await world.fake.fetch(container, { method: "POST", headers: { authorization: `Bearer ${readonly}`, "content-type": LTI_MEDIA_TYPES.lineItem }, body: JSON.stringify({ label: "x", scoreMaximum: 1 }) });
      expect(refused.status).toBe(name === "canvas" ? 401 : 403);
    });

    it("accepts a well-formed score in the score media type, and reads it back as a result", async () => {
      const world = await setup(flavour);
      const bearer = await accessToken(world, AGS);
      const auth = { authorization: `Bearer ${bearer}` };
      const lineItem = world.fake.addLineItem(world.tool.clientId, BIO, { label: "Lab", scoreMaximum: 10 });
      const userId = world.fake.userOf(ADA).sub;
      const score = { userId, scoreGiven: 8, scoreMaximum: 10, activityProgress: "Completed", gradingProgress: "FullyGraded", timestamp: "2026-10-20T14:00:00.000Z", comment: "Good" };
      const post = (body: unknown, contentType: string = LTI_MEDIA_TYPES.score) =>
        world.fake.fetch(`${lineItem}/scores`, { method: "POST", headers: { ...auth, "content-type": contentType }, body: JSON.stringify(body) });

      const accepted = await post(score);
      if (name === "canvas") {
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toEqual({ resultUrl: `${lineItem}/results/${userId}` });
      } else {
        expect(accepted.status).toBe(201);
      }
      expect(world.fake.scores).toEqual([{ lineItem, score }]);

      expect((await post(score, "application/json")).status).toBe(415);
      expect((await post({ ...score, gradingProgress: "Done" })).status).toBe(400);
      expect((await post({ ...score, timestamp: "yesterday" })).status).toBe(400);
      expect((await post({ ...score, timestamp: "2026-10-19T14:00:00Z" })).status).toBe(400);
      expect((await post({ ...score, userId: world.fake.userOf(OKAFOR).sub })).status).toBe(422);

      const results = await world.fake.fetch(`${lineItem}/results?user_id=${userId}`, { headers: auth });
      expect(results.headers.get("content-type")).toBe(LTI_MEDIA_TYPES.resultContainer);
      expect(await results.json()).toEqual([{ id: `${lineItem}/results/${userId}`, scoreOf: lineItem, userId, resultScore: 8, resultMaximum: 10, comment: "Good" }]);
    });

    it("serves a malformed line item on request", async () => {
      const world = await setup(flavour);
      const bearer = await accessToken(world, AGS);
      world.fake.inject({ kind: "malformed-record", times: 1 });
      const items = (await (await world.fake.fetch(world.fake.contextOf(BIO).lineItemsUrl, { headers: { authorization: `Bearer ${bearer}` } })).json()) as object[];
      expect(items[0]).not.toHaveProperty("scoreMaximum");
    });
  });

  describe("Deep Linking 2.0", () => {
    async function respond(world: World, data: string | undefined, items: unknown[], deploymentId = world.tool.deploymentIds[0]!) {
      const now = Math.floor(world.clock.ms / 1000);
      return new SignJWT({
        nonce: crypto.randomUUID(),
        [LTI_CLAIMS.messageType]: "LtiDeepLinkingResponse",
        [LTI_CLAIMS.version]: "1.3.0",
        [LTI_CLAIMS.deploymentId]: deploymentId,
        [LTI_CLAIMS.contentItems]: items,
        ...(data === undefined ? {} : { [LTI_CLAIMS.data]: data }),
      })
        .setProtectedHeader({ alg: "RS256", kid: world.key.kid })
        .setIssuer(world.tool.clientId)
        .setAudience(world.fake.issuer)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(world.key.privateKey);
    }

    it("verifies the tool's response, round-trips data, and places the links it carries", async () => {
      const world = await setup(flavour);
      const { result } = await launch(world, { personId: OKAFOR, messageType: "LtiDeepLinkingRequest" });
      const settings = result.claims![LTI_CLAIMS.deepLinkingSettings] as Record<string, unknown>;
      expect(settings).toMatchObject({ accept_types: expect.arrayContaining(["ltiResourceLink"]), accept_multiple: true });
      const returnUrl = settings.deep_link_return_url as string;
      // Canvas carries `data` in the return URL; the spec (and Schoology) in the settings claim.
      const data = name === "canvas" ? new URL(returnUrl).searchParams.get("data")! : (settings.data as string);
      expect(name === "canvas" ? settings.data : new URL(returnUrl).searchParams.get("data")).toBeFalsy();

      const items = [{ type: "ltiResourceLink", title: "Cell lab", url: LAUNCH, custom: { Link: "dl-1" }, lineItem: { scoreMaximum: 20, label: "Cell lab" } }];
      const jwt = await respond(world, name === "canvas" ? undefined : data, items);
      const response = await world.fake.fetch(returnUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ JWT: jwt }).toString() });
      expect(response.status).toBe(200);
      const [placed] = world.fake.deepLinkResults;
      expect(placed!.links).toHaveLength(1);
      const link = placed!.links[0]!;
      expect(world.fake.lineItemsOf(world.tool.clientId, BIO).find((item) => item.resourceLinkId === link.id)).toMatchObject({ scoreMaximum: 20 });

      // A launch of the placed link carries its custom parameters and its line item.
      const { result: again } = await launch(world, { resourceLinkId: link.id });
      expect(again.claims![LTI_CLAIMS.resourceLink]).toMatchObject({ id: link.id, title: "Cell lab" });
      expect(again.claims![LTI_CLAIMS.custom]).toEqual(name === "canvas" ? { CourseKey: "bio", Link: "dl-1" } : { link: "dl-1" });
      expect((again.claims![LTI_CLAIMS.agsEndpoint] as { lineitem: string }).lineitem).toBe(link.lineItemId);

      // A replayed response, another deployment, foreign data and an unaccepted type are refused.
      const post = async (token: string, url = returnUrl) =>
        (await world.fake.fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ JWT: token }).toString() })).status;
      expect(await post(jwt)).toBe(400);
      expect(await post(await respond(world, name === "canvas" ? undefined : data, items, "other-deployment"))).toBe(400);
      const foreign = new URL(returnUrl);
      if (name === "canvas") foreign.searchParams.set("data", "forged");
      expect(await post(await respond(world, name === "canvas" ? undefined : "forged", items), foreign.toString())).toBe(400);
      expect(await post(await respond(world, name === "canvas" ? undefined : data, [{ type: "ltiAssetProcessor" }]))).toBe(400);
    });
  });

  describe("faults", () => {
    it("serves outages and rate limits in the platform's style, and network errors", async () => {
      const world = await setup(flavour);
      world.fake.inject({ kind: "outage", times: 1 });
      const down = await world.fake.fetch(world.fake.flavour.jwksUri);
      expect(down.status).toBe(503);
      expect(await down.json()).toEqual(name === "canvas" ? { errors: [{ message: "An error occurred." }] } : expect.objectContaining({ error: "server_error" }));
      world.fake.inject({ kind: "rate-limit", retryAfterSeconds: 30, times: 1 });
      const limited = await world.fake.fetch(world.fake.flavour.tokenEndpoint, { method: "POST" });
      expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "30"]);
      if (name === "canvas") expect(await limited.text()).toBe("429 Forbidden (Rate Limit Exceeded)");
      world.fake.inject({ kind: "network-error", times: 1 });
      await expect(world.fake.fetch(world.fake.flavour.jwksUri)).rejects.toThrow(TypeError);
      expect((await world.fake.fetch(world.fake.flavour.jwksUri)).status).toBe(200);
    });
  });
});

describe("Dynamic Registration 1.0", () => {
  const metadata = {
    application_type: "web",
    grant_types: ["implicit", "client_credentials"],
    response_types: ["id_token"],
    initiate_login_uri: `${TOOL}/lti/login`,
    redirect_uris: [LAUNCH],
    client_name: "Tool",
    jwks_uri: `${TOOL}/lti/jwks`,
    token_endpoint_auth_method: "private_key_jwt",
    scope: `${LTI_SCOPES.score} ${LTI_SCOPES.contextMembershipReadonly}`,
    "https://purl.imsglobal.org/spec/lti-tool-configuration": { domain: "tool.example", target_link_uri: LAUNCH, claims: ["iss", "sub"], messages: [{ type: "LtiResourceLinkRequest" }] },
  };

  it("Canvas: serves its OpenID configuration for the registration token, and registers the tool", async () => {
    const fake = await LtiPlatformFake.create({ flavour: canvasFlavour(), seed: SAMPLE_DISTRICT });
    const started = fake.registrationInitiation(`${TOOL}/lti/register?invitation=abc`);
    const url = new URL(started.url);
    expect(url.searchParams.get("invitation")).toBe("abc");
    expect(url.searchParams.get("registration_token")).toBe(started.registrationToken);
    const configUrl = url.searchParams.get("openid_configuration")!;

    const withoutToken = new URL(configUrl);
    withoutToken.search = "";
    expect((await fake.fetch(withoutToken)).status).toBe(401);
    const config = (await (await fake.fetch(configUrl)).json()) as Record<string, any>;
    expect(config).toMatchObject({
      issuer: fake.issuer,
      authorization_endpoint: fake.flavour.authorizationEndpoint,
      token_endpoint: fake.flavour.tokenEndpoint,
      jwks_uri: fake.flavour.jwksUri,
      registration_endpoint: fake.flavour.registrationEndpoint,
    });
    expect(config["https://purl.imsglobal.org/spec/lti-platform-configuration"]).toMatchObject({ product_family_code: "canvas" });
    expect(config["https://purl.imsglobal.org/spec/lti-platform-configuration"].messages_supported.map((m: { type: string }) => m.type)).toEqual([
      "LtiResourceLinkRequest",
      "LtiDeepLinkingRequest",
    ]);
    expect(config["https://purl.imsglobal.org/spec/lti-platform-configuration"].variables).toContain("ResourceLink.id");

    const register = (body: unknown, token: string | null = started.registrationToken) =>
      fake.fetch(config.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
        body: JSON.stringify(body),
      });
    expect((await register(metadata, null)).status).toBe(401);
    expect((await register({ ...metadata, token_endpoint_auth_method: "client_secret_basic" })).status).toBe(422);
    const answer = (await (await register(metadata)).json()) as Record<string, any>;
    const tool = fake.tools.get(answer.client_id)!;
    expect(tool.scopes).toEqual([LTI_SCOPES.score, LTI_SCOPES.contextMembershipReadonly]);
    // Canvas puts the new deployment at the top level, not in the tool configuration.
    expect(answer.deployment_id).toBe(tool.deploymentIds[0]);
    expect(answer["https://purl.imsglobal.org/spec/lti-tool-configuration"]).not.toHaveProperty("deployment_id");
    expect(answer.scope.split(" ")).toContain("openid");
  });

  it("Canvas: can put the deployment in the tool configuration, as the spec's example does", async () => {
    const fake = await LtiPlatformFake.create({ flavour: canvasFlavour(), seed: SAMPLE_DISTRICT, registrationDeploymentId: "tool-configuration" });
    const { registrationToken } = fake.registrationInitiation(`${TOOL}/lti/register`);
    const answer = (await (
      await fake.fetch(fake.flavour.registrationEndpoint!, { method: "POST", headers: { authorization: `Bearer ${registrationToken}` }, body: JSON.stringify(metadata) })
    ).json()) as Record<string, any>;
    expect(answer["https://purl.imsglobal.org/spec/lti-tool-configuration"].deployment_id).toBeDefined();
    expect(answer).not.toHaveProperty("deployment_id");
  });

  it("Schoology: has no Dynamic Registration", async () => {
    const fake = await LtiPlatformFake.create({ flavour: schoologyFlavour(), seed: SAMPLE_DISTRICT });
    expect(fake.flavour.openidConfigurationUrl).toBeUndefined();
    expect(() => fake.registrationInitiation(`${TOOL}/lti/register`)).toThrow(/does not support/);
  });
});

describe("parseAutoSubmitForm", () => {
  it("reads the action and hidden fields, unescaping them", () => {
    expect(parseAutoSubmitForm('<form method="post" action="https://t.example/a?x=1&amp;y=2"><input type="hidden" name="id_token" value="a&quot;b"></form>')).toEqual({
      action: "https://t.example/a?x=1&y=2",
      method: "POST",
      fields: { id_token: 'a"b' },
    });
  });
});
