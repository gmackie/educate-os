// The demo showcase (SCHO-326) through the deployed Worker in workerd: its routes reach the
// district's SQLite Durable Object behind the Access sign-in, only a district administrator may use
// them, and what seeding builds survives a restart of the object.
import { env, evictDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD, NORTHFIELD_SHOWCASE } from "@educateos/fixtures";
import { ACCESS_AUDIENCE, ACCESS_ISSUER } from "./fixtures.ts";
import type { ShowcaseStatus } from "../src/showcase.ts";

const district = () => env.DISTRICT.getByName(NORTHFIELD.district.id);

async function signIn(principalId: string): Promise<string> {
  const subject = NORTHFIELD.principals.find((p) => p.id === principalId)!.externalIdentities[0]!.subject;
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: subject, iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .sign(key);
}

/** Calls a showcase route through the Worker's fetch handler, reading the whole body. */
async function call(principalId: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "cf-access-jwt-assertion": await signIn(principalId) };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await SELF.fetch(`https://district.example/api/demo/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}

describe("the demo showcase through the Worker", () => {
  it("answers a district administrator only", async () => {
    expect((await call("prn_nf-district-admin", "GET", "showcase")).body).toMatchObject({ showcase: "northfield", districtId: NORTHFIELD.district.id });
    expect((await call("prn_nf-teacher-rivera", "GET", "showcase")).status).toBe(403);
    expect((await call("prn_nf-student-amara", "POST", "showcase/seed", {})).status).toBe(403);
    const unsigned = await SELF.fetch("https://district.example/api/demo/showcase");
    expect(unsigned.status).toBe(401);
    await unsigned.arrayBuffer();
  });

  it("seeds a band inside the district's object, which keeps it across a restart", async () => {
    const seeded = await call("prn_nf-district-admin", "POST", "showcase/seed", { bands: ["9-12"] });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    // Northfield already holds its own directory, so nothing is added to it.
    expect(Object.values(seeded.body.directory).every((n) => n === 0)).toBe(true);
    const courses = NORTHFIELD_SHOWCASE.courses.filter((c) => c.band === "9-12");
    expect(seeded.body.showcase.bands["9-12"]).toMatchObject({ courses: courses.length, activities: courses.flatMap((c) => c.activities).length });
    expect(seeded.body.showcase.bands["K-2"].courses).toBe(0);

    await evictDurableObject(district());
    const status: ShowcaseStatus = (await call("prn_nf-district-admin", "GET", "showcase")).body;
    expect(status.bands["9-12"].offerings.every((o) => o.assignments > 0)).toBe(true);
    expect(status.bands["K-2"].assignments).toBe(0);
  }, 180_000);
});
