import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet } from "jose";
import { describe, expect, it } from "vitest";
import { SAMPLE_DISTRICT, routeFetch } from "../src/index.ts";
import { CleverDataFake } from "../src/clever/index.ts";
import { OIDC_PRESETS, OidcFake, googleSubjectId, rebasePreset, type OidcFakeOptions, type OidcPresetName } from "../src/oidc/index.ts";
import { generatePlatformKey } from "../src/lti/keys.ts";

const CLIENT = { clientId: "educateos-test", clientSecret: "s3cret-value", redirectUris: ["https://app.maplewood.example/auth/callback"] };
const REDIRECT = CLIENT.redirectUris[0]!;

function setup(preset: OidcPresetName, options: Partial<OidcFakeOptions> = {}) {
  let clock = Date.parse("2026-10-20T12:00:00Z");
  const fake = new OidcFake({ seed: SAMPLE_DISTRICT, preset, clients: [CLIENT], now: () => clock, ...options });
  const fetch = routeFetch(Object.fromEntries(fake.origins.map((origin) => [origin, fake])));
  return { fake, fetch, tick: (ms: number) => (clock += ms), nowSeconds: () => Math.floor(clock / 1000) };
}

type Setup = ReturnType<typeof setup>;

async function discover({ fetch, fake }: Setup) {
  return (await (await fetch(fake.discoveryUrl)).json()) as Record<string, string>;
}

async function authorize(s: Setup, params: Record<string, string>) {
  const config = await discover(s);
  const url = new URL(config["authorization_endpoint"]!);
  const defaults = { client_id: CLIENT.clientId, redirect_uri: REDIRECT, response_type: "code", scope: "openid email profile", state: "st-1", nonce: "n-1" };
  for (const [k, v] of Object.entries({ ...defaults, ...params })) if (v !== "") url.searchParams.set(k, v);
  return s.fetch(url, { redirect: "manual" });
}

async function codeFrom(response: Response) {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  return { code: location.searchParams.get("code"), state: location.searchParams.get("state"), location };
}

async function exchange(s: Setup, code: string, extra: Record<string, string> = {}, auth: "basic" | "post" = "basic") {
  const config = await discover(s);
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, ...extra });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (auth === "basic") headers["authorization"] = `Basic ${btoa(`${CLIENT.clientId}:${CLIENT.clientSecret}`)}`;
  else {
    form.set("client_id", CLIENT.clientId);
    form.set("client_secret", CLIENT.clientSecret);
  }
  return s.fetch(config["token_endpoint"]!, { method: "POST", headers, body: form });
}

async function verify(s: Setup, idToken: string) {
  const config = await discover(s);
  const jwks = (await (await s.fetch(config["jwks_uri"]!)).json()) as JSONWebKeySet;
  return jwtVerify(idToken, createLocalJWKSet(jwks), { issuer: config["issuer"], audience: CLIENT.clientId, currentDate: new Date(s.nowSeconds() * 1000) });
}

async function pkce() {
  const verifier = "v".repeat(20) + crypto.randomUUID().replaceAll("-", "");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return { verifier, challenge };
}

describe.each(["clever", "classlink", "google"] as const)("OIDC fake, %s preset", (name) => {
  it("publishes the vendor's discovery document", async () => {
    const s = setup(name);
    const config = await discover(s);
    const preset = OIDC_PRESETS[name];
    expect(config).toMatchObject({
      issuer: preset.issuer,
      authorization_endpoint: preset.authorizationEndpoint,
      token_endpoint: preset.tokenEndpoint,
      jwks_uri: preset.jwksUri,
      userinfo_endpoint: preset.userinfoEndpoint,
      id_token_signing_alg_values_supported: ["RS256"],
    });
    expect(config["token_endpoint_auth_methods_supported"]).toEqual(expect.arrayContaining(["client_secret_basic", "client_secret_post"]));
  });

  it("runs a full code flow with PKCE, and the id_token verifies against the served JWKS", async () => {
    const s = setup(name);
    const { verifier, challenge } = await pkce();
    const { code, state, location } = await codeFrom(await authorize(s, { login_hint: "mw-s-01", code_challenge: challenge, code_challenge_method: "S256" }));
    expect(state).toBe("st-1");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    const response = await exchange(s, code!, { code_verifier: verifier });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const tokens = (await response.json()) as { access_token: string; id_token: string; token_type: string };
    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    const { payload, protectedHeader } = await verify(s, tokens.id_token);
    expect(protectedHeader).toMatchObject({ alg: "RS256", kid: s.fake.kid });
    expect(payload).toMatchObject({ iss: OIDC_PRESETS[name].issuer, aud: CLIENT.clientId, sub: s.fake.subjectOf("mw-s-01"), nonce: "n-1" });
    expect(payload.exp! - payload.iat!).toBe(3600);

    const userinfo = await s.fetch((await discover(s))["userinfo_endpoint"]!, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(userinfo.status).toBe(200);
    const info = (await userinfo.json()) as Record<string, unknown>;
    if (name === "clever") {
      expect(payload).toMatchObject({ user_type: "student", user_id: payload.sub, multi_role_user_id: payload.sub, district: expect.stringMatching(/^[0-9a-f]{24}$/), email_verified: false });
      expect(info).toMatchObject({ sub: payload.sub, user_type: "student", district_id: payload["district"], district: payload["district"], authorized_by: "district", name: { first: "Ada", last: "Brightwater" } });
    } else if (name === "classlink") {
      expect(payload).toMatchObject({ classLink_role: "Student", classLink_sourcedId: "mw-s-01", classLink_org_sourcedids: "mw-hs", preferred_username: "ada.brightwater" });
      expect(info).toMatchObject({ UserId: Number(payload.sub), SourcedId: "mw-s-01", Role: "Student", Email: "ada.brightwater@maplewood.example" });
    } else {
      expect(payload).toMatchObject({ hd: "maplewood.example", email: "ada.brightwater@maplewood.example", email_verified: true, azp: CLIENT.clientId, at_hash: expect.any(String) });
      expect(payload.sub).toBe(googleSubjectId(SAMPLE_DISTRICT, "mw-s-01"));
      expect(payload.sub).toMatch(/^[1-9]\d{20}$/);
      expect(info).toMatchObject({ sub: payload.sub, hd: "maplewood.example", email_verified: true });
      expect(location.searchParams.get("iss")).toBe("https://accounts.google.com");
    }
  });

  it("authenticates clients by client_secret_post too, and refuses a bad secret with invalid_client", async () => {
    const s = setup(name);
    const { code } = await codeFrom(await authorize(s, { login_hint: "ada.brightwater@maplewood.example" }));
    expect((await exchange(s, code!, {}, "post")).status).toBe(200);
    const { code: second } = await codeFrom(await authorize(s, { login_hint: "mw-t-okafor" }));
    const config = await discover(s);
    const bad = await s.fetch(config["token_endpoint"]!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`${CLIENT.clientId}:wrong`)}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code: second!, redirect_uri: REDIRECT }),
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toMatch(/^Basic/);
    expect(await bad.json()).toMatchObject({ error: "invalid_client" });
  });

  it("refuses a wrong PKCE verifier, a reused code (revoking its tokens) and an expired code", async () => {
    const s = setup(name);
    const { challenge } = await pkce();
    const { code: withPkce } = await codeFrom(await authorize(s, { login_hint: "mw-s-01", code_challenge: challenge, code_challenge_method: "S256" }));
    const wrong = await exchange(s, withPkce!, { code_verifier: "w".repeat(43) });
    expect([wrong.status, ((await wrong.json()) as { error: string }).error]).toEqual([400, "invalid_grant"]);
    expect((await exchange(s, withPkce!)).status).toBe(400);

    const { code } = await codeFrom(await authorize(s, { login_hint: "mw-s-02" }));
    const first = (await (await exchange(s, code!)).json()) as { access_token: string };
    const reuse = await exchange(s, code!);
    expect([reuse.status, ((await reuse.json()) as { error: string }).error]).toEqual([400, "invalid_grant"]);
    const userinfo = await s.fetch((await discover(s))["userinfo_endpoint"]!, { headers: { authorization: `Bearer ${first.access_token}` } });
    expect(userinfo.status).toBe(401);
    expect(userinfo.headers.get("www-authenticate")).toContain("invalid_token");

    const { code: late } = await codeFrom(await authorize(s, { login_hint: "mw-s-03" }));
    s.tick(OIDC_PRESETS[name].codeLifetimeSeconds * 1000 + 1);
    expect(((await (await exchange(s, late!)).json()) as { error: string }).error).toBe("invalid_grant");

    const { code: elsewhere } = await codeFrom(await authorize(s, { login_hint: "mw-s-04" }));
    expect((await exchange(s, elsewhere!, { redirect_uri: "https://app.maplewood.example/other" })).status).toBe(400);
  });

  it("redeems a PKCE code once even when two exchanges race", async () => {
    const s = setup(name);
    const { verifier, challenge } = await pkce();
    const { code } = await codeFrom(await authorize(s, { login_hint: "mw-s-05", code_challenge: challenge, code_challenge_method: "S256" }));
    const statuses = (await Promise.all([1, 2].map(() => exchange(s, code!, { code_verifier: verifier })))).map((r) => r.status);
    expect(statuses.toSorted()).toEqual([200, 400]);
  });

  it("validates the authorization request as RFC 6749 §4.1.2.1 says", async () => {
    const s = setup(name);
    const unknownClient = await authorize(s, { client_id: "nobody", login_hint: "mw-s-01" });
    expect(unknownClient.status).toBe(400);
    expect(await unknownClient.json()).toMatchObject({ error: "invalid_client" });
    const badRedirect = await authorize(s, { redirect_uri: "https://evil.example/cb", login_hint: "mw-s-01" });
    expect(badRedirect.status).toBe(400);
    const redirected = async (params: Record<string, string>) => (await codeFrom(await authorize(s, params))).location.searchParams;
    expect((await redirected({ response_type: "token", login_hint: "mw-s-01" })).get("error")).toBe("unsupported_response_type");
    const noOpenid = await redirected({ scope: "email", login_hint: "mw-s-01" });
    expect([noOpenid.get("error"), noOpenid.get("state")]).toEqual(["invalid_scope", "st-1"]);
    expect((await redirected({ code_challenge: "x".repeat(43), code_challenge_method: "S512", login_hint: "mw-s-01" })).get("error")).toBe("invalid_request");
    expect((await redirected({})).get("error")).toBe("login_required");
    expect((await redirected({ login_hint: "nobody@maplewood.example" })).get("error")).toBe("access_denied");
  });

  it("chooses the user with selectUser when given", async () => {
    const s = setup(name, { selectUser: () => "mw-t-quill" });
    const { code } = await codeFrom(await authorize(s, {}));
    const { id_token } = (await (await exchange(s, code!)).json()) as { id_token: string };
    expect(decodeJwt(id_token).sub).toBe(s.fake.subjectOf("mw-t-quill"));
  });

  it("serves outages, rate limits and network errors", async () => {
    const s = setup(name);
    s.fake.inject({ kind: "outage", times: 1 });
    const down = await s.fetch(s.fake.discoveryUrl);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ error: "temporarily_unavailable" });
    s.fake.inject({ kind: "rate-limit", retryAfterSeconds: 12, times: 1 });
    const limited = await s.fetch(s.fake.discoveryUrl);
    expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "12"]);
    s.fake.inject({ kind: "network-error", times: 1 });
    await expect(s.fetch(s.fake.discoveryUrl)).rejects.toThrow(TypeError);
    expect((await s.fetch(s.fake.discoveryUrl)).status).toBe(200);
  });

  it("breaks the next id_token's claims the vendor's way on a malformed-record fault", async () => {
    const s = setup(name);
    s.fake.inject({ kind: "malformed-record", times: 1, match: { path: new URL(OIDC_PRESETS[name].tokenEndpoint).pathname } });
    const { code } = await codeFrom(await authorize(s, { login_hint: "mw-s-01" }));
    const { id_token } = (await (await exchange(s, code!)).json()) as { id_token: string };
    const { payload } = await verify(s, id_token);
    if (name === "clever") expect(payload["district"]).toBeUndefined();
    else if (name === "classlink") expect(payload["classLink_sourcedId"]).toBeUndefined();
    else expect(payload["email_verified"]).toBe("true");
  });

  it("refuses sign-in to students a large removal took out", async () => {
    const s = setup(name);
    s.fake.inject({ kind: "large-removal", fraction: 0.3 });
    const gone = await codeFrom(await authorize(s, { login_hint: "mw-s-01" }));
    expect(gone.location.searchParams.get("error")).toBe("access_denied");
    expect((await codeFrom(await authorize(s, { login_hint: "mw-s-04" }))).code).toBeTruthy();
  });

  it("stops honouring a removed student's token at userinfo, and their pending code", async () => {
    const s = setup(name);
    const { code } = await codeFrom(await authorize(s, { login_hint: "mw-s-01" }));
    const { code: pending } = await codeFrom(await authorize(s, { login_hint: "mw-s-01", state: "st-2" }));
    const { access_token: token } = (await (await exchange(s, code!)).json()) as { access_token: string };
    const config = await discover(s);
    const userinfo = () => s.fetch(config["userinfo_endpoint"]!, { headers: { authorization: `Bearer ${token}` } });
    expect((await userinfo()).status).toBe(200);
    expect(s.fake.accessGrant(token)).toMatchObject({ personId: "mw-s-01", clientId: CLIENT.clientId });
    s.fake.inject({ kind: "large-removal", fraction: 0.3 });
    expect((await userinfo()).status).toBe(401);
    expect(s.fake.accessGrant(token)).toBeUndefined();
    expect(await (await exchange(s, pending!)).json()).toMatchObject({ error: "invalid_grant" });
  });

  it("serves the same flow rebased under a path, and signs with a key it is given", async () => {
    const base = `https://fakes.example/maplewood/${name}`;
    const key = await generatePlatformKey();
    const s = setup(name, { preset: rebasePreset(OIDC_PRESETS[name], base), signingKey: key });
    const config = await discover(s);
    expect(s.fake.discoveryUrl).toBe(`${base}/.well-known/openid-configuration`);
    expect(config["issuer"]).toBe(base);
    for (const endpoint of ["authorization_endpoint", "token_endpoint", "jwks_uri", "userinfo_endpoint"]) expect(config[endpoint]!.startsWith(`${base}/`)).toBe(true);
    const { code } = await codeFrom(await authorize(s, { login_hint: "mw-s-02" }));
    const { id_token: idToken } = (await (await exchange(s, code!)).json()) as { id_token: string };
    const { protectedHeader, payload } = await verify(s, idToken);
    expect(protectedHeader.kid).toBe(key.kid);
    expect(payload.iss).toBe(base);
  });
});

describe("OIDC fake, pending codes", () => {
  it("forgets the oldest codes past its cap", async () => {
    const s = setup("clever", { maxPendingCodes: 3 });
    const codes: string[] = [];
    for (let i = 0; i < 4; i++) codes.push((await codeFrom(await authorize(s, { login_hint: "mw-s-02", state: `st-${i}` }))).code!);
    expect(await (await exchange(s, codes[0]!)).json()).toMatchObject({ error: "invalid_grant" });
    expect((await exchange(s, codes[3]!)).status).toBe(200);
  });
});

describe("OIDC fake, accepted scopes", () => {
  it("grants a preset's accepted scopes beyond scopes_supported, and still refuses unknown ones", async () => {
    const extra = "https://www.googleapis.com/auth/classroom.courses.readonly";
    const s = setup("google", { preset: { ...OIDC_PRESETS.google, acceptedScopes: [extra] } });
    const { code } = await codeFrom(await authorize(s, { login_hint: "mw-t-okafor", scope: `openid email ${extra}` }));
    const { access_token: token } = (await (await exchange(s, code!)).json()) as { access_token: string };
    expect(s.fake.accessGrant(token)?.scopes).toContain(extra);
    const refused = await codeFrom(await authorize(s, { login_hint: "mw-t-okafor", scope: "openid https://www.googleapis.com/auth/drive" }));
    expect(refused.location.searchParams.get("error")).toBe("invalid_scope");
  });
});

describe("OIDC fake, Clever specifics", () => {
  it("signs in the same user ID the Clever Data API fake lists, with a distinct legacy user_id for teachers", async () => {
    const s = setup("clever");
    const data = new CleverDataFake({ seed: SAMPLE_DISTRICT });
    const { code } = await codeFrom(await authorize(s, { login_hint: "mw-t-okafor" }));
    const { id_token } = (await (await exchange(s, code!)).json()) as { id_token: string };
    const claims = decodeJwt(id_token);
    expect(claims.sub).toBe(data.userId("mw-t-okafor"));
    expect(claims["district"]).toBe(data.districtId);
    expect(claims["user_type"]).toBe("teacher");
    const user = data.record("users", claims.sub!)!;
    expect(claims["user_id"]).toBe((user["roles"] as Record<string, { legacy_id: string }>)["teacher"]!.legacy_id);
    expect(claims["user_id"]).not.toBe(claims.sub);
  });

  it("takes a JSON token request, as Clever documents, and refuses multipart", async () => {
    const s = setup("clever");
    const { code } = await codeFrom(await authorize(s, { login_hint: "mw-s-01" }));
    const json = await s.fetch("https://clever.com/oauth/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${btoa(`${CLIENT.clientId}:${CLIENT.clientSecret}`)}` },
      body: JSON.stringify({ code, grant_type: "authorization_code", redirect_uri: REDIRECT }),
    });
    expect(json.status).toBe(200);
    const form = new FormData();
    form.set("code", "x");
    const multipart = await s.fetch("https://clever.com/oauth/tokens", { method: "POST", body: form });
    expect(await multipart.json()).toMatchObject({ error: "invalid_request", error_description: "invalid content-type" });
    const reuse = await exchange(s, code!);
    expect(await reuse.json()).toEqual({ error: "invalid_grant", error_description: "Invalid grant: invalid code" });
  });

  it("issues access tokens that last 24 hours", async () => {
    const s = setup("clever");
    const { code } = await codeFrom(await authorize(s, { login_hint: "mw-s-01" }));
    const { access_token } = (await (await exchange(s, code!)).json()) as { access_token: string };
    const userinfo = () => s.fetch("https://api.clever.com/userinfo", { headers: { authorization: `Bearer ${access_token}` } });
    s.tick(23 * 3600 * 1000);
    expect((await userinfo()).status).toBe(200);
    s.tick(3600 * 1000);
    expect((await userinfo()).status).toBe(401);
  });
});
