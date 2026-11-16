// SCHO-334: every educateos.io sample course, imported from its committed signed bundle into a
// harness Northfield whose showcase is seeded, installs into the showcase class it continues. Each
// class keeps its showcase modules and gains the course's later units; students read the units'
// pages but never their teacher-only notes; and a rerun finds everything in place.
import { readdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createDistrictApiClient, type DistrictApiClient } from "@educateos/api-client";
import type { PrincipalId } from "@educateos/contracts";
import { PublisherTrust } from "@educateos/district-app";
import { NORTHFIELD, NORTHFIELD_COURSE_CLASSES, NORTHFIELD_GUARDIANS, NORTHFIELD_SHOWCASE } from "@educateos/fixtures";
import publisher from "../../../curriculum/educateos.io/publisher.json" with { type: "json" };
import {
  bootDistrictApp,
  bootHarness,
  installSampleCourses,
  loadSampleCourseBundles,
  SAMPLE_COURSE_IDS,
  seedShowcase,
  showcaseResourceUrl,
  type SampleCourseBundle,
  type SampleCoursesSummary,
} from "../src/index.ts";

const ADMIN = "prn_nf-district-admin" as PrincipalId;
const name = (id: string) => NORTHFIELD.principals.find((p) => p.id === id)!.displayName;

/** MAJOR.MINOR.PATCH, compared numerically. */
const newer = (a: string, b: string) => {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
};

describe("the committed sample course bundles", () => {
  it("are every course under curriculum/bundles, one per showcase class, each at its newest committed version", async () => {
    const root = new URL("../../../curriculum/bundles/educateos.io/", import.meta.url);
    const committed = readdirSync(root).map((dir) => `educateos.io/${dir}`);
    expect(SAMPLE_COURSE_IDS.toSorted()).toStrictEqual(committed.toSorted());
    expect(Object.keys(NORTHFIELD_COURSE_CLASSES).toSorted()).toStrictEqual(committed.toSorted());
    const bundles = await loadSampleCourseBundles();
    expect(bundles.map((b) => b.packageId)).toStrictEqual(SAMPLE_COURSE_IDS);
    for (const { packageId, version } of bundles) {
      const versions = readdirSync(new URL(`${packageId.slice("educateos.io/".length)}/`, root)).map((file) => file.replace(/\.json$/, ""));
      const latest = versions.reduce((a, b) => (newer(b, a) ? b : a));
      expect(version, `point ${packageId} in src/sample-courses.ts at its newest bundle`).toBe(latest);
    }
    expect(bundles.find((b) => b.packageId === "educateos.io/english-9")!.version).toBe("1.0.1");
  });
});

describe("installing the sample courses into the Northfield showcase", () => {
  let actAs: (id: string) => Promise<DistrictApiClient>;
  let bundles: SampleCourseBundle[];
  let first: SampleCoursesSummary;
  const before = new Map<string, { modules: string[]; assignments: number }>();
  const install = () => installSampleCourses({ bundles, adminId: ADMIN, actAs, showcase: NORTHFIELD_SHOWCASE, origins: NORTHFIELD_COURSE_CLASSES, publish: true });

  beforeAll(async () => {
    const [entry] = await bootHarness([NORTHFIELD]);
    const app = await bootDistrictApp(entry!, undefined, { courseLibraryTrust: PublisherTrust.parse({ localDomains: [], publishers: [publisher] }) });
    actAs = async (id) => {
      const subject = NORTHFIELD.principals.find((p) => p.id === id)!.externalIdentities[0]!.subject;
      return createDistrictApiClient({ baseUrl: "http://district.harness", token: await entry!.identity.issueToken(subject), fetch: (request) => app.fetch(request) });
    };
    await seedShowcase({
      showcase: NORTHFIELD_SHOWCASE,
      adminId: ADMIN,
      actAs,
      guardians: NORTHFIELD_GUARDIANS,
      guardianNames: Object.fromEntries(NORTHFIELD_GUARDIANS.map((g) => [g.guardianPrincipalId, name(g.guardianPrincipalId)])),
      resourceUrl: showcaseResourceUrl,
    });
    for (const course of NORTHFIELD_SHOWCASE.courses) {
      const teacher = await actAs(course.teacherId);
      const params = { offeringId: course.offeringId };
      before.set(course.offeringId, {
        modules: (await teacher.call("teacher.listModules", { params })).outline.modules.map((m) => m.id),
        assignments: (await teacher.call("teacher.listAssignments", { params })).length,
      });
    }
    bundles = await loadSampleCourseBundles();
    first = await install();
  }, 300_000);

  it("imports all twelve signed courses and installs each into its class, after the showcase's modules", async () => {
    expect(first.courses).toHaveLength(12);
    expect(first.pending).toStrictEqual([]);
    const library = await (await actAs(ADMIN)).call("admin.listLibraryCourses");
    expect(library.map((c) => c.packageId).toSorted()).toStrictEqual(SAMPLE_COURSE_IDS.toSorted());
    expect(library.every((c) => c.publisher.signed && c.publisher.domain === "educateos.io")).toBe(true);

    for (const result of first.courses) {
      expect(result).toMatchObject({ imported: true, done: true });
      expect(result.unitsSkipped).toBe(2);
      expect(result.unitsInstalled).toBeGreaterThan(0);
      expect(result.published).toBe(result.unitsInstalled);
      const course = NORTHFIELD_SHOWCASE.courses.find((c) => c.offeringId === result.offeringId)!;
      const teacher = await actAs(course.teacherId);
      const params = { offeringId: course.offeringId };
      const outline = (await teacher.call("teacher.listModules", { params })).outline;
      const was = before.get(course.offeringId)!;
      // The showcase's modules come first, as they were; the course's later units follow.
      expect(outline.modules.slice(0, was.modules.length).map((m) => m.id)).toStrictEqual(was.modules);
      const added = outline.modules.slice(was.modules.length);
      expect(added).toHaveLength(result.unitsInstalled);
      expect(added.every((m) => m.published && m.source?.kind === "course" && m.source.packageId === result.packageId)).toBe(true);
      expect(added.flatMap((m) => m.items).filter((i) => i.kind === "teacher-note")).toHaveLength(result.teacherNotes);
      expect((await teacher.call("teacher.listAssignments", { params })).length).toBe(was.assignments + result.activities);

      // A student of the class reads the new units' pages, and none of their teacher-only notes.
      const studentId = Object.keys(course.activities[0]!.work)[0]!;
      const student = (await (await actAs(studentId)).call("student.listModules", { params })).outline;
      const seen = student.modules.filter((m) => added.some((a) => a.id === m.id));
      expect(seen).toHaveLength(added.length);
      expect(seen.flatMap((m) => m.items).some((i) => i.kind === "teacher-note")).toBe(false);
      const notePages = new Set(added.flatMap((m) => m.items.flatMap((i) => (i.kind === "teacher-note" ? [i.pageId] : []))));
      expect(student.pages.some((p) => notePages.has(p.id))).toBe(false);
      expect(seen.flatMap((m) => m.items).filter((i) => i.kind === "page")).toHaveLength(result.pages);
    }
  });

  it("does nothing on a rerun", async () => {
    const again = await install();
    expect(again.created).toBe(0);
    expect(again.courses.every((c) => !c.imported && c.unitsInstalled === 0 && c.published === 0 && c.done)).toBe(true);
  });

  it("stops after maxCourses courses with work, leaving the rest pending", async () => {
    const limited = await installSampleCourses({ bundles, adminId: ADMIN, actAs, showcase: NORTHFIELD_SHOWCASE, origins: NORTHFIELD_COURSE_CLASSES, maxCourses: 1 });
    // Nothing is left to do, so no course counts against the limit and every one is reached.
    expect(limited.pending).toStrictEqual([]);
    expect(limited.courses).toHaveLength(12);
  });
});
