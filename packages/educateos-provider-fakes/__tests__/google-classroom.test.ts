// Contract tests of the Google Classroom fake against Google's Classroom REST reference: course,
// roster, coursework and submission shapes, visibility, `me`, paging with opaque tokens, scopes,
// the developer-project rule, Google's error bodies, and each fault kind.
import { describe, expect, it } from "vitest";
import { CLASSROOM_SCOPES as S, GoogleClassroomFake } from "../src/google-classroom/index.ts";
import type { ClassroomGrant } from "../src/google-classroom/index.ts";
import { SAMPLE_DISTRICT } from "../src/sample.ts";

const TEACHER_SCOPES = [S.coursesReadonly, S.rostersReadonly, S.courseworkStudents];
const BASE = "https://classroom.googleapis.com/v1";

function setup(options: { maxPageSize?: number; apiDisabled?: boolean } = {}) {
  const clock = { ms: Date.parse("2026-10-25T10:00:00.000Z") };
  const fake = new GoogleClassroomFake({
    seed: SAMPLE_DISTRICT,
    now: () => clock.ms,
    tokens: {
      okafor: { userId: "mw-t-okafor", scopes: TEACHER_SCOPES },
      quill: { userId: "mw-t-quill", scopes: TEACHER_SCOPES },
      ada: { userId: "mw-s-01", scopes: [S.coursesReadonly, S.rostersReadonly, S.courseworkMe] },
    },
    ...options,
  });
  const call = async (token: string | undefined, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
    const response = await fake.fetch(`${BASE}${path}`, { ...init, headers });
    return { response, body: (await response.json()) as Record<string, any> };
  };
  const as = (grant: ClassroomGrant) => fake.issueToken(grant);
  const bio = fake.courseId("mw-bio-p2");
  const lab = fake.courseWorkId("mw-bio-p2-lab");
  const quiz = fake.courseWorkId("mw-bio-p2-quiz");
  return { fake, clock, call, as, bio, lab, quiz };
}

describe("courses", () => {
  it("lists the courses a teacher teaches, and a student attends, by me", async () => {
    const { call, fake } = setup();
    const taught = await call("okafor", "/courses?teacherId=me&courseStates=ACTIVE");
    expect(taught.body.courses.map((c: { name: string }) => c.name)).toEqual(["Biology, period 2", "Biology, period 4"]);
    expect(taught.body.courses[0]).toMatchObject({
      id: fake.courseId("mw-bio-p2"),
      section: "Period 2",
      room: "R202",
      ownerId: fake.userId("mw-t-okafor"),
      courseState: "ACTIVE",
      enrollmentCode: expect.stringMatching(/^[a-z0-9]{7}$/),
      alternateLink: expect.stringMatching(/^https:\/\/classroom\.google\.com\/c\//),
    });
    const attended = await call("ada", "/courses?studentId=me");
    expect(attended.body.courses.map((c: { name: string }) => c.name)).toEqual(["Biology, period 2", "English 9, period 1"]);
    // Students never see the enrollment code.
    expect(attended.body.courses[0]).not.toHaveProperty("enrollmentCode");
    // Google omits an empty list.
    expect((await call("ada", "/courses?teacherId=me")).body).toEqual({});
    expect((await call("okafor", `/courses?studentId=${fake.userId("mw-s-01")}`)).body.courses).toHaveLength(1);
    expect((await call("okafor", "/courses?teacherId=ada.brightwater@maplewood.example")).body).toEqual({});
  });

  it("hides a course from someone outside it, and 404s an unknown one", async () => {
    const { call, bio } = setup();
    expect((await call("okafor", `/courses/${bio}`)).response.status).toBe(200);
    const outsider = await call("quill", `/courses/${bio}`);
    expect(outsider.response.status).toBe(403);
    expect(outsider.body.error).toMatchObject({ code: 403, status: "PERMISSION_DENIED" });
    expect((await call("okafor", "/courses/123")).body.error).toMatchObject({ code: 404, status: "NOT_FOUND" });
  });

  it("pages with opaque tokens bound to the request, returning fewer than asked", async () => {
    const { call } = setup({ maxPageSize: 1 });
    const first = await call("okafor", "/courses?teacherId=me&pageSize=100");
    expect(first.body.courses).toHaveLength(1);
    const token = first.body.nextPageToken as string;
    expect(token).not.toMatch(/^\d+$/);
    const second = await call("okafor", `/courses?teacherId=me&pageSize=100&pageToken=${token}`);
    expect(second.body.courses).toHaveLength(1);
    expect(second.body).not.toHaveProperty("nextPageToken");
    expect((await call("okafor", `/courses?studentId=me&pageToken=${token}`)).body.error.status).toBe("INVALID_ARGUMENT");
  });
});

describe("rosters", () => {
  it("lists teachers and students with names, and email only under profile.emails", async () => {
    const { call, as, bio, fake } = setup();
    const students = await call("okafor", `/courses/${bio}/students`);
    expect(students.body.students).toHaveLength(6);
    expect(students.body.students[0]).toEqual({
      courseId: bio,
      userId: fake.userId("mw-s-01"),
      profile: { id: fake.userId("mw-s-01"), name: { givenName: "Ada", familyName: "Brightwater", fullName: "Ada Brightwater" } },
    });
    const withEmail = await call(as({ userId: "mw-t-okafor", scopes: [S.rostersReadonly, S.profileEmails] }), `/courses/${bio}/students`);
    expect(withEmail.body.students[0].profile.emailAddress).toBe("ada.brightwater@maplewood.example");
  });

  it("answers teachers/me for a teacher, and 404s it for a student", async () => {
    const { call, bio } = setup();
    expect((await call("okafor", `/courses/${bio}/teachers/me`)).response.status).toBe(200);
    expect((await call("ada", `/courses/${bio}/teachers/me`)).response.status).toBe(404);
    expect((await call("ada", `/courses/${bio}/students/me`)).response.status).toBe(200);
  });
});

describe("coursework", () => {
  it("lists published work by default, and drafts only to teachers", async () => {
    const { call, bio, lab, quiz } = setup();
    const created = await call("okafor", `/courses/${bio}/courseWork`, { method: "POST", body: JSON.stringify({ title: "Draft lab", workType: "ASSIGNMENT" }) });
    expect(created.body).toMatchObject({ title: "Draft lab", state: "DRAFT", associatedWithDeveloper: true, workType: "ASSIGNMENT" });
    const published = await call("okafor", `/courses/${bio}/courseWork`);
    expect(published.body.courseWork.map((w: { id: string }) => w.id).toSorted()).toEqual([lab, quiz].toSorted());
    const both = await call("okafor", `/courses/${bio}/courseWork?courseWorkStates=PUBLISHED&courseWorkStates=DRAFT`);
    expect(both.body.courseWork).toHaveLength(3);
    const student = await call("ada", `/courses/${bio}/courseWork?courseWorkStates=PUBLISHED&courseWorkStates=DRAFT`);
    expect(student.body.courseWork).toHaveLength(2);
    expect((await call("ada", `/courses/${bio}/courseWork/${created.body.id}`)).response.status).toBe(404);
  });

  it("marks only the project's coursework associatedWithDeveloper, and omits it otherwise", async () => {
    const { call, bio, lab, quiz } = setup();
    expect((await call("okafor", `/courses/${bio}/courseWork/${lab}`)).body).toMatchObject({
      associatedWithDeveloper: true,
      maxPoints: 100,
      dueDate: { year: 2026, month: 10, day: 30 },
      dueTime: { hours: 23, minutes: 59 },
    });
    expect((await call("okafor", `/courses/${bio}/courseWork/${quiz}`)).body).not.toHaveProperty("associatedWithDeveloper");
  });

  it("refuses creation to a student, a malformed body, and a token without coursework.students", async () => {
    const { call, as, bio } = setup();
    const body = JSON.stringify({ title: "X", workType: "ASSIGNMENT" });
    expect((await call(as({ userId: "mw-s-01", scopes: [S.courseworkStudents] }), `/courses/${bio}/courseWork`, { method: "POST", body })).response.status).toBe(403);
    expect((await call("okafor", `/courses/${bio}/courseWork`, { method: "POST", body: JSON.stringify({ title: "X" }) })).body.error.status).toBe("INVALID_ARGUMENT");
    expect((await call("okafor", `/courses/${bio}/courseWork`, { method: "POST", body: JSON.stringify({ title: "X", workType: "ASSIGNMENT", colour: 1 }) })).response.status).toBe(400);
    const scoped = await call("ada", `/courses/${bio}/courseWork`, { method: "POST", body });
    expect(scoped.response.status).toBe(403);
    expect(scoped.body.error.details[0]).toMatchObject({ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" });
  });

  it("gives published new coursework a NEW submission per student", async () => {
    const { call, bio } = setup();
    const created = await call("okafor", `/courses/${bio}/courseWork`, { method: "POST", body: JSON.stringify({ title: "Quiz 2", workType: "ASSIGNMENT", state: "PUBLISHED" }) });
    const subs = await call("okafor", `/courses/${bio}/courseWork/${created.body.id}/studentSubmissions`);
    expect(subs.body.studentSubmissions).toHaveLength(6);
    expect(subs.body.studentSubmissions.every((s: { state: string }) => s.state === "NEW")).toBe(true);
  });
});

describe("submissions", () => {
  it("lists every coursework's submissions with -, filtered by userId and states", async () => {
    const { call, bio, fake, lab } = setup();
    const all = await call("okafor", `/courses/${bio}/courseWork/-/studentSubmissions`);
    expect(all.body.studentSubmissions).toHaveLength(12);
    const ada = await call("okafor", `/courses/${bio}/courseWork/-/studentSubmissions?userId=${fake.userId("mw-s-01")}`);
    expect(ada.body.studentSubmissions).toHaveLength(2);
    const turnedIn = await call("okafor", `/courses/${bio}/courseWork/${lab}/studentSubmissions?states=TURNED_IN`);
    expect(turnedIn.body.studentSubmissions.map((s: { userId: string }) => s.userId)).toEqual([fake.userId("mw-s-01"), fake.userId("mw-s-02")]);
    expect(turnedIn.body.studentSubmissions[0]).toMatchObject({ draftGrade: 88, associatedWithDeveloper: true, courseWorkType: "ASSIGNMENT" });
    // A student sees only their own.
    expect((await call("ada", `/courses/${bio}/courseWork/-/studentSubmissions`)).body.studentSubmissions).toHaveLength(2);
  });

  it("grades and returns the project's coursework", async () => {
    const { call, bio, lab, fake } = setup();
    const id = fake.submissionId("mw-bio-p2-lab", "mw-s-01");
    const path = `/courses/${bio}/courseWork/${lab}/studentSubmissions/${id}`;
    const patched = await call("okafor", `${path}?updateMask=assignedGrade,draftGrade`, { method: "PATCH", body: JSON.stringify({ assignedGrade: 91.256, draftGrade: 91 }) });
    expect(patched.body).toMatchObject({ assignedGrade: 91.26, draftGrade: 91, state: "TURNED_IN" });
    expect((await call("okafor", `${path}:return`, { method: "POST", body: "{}" })).body).toEqual({});
    expect(fake.submission(id)).toMatchObject({ state: "RETURNED", assignedGrade: 91.26 });
  });

  it("refuses a patch body that is not an object, keeping the grades", async () => {
    const { call, bio, lab, fake } = setup();
    const id = fake.submissionId("mw-bio-p2-lab", "mw-s-01");
    const path = `/courses/${bio}/courseWork/${lab}/studentSubmissions/${id}?updateMask=draftGrade`;
    for (const body of ["null", "[]", "5"]) {
      expect((await call("okafor", path, { method: "PATCH", body })).response.status).toBe(400);
    }
    expect(fake.submission(id)).toMatchObject({ draftGrade: 88 });
  });

  it("requires an update mask of grade fields", async () => {
    const { call, bio, lab, fake } = setup();
    const path = `/courses/${bio}/courseWork/${lab}/studentSubmissions/${fake.submissionId("mw-bio-p2-lab", "mw-s-01")}`;
    expect((await call("okafor", path, { method: "PATCH", body: "{}" })).body.error.status).toBe("INVALID_ARGUMENT");
    expect((await call("okafor", `${path}?updateMask=state`, { method: "PATCH", body: "{}" })).body.error.status).toBe("INVALID_ARGUMENT");
  });

  it("refuses to change another project's coursework with @ProjectPermissionDenied", async () => {
    const { call, bio, quiz, fake } = setup();
    const path = `/courses/${bio}/courseWork/${quiz}/studentSubmissions/${fake.submissionId("mw-bio-p2-quiz", "mw-s-01")}`;
    for (const [suffix, method] of [["?updateMask=assignedGrade", "PATCH"], [":return", "POST"]] as const) {
      const refused = await call("okafor", `${path}${suffix}`, { method, body: JSON.stringify({ assignedGrade: 1 }) });
      expect(refused.response.status).toBe(403);
      expect(refused.body.error).toMatchObject({ code: 403, status: "PERMISSION_DENIED", message: expect.stringMatching(/^@ProjectPermissionDenied /) });
    }
    expect(fake.submission(fake.submissionId("mw-bio-p2-quiz", "mw-s-01"))).toMatchObject({ assignedGrade: 18 });
  });

  it("lets a student turn in, after the due date as late", async () => {
    const { call, bio, lab, fake, clock } = setup();
    clock.ms = Date.parse("2026-11-01T00:00:00Z");
    const id = fake.submissionId("mw-bio-p2-lab", "mw-s-01");
    const path = `/courses/${bio}/courseWork/${lab}/studentSubmissions/${id}`;
    // Already turned in.
    expect((await call("ada", `${path}:turnIn`, { method: "POST", body: "{}" })).body.error.status).toBe("FAILED_PRECONDITION");
    const other = await call("ada", `/courses/${bio}/courseWork/${lab}/studentSubmissions/${fake.submissionId("mw-bio-p2-lab", "mw-s-02")}`);
    expect(other.response.status).toBe(403);
    expect((await call("okafor", `${path}:return`, { method: "POST", body: "{}" })).response.status).toBe(200);
    // A returned submission can be resubmitted.
    expect((await call("ada", `${path}:turnIn`, { method: "POST", body: "{}" })).body).toEqual({});
    const s3 = fake.submissionId("mw-bio-p2-lab", "mw-s-03");
    const turned = await call(fake.issueToken({ userId: "mw-s-03", scopes: [S.courseworkMe] }), `/courses/${bio}/courseWork/${lab}/studentSubmissions/${s3}:turnIn`, { method: "POST", body: "{}" });
    expect(turned.body).toEqual({});
    expect(fake.submission(s3)).toMatchObject({ state: "TURNED_IN", late: true });
  });
});

describe("authentication and errors", () => {
  it("answers a missing or unknown token with 401 UNAUTHENTICATED", async () => {
    const { call, fake, clock } = setup();
    for (const token of [undefined, "ya29.unknown"]) {
      const { response, body } = await call(token, "/courses");
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toMatch(/^Bearer realm=/);
      expect(body.error).toMatchObject({ code: 401, status: "UNAUTHENTICATED" });
    }
    const short = fake.issueToken({ userId: "mw-t-okafor", scopes: TEACHER_SCOPES }, 60);
    clock.ms += 61_000;
    expect((await call(short, "/courses")).response.status).toBe(401);
  });

  it("refuses a method its scopes do not cover", async () => {
    const { call, as } = setup();
    const { response, body } = await call(as({ userId: "mw-t-okafor", scopes: [S.rostersReadonly] }), "/courses");
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(body.error.details[0].metadata.method).toBe("google.classroom.v1.Courses.ListCourses");
  });

  it("reports Classroom data access turned off with @ClassroomApiDisabled", async () => {
    const { call } = setup({ apiDisabled: true });
    expect((await call("okafor", "/courses")).body.error.message).toMatch(/^@ClassroomApiDisabled /);
  });
});

describe("routing", () => {
  it("answers only the methods and verbs Classroom defines, and 404s a malformed path", async () => {
    const { call, bio, lab } = setup();
    expect((await call("okafor", `/courses/${bio}`, { method: "PATCH", body: "{}" })).response.status).toBe(404);
    expect((await call("okafor", `/courses/${bio}`, { method: "DELETE" })).response.status).toBe(404);
    expect((await call("okafor", `/courses/${bio}/courseWork/${lab}:bogus`)).response.status).toBe(404);
    expect((await call("okafor", "/courses/%E0")).response.status).toBe(404);
  });
});

describe("faults", () => {
  it("rate-limits with Retry-After and RESOURCE_EXHAUSTED", async () => {
    const { call, fake } = setup();
    fake.inject({ kind: "rate-limit", retryAfterSeconds: 2, times: 1 });
    const { response, body } = await call("okafor", "/courses");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(body.error).toMatchObject({ code: 429, status: "RESOURCE_EXHAUSTED", details: [expect.objectContaining({ reason: "RATE_LIMIT_EXCEEDED" })] });
    expect((await call("okafor", "/courses")).response.status).toBe(200);
  });

  it("serves an outage as UNAVAILABLE, and fails the connection on a network error", async () => {
    const { call, fake } = setup();
    fake.inject({ kind: "outage", times: 1 });
    expect((await call("okafor", "/courses")).body.error).toMatchObject({ code: 503, status: "UNAVAILABLE" });
    fake.inject({ kind: "network-error", times: 1 });
    await expect(call("okafor", "/courses")).rejects.toBeInstanceOf(TypeError);
  });

  it("breaks one item of the next list page", async () => {
    const { call, fake, bio } = setup();
    fake.inject({ kind: "malformed-record", times: 1, match: { path: "/students" } });
    const [broken, intact] = (await call("okafor", `/courses/${bio}/students`)).body.students;
    expect(broken).not.toHaveProperty("userId");
    expect(intact).toHaveProperty("userId");
    expect((await call("okafor", `/courses/${bio}/students`)).body.students[0]).toHaveProperty("userId");
  });

  it("removes a large share of students from rosters, with their submissions", async () => {
    const { call, fake, bio } = setup();
    fake.inject({ kind: "large-removal", fraction: 0.5 });
    expect((await call("okafor", `/courses/${bio}/students`)).body.students).toHaveLength(1);
    expect((await call("okafor", `/courses/${bio}/courseWork/-/studentSubmissions`)).body.studentSubmissions).toHaveLength(2);
  });
});
