import { beforeAll, describe, expect, it } from "vitest";
import { createDistrictApiClient, type DistrictApiClient } from "@educateos/api-client";
import type { PrincipalId } from "@educateos/contracts";
import { NORTHFIELD, NORTHFIELD_GUARDIANS, NORTHFIELD_SHOWCASE, SHOWCASE_BANDS, type ShowcaseBand } from "@educateos/fixtures";
import { bootDistrictApp, bootHarness, seedShowcase, showcaseResourceUrl, type ShowcaseSummary } from "../src/index.ts";

const ADMIN = "prn_nf-district-admin" as PrincipalId;
const name = (id: string) => NORTHFIELD.principals.find((p) => p.id === id)!.displayName;
const coursesIn = (band: ShowcaseBand) => NORTHFIELD_SHOWCASE.courses.filter((c) => c.band === band);

async function bootNorthfield() {
  const [entry] = await bootHarness([NORTHFIELD]);
  const app = await bootDistrictApp(entry!);
  const actAs = async (id: string): Promise<DistrictApiClient> => {
    const subject = NORTHFIELD.principals.find((p) => p.id === id)!.externalIdentities[0]!.subject;
    return createDistrictApiClient({ baseUrl: "http://district.harness", token: await entry!.identity.issueToken(subject), fetch: (request) => app.fetch(request) });
  };
  const seed = () => seedShowcase({
    showcase: NORTHFIELD_SHOWCASE,
    adminId: ADMIN,
    actAs,
    guardians: NORTHFIELD_GUARDIANS,
    guardianNames: Object.fromEntries(NORTHFIELD_GUARDIANS.map((g) => [g.guardianPrincipalId, name(g.guardianPrincipalId)])),
    resourceUrl: showcaseResourceUrl,
  });
  return { actAs, seed };
}

describe("the Northfield showcase, seeded through the district API", () => {
  let district: Awaited<ReturnType<typeof bootNorthfield>>;
  let first: ShowcaseSummary;
  beforeAll(async () => {
    district = await bootNorthfield();
    first = await district.seed();
  }, 120_000);

  it("makes every class of every band, with nothing skipped", () => {
    expect(first.skipped).toStrictEqual([]);
    expect(first.standardsApproved).toBe(3);
    expect(first.guardiansConfirmed).toBe(NORTHFIELD_GUARDIANS.length);
    for (const band of SHOWCASE_BANDS) {
      const courses = coursesIn(band);
      const made = first.bands[band];
      expect(made.courses, band).toBe(courses.length);
      expect(made.modules, band).toBe(courses.length * 2);
      expect(made.activities, band).toBe(courses.flatMap((c) => c.activities).length);
      expect(made.quizzes, band).toBe(courses.flatMap((c) => c.quizzes).length);
      expect(made.quizAttempts, band).toBe(courses.flatMap((c) => c.quizzes.flatMap((q) => Object.keys(q.attempts))).length);
      expect(made.announcements, band).toBe(courses.flatMap((c) => c.announcements).length);
      expect(made.weeklyNotes, band).toBe(courses.length);
      for (const count of ["drafts", "submissions", "feedback", "grades", "releases"] as const) expect(made[count], `${band} ${count}`).toBeGreaterThan(0);
    }
  });

  it.each(SHOWCASE_BANDS)("shows each %s student their classes, modules, activities and released feedback", async (band) => {
    for (const course of coursesIn(band)) {
      for (const activity of course.activities) {
        for (const [studentId, work] of Object.entries(activity.work)) {
          const student = await district.actAs(studentId);
          const params = { offeringId: course.offeringId };
          expect((await student.call("student.listOfferings")).map((o) => o.offering.id)).toContain(course.offeringId);
          const { outline } = await student.call("student.listModules", { params });
          expect(outline.modules.map((m) => m.title)).toStrictEqual(course.modules.map((m) => m.title));
          const assigned = await student.call("student.listActivities", { params });
          const mine = assigned.find((a) => a.assignment.title === activity.title);
          expect(mine, `${studentId} ${activity.title}`).toBeDefined();
          if (work.stage !== "released") continue;
          const [feedback] = await student.call("student.assignmentFeedback", { params: { assignmentId: mine!.assignment.id } });
          expect(feedback).toMatchObject({ state: "shared-with-student", comments: [{ body: work.comment }] });
          expect(await student.call("student.officialGrades", { params: { assignmentId: mine!.assignment.id } })).toHaveLength(1);
        }
      }
    }
  });

  it.each(SHOWCASE_BANDS)("gives each %s teacher a gradebook with scores", async (band) => {
    for (const course of coursesIn(band)) {
      const teacher = await district.actAs(course.teacherId);
      const gradebook = await teacher.call("teacher.gradebook", { params: { offeringId: course.offeringId } });
      const scored = gradebook.rows.flatMap((r) => r.cells.filter((c) => c.score !== undefined));
      expect(scored.length, course.offeringId).toBeGreaterThan(0);
      expect(gradebook.rows.some((r) => r.totals.letter !== null), course.offeringId).toBe(true);
    }
  });

  it("shows each guardian each child's classes, with released work", async () => {
    for (const guardianId of new Set(NORTHFIELD_GUARDIANS.map((g) => g.guardianPrincipalId))) {
      const guardian = await district.actAs(guardianId);
      const children = NORTHFIELD_GUARDIANS.filter((g) => g.guardianPrincipalId === guardianId).map((g) => g.studentPrincipalId);
      expect((await guardian.call("guardian.listChildren")).map((c) => c.studentPrincipalId).toSorted()).toStrictEqual(children.toSorted());
      for (const child of children) {
        const theirs = NORTHFIELD_SHOWCASE.courses.filter((c) => NORTHFIELD.enrollments.some((e) => e.offeringId === c.offeringId && e.principalId === child && e.status === "active"));
        const offerings = (await guardian.call("guardian.childOfferings", { params: { studentId: child } })).map((o) => o.offering.id);
        for (const course of theirs) expect(offerings, child).toContain(course.offeringId);
        const detail = await guardian.call("guardian.childCourse", { params: { studentId: child, offeringId: theirs[0]!.offeringId } });
        expect(detail.assignments.length).toBeGreaterThan(0);
        expect(detail.announcements.length).toBeGreaterThan(0);
      }
    }
  });

  it("lists every Northfield class for the administrator, with its teachers and students", async () => {
    const admin = await district.actAs(ADMIN);
    const offerings = await admin.call("admin.listOfferings");
    expect(offerings.map((o) => o.offering.id).toSorted()).toStrictEqual(NORTHFIELD.offerings.map((o) => o.id).toSorted());
    for (const course of NORTHFIELD_SHOWCASE.courses) {
      const row = offerings.find((o) => o.offering.id === course.offeringId)!;
      expect(row.teachers).toContain(name(course.teacherId));
      expect(row.students).toBeGreaterThanOrEqual(2);
    }
  });

  it("makes nothing new when run again", async () => {
    const admin = await district.actAs(ADMIN);
    const before = await admin.call("admin.health");
    const again = await district.seed();
    expect(again.created).toBe(0);
    expect(again.skipped).toStrictEqual([]);
    expect(await admin.call("admin.health")).toStrictEqual(before);
  }, 120_000);
});
