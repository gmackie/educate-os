// `CF_ACCESS_AUD` as a list (SCHO-218): the district's own Access application and the instance
// Workshop's. district.test.ts checks the deployed Worker against such a list end to end.
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { ACCESS_ASSERTION_HEADER, ACCESS_COOKIE, accessAudiences, accessRequestVerifier } from "../src/access.ts";

describe("the Access audiences a district accepts", () => {
  it("reads a comma-separated list, trimming entries and ignoring empty ones", () => {
    expect(accessAudiences("district-aud")).toStrictEqual(["district-aud"]);
    expect(accessAudiences(" district-aud , workshop-aud ")).toStrictEqual(["district-aud", "workshop-aud"]);
    expect(accessAudiences(",district-aud,, ,workshop-aud,")).toStrictEqual(["district-aud", "workshop-aud"]);
    expect(accessAudiences(" , ")).toStrictEqual([]);
    expect(accessAudiences(undefined)).toStrictEqual([]);
  });

  it("refuses to start without an issuer and at least one real audience", () => {
    const keys = async () => { throw new Error("unused"); };
    const issuer = "https://team.cloudflareaccess.com";
    expect(() => accessRequestVerifier({ issuer, audiences: [], keys })).toThrow("must both be configured");
    expect(() => accessRequestVerifier({ issuer, audiences: accessAudiences(" , "), keys })).toThrow("must both be configured");
    expect(() => accessRequestVerifier({ issuer, audiences: ["district-aud", " "], keys })).toThrow("must both be configured");
    expect(() => accessRequestVerifier({ issuer: "", audiences: ["district-aud"], keys })).toThrow("must both be configured");
    expect(() => accessRequestVerifier({ issuer, audiences: ["district-aud", "workshop-aud"], keys })).not.toThrow();
  });
});

// SCHO-203: a district that signs in through Clever behind Access resolves the Clever user ID.
describe("Clever sign-ins through Access", () => {
  const issuer = "https://team.cloudflareaccess.example";
  const district = "6650c1a0e1b2c3d4e5f6d001";
  const student = "6650c1a0e1b2c3d4e5f62001";

  async function signed(claims: Record<string, unknown>) {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const token = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience("district-aud")
      .setSubject("access-uuid-family").setIssuedAt().setExpirationTime("5m").sign(privateKey);
    return { keys: createLocalJWKSet({ keys: [jwk] }), request: new Request("https://district.example/api", { headers: { [ACCESS_ASSERTION_HEADER]: token } }) };
  }

  it("reads the Clever user ID when the deployment signs in through Clever", async () => {
    const { keys, request } = await signed({ custom: { user_type: "student", district_id: district, user_id: student } });
    const verify = accessRequestVerifier({ issuer, audiences: ["district-aud"], keys, clever: { districtId: district } });
    expect(await verify(request)).toStrictEqual({ issuer: "https://clever.com", subject: student, credential: "person" });
  });

  it("reads Access's sub when it does not", async () => {
    const { keys, request } = await signed({ custom: { user_type: "student", district_id: district, user_id: student } });
    const verify = accessRequestVerifier({ issuer, audiences: ["district-aud"], keys });
    expect(await verify(request)).toStrictEqual({ issuer, subject: "access-uuid-family", credential: "person" });
  });
});

// SCHO-261: /api/pair/* is an Access bypass path, so Access adds no assertion header there; the
// pairing relay's browser endpoints read the signed-in browser's Access cookie instead.
describe("the Access cookie on the pairing relay's paths", () => {
  const issuer = "https://team.cloudflareaccess.example";

  async function setup() {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const token = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience("district-aud")
      .setSubject("access-uuid-ava").setIssuedAt().setExpirationTime("5m").sign(privateKey);
    return { token, verify: accessRequestVerifier({ issuer, audiences: ["district-aud"], keys: createLocalJWKSet({ keys: [jwk] }) }) };
  }

  it("verifies the cookie under /api/pair/ when the header is absent", async () => {
    const { token, verify } = await setup();
    const request = new Request("https://district.example/api/pair/rooms", { headers: { cookie: `other=1; ${ACCESS_COOKIE}=${token}; more=2` } });
    expect(await verify(request)).toStrictEqual({ issuer, subject: "access-uuid-ava", credential: "person" });
  });

  it("ignores the cookie everywhere else, and an invalid cookie anywhere", async () => {
    const { token, verify } = await setup();
    for (const path of ["/api/me", "/api/m/me", "/api/pairing", "/connect-phone"]) {
      expect(await verify(new Request(`https://district.example${path}`, { headers: { cookie: `${ACCESS_COOKIE}=${token}` } }))).toBeUndefined();
    }
    expect(await verify(new Request("https://district.example/api/pair/rooms", { headers: { cookie: `${ACCESS_COOKIE}=${token}x` } }))).toBeUndefined();
  });
});
