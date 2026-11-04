// SCHO-331: a district imports the committed reference course bundle through its own Worker,
// verified against the educateos.io key its COURSE_LIBRARY_TRUST var pins, keeps it in the
// Durable Object's SQLite across a restart, and a teacher installs it into a class from there:
// the library's copy, not the bundle, is what the install reads.

import { env, evictDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { ROUTES, routePath, type RouteInput, type RouteName } from "@educateos/district-app/routes";
import bundle from "../../../curriculum/bundles/educateos.io/grade-1-reading-foundations/1.0.0.json" with { type: "json" };
import { readCourseLibraryTrust } from "../src/district.ts";
import { ACCESS_AUDIENCE, ACCESS_ISSUER } from "./fixtures.ts";

const ADMIN = "prn_nf-district-admin";
const RIVERA = "prn_nf-teacher-rivera";
const ENG9 = "off_nf-eng9-fall-p3";
const COURSE = { packageId: "educateos.io/grade-1-reading-foundations", version: "1.0.0" };

async function signIn(principalId: string): Promise<string> {
  const subject = NORTHFIELD.principals.find((p) => p.id === principalId)!.externalIdentities[0]!.subject;
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: subject, iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .sign(key);
}

/** Calls a route through the Worker, reading the whole body so nothing stays open in the object. */
async function call<N extends RouteName>(principalId: string, name: N, input: RouteInput<N> = {} as RouteInput<N>): Promise<{ status: number; body: any }> {
  const spec = ROUTES[name];
  const parts = input as { params?: Record<string, string>; body?: unknown };
  const response = await SELF.fetch(new Request(new URL(routePath(spec.path, parts.params), "https://district.example"), {
    method: spec.method,
    headers: { "content-type": "application/json", "cf-access-jwt-assertion": await signIn(principalId) },
    ...(spec.method === "POST" ? { body: JSON.stringify(parts.body ?? {}) } : {}),
  }));
  return { status: response.status, body: await response.json() };
}

const district = () => env.DISTRICT.getByName(NORTHFIELD.district.id);
const restart = () => evictDurableObject(district());

describe("course library (SCHO-331)", () => {
  it("imports the signed reference course, keeps it across a restart, and installs it into a class in batches", async () => {
    const imported = await call(ADMIN, "admin.importCourseBundle", { body: bundle as never });
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ ...COURSE, publisher: { domain: "educateos.io", signed: true }, activities: 22 });

    await restart();
    expect((await call(ADMIN, "admin.listLibraryCourses")).body).toStrictEqual([imported.body]);
    const again = await call(ADMIN, "admin.importCourseBundle", { body: bundle as never });
    expect(again.body).toStrictEqual(imported.body);

    // Until the district approves the course's standards, the install is refused and writes nothing.
    const params = { offeringId: ENG9 };
    expect((await call(RIVERA, "teacher.previewCourseInstall", { params, body: COURSE })).body.problems).toHaveLength(1);
    expect((await call(RIVERA, "teacher.installCourse", { params, body: COURSE })).status).toBe(400);
    expect((await call(RIVERA, "teacher.listModules", { params })).body.outline.modules).toStrictEqual([]);
    await district().approveCatalogSeed(ADMIN);

    const first = await call(RIVERA, "teacher.installCourse", { params, body: { ...COURSE, maxUnits: 3 } });
    expect(first.status).toBe(200);
    expect(first.body.units.map((unit: { status: string }) => unit.status)).toStrictEqual(["installed", "installed", "installed", "new", "new", "new"]);

    // The install record lives in the object's storage too: a restart resumes it.
    await restart();
    const rest = await call(RIVERA, "teacher.installCourse", { params, body: COURSE });
    expect(rest.body.done).toBe(true);
    const { body: { outline } } = await call(RIVERA, "teacher.listModules", { params });
    expect(outline.modules).toHaveLength(6);
    expect(outline.modules[0].source).toMatchObject({ kind: "course", ...COURSE });
    expect(outline.modules.flatMap((module: { items: { kind: string }[] }) => module.items).filter((item: { kind: string }) => item.kind === "teacher-note")).toHaveLength(12);
    expect((await call(RIVERA, "teacher.listAssignments", { params })).body).toHaveLength(22);
    const [offered] = (await call(RIVERA, "teacher.libraryCourses", { params })).body;
    expect(offered.installed).toStrictEqual({ version: "1.0.0", done: true });
  });

  it("refuses a bundle whose course was altered after signing", async () => {
    const tampered = structuredClone(bundle) as unknown as { packages: { files: Record<string, string> }[] };
    tampered.packages[0]!.files["ocs.json"] = tampered.packages[0]!.files["ocs.json"]!.replace("Grade 1 Reading Foundations", "Grade 1 Reading");
    const refused = await call(ADMIN, "admin.importCourseBundle", { body: tampered as never });
    expect(refused.status).toBe(400);
  });
});

describe("readCourseLibraryTrust", () => {
  it("reads a pin, treats unset as none, and refuses anything malformed without quoting it", () => {
    expect(readCourseLibraryTrust(undefined)).toBeUndefined();
    expect(readCourseLibraryTrust("")).toBeUndefined();
    expect(readCourseLibraryTrust(env.COURSE_LIBRARY_TRUST)?.publishers.map((p) => p.domain)).toStrictEqual(["educateos.io"]);
    expect(() => readCourseLibraryTrust("{not json")).toThrow("COURSE_LIBRARY_TRUST is not JSON");
    expect(() => readCourseLibraryTrust(JSON.stringify({ publishers: "secret-looking" }))).toThrow(/^COURSE_LIBRARY_TRUST is not a publisher trust$/);
  });
});
