// The LTI platforms at their public URLs: a tool registered through the admin surface (Schoology)
// or Dynamic Registration (Canvas), launched through the platform's OIDC endpoints, calling its
// services with a client-credentials token, and still registered after the object restarts.
import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createLocalJWKSet, decodeJwt, importJWK, jwtVerify, SignJWT, type JSONWebKeySet, type JWK } from "jose";
import { LTI_SCOPES, parseAutoSubmitForm } from "@educateos/provider-fakes";
import { seedOf } from "../src/fakes.ts";
import { ORIGIN, TOOL } from "./constants.ts";
import { admin, call } from "./helpers.ts";

const LAUNCH = `${TOOL}/lti/launch`;
const ip = { ip: "192.0.2.80" };

/** The tool's authentication request, after the platform's login initiation. */
function authRequest(endpoint: string, login: Record<string, string>): string {
  const url = new URL(endpoint);
  const params = { scope: "openid", response_type: "id_token", response_mode: "form_post", prompt: "none", client_id: login.client_id!, redirect_uri: LAUNCH, login_hint: login.login_hint!, lti_message_hint: login.lti_message_hint!, state: "st", nonce: crypto.randomUUID() };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** A client-credentials token for the tool, signed with the test tool's key. */
async function serviceToken(clientId: string, tokenEndpoint: string, scopes: string[]): Promise<string> {
  const jwk = JSON.parse(env.TEST_TOOL_PRIVATE_JWK) as JWK;
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid! })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(tokenEndpoint)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti(crypto.randomUUID())
    .sign(await importJWK(jwk, "RS256"));
  const answer = await call(tokenEndpoint, {
    ...ip,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion, scope: scopes.join(" ") }).toString(),
  });
  expect(answer.status, answer.text).toBe(200);
  return answer.json<{ access_token: string }>().access_token;
}

describe("Schoology at lakeshore", () => {
  it("launches a tool registered through the admin surface, serves NRPS to it, and keeps it across a restart", async () => {
    const registered = await admin("lakeshore/lti/schoology/tools", {
      method: "POST",
      body: JSON.stringify({ name: "EducateOS", initiateLoginUri: `${TOOL}/lti/login`, redirectUris: [LAUNCH], jwksUri: `${TOOL}/lti/jwks` }),
    });
    expect(registered.status, registered.text).toBe(201);
    const tool = registered.json<{ clientId: string; deploymentIds: string[] }>();
    expect(tool.clientId).toMatch(/^7\d{9}$/);
    const platform = (await admin("lakeshore/credentials")).json().lti.schoology;
    expect(platform).toMatchObject({ issuer: `${ORIGIN}/lakeshore/lti/schoology`, jwksUri: `${ORIGIN}/lakeshore/lti/schoology/lti-service/.well-known/jwks` });

    const seed = seedOf("lakeshore");
    const section = seed.sections.find((s) => s.studentIds.length > 0)!;
    const launched = await admin("lakeshore/lti/schoology/launches", { method: "POST", body: JSON.stringify({ clientId: tool.clientId, personId: section.studentIds[0], sectionId: section.id }) });
    expect(launched.status, launched.text).toBe(201);
    const login = launched.json<{ url: string; params: Record<string, string> }>();
    expect(login.url.startsWith(`${TOOL}/lti/login?`)).toBe(true);

    const answer = await call(authRequest(platform.authorizationEndpoint, login.params), ip);
    expect(answer.status).toBe(200);
    const form = parseAutoSubmitForm(answer.text)!;
    expect(form.action).toBe(LAUNCH);
    const jwks = (await call(platform.jwksUri, ip)).json<JSONWebKeySet>();
    const { payload } = await jwtVerify(form.fields.id_token!, createLocalJWKSet(jwks), { issuer: platform.issuer, audience: tool.clientId });
    const nrps = payload["https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice"] as { context_memberships_url: string };
    expect(nrps.context_memberships_url.startsWith(`${ORIGIN}/lakeshore/lti/schoology/`)).toBe(true);
    // The hint is spent.
    expect(parseAutoSubmitForm((await call(authRequest(platform.authorizationEndpoint, login.params), ip)).text)?.fields.error).toBe("launch_no_longer_valid");

    const bearer = await serviceToken(tool.clientId, platform.tokenEndpoint, [LTI_SCOPES.contextMembershipReadonly]);
    const members = await call(nrps.context_memberships_url, { ...ip, headers: { authorization: `Bearer ${bearer}` } });
    expect(members.status).toBe(200);
    expect(members.json<{ members: unknown[] }>().members).toHaveLength(section.teacherIds.length + section.studentIds.length);

    await evictDurableObject(env.DISTRICTS.getByName("lakeshore"));
    const after = (await admin("lakeshore/lti/schoology/tools")).json<{ tools: { clientId: string; deploymentIds: string[] }[] }>().tools;
    expect(after).toEqual([expect.objectContaining({ clientId: tool.clientId, deploymentIds: tool.deploymentIds })]);
    // The platform's key survived the restart too.
    expect((await call(platform.jwksUri, ip)).json<JSONWebKeySet>()).toEqual(jwks);
    expect((await admin("lakeshore/lti/schoology/tools", { method: "DELETE" })).status).toBe(200);
    expect((await admin("lakeshore/lti/schoology/tools")).json().tools).toEqual([]);
  });
});

describe("Canvas at northfield", () => {
  const metadata = {
    application_type: "web",
    grant_types: ["implicit", "client_credentials"],
    response_types: ["id_token"],
    initiate_login_uri: `${TOOL}/lti/login`,
    redirect_uris: [LAUNCH],
    client_name: "EducateOS",
    jwks_uri: `${TOOL}/lti/jwks`,
    token_endpoint_auth_method: "private_key_jwt",
    scope: `${LTI_SCOPES.score} ${LTI_SCOPES.contextMembershipReadonly}`,
    "https://purl.imsglobal.org/spec/lti-tool-configuration": { domain: "tool.example", target_link_uri: LAUNCH, messages: [{ type: "LtiResourceLinkRequest" }] },
  };

  it("registers a tool by Dynamic Registration once per token, launches it through the redirect hop, and keeps it across a restart", async () => {
    const started = await admin("northfield/lti/canvas/registrations", { method: "POST", body: JSON.stringify({ toolRegistrationUrl: `${TOOL}/lti/register` }) });
    expect(started.status, started.text).toBe(201);
    const { openidConfiguration, registrationToken } = started.json<{ openidConfiguration: string; registrationToken: string }>();
    expect(openidConfiguration.startsWith(`${ORIGIN}/northfield/lti/canvas/api/lti/security/openid-configuration?`)).toBe(true);
    const config = (await call(openidConfiguration, ip)).json();
    expect(config.issuer).toBe(`${ORIGIN}/northfield/lti/canvas`);
    const register = () =>
      call(config.registration_endpoint, { ...ip, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${registrationToken}` }, body: JSON.stringify(metadata) });
    const registered = await register();
    expect(registered.status, registered.text).toBe(200);
    const clientId = registered.json<{ client_id: string; deployment_id: string }>().client_id;
    expect(clientId).toMatch(/^1\d{13}$/);
    expect((await register()).status).toBe(401);

    await evictDurableObject(env.DISTRICTS.getByName("northfield"));
    expect((await admin("northfield/lti/canvas/tools")).json<{ tools: { clientId: string }[] }>().tools.map((t) => t.clientId)).toEqual([clientId]);

    const seed = seedOf("northfield");
    const section = seed.sections.find((s) => s.teacherIds.length > 0)!;
    const login = (await admin("northfield/lti/canvas/launches", { method: "POST", body: JSON.stringify({ clientId, personId: section.teacherIds[0], sectionId: section.id }) })).json<{ params: Record<string, string> }>();
    const hop = await call(authRequest(config.authorization_endpoint, login.params), ip);
    expect(hop.status).toBe(302);
    const location = hop.headers.get("location")!;
    expect(location.startsWith(`${ORIGIN}/northfield/lti/canvas/api/lti/authorize?`)).toBe(true);
    const form = parseAutoSubmitForm((await call(location, ip)).text)!;
    expect(decodeJwt(form.fields.id_token!)).toMatchObject({ iss: `${ORIGIN}/northfield/lti/canvas`, aud: clientId });
  });

  it("refuses a launch for someone outside the section, and a malformed tool", async () => {
    const seed = seedOf("northfield");
    const [first, second] = seed.sections;
    const outsider = second!.studentIds.find((id) => !first!.studentIds.includes(id) && !first!.teacherIds.includes(id))!;
    expect((await admin("northfield/lti/canvas/launches", { method: "POST", body: JSON.stringify({ personId: outsider, sectionId: first!.id }) })).status).toBe(400);
    expect((await admin("northfield/lti/canvas/tools", { method: "POST", body: JSON.stringify({ initiateLoginUri: "http://tool.example/login", redirectUris: [LAUNCH], jwksUri: `${TOOL}/jwks` }) })).status).toBe(400);
  });
});
