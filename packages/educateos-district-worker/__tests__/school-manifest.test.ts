// The public school manifest at /.well-known/educateos.json (ADR-0014, SCHO-259).
import { env, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { NORTHFIELD } from "@educateos/fixtures";
import { describe, expect, it } from "vitest";
import {
  readSchoolManifestSettings, SCHOOL_MANIFEST_PATH, SchoolManifest, schoolManifest, serveSchoolManifest,
} from "../src/school-manifest.ts";
import { ACCESS_AUDIENCE, ACCESS_ISSUER, TEST_CONFIG } from "./fixtures.ts";

const CONFIG = JSON.stringify(TEST_CONFIG);
const ORIGIN = "https://northfield.educateos.io";

/** Fetches through the deployed fetch handler, reading the body so the pool can evict. */
async function fetchWorker(input: Request): Promise<{ response: Response; body: string }> {
  const response = await SELF.fetch(input);
  return { response, body: await response.text() };
}

describe("the school manifest", () => {
  it("is served by the Worker with no sign-in, as public, cacheable JSON with CORS for everyone", async () => {
    const { response, body } = await fetchWorker(new Request(`https://district.example${SCHOOL_MANIFEST_PATH}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const manifest = SchoolManifest.parse(JSON.parse(body));
    expect(manifest).toStrictEqual({
      v: 1,
      name: NORTHFIELD.district.name,
      origin: "https://district.example",
      brand: { logo: null, accent: null },
      signIn: [],
      features: { ai: false, mobile: true, family: true },
      mobileApi: { min: 1, max: 2 },
      release: null,
    });
  });

  it("answers HEAD and a CORS preflight, and refuses other methods", async () => {
    const url = `https://district.example${SCHOOL_MANIFEST_PATH}`;
    const head = await fetchWorker(new Request(url, { method: "HEAD" }));
    expect(head.response.status).toBe(200);
    expect(head.body).toBe("");
    const preflight = await fetchWorker(new Request(url, { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Method": "GET" } }));
    expect(preflight.response.status).toBe(204);
    expect(preflight.response.headers.get("access-control-allow-origin")).toBe("*");
    const post = await fetchWorker(new Request(url, { method: "POST", body: "{}" }));
    expect(post.response.status).toBe(405);
  });

  it("names the district as its directory now does, after an administrator renames it (SCHO-344)", async () => {
    const rename = async (name: string) => {
      const admin = NORTHFIELD.principals.find((p) => p.id === "prn_nf-district-admin")!.externalIdentities[0]!.subject;
      const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
      const now = Math.floor(Date.now() / 1000);
      const assertion = await new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: admin, iat: now, exp: now + 300 })
        .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
        .sign(key);
      return fetchWorker(new Request("https://district.example/api/admin/district", {
        method: "POST",
        headers: { "cf-access-jwt-assertion": assertion, "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }));
    };
    const renamed = await rename(" Northfield Co-op ");
    expect(renamed.response.status).toBe(200);
    expect(JSON.parse(renamed.body)).toMatchObject({ id: NORTHFIELD.district.id, name: "Northfield Co-op" });
    const { body } = await fetchWorker(new Request(`https://district.example${SCHOOL_MANIFEST_PATH}`));
    expect(SchoolManifest.parse(JSON.parse(body)).name).toBe("Northfield Co-op");
    expect((await rename(NORTHFIELD.district.name)).response.status).toBe(200);
  });

  it("serves only its exact path", async () => {
    const { response } = await fetchWorker(new Request("https://district.example/.well-known/educateos.json/x"));
    expect(response.status).toBe(404);
  });

  it("takes the deployment's settings over its defaults", () => {
    const manifest = schoolManifest({
      districtConfig: CONFIG,
      requestOrigin: "https://district.schoolos.gmac.io",
      versionTag: "r000041-0000000",
      settings: JSON.stringify({
        origin: ORIGIN,
        logo: `${ORIGIN}/brand/logo.svg`,
        accent: "#2458ac",
        signIn: [{ id: "google", label: "Google" }, { id: "clever", label: "Clever" }],
        features: { ai: true, family: false },
        release: "r000042-ade9299",
      }),
    });
    expect(manifest).toStrictEqual({
      v: 1,
      name: NORTHFIELD.district.name,
      origin: ORIGIN,
      brand: { logo: `${ORIGIN}/brand/logo.svg`, accent: "#2458ac" },
      signIn: [{ id: "google", label: "Google" }, { id: "clever", label: "Clever" }],
      features: { ai: true, mobile: true, family: false },
      mobileApi: { min: 1, max: 2 },
      release: "r000042-ade9299",
    });
  });

  it("reads the release from the Worker's version tag when the settings name none", () => {
    expect(schoolManifest({ districtConfig: CONFIG, settings: undefined, requestOrigin: ORIGIN, versionTag: "r7" }).release).toBe("r7");
    expect(schoolManifest({ districtConfig: CONFIG, settings: "", requestOrigin: ORIGIN, versionTag: 7 }).release).toBeNull();
  });

  it("implies Google and Clever sign-in from the district's configuration", () => {
    const district = { ...TEST_CONFIG.directory.district, trustedIssuers: [...TEST_CONFIG.directory.district.trustedIssuers, "https://accounts.google.com", "https://clever.com"] };
    const config = JSON.stringify({
      ...TEST_CONFIG,
      directory: { ...TEST_CONFIG.directory, district },
      cleverSso: { districtId: "6650c1a0e1b2c3d4e5f6d001" },
    });
    expect(schoolManifest({ districtConfig: config, settings: undefined, requestOrigin: ORIGIN }).signIn)
      .toStrictEqual([{ id: "google", label: "Google" }, { id: "clever", label: "Clever" }]);
  });

  it("refuses invalid settings, naming the fields and not their values", () => {
    expect(() => readSchoolManifestSettings("{")).toThrow("SCHOOL_MANIFEST is not JSON");
    expect(() => readSchoolManifestSettings(JSON.stringify({ accent: "blue", origin: "https://x.example/path", extra: 1 })))
      .toThrow(/invalid at: .*accent.*origin|invalid at: .*origin.*accent/);
    expect(() => readSchoolManifestSettings(JSON.stringify({ logo: "http://x.example/logo.svg" }))).toThrow("logo");
    expect(() => readSchoolManifestSettings(JSON.stringify({ signIn: [{ id: "Google!", label: "G" }] }))).toThrow("signIn");
  });

  it("fails closed, without detail, when the configuration is invalid", async () => {
    const response = serveSchoolManifest(new Request(`${ORIGIN}${SCHOOL_MANIFEST_PATH}`), {
      districtConfig: CONFIG, settings: JSON.stringify({ accent: "secret-value" }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("secret-value");
  });

  it("matches the documented example", () => {
    // The example in docs/educateos/adr/0014-one-origin-per-district.md.
    expect(SchoolManifest.parse({
      v: 1,
      name: "Northfield Public Schools",
      origin: ORIGIN,
      brand: { logo: `${ORIGIN}/brand/logo.svg`, accent: "#2458ac" },
      signIn: [{ id: "google", label: "Google" }, { id: "clever", label: "Clever" }],
      features: { ai: true, mobile: true, family: true },
      mobileApi: { min: 1, max: 2 },
      release: "r000042-ade9299",
    })).toBeTruthy();
    expect(SchoolManifest.safeParse({ v: 2 }).success).toBe(false);
  });
});
