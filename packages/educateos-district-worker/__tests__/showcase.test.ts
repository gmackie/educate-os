// The demo showcase (SCHO-326) over a district that is not Northfield: a demo co-op with its own
// district ID and its own people and classes, as the schoolos.gmac.io district is. The showcase is
// seeded inside the district (in-memory stores here; the Worker path is in showcase-worker.test.ts),
// only adds, keeps every co-op record as it was, and links presenters' sign-ins to its personas.
import { beforeAll, describe, expect, it } from "vitest";
import { DistrictDirectorySnapshot, type VerifiedIdentity } from "@educateos/contracts";
import { createDistrictApp, inMemoryDistrictStores, PublisherTrust, type DistrictApp } from "@educateos/district-app";
import { NORTHFIELD, NORTHFIELD_GUARDIANS, NORTHFIELD_SHOWCASE, SHOWCASE_BANDS } from "@educateos/fixtures";
import {
  linkPersona,
  mergeShowcaseDirectory,
  placeholderSubject,
  showcaseEnabled,
  showcaseRecords,
  startDistrictShowcase,
  withShowcaseReadings,
  type DistrictShowcase,
  type ShowcasePersona,
  type ShowcaseStatus,
} from "../src/showcase.ts";
import publisher from "../../../curriculum/educateos.io/publisher.json" with { type: "json" };

const ISSUER = "https://team.cloudflareaccess.example";
const D = "dst_test-coop";
const ADMIN_SUB = "11111111-1111-4111-8111-111111111111";
const TEACHER_SUB = "22222222-2222-4222-8222-222222222222";
const PRESENTER = "33333333-3333-4333-8333-333333333333";

/** A co-op like schoolos.gmac.io's: its own administrator, a teacher, a class and a student. */
const COOP = DistrictDirectorySnapshot.parse({
  district: { id: D, name: "Test co-op (synthetic)", timeZone: "America/Detroit", trustedIssuers: [ISSUER] },
  schools: [{ id: "sch_coop", districtId: D, name: "Co-op", gradeBands: ["K-5"] }],
  terms: [{ id: "trm_coop", districtId: D, name: "Fall", startsOn: "2026-08-31", endsOn: "2027-01-22", state: "active" }],
  courses: [{ id: "crs_coop-art", districtId: D, title: "Art", subject: "arts", gradeBand: "3" }],
  offerings: [{ id: "off_coop-art", districtId: D, schoolId: "sch_coop", termId: "trm_coop", courseId: "crs_coop-art", sectionName: "Tuesdays" }],
  principals: [
    { id: "prn_coop-admin", districtId: D, kind: "staff", status: "active", displayName: "Co-op administrator", externalIdentities: [{ districtId: D, issuer: ISSUER, subject: ADMIN_SUB }] },
    { id: "prn_coop-teacher", districtId: D, kind: "staff", status: "active", displayName: "Co-op teacher", externalIdentities: [{ districtId: D, issuer: ISSUER, subject: TEACHER_SUB }] },
    { id: "prn_coop-kid", districtId: D, kind: "student", status: "active", displayName: "Co-op kid", externalIdentities: [{ districtId: D, issuer: ISSUER, subject: "kid-username" }] },
  ],
  enrollments: [
    { id: "enr_coop-1", districtId: D, offeringId: "off_coop-art", principalId: "prn_coop-teacher", role: "teacher", status: "active" },
    { id: "enr_coop-2", districtId: D, offeringId: "off_coop-art", principalId: "prn_coop-kid", role: "student", status: "active" },
  ],
  roleAssignments: [
    { principalId: "prn_coop-admin", role: "district-admin", scope: { level: "district", districtId: D }, source: "local-grant" },
    { principalId: "prn_coop-teacher", role: "teacher", scope: { level: "offering", districtId: D, schoolId: "sch_coop", offeringId: "off_coop-art" }, source: "local-grant" },
  ],
});

/** A co-op district as the Worker composes one: in-memory here, signed in by a test header standing in for Access. */
async function bootCoop(directory: DistrictDirectorySnapshot = COOP): Promise<{ app: DistrictApp; showcase: DistrictShowcase }> {
  const verifyRequest = async (request: Request): Promise<VerifiedIdentity | undefined> => {
    const subject = request.headers.get("x-test-subject");
    return subject === null ? undefined : { issuer: ISSUER, subject, credential: "person" };
  };
  const app = await createDistrictApp({
    stores: inMemoryDistrictStores(directory),
    verifyRequest,
    authority: "local",
    unscreenedStudentPosts: "publish",
    importFetch: withShowcaseReadings(async () => new Response("not found", { status: 404 })),
    courseLibraryTrust: PublisherTrust.parse({ localDomains: [], publishers: [publisher] }),
  });
  return { app, showcase: startDistrictShowcase({ app, verifyRequest, accessIssuer: ISSUER, name: "northfield" }) };
}

/** Calls a showcase route as `subject`, reading the whole body. */
async function call(showcase: DistrictShowcase, subject: string | undefined, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (subject !== undefined) headers["x-test-subject"] = subject;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await showcase.serve(new Request(`https://coop.example/api/demo/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { status: response.status, body: await response.json() };
}

/** Calls a district `/api` route as `subject`, through the district's own sign-in. */
async function api(app: DistrictApp, subject: string, path: string): Promise<{ status: number; body: any }> {
  const response = await app.fetch(new Request(`https://coop.example${path}`, { headers: { "x-test-subject": subject } }));
  return { status: response.status, body: await response.json() };
}

describe("the showcase gate", () => {
  it("is on only when the configuration and the deployment name the same showcase", () => {
    expect(showcaseEnabled({ showcase: "northfield" }, "northfield")).toBe("northfield");
    expect(showcaseEnabled(undefined, "northfield")).toBeUndefined();
    expect(showcaseEnabled({ showcase: "northfield" }, undefined)).toBeUndefined();
    expect(showcaseEnabled({ showcase: "northfield" }, "")).toBeUndefined();
    expect(showcaseEnabled({ showcase: "northfield" }, "riverbend")).toBeUndefined();
  });
});

describe("the showcase's directory, mapped into another district", () => {
  const records = showcaseRecords(NORTHFIELD, COOP);

  it("keeps the fixture's IDs, under the live district's ID, with no district administrator or district role", () => {
    for (const list of [records.schools, records.terms, records.courses, records.offerings, records.principals, records.enrollments]) {
      for (const record of list) expect(record.districtId).toBe(D);
    }
    expect(records.offerings.map((o) => o.id).toSorted()).toStrictEqual(NORTHFIELD.offerings.map((o) => o.id).toSorted());
    expect(records.principals.map((p) => p.id)).not.toContain("prn_nf-district-admin");
    expect(records.roleAssignments.every((r) => r.role !== "district-admin" && r.scope.level !== "district" && r.scope.districtId === D)).toBe(true);
    expect(records.roleAssignments.every((r) => r.source === "local-grant")).toBe(true);
  });

  it("gives every persona only a placeholder sign-in, which no Access subject can be", () => {
    for (const p of records.principals) {
      expect(p.externalIdentities).toStrictEqual([{ districtId: D, issuer: ISSUER, subject: placeholderSubject(p.id) }]);
    }
  });

  it("only appends, and stops when a showcase ID already names something else", () => {
    const { next, added } = mergeShowcaseDirectory(COOP, records);
    for (const name of ["schools", "terms", "courses", "offerings", "principals", "enrollments", "roleAssignments"] as const) {
      expect(next[name].slice(0, COOP[name].length), name).toStrictEqual(COOP[name]);
      expect(next[name].length - COOP[name].length, name).toBe(added[name]);
    }
    expect(next.district).toStrictEqual(COOP.district);
    expect(mergeShowcaseDirectory(next, records).added).toStrictEqual({ schools: 0, terms: 0, courses: 0, offerings: 0, principals: 0, enrollments: 0, roleAssignments: 0 });

    const clash = DistrictDirectorySnapshot.parse({ ...COOP, offerings: [...COOP.offerings, { ...COOP.offerings[0]!, id: "off_nf-bio-fall-p2" }] });
    expect(() => mergeShowcaseDirectory(clash, records)).toThrow(/off_nf-bio-fall-p2/);
  });
});

describe("the showcase, seeded inside a co-op district", () => {
  let coop: Awaited<ReturnType<typeof bootCoop>>;
  let first: { status: number; body: any };
  beforeAll(async () => {
    coop = await bootCoop();
    first = await call(coop.showcase, ADMIN_SUB, "POST", "showcase/seed", {});
  }, 120_000);

  it("refuses anyone but a district administrator, and an unsigned request", async () => {
    for (const [method, path] of [["GET", "showcase"], ["GET", "showcase/export"], ["POST", "showcase/seed"], ["POST", "showcase/courses"], ["GET", "showcase/personas"], ["POST", "showcase/personas"]] as const) {
      const body = method === "POST" ? {} : undefined;
      expect((await call(coop.showcase, TEACHER_SUB, method, path, body)).status, `${method} ${path}`).toBe(403);
      expect((await call(coop.showcase, undefined, method, path, body)).status, `${method} ${path}`).toBe(401);
    }
    expect((await call(coop.showcase, ADMIN_SUB, "GET", "showcase/nothing")).status).toBe(404);
    // A POST must say it is JSON, which a cross-site form cannot.
    const form = await coop.showcase.serve(new Request("https://coop.example/api/demo/showcase/seed", { method: "POST", headers: { "x-test-subject": ADMIN_SUB, "content-type": "text/plain" }, body: "{}" }));
    expect(form.status).toBe(400);
    await form.arrayBuffer();
  });

  it("adds the whole fixture directory and builds every class of every band", () => {
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const { directory, guardiansConfirmed, showcase } = first.body;
    expect(directory.offerings).toBe(NORTHFIELD.offerings.length);
    expect(directory.principals).toBe(NORTHFIELD.principals.length - 1);
    expect(guardiansConfirmed).toBe(NORTHFIELD_GUARDIANS.length);
    expect(showcase.skipped).toStrictEqual([]);
    for (const band of SHOWCASE_BANDS) {
      const courses = NORTHFIELD_SHOWCASE.courses.filter((c) => c.band === band);
      expect(showcase.bands[band].courses, band).toBe(courses.length);
      expect(showcase.bands[band].activities, band).toBe(courses.flatMap((c) => c.activities).length);
    }
  });

  it("keeps every record the co-op had, exactly as it was", async () => {
    const { snapshot } = await coop.app.stores.directory.load();
    for (const name of ["schools", "terms", "courses", "offerings", "principals", "enrollments", "roleAssignments"] as const) {
      for (const record of COOP[name]) expect(snapshot[name], name).toContainEqual(record);
    }
    expect(snapshot.district).toStrictEqual(COOP.district);
    // The co-op's own people still sign in as themselves.
    expect((await api(coop.app, TEACHER_SUB, "/api/teacher/offerings")).body.map((t: any) => t.offering.id)).toStrictEqual(["off_coop-art"]);
  });

  it("reports what it holds per band, and exports the directory and its counts", async () => {
    const status: ShowcaseStatus = (await call(coop.showcase, ADMIN_SUB, "GET", "showcase")).body;
    expect(status.districtId).toBe(D);
    for (const band of SHOWCASE_BANDS) {
      expect(status.bands[band].offerings.every((o) => o.present && o.assignments > 0 && o.students >= 2), band).toBe(true);
    }
    expect(status.personas).toStrictEqual({ present: NORTHFIELD.principals.length - 1, linked: 0 });
    const exported = (await call(coop.showcase, ADMIN_SUB, "GET", "showcase/export")).body;
    expect(exported.format).toBe("educateos.showcase-export/v1");
    expect(DistrictDirectorySnapshot.parse(exported.directory).district.id).toBe(D);
    expect(exported.health.directory.offerings).toBe(COOP.offerings.length + NORTHFIELD.offerings.length);
  });

  it("makes nothing new when run again", async () => {
    const again = await call(coop.showcase, ADMIN_SUB, "POST", "showcase/seed", {});
    expect(again.status).toBe(200);
    expect(Object.values(again.body.directory).every((n) => n === 0)).toBe(true);
    expect(again.body.guardiansConfirmed).toBe(0);
    expect(again.body.showcase.created).toBe(0);
  }, 120_000);

  it("installs a sample course into its showcase class as the co-op's administrator and the class's teacher, once", async () => {
    const course = "educateos.io/grade-1-reading-foundations";
    const dry = await call(coop.showcase, ADMIN_SUB, "POST", "showcase/courses", { dryRun: true, courses: [course] });
    expect(dry.body).toStrictEqual({ dryRun: true, courses: [{ packageId: course, offeringId: "off_nf-g1read-fall-r7", imported: false, installed: false }] });
    expect(await coop.app.stores.courseLibrary.listCourses()).toStrictEqual([]);

    const installed = await call(coop.showcase, ADMIN_SUB, "POST", "showcase/courses", { courses: [course] });
    expect(installed.status, JSON.stringify(installed.body)).toBe(200);
    expect(installed.body.pending).toStrictEqual([]);
    expect(installed.body.courses).toMatchObject([{ packageId: course, imported: true, unitsSkipped: 2, unitsInstalled: 4, published: 4, done: true }]);
    // The co-op's administrator imported it, under the deployment's pin.
    const [entry] = await coop.app.stores.courseLibrary.listCourses();
    expect(entry).toMatchObject({ packageId: course, publisher: { domain: "educateos.io", signed: true }, imported: { by: "prn_coop-admin" } });
    const status: ShowcaseStatus = (await call(coop.showcase, ADMIN_SUB, "GET", "showcase")).body;
    expect(status.courses.find((c) => c.packageId === course)).toStrictEqual({ packageId: course, offeringId: "off_nf-g1read-fall-r7", imported: true, installed: true });

    const again = await call(coop.showcase, ADMIN_SUB, "POST", "showcase/courses", { courses: [course] });
    expect(again.body).toMatchObject({ created: 0, pending: [] });
    expect((await call(coop.showcase, ADMIN_SUB, "POST", "showcase/courses", { courses: ["educateos.io/not-a-course"] })).status).toBe(400);
  }, 120_000);

  it("links a presenter to a persona, moves them to another, and frees them", async () => {
    const personas: ShowcasePersona[] = (await call(coop.showcase, ADMIN_SUB, "GET", "showcase/personas")).body;
    const mateo = personas.find((p) => p.principalId === "prn_nf-student-mateo")!;
    expect(mateo).toMatchObject({ kind: "student", bands: ["K-2"], presenters: [] });
    expect(personas.find((p) => p.principalId === "prn_nf-guardian-rosa")!.bands).toStrictEqual(["K-2", "9-12"]);

    // Unlinked, the presenter is nobody here.
    expect((await api(coop.app, PRESENTER, "/api/me")).status).toBe(401);
    expect((await call(coop.showcase, ADMIN_SUB, "POST", "showcase/personas", { subject: PRESENTER, personaId: "prn_nf-student-mateo" })).body)
      .toStrictEqual({ personaId: "prn_nf-student-mateo", previousPersonaId: null, changed: true });
    expect((await api(coop.app, PRESENTER, "/api/me")).body).toMatchObject({ principalId: "prn_nf-student-mateo" });

    expect((await call(coop.showcase, ADMIN_SUB, "POST", "showcase/personas", { subject: PRESENTER, personaId: "prn_nf-student-lucia" })).body)
      .toStrictEqual({ personaId: "prn_nf-student-lucia", previousPersonaId: "prn_nf-student-mateo", changed: true });
    expect((await api(coop.app, PRESENTER, "/api/me")).body).toMatchObject({ principalId: "prn_nf-student-lucia" });
    const { snapshot } = await coop.app.stores.directory.load();
    expect(snapshot.principals.find((p) => p.id === "prn_nf-student-mateo")!.externalIdentities.map((i) => i.subject)).toStrictEqual([placeholderSubject("prn_nf-student-mateo")]);

    expect((await call(coop.showcase, ADMIN_SUB, "POST", "showcase/personas", { subject: PRESENTER, personaId: "prn_nf-student-lucia" })).body.changed).toBe(false);
    expect((await call(coop.showcase, ADMIN_SUB, "POST", "showcase/personas", { subject: PRESENTER, personaId: null })).body)
      .toStrictEqual({ personaId: null, previousPersonaId: "prn_nf-student-lucia", changed: true });
    expect((await api(coop.app, PRESENTER, "/api/me")).status).toBe(401);
  });

  it("never takes a sign-in from the co-op's own people, nor links one to them", async () => {
    const taken = await call(coop.showcase, ADMIN_SUB, "POST", "showcase/personas", { subject: TEACHER_SUB, personaId: "prn_nf-teacher-marsh" });
    expect(taken.status).toBe(409);
    const own = await call(coop.showcase, ADMIN_SUB, "POST", "showcase/personas", { subject: PRESENTER, personaId: "prn_coop-teacher" });
    expect(own.status).toBe(404);
    const admin = await call(coop.showcase, ADMIN_SUB, "POST", "showcase/personas", { subject: PRESENTER, personaId: "prn_coop-admin" });
    expect(admin.status).toBe(404);
    const placeholder = await call(coop.showcase, ADMIN_SUB, "POST", "showcase/personas", { subject: placeholderSubject("prn_nf-student-noah"), personaId: "prn_nf-student-mateo" });
    expect(placeholder.status).toBe(400);
    expect((await api(coop.app, TEACHER_SUB, "/api/me")).body).toMatchObject({ principalId: "prn_coop-teacher" });
  });
});

describe("a dry run, and a district whose records clash", () => {
  it("says what the directory would gain and writes nothing", async () => {
    const coop = await bootCoop();
    const before = await coop.app.stores.directory.load();
    const dry = await call(coop.showcase, ADMIN_SUB, "POST", "showcase/seed", { dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, directory: { offerings: NORTHFIELD.offerings.length } });
    expect((await coop.app.stores.directory.load()).snapshot).toStrictEqual(before.snapshot);
  });

  it("refuses to install the sample courses before the showcase's classes are there", async () => {
    const coop = await bootCoop();
    const refused = await call(coop.showcase, ADMIN_SUB, "POST", "showcase/courses", {});
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain("Seed the showcase first");
    expect(await coop.app.stores.courseLibrary.listCourses()).toStrictEqual([]);
  });

  it("refuses to seed over another record under a showcase ID, writing nothing", async () => {
    const clash = DistrictDirectorySnapshot.parse({ ...COOP, offerings: [...COOP.offerings, { ...COOP.offerings[0]!, id: "off_nf-g1read-fall-r7" }] });
    const coop = await bootCoop(clash);
    const refused = await call(coop.showcase, ADMIN_SUB, "POST", "showcase/seed", {});
    expect(refused.status).toBe(409);
    expect((await coop.app.stores.directory.load()).snapshot).toStrictEqual(clash);
  });

  it("refuses a persona link that would take a sign-in from the district's own people", () => {
    const { next } = mergeShowcaseDirectory(COOP, showcaseRecords(NORTHFIELD, COOP));
    const personas = new Set(showcaseRecords(NORTHFIELD, COOP).principals.map((p) => p.id));
    const identity = { districtId: COOP.district.id, issuer: ISSUER, subject: ADMIN_SUB };
    expect(() => linkPersona(next, identity, "prn_nf-student-noah" as never, personas)).toThrow(/district's own people/);
  });
});
