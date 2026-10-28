import { RpcStub, RpcTarget } from "cloudflare:workers";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import type {
  ActionDescription, ApprovalQueue, GitCache, HookController, HookDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLASSROOM_ACTIONS, type ClassroomAction } from "../../src/classroom-actions";
import { ClassroomApi } from "../../src/classroom-api";
import { GoogleClassroomCourseSessionImpl } from "../../src/classroom";
import { FakeClassroom } from "../classroom-fixture";
import { FakeKv } from "../fake-kv";

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly observations: ObservationDescription[] = [];
  readonly submitted: ActionDescription[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
  }

  async getGitCache(): Promise<GitCache> {
    throw new Error("Unexpected git cache access");
  }

  async submitAction(_action: number, description: ActionDescription): Promise<void> {
    this.submitted.push(description);
  }

  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>, _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    throw new Error("Unexpected hook binding");
  }
}

let classroom: FakeClassroom;
let queue: TestApprovalQueue;
let journal: ActionJournal<ClassroomAction>;
let actions: ReturnType<typeof CLASSROOM_ACTIONS.bind>;
let session: GoogleClassroomCourseSessionImpl;

beforeEach(() => {
  classroom = new FakeClassroom();
  vi.stubGlobal("fetch", vi.fn(classroom.fetch));
  queue = new TestApprovalQueue();
  journal = new ActionJournal<ClassroomAction>(new FakeKv(), { namespace: "classroom" });
  let api = new ClassroomApi(async () => "token");
  actions = CLASSROOM_ACTIONS.bind(journal, { api, courseId: "101" });
  let stub = new RpcStub<ApprovalQueue>(queue);
  session = new GoogleClassroomCourseSessionImpl(api, "101", stub, {
    pending: () => journal.listPending(),
    submit: async (kind, payload) => { await actions.submit(stub, kind, payload); },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const writes = () => classroom.requests.filter(({ method }) => method !== "GET");

describe("Google Classroom course session", () => {
  it("records each read as an observation", async () => {
    let roster = await session.getRoster();

    expect(roster.students).toHaveLength(5);
    expect(queue.observations.map(({ description }) => description)).toEqual([
      "Read the roster of Google Classroom course 101: 1 teacher(s) and 5 student(s).",
    ]);
  });

  it("lists owned coursework, with a queued creation shown as pending", async () => {
    await session.createCourseWork({ title: "Lab 2", maxPoints: 20 });
    expect(queue.submitted.map(({ title }) => title)).toEqual(["Create Classroom assignment: Lab 2"]);
    expect(writes()).toEqual([]);

    let listed = await session.listCourseWork();

    expect(listed.map(({ id, title, pending }) => ({ id, title, pending }))).toEqual([
      { id: "201", title: "Lab report", pending: undefined },
      { id: "203", title: "Essay", pending: undefined },
      { id: "pending:create:1", title: "Lab 2", pending: true },
    ]);
    expect(await session.getCourseWork("pending:create:1"))
      .toEqual({ id: "pending:create:1", title: "Lab 2", state: "DRAFT", maxPoints: 20, pending: true });
    expect(await session.listSubmissions("pending:create:1")).toEqual([]);
    await expect(session.setGrade("pending:create:1", "Cg4Isub1", 10)).rejects.toThrow(/not created yet/);

    await actions.apply(1);
    expect((await session.listCourseWork()).map(({ id }) => id)).toEqual(["201", "203", "500"]);
  });

  it("returns no submissions for a committed draft without asking Google's submissions endpoint", async () => {
    expect(await session.listSubmissions("203")).toEqual([]);
    expect(classroom.requests.some(r => r.path.endsWith("/studentSubmissions"))).toBe(false);
    expect(queue.observations).toHaveLength(1);
  });

  it("refuses coursework another project created, without asking Google to change it", async () => {
    classroom.courseWork.find(work => work.id === "202")!.state = "DRAFT";
    await expect(session.getCourseWork("202")).rejects.toThrow(/only the coursework it created/);
    await expect(session.listSubmissions("202")).rejects.toThrow(/only the coursework it created/);
    await expect(session.setGrade("202", "Cg4Isub9", 90)).rejects.toThrow(/only the coursework it created/);

    expect(queue.submitted).toEqual([]);
    expect(queue.observations).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("refuses a grade with more than two decimal places, rather than rounding it", async () => {
    await expect(session.setGrade("201", "Cg4Isub1", 91.255)).rejects.toThrow(/two decimal places/);
    expect(queue.submitted).toEqual([]);
    expect(classroom.requests).toEqual([]);
  });

  it("queues a grade, shows it pending, and passes it back once approved", async () => {
    await session.setGrade("201", "Cg4Isub2", 88.75);

    expect(queue.submitted[0]).toMatchObject({ title: "Grade Classroom submission: 88.75 out of 100" });
    expect(writes()).toEqual([]);
    let pending = await session.listSubmissions("201", { userId: "2002" });
    expect(pending).toEqual([{
      id: "Cg4Isub2", courseWorkId: "201", userId: "2002", state: "RETURNED", draftGrade: 80,
      assignedGrade: 88.75, pending: true,
    }]);

    await actions.apply(1);

    expect(writes().map(({ method, path }) => `${method} ${path}`)).toEqual([
      "PATCH /courses/101/courseWork/201/studentSubmissions/Cg4Isub2",
      "POST /courses/101/courseWork/201/studentSubmissions/Cg4Isub2:return",
    ]);
    expect(await session.listSubmissions("201", { userId: "2002" })).toEqual([{
      id: "Cg4Isub2", courseWorkId: "201", userId: "2002", state: "RETURNED", draftGrade: 80,
      assignedGrade: 88.75,
    }]);
  });
});

describe("Classroom Plus session", () => {
  it("audits reads and queues rubric creation before any write", async () => {
    expect(await session.getGradingPeriodSettings()).toEqual({ gradingPeriods: [] });
    expect(await session.listRubrics("201")).toEqual([]);
    expect(queue.observations.map(o => o.title)).toEqual(["Read Classroom grading periods", "Read Classroom rubrics"]);
    await session.createRubric("201", { criteria: [{ title: "Evidence", levels: [{ title: "Supported", points: 10 }] }] });
    expect(writes()).toEqual([]);
    expect(queue.submitted.at(-1)?.title).toBe("Create Google Classroom rubric");
    await actions.apply(journal.listPending()[0].id);
    expect(await session.listRubrics("201")).toHaveLength(1);
  });

  it("refuses foreign-project rubrics and invalid IDs before submission", async () => {
    const draft = { criteria: [{ title: "Evidence", levels: [{ title: "Supported", points: 10 }] }] };
    await expect(session.createRubric("202", draft)).rejects.toThrow(/not created/);
    await expect(session.listRubrics("../201")).rejects.toThrow(/Invalid/);
    expect(queue.submitted).toEqual([]);
    expect(writes()).toEqual([]);
  });
});
