// LTI Dynamic Registration (SCHO-59): an invited platform registers itself, and the result is a
// pending registration that launches nothing until a district administrator approves it.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DistrictId, OfferingId, PrincipalId } from "@educateos/contracts";
import {
  approvedRegistration,
  createLtiHandler,
  DynamicRegistration,
  InMemoryPendingRegistrationStore,
  InMemorySingleUseStore,
  REGISTRATION_CLOSE_SCRIPT,
  REGISTRATION_CLOSE_SCRIPT_HASH,
  REGISTRATION_INVITATION_TTL_MS,
  type RegistrationInvitation,
} from "../src/index.ts";
import { createWorld, rejection, TOOL } from "./helpers.ts";

const NF = DistrictId.parse("dst_northfield");
const ADMIN = PrincipalId.parse("prn_nf-district-admin");
const ISSUER = "https://canvas.northfield.example";
const CONFIG_URL = `${ISSUER}/api/lti/security/openid-configuration`;
const REGISTRATION_ENDPOINT = `${ISSUER}/api/lti/registrations`;
const REGISTRATION_TOKEN = "one-time-platform-token";

const openIdConfiguration = (overrides: Record<string, unknown> = {}) => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/api/lti/authorize_redirect`,
  token_endpoint: `${ISSUER}/login/oauth2/token`,
  jwks_uri: `${ISSUER}/api/lti/security/jwks`,
  registration_endpoint: REGISTRATION_ENDPOINT,
  scopes_supported: ["openid", "https://purl.imsglobal.org/spec/lti-ags/scope/score", "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly"],
  "https://purl.imsglobal.org/spec/lti-platform-configuration": { product_family_code: "canvas", version: "cloud" },
  id_token_signing_alg_values_supported: ["RS256"],
  ...overrides,
});

const toolRegistration = (overrides: Record<string, unknown> = {}) => ({
  client_id: "10000000000077",
  client_name: "EducateOS",
  "https://purl.imsglobal.org/spec/lti-tool-configuration": { deployment_id: "nf-canvas-deploy-77", domain: "educateos.example" },
  ...overrides,
});

interface Answers {
  config?: () => Response;
  register?: () => Response;
}

function createRegistration(answers: Answers = {}) {
  const clock = { ms: Date.UTC(2026, 9, 21, 9, 0, 0) };
  const now = () => clock.ms;
  const requests: Request[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    expect(init?.redirect).toBe("manual");
    if (request.url === CONFIG_URL) return answers.config?.() ?? Response.json(openIdConfiguration());
    if (request.url === REGISTRATION_ENDPOINT) return answers.register?.() ?? Response.json(toolRegistration());
    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
  const invitations = new InMemorySingleUseStore<RegistrationInvitation>(now);
  const pending = new InMemoryPendingRegistrationStore();
  const registration = new DynamicRegistration({ toolOrigin: TOOL, toolName: "EducateOS", invitations, pending, fetch, now });
  const open = async (url: string, extra: Record<string, string> = { openid_configuration: CONFIG_URL, registration_token: REGISTRATION_TOKEN }) => {
    const target = new URL(url);
    for (const [name, value] of Object.entries(extra)) target.searchParams.set(name, value);
    return registration.handle(new Request(target));
  };
  return { clock, requests, pending, registration, open };
}

describe("LTI dynamic registration (SCHO-59)", () => {
  it("registers with an invited platform and records a pending registration for the district", async () => {
    const world = createRegistration();
    const { url, expiresAt } = await world.registration.issueInvitation(NF, ADMIN);
    expect(new URL(url).pathname).toBe("/lti/register");
    expect(Date.parse(expiresAt) - world.clock.ms).toBe(REGISTRATION_INVITATION_TTL_MS);

    const response = await world.open(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(`script-src ${REGISTRATION_CLOSE_SCRIPT_HASH}`);
    expect(await response.text()).toContain(REGISTRATION_CLOSE_SCRIPT);

    const [pending, ...others] = await world.pending.list();
    expect(others).toEqual([]);
    expect(pending).toMatchObject({
      districtId: NF,
      issuer: ISSUER,
      clientId: "10000000000077",
      deploymentId: "nf-canvas-deploy-77",
      authLoginUrl: `${ISSUER}/api/lti/authorize_redirect`,
      authTokenUrl: `${ISSUER}/login/oauth2/token`,
      jwksUrl: `${ISSUER}/api/lti/security/jwks`,
      productFamily: "canvas",
      invitedBy: ADMIN,
    });
    expect(pending!.id).toMatch(/^lpr_/);

    // The tool asked only for `iss` and `sub`, anonymously, with the platform's one-time token.
    const register = world.requests.find((request) => request.url === REGISTRATION_ENDPOINT)!;
    expect(register.method).toBe("POST");
    expect(register.headers.get("authorization")).toBe(`Bearer ${REGISTRATION_TOKEN}`);
    const body = await register.json() as Record<string, any>;
    expect(body).toMatchObject({
      response_types: ["id_token"],
      initiate_login_uri: `${TOOL}/lti/login`,
      redirect_uris: [`${TOOL}/lti/launch`],
      jwks_uri: `${TOOL}/lti/jwks`,
      token_endpoint_auth_method: "private_key_jwt",
    });
    const toolConfig = body["https://purl.imsglobal.org/spec/lti-tool-configuration"];
    expect(toolConfig.claims).toEqual(["iss", "sub"]);
    expect(toolConfig["https://canvas.instructure.com/lti/privacy_level"]).toBe("anonymous");
    // Each message names its placements, so Canvas does not default the resource link to
    // `link_selection` and shadow Deep Linking there.
    expect(toolConfig.messages).toEqual([
      { type: "LtiResourceLinkRequest", target_link_uri: `${TOOL}/lti/launch`, placements: ["course_navigation"] },
      {
        type: "LtiDeepLinkingRequest",
        target_link_uri: `${TOOL}/lti/launch`,
        placements: ["link_selection", "assignment_selection", "editor_button"],
      },
    ]);
    // Only scopes the platform says it supports are requested.
    expect(body.scope.split(" ").toSorted()).toEqual([
      "https://purl.imsglobal.org/spec/lti-ags/scope/score",
      "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
    ]);
  });

  it("admits the completion script by a hash that matches it", () => {
    const digest = createHash("sha256").update(REGISTRATION_CLOSE_SCRIPT).digest("base64");
    expect(REGISTRATION_CLOSE_SCRIPT_HASH).toBe(`'sha256-${digest}'`);
  });

  it("refuses an unknown, reused or expired invitation before contacting any platform", async () => {
    const world = createRegistration();
    expect(await rejection(world.open(`${TOOL}/lti/register?invitation=${"a".repeat(43)}`))).toBe("unauthenticated");

    const once = await world.registration.issueInvitation(NF, ADMIN);
    await world.open(once.url);
    const fetched = world.requests.length;
    expect(await rejection(world.open(once.url))).toBe("unauthenticated");

    const late = await world.registration.issueInvitation(NF, ADMIN);
    world.clock.ms += REGISTRATION_INVITATION_TTL_MS + 1;
    expect(await rejection(world.open(late.url))).toBe("unauthenticated");
    expect(world.requests.length).toBe(fetched);
    expect(await world.pending.list()).toHaveLength(1);
  });

  it("requires a client ID from the platform, and refuses an empty deployment ID", async () => {
    for (const answer of [
      toolRegistration({ "https://purl.imsglobal.org/spec/lti-tool-configuration": { deployment_id: "" } }),
      toolRegistration({ deployment_id: "" }),
      toolRegistration({ client_id: "" }),
      { deployment_id: "nf-canvas-deploy-77" },
    ]) {
      const world = createRegistration({ register: () => Response.json(answer) });
      const { url } = await world.registration.issueInvitation(NF, ADMIN);
      expect(await rejection(world.open(url))).toBe("validation-failed");
      expect(await world.pending.list()).toEqual([]);
    }
  });

  it("takes Canvas's top-level deployment ID, and waits for the administrator's when the platform created none", async () => {
    const canvas = createRegistration({ register: () => Response.json({ client_id: "10000000000077", deployment_id: "1:canvas-deploy" }) });
    await canvas.open((await canvas.registration.issueInvitation(NF, ADMIN)).url);
    expect((await canvas.pending.list())[0]).toMatchObject({ deploymentId: "1:canvas-deploy" });

    const later = createRegistration({ register: () => Response.json({ client_id: "10000000000077" }) });
    await later.open((await later.registration.issueInvitation(NF, ADMIN)).url);
    const [pending] = await later.pending.list();
    expect(pending!.deploymentId).toBeUndefined();
    const offerings = [{ contextId: "c1", offeringId: OfferingId.parse("off_nf-bio-fall-p2") }];
    expect(() => approvedRegistration(pending!, { provider: "canvas", offerings })).toThrow(/no deployment/);
    expect(approvedRegistration(pending!, { provider: "canvas", offerings, deploymentIds: ["2:installed"] }).deploymentIds).toEqual(["2:installed"]);
  });

  it("refuses a configuration with a non-https endpoint, and a non-https configuration URL without fetching it", async () => {
    const world = createRegistration({ config: () => Response.json(openIdConfiguration({ jwks_uri: "http://canvas.northfield.example/jwks" })) });
    const { url } = await world.registration.issueInvitation(NF, ADMIN);
    expect(await rejection(world.open(url))).toBe("validation-failed");
    expect(world.requests.some((request) => request.url === REGISTRATION_ENDPOINT)).toBe(false);

    const plain = createRegistration();
    const invited = await plain.registration.issueInvitation(NF, ADMIN);
    expect(await rejection(plain.open(invited.url, { openid_configuration: "http://canvas.northfield.example/config" }))).toBe("validation-failed");
    expect(plain.requests).toEqual([]);
  });

  it("never follows a redirect and never repeats the platform's error body", async () => {
    const redirected = createRegistration({ config: () => new Response(null, { status: 302, headers: { location: "https://attacker.example/config" } }) });
    const first = await redirected.registration.issueInvitation(NF, ADMIN);
    expect(await rejection(redirected.open(first.url))).toBe("unavailable");
    expect(redirected.requests.map((request) => request.url)).toEqual([CONFIG_URL]);

    const failing = createRegistration({ register: () => new Response(`bad token ${REGISTRATION_TOKEN}`, { status: 400 }) });
    const second = await failing.registration.issueInvitation(NF, ADMIN);
    await expect(failing.open(second.url)).rejects.toSatisfy((err: Error) => !err.message.includes(REGISTRATION_TOKEN));
  });

  it("is served by the LTI handler only when configured", async () => {
    const world = await createWorld();
    const without = await world.handler(new Request(`${TOOL}/lti/register?invitation=x`));
    expect(without).toBeUndefined();

    const registration = createRegistration();
    const handler = createLtiHandler({
      broker: world.broker,
      onResourceLinkLaunch: async () => new Response(null),
      onDeepLinkingRequest: async () => new Response(null),
      selectActivities: async () => [],
      dynamicRegistration: registration.registration,
    });
    const { url } = await registration.registration.issueInvitation(NF, ADMIN);
    const target = new URL(url);
    target.searchParams.set("openid_configuration", CONFIG_URL);
    expect((await handler(new Request(target)))!.status).toBe(200);
    expect((await handler(new Request(target)))!.status).toBe(401);
  });

  it("launches nothing until approved, and approval sets the offering mappings", async () => {
    const world = await createWorld();
    const registration = createRegistration();
    const { url } = await registration.registration.issueInvitation(NF, ADMIN);
    await registration.open(url);
    const [pending] = await registration.pending.list();

    // The broker reads only approved registrations, so the pending one cannot even start a login.
    expect(
      await rejection(world.broker.login({ iss: pending!.issuer, client_id: pending!.clientId, login_hint: "h", target_link_uri: `${TOOL}/lti/launch` })),
    ).toBe("unauthenticated");

    const bio = OfferingId.parse("off_nf-bio-fall-p2");
    expect(() => approvedRegistration(pending!, { provider: "canvas", offerings: [] })).toThrow();
    expect(() => approvedRegistration(pending!, { provider: "Canvas Cloud", offerings: [{ contextId: "c1", offeringId: bio }] })).toThrow();
    expect(() => approvedRegistration(pending!, { provider: "canvas", offerings: [{ contextId: "c1", offeringId: bio }], extra: true } as never)).toThrow();
    expect(approvedRegistration(pending!, { provider: "canvas", offerings: [{ contextId: "c1", offeringId: bio }] })).toEqual({
      districtId: NF,
      provider: "canvas",
      issuer: ISSUER,
      clientId: "10000000000077",
      deploymentIds: ["nf-canvas-deploy-77"],
      authLoginUrl: pending!.authLoginUrl,
      authTokenUrl: pending!.authTokenUrl,
      jwksUrl: pending!.jwksUrl,
      offerings: [{ contextId: "c1", offeringId: bio }],
      activityLinks: [],
    });
  });
});
