import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
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

  it("dues activities at the time `dueAt` gives, when given one", async () => {
    // The due dates below are fixed, and a due date must fall after installation, so install on a
    // fixed day before them instead of today. Only Date is faked; timers and I/O stay real.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T12:00:00Z") });
    onTestFinished(() => vi.useRealTimers());
    const fresh = await bootNorthfield();
    const showcase = { ...NORTHFIELD_SHOWCASE, courses: NORTHFIELD_SHOWCASE.courses.filter((c) => c.offeringId === "off_nf-g1math-fall-r7") };
    await seedShowcase({ showcase, adminId: ADMIN, actAs: fresh.actAs, dueAt: (days) => `2026-11-${String(2 + days).padStart(2, "0")}T15:30:00-05:00` });
    const teacher = await fresh.actAs("prn_nf-teacher-yazzie");
    const due = (await teacher.call("teacher.listAssignments", { params: { offeringId: "off_nf-g1math-fall-r7" } })).map((a) => [a.title, a.dueAt]);
    // A quiz's gradebook assignment is due on the day the host gives quizzes too.
    expect(due.toSorted()).toStrictEqual([
      ["Apple Orchard Story Problems", "2026-11-09T20:30:00.000Z"],
      ["Count and Compare", "2026-11-06T20:30:00.000Z"],
      ["Tens and Ones", "2026-11-16T20:30:00.000Z"],
    ]);
  }, 60_000);

  it("approves the student posts a premoderated class holds, and finishes a discussion a cut-short run left", async () => {
    const fresh = await bootNorthfield();
    const offeringId = "off_nf-eng9-fall-p3";
    const course = NORTHFIELD_SHOWCASE.courses.find((c) => c.offeringId === offeringId)!;
    const teacher = await fresh.actAs(course.teacherId);
    await teacher.call("teacher.discussionSettings", { params: { offeringId }, body: { premoderation: true } });
    // The cut-short run: the topic and its first post, and nothing more.
    const [discussion] = course.discussions;
    const topic = await teacher.call("teacher.createTopic", { params: { offeringId }, body: { title: discussion!.title, prompt: discussion!.prompt } });
    await (await fresh.actAs(discussion!.posts[0]!.author)).call("student.createPost", { params: { offeringId, topicId: topic.id }, body: { body: discussion!.posts[0]!.body } });

    const summary = await seedShowcase({ showcase: { ...NORTHFIELD_SHOWCASE, courses: [course] }, adminId: ADMIN, actAs: fresh.actAs, resourceUrl: showcaseResourceUrl });
    expect(summary.bands["9-12"].discussions).toBe(0);
    expect(summary.bands["9-12"].posts).toBe(discussion!.posts.length - 1);
    const thread = await teacher.call("teacher.discussionThread", { params: { offeringId, topicId: topic.id } });
    expect(thread.posts.map((p) => [p.body, p.status])).toStrictEqual(discussion!.posts.map((p) => [p.body, "visible"]));
  }, 60_000);

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

  it("hands in young learners' drawings and recordings, one a step, for their teacher to see and hear", async () => {
    const course = NORTHFIELD_SHOWCASE.courses.find((c) => c.offeringId === "off_nf-ksci-fall-r4")!;
    const activity = course.activities.find((a) => a.template === "picture-response" && a.work["prn_nf-student-noah"]?.stage === "submitted")!;
    const teacher = await district.actAs(course.teacherId);
    const assignment = (await teacher.call("teacher.listAssignments", { params: { offeringId: course.offeringId } })).find((a) => a.title === activity.title)!;
    const submissions = await teacher.call("teacher.listSubmissions", { params: { assignmentId: assignment.id } });
    const noah = submissions.find((s) => s.studentPrincipalId === "prn_nf-student-noah")!;
    expect(noah.items.map((i) => `${i.artifactType} ${i.mediaType}`).toSorted()).toStrictEqual(["audio audio/wav", "image image/png"]);
    for (const item of noah.items) {
      const read = await teacher.call("teacher.submittedContent", { params: { submissionId: noah.id, artifactId: item.artifactId } });
      expect(read.content.kind).toBe("bytes");
    }

    // The student finds each piece on its step, titled as the Learning Home titles a step's work.
    const student = await district.actAs("prn_nf-student-noah");
    const workspace = await student.call("student.openCourseWorkspace", { params: { offeringId: course.offeringId } });
    const titles = (await student.call("student.listArtifacts", { params: { workspaceId: workspace.id } })).map((a) => a.artifact.title);
    expect(titles).toEqual(expect.arrayContaining([`${activity.title}: Draw it`, `${activity.title}: Tell about it`]));
  });

  it("keeps an older student's draft in the activity's Draft step, where their page shows it", async () => {
    const abena = await district.actAs("prn_nf-student-abena");
    const workspace = await abena.call("student.openCourseWorkspace", { params: { offeringId: "off_nf-g4ela-fall-r12" } });
    const titles = (await abena.call("student.listArtifacts", { params: { workspaceId: workspace.id } })).map((a) => a.artifact.title);
    expect(titles).toContain("Should Recess Be Longer?: Draft");
  });

  it("leaves Mateo's retelling for him to do, with a classmate's waiting for the teacher", async () => {
    const mateo = await district.actAs("prn_nf-student-mateo");
    const retell = (await mateo.call("student.listActivities", { params: { offeringId: "off_nf-g1read-fall-r7" } })).find((a) => a.assignment.title === "Retell The Little Seed")!;
    expect(retell.activity.content.steps.map((s) => s.response.kind === "artifact" ? s.response.artifactType : s.response.kind)).toStrictEqual(["none", "audio", "audio", "image"]);
    expect(await mateo.call("student.listSubmissions", { params: { assignmentId: retell.assignment.id } })).toStrictEqual([]);
    const teacher = await district.actAs("prn_nf-teacher-yazzie");
    expect((await teacher.call("teacher.listSubmissions", { params: { assignmentId: retell.assignment.id } })).length).toBe(2);
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
