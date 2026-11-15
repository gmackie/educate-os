// SCHO-403: live, read-only Classroom grade reads for the "From Google Classroom" panel, against the
// wire-faithful Classroom fake seeded with Harbor. A student's read asks Classroom for their own
// returned work only; a class read lists every student's submissions; caps and failures hold.
import { demoDistrict } from "@educateos/fixtures";
import { GoogleClassroomFake, type AssignmentSeed } from "@educateos/provider-fakes";
import { describe, expect, it } from "vitest";
import { googleclassroom } from "../src/index.ts";
import { classroomDistrictSeed, emailOf, fakeDelegation } from "./fixtures/classroom-district.ts";

const MARINE = "off_hb-marine-b1";
const NIA = "prn_hb-student-nia";
const OWEN = "prn_hb-student-owen";

/** Teacher-made Marine Science work: Nia's returned 8/10, Owen's turned-in work, an ungraded returned reflection. */
const WORK: AssignmentSeed[] = [
  {
    id: "hb-marine-quiz", sectionId: MARINE, title: "Tide quiz", maxPoints: 10,
    submissions: [
      { studentId: NIA, state: "RETURNED", assignedGrade: 8, draftGrade: 8 },
      { studentId: OWEN, state: "TURNED_IN", draftGrade: 6 },
    ],
  },
  {
    id: "hb-marine-reflection", sectionId: MARINE, title: "Reflection",
    submissions: [{ studentId: NIA, state: "RETURNED" }, { studentId: OWEN, state: "RETURNED", assignedGrade: 3 }],
  },
];

function harbor(options: { scopes?: readonly string[]; work?: AssignmentSeed[]; limits?: Partial<googleclassroom.ClassroomGradeReadLimits> } = {}) {
  const seed = classroomDistrictSeed(demoDistrict("harbor"), options.work ?? WORK);
  const fake = new GoogleClassroomFake({ seed, maxPageSize: 3 });
  const tokens = fakeDelegation(fake, seed, options.scopes ?? googleclassroom.CLASSROOM_GRADE_READ_SCOPES);
  const client = new googleclassroom.GoogleClassroomClient({
    tokens, admin: emailOf(seed, "prn_hb-school-admin"), fetch: fake.fetch, pageSize: 2, sleep: async () => {},
  });
  const reader = new googleclassroom.ClassroomGradeReader(client, { ...googleclassroom.DEFAULT_CLASSROOM_GRADE_READ_LIMITS, ...options.limits });
  return { fake, reader, courseId: fake.courseId(MARINE), tokens };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && "code" in error) return String(error.code);
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("a student's Classroom grades", () => {
  it("asks Classroom for their own returned submissions only, with each coursework's points", async () => {
    const { fake, reader, courseId } = harbor();
    const read = await reader.student(courseId, fake.userId(NIA));

    const titles = new Map(read.courseWork.map((w) => [w.id, w]));
    expect(read.submissions.map((s) => ({ title: titles.get(s.courseWorkId!)?.title, grade: s.assignedGrade, state: s.state })).toSorted((a, b) => a.title!.localeCompare(b.title!))).toStrictEqual([
      { title: "Reflection", grade: undefined, state: "RETURNED" },
      { title: "Tide quiz", grade: 8, state: "RETURNED" },
    ]);
    expect(titles.get(fake.courseWorkId("hb-marine-quiz"))).toMatchObject({ maxPoints: 10, alternateLink: expect.stringMatching(/^https:\/\/classroom\.google\.com\//) });
    expect(read.courseLink).toMatch(/^https:\/\/classroom\.google\.com\/c\//);
    expect(read.truncated).toBe(false);
    // One filtered listing across the course's coursework, as its owner: Owen's work is never fetched.
    const lists = fake.requests.filter((r) => r.url.pathname.endsWith("/studentSubmissions"));
    expect(lists.length).toBeGreaterThan(0);
    for (const r of lists) {
      expect(r.url.pathname).toContain("/courseWork/-/");
      expect(r.url.searchParams.get("userId")).toBe(fake.userId(NIA));
      expect(r.url.searchParams.getAll("states")).toStrictEqual(["RETURNED"]);
    }
    expect(read.submissions.every((s) => s.userId === fake.userId(NIA))).toBe(true);
  });

  it("is empty when nothing has been returned to them", async () => {
    const { fake, reader, courseId } = harbor();
    const read = await reader.student(courseId, fake.userId("prn_hb-student-pia"));
    expect(read.submissions).toStrictEqual([]);
  });
});

describe("a class's Classroom grades", () => {
  it("lists every student's submissions, returned and turned in", async () => {
    const { fake, reader, courseId } = harbor();
    const read = await reader.course(courseId);
    const quiz = fake.courseWorkId("hb-marine-quiz");
    const of = (personId: string) => read.submissions.find((s) => s.courseWorkId === quiz && s.userId === fake.userId(personId));
    expect(of(NIA)).toMatchObject({ state: "RETURNED", assignedGrade: 8 });
    expect(of(OWEN)).toMatchObject({ state: "TURNED_IN" });
    expect(of(OWEN)).not.toHaveProperty("assignedGrade");
    expect(read.courseWork.map((w) => w.title).toSorted()).toStrictEqual(["Reflection", "Tide quiz"]);
  });

  it("caps coursework and submissions and says so", async () => {
    const { reader, courseId } = harbor({ limits: { maxCourseWork: 1, maxSubmissions: 2 } });
    const read = await reader.course(courseId);
    expect(read.truncated).toBe(true);
    expect(read.courseWork).toHaveLength(1);
    expect(read.submissions.length).toBeLessThanOrEqual(2);
    expect(read.submissions.every((s) => s.courseWorkId === read.courseWork[0]!.id)).toBe(true);
  });
});

describe("Classroom failures", () => {
  it("reject, so the caller can say Classroom is unavailable", async () => {
    const down = harbor();
    down.fake.inject({ kind: "outage" });
    expect(await code(down.reader.course(down.courseId))).toBe("source-unavailable");

    // Without a coursework scope, Classroom refuses the read.
    const roster = harbor({ scopes: googleclassroom.CLASSROOM_ROSTER_SCOPES });
    expect(await code(roster.reader.student(roster.courseId, roster.fake.userId(NIA)))).toBe("auth-failed");
  });

  it("gives up at the deadline", async () => {
    const { courseId, fake } = harbor();
    const slow = new googleclassroom.ClassroomGradeReader(new googleclassroom.GoogleClassroomClient({
      tokens: fakeDelegation(fake, classroomDistrictSeed(demoDistrict("harbor"), WORK), googleclassroom.CLASSROOM_GRADE_READ_SCOPES),
      admin: "hb-school-admin@harbor.gedu.example",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return fake.fetch(input, init);
      }) as typeof fetch,
      sleep: async () => {},
    }), { ...googleclassroom.DEFAULT_CLASSROOM_GRADE_READ_LIMITS, deadlineMs: 5 });
    expect(await code(slow.course(courseId))).toBe("source-unavailable");
  });

  it("refuses a malformed submission list rather than show part of it", async () => {
    const { fake, reader, courseId } = harbor();
    fake.inject({ kind: "malformed-record", match: { path: /studentSubmissions$/ } });
    expect(await code(reader.course(courseId))).toBe("invalid-response");
  });
});
