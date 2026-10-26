// SCHO-203: Clever SSO claims, read from ID tokens and userinfo the Clever preset of the OIDC fake
// signs and serves, and from a verified Access token that passed Clever's claims through.
import { EducateOsError } from "@educateos/contracts";
import { OidcFake, SAMPLE_DISTRICT, cleverDistrictId, cleverUserId, routeFetch } from "@educateos/provider-fakes";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { describe, expect, it } from "vitest";
import { CLEVER_ISSUER, identityFromAccessPayload, identityFromCleverClaims, type CleverClaims } from "../src/index.ts";

const CLIENT = { clientId: "educateos-clever-test", clientSecret: "test-client-value", redirectUris: ["https://maplewood.educateos.example/callback"] };
const DISTRICT = cleverDistrictId(SAMPLE_DISTRICT);
const CONFIG = { districtId: DISTRICT };

/** Signs a seed person in through the Clever preset and returns their verified ID token claims and userinfo. */
async function signIn(personId: string, options: { malformed?: boolean } = {}) {
  const fake = new OidcFake({ seed: SAMPLE_DISTRICT, preset: "clever", clients: [CLIENT] });
  if (options.malformed === true) fake.inject({ kind: "malformed-record", times: 1 });
  const fetch = routeFetch(Object.fromEntries(fake.origins.map((origin) => [origin, fake])));
  const config = (await (await fetch(fake.discoveryUrl)).json()) as Record<string, string>;
  const authorize = new URL(config["authorization_endpoint"]!);
  for (const [k, v] of Object.entries({ client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUris[0]!, response_type: "code", scope: "openid email profile", state: "s", nonce: "n", login_hint: personId })) {
    authorize.searchParams.set(k, v);
  }
  const code = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location")!).searchParams.get("code")!;
  const tokens = (await (await fetch(config["token_endpoint"]!, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`${CLIENT.clientId}:${CLIENT.clientSecret}`)}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CLIENT.redirectUris[0]! }),
  })).json()) as { id_token: string; access_token: string };
  const jwks = (await (await fetch(config["jwks_uri"]!)).json()) as JSONWebKeySet;
  const { payload } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), { issuer: config["issuer"]!, audience: CLIENT.clientId });
  const userinfo = (await (await fetch(config["userinfo_endpoint"]!, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json()) as CleverClaims;
  return { idToken: payload as CleverClaims, userinfo };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(EducateOsError);
    return (err as EducateOsError).code;
  }
  throw new Error("expected a EducateOsError");
}

describe("identityFromCleverClaims", () => {
  it.each(["mw-s-01", "mw-t-reyes", "mw-admin-varga"])("reads %s's Clever user ID from a verified ID token and from userinfo alike", async (personId) => {
    const { idToken, userinfo } = await signIn(personId);
    const want = { issuer: CLEVER_ISSUER, subject: cleverUserId(SAMPLE_DISTRICT, personId), credential: "person" };
    // The ID token carries `district`; userinfo carries both `district` and `district_id`.
    expect(idToken["district"]).toBe(DISTRICT);
    expect(identityFromCleverClaims(idToken, CONFIG)).toEqual(want);
    expect(identityFromCleverClaims(userinfo, CONFIG)).toEqual(want);
  });

  it("names the district's own issuer when it configures one", async () => {
    const { idToken } = await signIn("mw-s-01");
    expect(identityFromCleverClaims(idToken, { ...CONFIG, issuer: "https://clever.maplewood.example" }).issuer).toBe("https://clever.maplewood.example");
  });

  it("refuses a sign-in from another Clever district", async () => {
    const { idToken } = await signIn("mw-s-01");
    expect(codeOf(() => identityFromCleverClaims(idToken, { districtId: "a".repeat(24) }))).toBe("unauthenticated");
  });

  it("refuses an ID token without a district, the way Clever claims go wrong", async () => {
    const { idToken } = await signIn("mw-s-01", { malformed: true });
    expect(idToken["district"]).toBeUndefined();
    expect(() => identityFromCleverClaims(idToken, CONFIG)).toThrow(/names no district/);
  });

  it("refuses claims whose two spellings disagree", () => {
    const user = "1".repeat(24);
    expect(() => identityFromCleverClaims({ district: DISTRICT, district_id: "b".repeat(24), sub: user }, CONFIG)).toThrow(/two different districts/);
    expect(() => identityFromCleverClaims({ district: DISTRICT, sub: user, multi_role_user_id: "2".repeat(24) }, CONFIG)).toThrow(/two different user IDs/);
  });

  it("takes a student's legacy user_id as their ID, but no one else's", () => {
    const legacy = "3".repeat(24);
    expect(identityFromCleverClaims({ district_id: DISTRICT, user_type: "student", user_id: legacy }, CONFIG).subject).toBe(legacy);
    expect(() => identityFromCleverClaims({ district_id: DISTRICT, user_type: "teacher", user_id: legacy }, CONFIG)).toThrow(/no Clever user ID/);
  });

  it("refuses a token another issuer signed", () => {
    expect(codeOf(() => identityFromCleverClaims({ iss: "https://evil.example", district: DISTRICT, sub: "4".repeat(24) }, CONFIG))).toBe("unauthenticated");
  });

  it("never reads email", () => {
    const a = identityFromCleverClaims({ district: DISTRICT, sub: "5".repeat(24), email: "family@maplewood.example" }, CONFIG);
    const b = identityFromCleverClaims({ district: DISTRICT, sub: "6".repeat(24), email: "family@maplewood.example" }, CONFIG);
    expect(a.subject).not.toBe(b.subject);
  });
});

describe("identityFromAccessPayload with Clever", () => {
  const ACCESS = "https://maplewood.cloudflareaccess.example";
  // The claims the "Clever (EducateOS demo)" Access login method passes through, as Access puts
  // them under `custom` (unverified against a live Access token; see maturity.md).
  const payload = (custom?: Record<string, unknown>) => ({ iss: ACCESS, sub: "access-uuid-shared-family", email: "family@maplewood.example", ...(custom === undefined ? {} : { custom }) });

  it("reads a Clever sign-in passed through Access as a Clever identity, not Access's sub", () => {
    const student = cleverUserId(SAMPLE_DISTRICT, "mw-s-01");
    const identity = identityFromAccessPayload(payload({ user_type: "student", district_id: DISTRICT, user_id: student }), { issuer: ACCESS, clever: CONFIG });
    expect(identity).toEqual({ issuer: CLEVER_ISSUER, subject: student, credential: "person" });
  });

  it("tells apart two people who share an email, and so an Access sub", () => {
    const config = { issuer: ACCESS, clever: CONFIG };
    const a = identityFromAccessPayload(payload({ user_type: "student", district_id: DISTRICT, user_id: cleverUserId(SAMPLE_DISTRICT, "mw-s-01") }), config);
    const b = identityFromAccessPayload(payload({ user_type: "student", district_id: DISTRICT, user_id: cleverUserId(SAMPLE_DISTRICT, "mw-s-02") }), config);
    expect(a.subject).not.toBe(b.subject);
  });

  it("refuses a person's sign-in without Clever claims rather than reading the shared Access sub", () => {
    expect(() => identityFromAccessPayload(payload(), { issuer: ACCESS, clever: CONFIG })).toThrow(/carries no Clever sign-in/);
  });

  it("still reads a service token", () => {
    const service = { iss: ACCESS, sub: "", common_name: "roster.access" };
    expect(identityFromAccessPayload(service, { issuer: ACCESS, clever: CONFIG })).toEqual({ issuer: ACCESS, subject: "service-token:roster.access", credential: "service" });
  });

  it("ignores Clever claims when the deployment does not sign in through Clever", () => {
    const identity = identityFromAccessPayload(payload({ user_type: "student", district_id: DISTRICT, user_id: "7".repeat(24) }), { issuer: ACCESS });
    expect(identity.issuer).toBe(ACCESS);
  });

  it("refuses a Clever sign-in from another district rather than falling back to Access's sub", () => {
    expect(codeOf(() => identityFromAccessPayload(payload({ user_type: "student", district_id: "c".repeat(24), user_id: "8".repeat(24) }), { issuer: ACCESS, clever: CONFIG }))).toBe("unauthenticated");
  });
});
