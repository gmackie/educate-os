import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClassroomApi, ClassroomNotOwnedError, validateClassroomGrade,
} from "../src/classroom-api";
import { FakeClassroom, googleError } from "./classroom-fixture";

let classroom: FakeClassroom;
let api: ClassroomApi;

beforeEach(() => {
  classroom = new FakeClassroom();
  vi.stubGlobal("fetch", vi.fn(classroom.fetch));
  api = new ClassroomApi(async () => "token");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A 429 Google asks to be retried at once, so the test need not wait out a backoff. */
const exhausted = () => {
  let response = googleError(429, "RESOURCE_EXHAUSTED");
  response.headers.set("Retry-After", "0");
  return response;
};

describe("ClassroomApi reads", () => {
  it("pages through the whole roster by nextPageToken", async () => {
    let roster = await api.getRoster("101");

    expect(roster.teachers).toEqual([{ userId: "1001", name: "Ms Teacher" }]);
    expect(roster.students.map(({ userId }) => userId)).toEqual(["2001", "2002", "2003", "2004", "2005"]);
    let studentPages = classroom.requests.filter(({ path }) => path === "/courses/101/students");
    expect(studentPages.map(({ query }) => query.get("pageToken"))).toEqual([null, "2", "4"]);
  });

  // Only fields the agent types declare survive; a field Google adds, or one this connection never
  // asked for (an email address), is dropped.
  it("keeps only the declared fields", async () => {
    let roster = await api.getRoster("101");
    expect(JSON.stringify(roster)).not.toContain("@school.example");
    expect(await api.getCourse("101")).toEqual({
      id: "101", name: "Biology", section: "Period 2", courseState: "ACTIVE",
      alternateLink: "https://classroom.google.com/c/MTAx",
    });
  });

  it("lists only the coursework this project created, published and draft", async () => {
    let courseWork = await api.listOwnedCourseWork("101");

    expect(courseWork).toEqual([
      {
        id: "201", title: "Lab report", state: "PUBLISHED", maxPoints: 100,
        updateTime: new Date("2026-10-20T12:00:00Z"),
      },
      {
        id: "203", title: "Essay", state: "DRAFT", maxPoints: 100,
        updateTime: new Date("2026-10-20T12:00:00Z"),
      },
    ]);
    let listed = classroom.requests.find(({ path }) => path === "/courses/101/courseWork")!;
    expect(listed.query.getAll("courseWorkStates")).toEqual(["PUBLISHED", "DRAFT"]);
  });

  it("refuses to read coursework another project created", async () => {
    await expect(api.getOwnedCourseWork("101", "202")).rejects.toBeInstanceOf(ClassroomNotOwnedError);
    expect((await api.getOwnedCourseWork("101", "201")).title).toBe("Lab report");
  });

  it("filters submissions by student", async () => {
    let submissions = await api.listSubmissions("101", "201", "2002");
    expect(submissions).toEqual([{
      id: "Cg4Isub2", courseWorkId: "201", userId: "2002", state: "TURNED_IN", draftGrade: 80,
    }]);
  });

  // Classroom resolves `d:` and `p:` aliases too, and an alias can be repointed at another course.
  it.each(["d:biology", "../101", "101/students", ""])("refuses the course ID %j before fetching", async id => {
    await expect(api.getCourse(id)).rejects.toThrow(/Invalid Google Classroom course ID/);
    expect(classroom.requests).toEqual([]);
  });

  it("answers whether the account teaches the course", async () => {
    expect(await api.isTeacher("101")).toBe(true);
    classroom.teachers = [];
    expect(await api.isTeacher("101")).toBe(false);
  });
});

describe("ClassroomApi grading", () => {
  it("sets assignedGrade with an update mask, then returns the submission", async () => {
    await api.gradeAndReturn("101", "201", "Cg4Isub1", 87.5);

    expect(classroom.requests.map(({ method, path, query }) => [method, path, query.get("updateMask")]))
      .toEqual([
        ["GET", "/courses/101/courseWork/201/studentSubmissions/Cg4Isub1", null],
        ["PATCH", "/courses/101/courseWork/201/studentSubmissions/Cg4Isub1", "assignedGrade"],
        ["POST", "/courses/101/courseWork/201/studentSubmissions/Cg4Isub1:return", null],
      ]);
    expect(classroom.requests[1].body).toEqual({ assignedGrade: 87.5 });
    expect(classroom.submissions[0]).toMatchObject({ assignedGrade: 87.5, state: "RETURNED" });
  });

  it.each([87, 87.5, 87.25, 0.29, 0])("accepts the grade %d", grade => {
    expect(validateClassroomGrade(grade)).toBe(grade);
  });

  // Classroom rounds to two places, which would publish a grade the teacher never approved.
  it.each([87.125, 1.005, -1, Number.NaN, Infinity])("refuses the grade %d without sending it", async grade => {
    await expect(api.gradeAndReturn("101", "201", "Cg4Isub1", grade)).rejects.toThrow(/grade/);
    expect(classroom.requests).toEqual([]);
  });

  it("maps @ProjectPermissionDenied to a clear ownership error", async () => {
    let error = await api.gradeAndReturn("101", "202", "Cg4Isub9", 90).catch(error => error);

    expect(error).toBeInstanceOf(ClassroomNotOwnedError);
    expect(error.message).toMatch(/only the coursework it created/);
    // Google's own prose, which can name a student, travels nowhere.
    expect(error.message).not.toContain("Alice");
    expect(classroom.submissions[3]).not.toHaveProperty("assignedGrade");
  });
});

describe("ClassroomApi errors", () => {
  it("tells the admin to turn on Classroom data access when it is off", async () => {
    classroom.failures.push(googleError(403, "PERMISSION_DENIED", "ClassroomApiDisabled"));

    await expect(api.getCourse("101")).rejects.toThrow(
      /Classroom data access is turned off.*Admin console > Apps > Google Workspace > Classroom > Data access/);
  });

  it("retries a read Classroom answers with RESOURCE_EXHAUSTED", async () => {
    classroom.failures.push(exhausted());

    expect((await api.getCourse("101")).name).toBe("Biology");
    expect(classroom.requests).toHaveLength(2);
  });

  it("retries a grade, which is safe to send twice", async () => {
    classroom.failures.push(exhausted());

    await api.gradeAndReturn("101", "201", "Cg4Isub1", 90);
    expect(classroom.requests.map(({ method }) => method)).toEqual(["GET", "GET", "PATCH", "POST"]);
  });

  it("does not resend a creation, and explains an exhausted quota", async () => {
    classroom.failures.push(exhausted());

    await expect(api.createCourseWork("101", { title: "Lab 2" }))
      .rejects.toThrow(/request quota is exhausted/);
    expect(classroom.requests).toHaveLength(1);
    expect(classroom.courseWork).toHaveLength(3);
  });

  it("creates a draft assignment by default", async () => {
    let created = await api.createCourseWork("101", { title: "Lab 2", maxPoints: 20 });

    expect(classroom.requests[0].body).toEqual({
      title: "Lab 2", workType: "ASSIGNMENT", state: "DRAFT", maxPoints: 20,
    });
    expect(created).toMatchObject({ id: "500", title: "Lab 2", state: "DRAFT", maxPoints: 20 });
  });
});


const rubricDraft = { criteria: [{ title: "Evidence", levels: [{ title: "Supported", points: 10 }, { title: "Missing", points: 0 }] }] };

describe("Classroom Plus", () => {
  it("creates and reads only app-owned rubrics and strips undeclared provider data", async () => {
    const created = await api.createRubric("101", "201", rubricDraft);
    expect(created.criteria).toEqual(rubricDraft.criteria);
    expect(created).not.toHaveProperty("courseWorkId");
    expect(await api.listRubrics("101", "201")).toEqual([created]);
    const before = classroom.requests.length;
    await expect(api.createRubric("101", "202", rubricDraft)).rejects.toBeInstanceOf(ClassroomNotOwnedError);
    expect(classroom.requests.slice(before).map(r => r.method)).toEqual(["GET"]);
  });

  it("rejects malformed points before making requests", async () => {
    await expect(api.createRubric("101", "201", { criteria: [{ title: "Evidence", levels: [{ title: "Bad", points: NaN }] }] })).rejects.toThrow(/points/);
    expect(classroom.requests).toEqual([]);
  });

  it("propagates an ineligible teacher refusal without creating a rubric", async () => {
    classroom.intercept = r => r.path.endsWith("/rubrics") ? googleError(403, "PERMISSION_DENIED", "UserIneligibleToUpdateGradingPeriodSettings") : undefined;
    await expect(api.createRubric("101", "201", rubricDraft)).rejects.toThrow();
    expect(classroom.rubrics).toEqual([]);
    expect(classroom.requests.filter(r => r.method === "POST")).toHaveLength(1);
  });

  it("reads empty and configured grading periods without leaking other fields", async () => {
    expect(await api.getGradingPeriodSettings("101")).toEqual({ gradingPeriods: [] });
    classroom.gradingPeriodSettings = { gradingPeriods: [{ id: "p1", title: "Fall", startDate: { year: 2026, month: 9, day: 1 }, endDate: { year: 2026, month: 12, day: 31 }, extra: "private" }], extra: "private" };
    expect(await api.getGradingPeriodSettings("101")).toEqual({ gradingPeriods: [{ id: "p1", title: "Fall", startDate: { year: 2026, month: 9, day: 1 }, endDate: { year: 2026, month: 12, day: 31 } }] });
    classroom.gradingPeriodSettings = { gradingPeriods: [{ id: "p1", title: "Bad", startDate: { year: 2026, month: 2, day: 30 }, endDate: { year: 2026, month: 12, day: 31 } }] };
    await expect(api.getGradingPeriodSettings("101")).rejects.toThrow(/date/);
  });
});


it("refuses to mutate a grade before student turn-in, and regrades returned work without returning twice", async () => {
  classroom.submissions[0].state = "CREATED";
  await expect(api.gradeAndReturn("101", "201", "Cg4Isub1", 8.5)).rejects.toThrow(/not been turned in/);
  expect(classroom.requests.map(r => r.method)).toEqual(["GET"]);
  expect(classroom.submissions[0]).not.toHaveProperty("assignedGrade");
  classroom.submissions[0].state = "RETURNED";
  await api.gradeAndReturn("101", "201", "Cg4Isub1", 8.5);
  expect(classroom.requests.map(r => r.method)).toEqual(["GET", "GET", "PATCH"]);
});
