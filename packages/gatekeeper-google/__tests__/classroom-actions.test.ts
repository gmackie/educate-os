import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionJournal, APPLY_OUTCOME_UNKNOWN_MESSAGE } from "@gadgets/gatekeeper-kit/actions";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { CLASSROOM_ACTIONS, type ClassroomAction, type ClassroomGrade } from "../src/classroom-actions";
import { ClassroomApi } from "../src/classroom-api";
import { FakeClassroom, googleError } from "./classroom-fixture";
import { FakeKv } from "./fake-kv";

let classroom: FakeClassroom;
let journal: ActionJournal<ClassroomAction>;
let submitted: ActionDescription[];
let actions: ReturnType<typeof CLASSROOM_ACTIONS.bind>;
const queue = {
  submitAction: async (_id: number, description: ActionDescription) => { submitted.push(description); },
};

beforeEach(() => {
  classroom = new FakeClassroom();
  vi.stubGlobal("fetch", vi.fn(classroom.fetch));
  journal = new ActionJournal<ClassroomAction>(new FakeKv(), { namespace: "classroom" });
  submitted = [];
  actions = CLASSROOM_ACTIONS.bind(journal, {
    api: new ClassroomApi(async () => "token"), courseId: "101",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const grade = (overrides: Partial<ClassroomGrade> = {}): ClassroomGrade => ({
  courseWorkId: "201", courseWorkTitle: "Lab report", maxPoints: 100, submissionId: "Cg4Isub1",
  userId: "2001", assignedGrade: 92.5, ...overrides,
});

describe("Classroom coursework creation", () => {
  it("queues the assignment, and creates it only once approved", async () => {
    let id = await actions.submit(queue, "createCourseWork", { draft: { title: "Lab 2", maxPoints: 20 } });

    expect(submitted[0].title).toBe("Create Classroom assignment: Lab 2");
    expect(submitted[0].description).toMatch(/created as a draft/);
    expect(submitted[0].fields).toContainEqual(expect.objectContaining({ label: "Assignment", kind: "json" }));
    expect(classroom.requests).toEqual([]);

    await actions.apply(id);

    expect(classroom.courseWork.at(-1)).toMatchObject({
      title: "Lab 2", maxPoints: 20, state: "DRAFT", associatedWithDeveloper: true,
    });
    expect((await new ClassroomApi(async () => "token").listOwnedCourseWork("101")).map(({ title }) => title))
      .toContain("Lab 2");
  });

  it("warns the approver when the assignment is published to the class", async () => {
    await actions.submit(queue, "createCourseWork", { draft: { title: "Quiz", state: "PUBLISHED" } });
    expect(submitted[0].description).toMatch(/\*\*published\*\*/);
  });

  // Classroom takes no request ID, so a creation whose response was lost may exist already.
  it("never resends a creation whose outcome is unknown", async () => {
    let id = await actions.submit(queue, "createCourseWork", { draft: { title: "Lab 2" } });
    classroom.failures.push(googleError(503, "UNAVAILABLE"));

    await expect(actions.apply(id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(journal.get(id)).toMatchObject({ state: "failed", outcome: "unknown" });
    await expect(actions.apply(id)).rejects.toThrow();
    expect(classroom.requests.filter(({ method }) => method === "POST")).toHaveLength(1);
  });

  it("leaves a creation Classroom throttled pending, to apply again", async () => {
    let id = await actions.submit(queue, "createCourseWork", { draft: { title: "Lab 2" } });
    classroom.failures.push(googleError(429, "RESOURCE_EXHAUSTED"));

    await expect(actions.apply(id)).rejects.toThrow(/quota/);
    expect(journal.get(id)?.state).toBe("pending");
    await actions.apply(id);
    expect(classroom.courseWork.at(-1)).toMatchObject({ title: "Lab 2" });
  });
});

describe("Classroom grade passback", () => {
  it("patches assignedGrade, then returns the submission, once approved", async () => {
    let id = await actions.submit(queue, "setGrade", grade());

    expect(submitted[0].title).toBe("Grade Classroom submission: 92.5 out of 100");
    expect(submitted[0].description).toMatch(/return it to the student/);
    expect(classroom.requests).toEqual([]);

    await actions.apply(id);

    expect(classroom.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /courses/101/courseWork/201/studentSubmissions/Cg4Isub1",
      "PATCH /courses/101/courseWork/201/studentSubmissions/Cg4Isub1",
      "POST /courses/101/courseWork/201/studentSubmissions/Cg4Isub1:return",
    ]);
    expect(classroom.submissions[0]).toMatchObject({ assignedGrade: 92.5, state: "RETURNED" });
    expect(journal.listPending()).toEqual([]);
  });

  it("fails a grade for another project's coursework with the ownership error", async () => {
    let id = await actions.submit(queue, "setGrade", grade({ courseWorkId: "202", submissionId: "Cg4Isub9" }));

    await expect(actions.apply(id)).rejects.toThrow(/only the coursework it created/);
    expect(journal.get(id)).toMatchObject({ state: "failed", error: expect.stringMatching(/created/) });
    expect(classroom.submissions[3]).not.toHaveProperty("assignedGrade");
  });

  it("applies an interrupted grade again", async () => {
    let id = await actions.submit(queue, "setGrade", grade());
    // The grade lands, but returning the submission keeps failing past the retries.
    classroom.intercept = ({ path }) => {
      if (!path.endsWith(":return")) return undefined;
      let response = googleError(503, "UNAVAILABLE");
      response.headers.set("Retry-After", "0");
      return response;
    };

    await expect(actions.apply(id)).rejects.toThrow(/http=503/);
    expect(journal.get(id)?.state).toBe("pending");
    expect(classroom.submissions[0]).toMatchObject({ assignedGrade: 92.5, state: "TURNED_IN" });

    classroom.intercept = undefined;
    await actions.apply(id);
    expect(classroom.submissions[0]).toMatchObject({ assignedGrade: 92.5, state: "RETURNED" });
  });
});


describe("Classroom rubric approval", () => {
  const draft = { criteria: [{ title: "Evidence", levels: [{ title: "Supported", points: 10 }] }] };
  it("writes only after approval, and never repeats an uncertain creation", async () => {
    const id = await actions.submit(queue, "createRubric", { courseWorkId: "201", draft });
    expect(classroom.requests).toEqual([]);
    expect(submitted[0].title).toBe("Create Google Classroom rubric");
    classroom.intercept = request => request.method === "POST" ? googleError(503, "UNAVAILABLE") : undefined;
    await expect(actions.apply(id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    await expect(actions.apply(id)).rejects.toThrow();
    expect(classroom.requests.filter(r => r.method === "POST")).toHaveLength(1);
  });
  it("creates an approved rubric on the bound course", async () => {
    const id = await actions.submit(queue, "createRubric", { courseWorkId: "201", draft });
    await actions.apply(id);
    expect(classroom.rubrics).toHaveLength(1);
    expect(classroom.requests.filter(r => r.method === "POST").map(r => r.path)).toEqual(["/courses/101/courseWork/201/rubrics"]);
  });
});
