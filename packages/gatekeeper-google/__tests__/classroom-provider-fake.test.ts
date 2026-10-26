// The Classroom client, unchanged, against the wire-faithful Google Classroom fake from
// @educateos/provider-fakes seeded with its sample district: taught courses, rosters, owned
// coursework, creation, submissions, grading, Google's ownership refusal, and scope failures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClassroomApi, ClassroomNotOwnedError, isClassroomNoAccessError } from "../src/classroom-api";
import { CLASSROOM_SCOPES as S, GoogleClassroomFake, SAMPLE_DISTRICT } from "@educateos/provider-fakes";

// The scopes the Classroom resource requests (src/resources.ts).
const TEACHER = { userId: "mw-t-okafor", scopes: [S.coursesReadonly, S.rostersReadonly, S.courseworkStudents] };

let fake: GoogleClassroomFake;
let bio: string;
let lab: string;
let quiz: string;

function apiFor(grant = TEACHER): ClassroomApi {
  const token = fake.issueToken(grant);
  return new ClassroomApi(async () => token);
}

beforeEach(() => {
  // One item a page, so every listing follows nextPageToken.
  fake = new GoogleClassroomFake({ seed: SAMPLE_DISTRICT, maxPageSize: 1 });
  vi.stubGlobal("fetch", fake.fetch);
  bio = fake.courseId("mw-bio-p2");
  lab = fake.courseWorkId("mw-bio-p2-lab");
  quiz = fake.courseWorkId("mw-bio-p2-quiz");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ClassroomApi against the provider fake", () => {
  it("lists the courses the teacher teaches, page by page", async () => {
    const courses = await apiFor().listTaughtCourses();
    expect(courses.map(({ name, section, courseState }) => ({ name, section, courseState }))).toEqual([
      { name: "Biology, period 2", section: "Period 2", courseState: "ACTIVE" },
      { name: "Biology, period 4", section: "Period 4", courseState: "ACTIVE" },
    ]);
    const listed = fake.requestsTo("/v1/courses").map((r) => r.url.searchParams);
    expect(listed.map((q) => q.get("teacherId"))).toEqual(["me", "me"]);
    expect(listed[1]!.get("pageToken")).toBeTruthy();
  });

  it("reads the roster, without email addresses it never asked for", async () => {
    const roster = await apiFor().getRoster(bio);
    expect(roster.teachers).toEqual([{ userId: fake.userId("mw-t-okafor"), name: "Nia Okafor" }]);
    expect(roster.students.map(({ name }) => name)).toEqual(["Ada Brightwater", "Bo Calder", "Cleo Dunmore", "Dev Ellery", "Esme Fairhall", "Finn Garrow"]);
    expect(JSON.stringify(roster)).not.toContain("@maplewood.example");
  });

  it("answers whether the account teaches the course", async () => {
    expect(await apiFor().isTeacher(bio)).toBe(true);
    expect(await apiFor({ userId: "mw-s-01", scopes: [S.rostersReadonly] }).isTeacher(bio)).toBe(false);
    expect(await apiFor({ ...TEACHER, userId: "mw-t-quill" }).isTeacher(bio)).toBe(false);
  });

  it("lists only coursework this project created, and creates more", async () => {
    const api = apiFor();
    expect((await api.listOwnedCourseWork(bio)).map(({ id, title, state, maxPoints }) => ({ id, title, state, maxPoints })))
      .toEqual([{ id: lab, title: "Cell lab report", state: "PUBLISHED", maxPoints: 100 }]);
    const created = await api.createCourseWork(bio, { title: "Lab 2", maxPoints: 20 });
    expect(created).toMatchObject({ title: "Lab 2", state: "DRAFT", maxPoints: 20 });
    expect((await api.listOwnedCourseWork(bio)).map(({ id }) => id).toSorted()).toEqual([lab, created.id].toSorted());
    expect((await api.getOwnedCourseWork(bio, created.id)).title).toBe("Lab 2");
    await expect(api.getOwnedCourseWork(bio, quiz)).rejects.toBeInstanceOf(ClassroomNotOwnedError);
  });

  it("lists submissions, for one student too", async () => {
    const api = apiFor();
    const all = await api.listSubmissions(bio, lab);
    expect(all).toHaveLength(6);
    expect(all.find((s) => s.userId === fake.userId("mw-s-01"))).toMatchObject({ state: "TURNED_IN", draftGrade: 88 });
    const one = await api.listSubmissions(bio, lab, fake.userId("mw-s-02"));
    expect(one).toEqual([{ id: fake.submissionId("mw-bio-p2-lab", "mw-s-02"), courseWorkId: lab, userId: fake.userId("mw-s-02"), state: "TURNED_IN", alternateLink: expect.any(String) }]);
  });

  it("grades and returns a submission of the project's coursework", async () => {
    const id = fake.submissionId("mw-bio-p2-lab", "mw-s-01");
    await apiFor().gradeAndReturn(bio, lab, id, 92.5);
    expect(fake.submission(id)).toMatchObject({ assignedGrade: 92.5, draftGrade: 88, state: "RETURNED" });
    expect(fake.requests.filter((r) => r.method !== "GET").map((r) => [r.method, r.url.searchParams.get("updateMask")]))
      .toEqual([["PATCH", "assignedGrade"], ["POST", null]]);
  });

  it("turns Google's @ProjectPermissionDenied into a clear ownership error", async () => {
    const id = fake.submissionId("mw-bio-p2-quiz", "mw-s-01");
    const error = await apiFor().gradeAndReturn(bio, quiz, id, 19).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClassroomNotOwnedError);
    expect(fake.submission(id)).toMatchObject({ assignedGrade: 18 });
    // The 403 was answered once: the fixed token cannot change, so it is not replayed.
    expect(fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });

  it("fails as no-access when the token lacks a scope", async () => {
    const error = await apiFor({ ...TEACHER, scopes: [S.coursesReadonly] }).getRoster(bio).catch((e: unknown) => e);
    expect(isClassroomNoAccessError(error)).toBe(true);
    expect(String(error)).toContain("http=403");
  });

  it("refreshes a rejected token once", async () => {
    const fresh = fake.issueToken(TEACHER);
    const getToken = vi.fn(async (opts?: { forceRefresh?: boolean }) => (opts?.forceRefresh ? fresh : "ya29.revoked"));
    expect((await new ClassroomApi(getToken).getCourse(bio)).name).toBe("Biology, period 2");
    expect(getToken).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true, staleToken: "ya29.revoked" }));
  });

  it("retries a read rate-limited with RESOURCE_EXHAUSTED, and explains a write's", async () => {
    const api = apiFor();
    fake.inject({ kind: "rate-limit", retryAfterSeconds: 0, times: 1 });
    expect((await api.getCourse(bio)).name).toBe("Biology, period 2");
    expect(fake.requestsTo(`/courses/${bio}`)).toHaveLength(2);
    fake.inject({ kind: "rate-limit", retryAfterSeconds: 0, times: 1 });
    await expect(api.createCourseWork(bio, { title: "Lab 3" })).rejects.toThrow(/request quota is exhausted/);
  });

  it("tells the admin when Classroom data access is off", async () => {
    fake = new GoogleClassroomFake({ seed: SAMPLE_DISTRICT, apiDisabled: true });
    vi.stubGlobal("fetch", fake.fetch);
    await expect(apiFor().getCourse(bio)).rejects.toThrow(/Classroom data access is turned off/);
  });

  it("refuses a malformed listing item", async () => {
    fake.inject({ kind: "malformed-record", times: 1, match: { path: "/students" } });
    await expect(apiFor().getRoster(bio)).rejects.toThrow(/without an ID/);
  });
});
