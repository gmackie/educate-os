// Contract tests of the LTI 1.3 tool fake: it answers a platform's login initiation with an
// authentication request, and accepts only a launch signed by the platform for it, with the state
// and nonce it sent, through a deployment it knows; and from its server it gets a service token
// and reads a roster.
import { describe, expect, it } from "vitest";
import { FakeLtiTool, FakeLtiToolError, LTI_CLAIMS, LTI_VERSION, PlatformKeyRing } from "../src/lti/index.ts";

const PLATFORM = "https://district.example";
const CLIENT = "ltt_notebook00000000000000";
const DEPLOYMENT = "ltd_notebook00000000000000";

async function setUp() {
  const platform = await PlatformKeyRing.create();
  const tool = await FakeLtiTool.create({
    origin: "https://notebook.example",
    platformIssuer: PLATFORM,
    platformAuthUrl: `${PLATFORM}/lti/platform/auth`,
    platformJwks: () => platform.jwks(),
  });
  tool.clientId = CLIENT;
  tool.deploymentIds.push(DEPLOYMENT);
  const login = (overrides: Record<string, string> = {}) => {
    const url = new URL(tool.loginUrl);
    const params = { iss: PLATFORM, login_hint: "subject-1", lti_message_hint: "ticket-1", target_link_uri: tool.launchUrl, client_id: CLIENT, lti_deployment_id: DEPLOYMENT, ...overrides };
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return url.toString();
  };
  const idToken = (auth: URLSearchParams, overrides: Record<string, unknown> = {}) =>
    platform.sign({
      iss: PLATFORM,
      aud: CLIENT,
      sub: "subject-1",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: auth.get("nonce"),
      [LTI_CLAIMS.messageType]: "LtiResourceLinkRequest",
      [LTI_CLAIMS.version]: LTI_VERSION,
      [LTI_CLAIMS.deploymentId]: DEPLOYMENT,
      [LTI_CLAIMS.context]: { id: "off_bio" },
      [LTI_CLAIMS.roles]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
      ...overrides,
    });
  return { platform, tool, login, idToken };
}

describe("FakeLtiTool", () => {
  it("answers a login initiation with an OIDC authentication request and accepts the platform's launch", async () => {
    const { tool, login, idToken } = await setUp();
    const auth = new URL(tool.initiateLogin(login()));
    expect(auth.origin + auth.pathname).toBe(`${PLATFORM}/lti/platform/auth`);
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({
      scope: "openid",
      response_type: "id_token",
      response_mode: "form_post",
      prompt: "none",
      client_id: CLIENT,
      redirect_uri: tool.launchUrl,
      login_hint: "subject-1",
      lti_message_hint: "ticket-1",
    });
    const launch = await tool.receiveLaunch({ id_token: await idToken(auth.searchParams), state: auth.searchParams.get("state")! });
    expect(launch).toMatchObject({ deploymentId: DEPLOYMENT, contextId: "off_bio", roles: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"] });
    expect(tool.launches).toHaveLength(1);
  });

  it("refuses a login initiation from another issuer, for another client or deployment, or aimed elsewhere", async () => {
    const { tool, login } = await setUp();
    const cases: Record<string, string>[] = [{ iss: "https://other.example" }, { client_id: "ltt_other00000000000000000" }, { lti_deployment_id: "ltd_other" }, { target_link_uri: "https://other.example/launch" }];
    for (const overrides of cases) {
      expect(() => tool.initiateLogin(login(overrides))).toThrow(FakeLtiToolError);
    }
  });

  it("refuses a launch with an unknown or reused state, a wrong nonce, issuer or audience, or a foreign key", async () => {
    const { tool, login, idToken } = await setUp();
    const refuse = async (make: (auth: URLSearchParams) => Promise<{ id_token: string; state: string }>) => {
      const auth = new URL(tool.initiateLogin(login())).searchParams;
      await expect(tool.receiveLaunch(await make(auth))).rejects.toThrow(FakeLtiToolError);
    };
    await refuse(async (auth) => ({ id_token: await idToken(auth), state: "not-a-state" }));
    await refuse(async (auth) => ({ id_token: await idToken(auth, { nonce: "other" }), state: auth.get("state")! }));
    await refuse(async (auth) => ({ id_token: await idToken(auth, { iss: "https://other.example" }), state: auth.get("state")! }));
    await refuse(async (auth) => ({ id_token: await idToken(auth, { aud: "ltt_other00000000000000000" }), state: auth.get("state")! }));
    await refuse(async (auth) => ({ id_token: await idToken(auth, { [LTI_CLAIMS.deploymentId]: "ltd_other" }), state: auth.get("state")! }));
    const forger = await PlatformKeyRing.create();
    await refuse(async (auth) => ({ id_token: await forger.sign({ iss: PLATFORM, aud: CLIENT, nonce: auth.get("nonce") }), state: auth.get("state")! }));

    const auth = new URL(tool.initiateLogin(login())).searchParams;
    const fields = { id_token: await idToken(auth), state: auth.get("state")! };
    await tool.receiveLaunch(fields);
    await expect(tool.receiveLaunch(fields)).rejects.toThrow(/unknown state/);
  });
});

describe("the tool fake's service calls", () => {
  const TOKEN_URL = `${PLATFORM}/lti/platform/token`;
  const ROSTER_URL = `${PLATFORM}/lti/platform/nrps/${DEPLOYMENT}/off_bio/memberships`;
  const MEDIA = "application/vnd.ims.lti-nrps.v2.membershipcontainer+json";

  async function serviceTool(answer: (request: Request) => Response | Promise<Response>) {
    const requests: Request[] = [];
    const tool = await FakeLtiTool.create({
      origin: "https://notebook.example",
      platformIssuer: PLATFORM,
      platformAuthUrl: `${PLATFORM}/lti/platform/auth`,
      platformTokenUrl: TOKEN_URL,
      platformJwks: () => ({ keys: [] }),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return answer(request);
      },
    });
    tool.clientId = CLIENT;
    return { tool, requests };
  }

  it("gets a token with a fresh private_key_jwt assertion for its own client ID", async () => {
    const { tool, requests } = await serviceTool(() => Response.json({ access_token: "token-1", token_type: "Bearer" }));
    expect(await tool.serviceToken(["scope-a", "scope-b"])).toBe("token-1");
    const form = new URLSearchParams(await requests[0]!.text());
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    expect(form.get("scope")).toBe("scope-a scope-b");
    const claims = JSON.parse(atob(form.get("client_assertion")!.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;
    expect(claims).toMatchObject({ iss: CLIENT, sub: CLIENT, aud: TOKEN_URL });
    expect(typeof claims.jti).toBe("string");
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
    expect(await tool.clientAssertion()).not.toBe(form.get("client_assertion"));
  });

  it("reports a refused token by its OAuth error", async () => {
    const { tool } = await serviceTool(() => Response.json({ error: "invalid_scope" }, { status: 400 }));
    await expect(tool.serviceToken(["scope-a"])).rejects.toThrow(/token refused \(invalid_scope\)/);
  });

  it("reads a roster page with the bearer token, and its next link", async () => {
    const container = { id: ROSTER_URL, context: { id: "off_bio" }, members: [{ user_id: "s1", roles: ["r"], status: "Active" }] };
    const { tool, requests } = await serviceTool(() => new Response(JSON.stringify(container), {
      headers: { "content-type": MEDIA, link: `<${ROSTER_URL}?page=2>; rel="next"` },
    }));
    expect(await tool.memberships(ROSTER_URL, "token-1")).toEqual({ ...container, next: `${ROSTER_URL}?page=2` });
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer token-1");
    expect(requests[0]!.headers.get("accept")).toBe(MEDIA);
  });

  it("reports a refused roster read by status and bearer error, and refuses another media type", async () => {
    const challenged = await serviceTool(() => new Response(null, { status: 403, headers: { "www-authenticate": 'Bearer error="insufficient_scope"' } }));
    await expect(challenged.tool.memberships(ROSTER_URL, "t")).rejects.toThrow(/memberships refused \(403 insufficient_scope\)/);
    const json = await serviceTool(() => Response.json({ id: ROSTER_URL, context: { id: "off_bio" }, members: [] }));
    await expect(json.tool.memberships(ROSTER_URL, "t")).rejects.toThrow(/not a membership container/);
  });
});
