// Contract tests of the LTI 1.3 tool fake: it answers a platform's login initiation with an
// authentication request, and accepts only a launch signed by the platform for it, with the state
// and nonce it sent, through a deployment it knows.
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
