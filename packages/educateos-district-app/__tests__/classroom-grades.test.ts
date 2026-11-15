// SCHO-403: the read-only "From Google Classroom" routes. Each is authorized as the gradebook is
// (a student their own row, the class's teachers its grid), maps the offering and people to
// Classroom through the roster's source map, and never stores or writes anything.
import { DistrictDirectorySnapshot } from "@educateos/contracts";
import type { googleclassroom } from "@educateos/integrations";
import { oneroster } from "@educateos/integrations";
import { describe, expect, it } from "vitest";
import { classroomCourseOf, type ClassroomGradeSource } from "../src/index.ts";
import { bootDistrict, expectError, NF, NORTHFIELD, RB, RIVERBEND } from "./support.ts";

const GOOGLE = "https://accounts.google.com";
const COURSE = "880000000001";
const USERS = { amara: "770000000001", elena: "770000000002", dmitri: "770000000003" } as const;
const LINK = "https://classroom.google.com/c/ODgw";
const USHIST = "off_nf-ushist-fall-p5";

/** Northfield, trusting Google sign-in so its configuration can name a Classroom roster. */
const DIRECTORY = DistrictDirectorySnapshot.parse({ ...NORTHFIELD, district: { ...NORTHFIELD.district, trustedIssuers: [...NORTHFIELD.district.trustedIssuers, GOOGLE] } });

const work = (id: string, title: string, maxPoints?: number): googleclassroom.ClassroomCourseWorkRecord => ({
  id, title, state: "PUBLISHED", associatedWithDeveloper: false, alternateLink: `${LINK}/a/${id}/details`, ...(maxPoints === undefined ? {} : { maxPoints }),
});
const submission = (courseWorkId: string, userId: string, state: string, assignedGrade?: number): googleclassroom.ClassroomSubmissionRecord => ({
  id: `sub-${courseWorkId}-${userId}`, courseWorkId, userId, state, ...(assignedGrade === undefined ? {} : { assignedGrade }),
});

/** A Classroom with English 9's coursework: Amara's returned 8/10, Elena's turned in, an ungraded reflection. */
function fakeClassroom(fail = false) {
  const calls: { kind: "student" | "course"; courseId: string; userId?: string }[] = [];
  const courseWork = [work("501", "Tide quiz", 10), work("502", "Reflection")];
  const all = [
    submission("501", USERS.amara, "RETURNED", 8),
    submission("501", USERS.elena, "TURNED_IN", 6),
    submission("502", USERS.amara, "RETURNED"),
    submission("502", USERS.elena, "RETURNED", 3),
    // Someone the district's roster did not import.
    submission("501", "770000000999", "RETURNED", 10),
  ];
  const source: ClassroomGradeSource = {
    async student(courseId, userId) {
      calls.push({ kind: "student", courseId, userId });
      if (fail) throw new Error("Classroom is down");
      return { courseLink: LINK, courseWork, submissions: all.filter((s) => s.userId === userId && s.state === "RETURNED"), truncated: false };
    },
    async course(courseId) {
      calls.push({ kind: "course", courseId });
      if (fail) throw new Error("Classroom is down");
      return { courseLink: LINK, courseWork, submissions: all, truncated: false };
    },
  };
  return { source, calls };
}

function config(provider: "google-classroom" | "oneroster-csv"): Record<string, unknown> {
  return {
    apiVersion: "educateos.io/v1alpha1",
    district: DIRECTORY.district.id,
    profile: "us-k12-conservative",
    identity: { provider: "cloudflare-access" },
    rostering: {
      provider,
      mode: "apply-automatically",
      identityMapping: provider === "google-classroom" ? { issuer: GOOGLE, subject: { field: "username" } } : { issuer: DIRECTORY.district.trustedIssuers[0], subject: { field: "username" } },
    },
    modules: { "core-learning": "enabled" },
    rollout: { target: "all-active-offerings", requiresAdminActivation: false },
    policies: { ai: { spending: "capped", promptsInGatewayLogs: false } },
  };
}

async function setup(options: { source?: "working" | "failing" | "none"; provider?: "google-classroom" | "oneroster-csv"; linked?: boolean } = {}) {
  const classroom = fakeClassroom(options.source === "failing");
  const unavailable: { surface: string }[] = [];
  const district = await bootDistrict(DIRECTORY, {
    ...(options.source === "none" ? {} : { classroomGrades: classroom.source }),
    onClassroomGradesUnavailable: ({ surface }) => unavailable.push({ surface }),
  });
  await district.ok(district.tokenFor(NF.admin), "admin.applyConfig", { body: { document: config(options.provider ?? "google-classroom"), acknowledgeApprovals: true } });
  const seen = "2026-10-20T15:00:00.000Z";
  await district.stores.rosterSources.save({
    ...oneroster.EMPTY_SOURCE_MAP,
    offerings: options.linked === false ? {} : { [NF.eng9]: COURSE, [USHIST]: "880000000002" } as never,
    principals: {
      [NF.amara]: { system: "oneroster", sourcedId: USERS.amara, lastSeenAt: seen },
      [NF.elena]: { system: "oneroster", sourcedId: USERS.elena, lastSeenAt: seen },
    } as never,
  });
  return { district, calls: classroom.calls, unavailable };
}

const ENG9 = { params: { offeringId: NF.eng9 } };

describe("student.classroomGrades", () => {
  it("shows the student their own returned grades, asking Classroom for theirs alone", async () => {
    const { district, calls } = await setup();
    const grades = await district.ok(district.tokenFor(NF.amara), "student.classroomGrades", ENG9);
    expect(grades).toStrictEqual({
      status: "ready",
      offeringId: NF.eng9,
      courseLink: LINK,
      grades: [
        { courseWorkId: "501", title: "Tide quiz", maxPoints: 10, link: `${LINK}/a/501/details`, assignedGrade: 8 },
        { courseWorkId: "502", title: "Reflection", link: `${LINK}/a/502/details` },
      ],
      truncated: false,
    });
    expect(calls).toStrictEqual([{ kind: "student", courseId: COURSE, userId: USERS.amara }]);
  });

  it("never shows a grade that was not returned", async () => {
    const { district } = await setup();
    const grades = await district.ok(district.tokenFor(NF.elena), "student.classroomGrades", ENG9);
    expect(grades.status === "ready" && grades.grades.map((g) => [g.title, g.assignedGrade])).toStrictEqual([["Reflection", 3]]);
  });

  it("refuses another class, and a teacher, without asking Classroom", async () => {
    const { district, calls } = await setup();
    // Amara is not in US History, though it is a Classroom course too.
    expectError(await district.call(district.tokenFor(NF.amara), "student.classroomGrades", { params: { offeringId: USHIST } }), 404, "not-found");
    expectError(await district.call(district.tokenFor(NF.rivera), "student.classroomGrades", ENG9), 403, "forbidden");
    const riverbend = await bootDistrict(RIVERBEND);
    expectError(await riverbend.call(riverbend.tokenFor(RB.student), "student.classroomGrades", ENG9), 404, "not-found");
    expect(calls).toStrictEqual([]);
  });

  it("is not-connected for a student the roster did not import", async () => {
    const { district, calls } = await setup();
    // Dmitri left English 9, so still reads his own row, but has no Classroom user.
    expect(await district.ok(district.tokenFor(NF.dmitri), "student.classroomGrades", ENG9)).toStrictEqual({ status: "not-connected" });
    expect(calls).toStrictEqual([]);
  });
});

describe("teacher.classroomGrades", () => {
  it("shows the class's teachers every enrolled student's Classroom submissions", async () => {
    const { district, calls } = await setup();
    const grades = await district.ok(district.tokenFor(NF.rivera), "teacher.classroomGrades", ENG9);
    if (grades.status !== "ready") throw new Error(`expected ready, got ${grades.status}`);
    expect(grades.courseWork.map((w) => [w.title, w.maxPoints])).toStrictEqual([["Tide quiz", 10], ["Reflection", undefined]]);
    const byName = Object.fromEntries(grades.rows.map((r) => [r.displayName, r.cells]));
    expect(byName["Amara Okafor"]).toStrictEqual([
      { courseWorkId: "501", state: "returned", assignedGrade: 8 },
      { courseWorkId: "502", state: "returned" },
    ]);
    expect(byName["Elena Sato"]).toStrictEqual([
      { courseWorkId: "501", state: "turned-in", assignedGrade: 6 },
      { courseWorkId: "502", state: "returned", assignedGrade: 3 },
    ]);
    // A Classroom user the roster did not import never appears.
    expect(JSON.stringify(grades)).not.toContain("770000000999");
    expect(calls).toStrictEqual([{ kind: "course", courseId: COURSE }]);
    // The co-teacher reads it too.
    expect((await district.ok(district.tokenFor(NF.chen), "teacher.classroomGrades", ENG9)).status).toBe("ready");
  });

  it("refuses a class the teacher does not teach, and a student", async () => {
    const { district, calls } = await setup();
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.classroomGrades", ENG9), 404, "not-found");
    expectError(await district.call(district.tokenFor(NF.amara), "teacher.classroomGrades", ENG9), 403, "forbidden");
    expect(calls).toStrictEqual([]);
  });
});

describe("without Classroom", () => {
  it("answers not-connected with no Classroom connection, a roster that is not Classroom, or an offering it did not import", async () => {
    for (const options of [{ source: "none" as const }, { provider: "oneroster-csv" as const }, { linked: false }]) {
      const { district, calls } = await setup(options);
      expect(await district.ok(district.tokenFor(NF.amara), "student.classroomGrades", ENG9)).toStrictEqual({ status: "not-connected" });
      expect(await district.ok(district.tokenFor(NF.rivera), "teacher.classroomGrades", ENG9)).toStrictEqual({ status: "not-connected" });
      expect(calls).toStrictEqual([]);
    }
  });

  it("answers unavailable when Classroom cannot be read, and says why to the Worker", async () => {
    const { district, unavailable } = await setup({ source: "failing" });
    expect(await district.ok(district.tokenFor(NF.amara), "student.classroomGrades", ENG9)).toStrictEqual({ status: "unavailable" });
    expect(await district.ok(district.tokenFor(NF.rivera), "teacher.classroomGrades", ENG9)).toStrictEqual({ status: "unavailable" });
    expect(unavailable).toStrictEqual([{ surface: "student" }, { surface: "teacher" }]);
  });
});

// SCHO-428: grade return to Classroom finds an offering's course by the same rule as the panel.
describe("classroomCourseOf", () => {
  it("is the offering's Classroom course when the head roster is Classroom and imported it", async () => {
    const { district } = await setup();
    expect(await classroomCourseOf(district.stores, NF.eng9)).toBe(COURSE);
    expect(await classroomCourseOf(district.stores, NF.bio)).toBeUndefined();
  });

  it("is nothing when the roster is not Classroom, or did not import the offering", async () => {
    expect(await classroomCourseOf((await setup({ provider: "oneroster-csv" })).district.stores, NF.eng9)).toBeUndefined();
    expect(await classroomCourseOf((await setup({ linked: false })).district.stores, NF.eng9)).toBeUndefined();
  });

  it("refuses a source ID that is not a Classroom course ID", async () => {
    const { district } = await setup();
    await district.stores.rosterSources.save({ ...oneroster.EMPTY_SOURCE_MAP, offerings: { [NF.eng9]: "eng9-csv" } as never });
    expect(await classroomCourseOf(district.stores, NF.eng9)).toBeUndefined();
  });
});
