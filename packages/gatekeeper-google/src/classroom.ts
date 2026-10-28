import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { ActionJournal, type JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { AccessTokenCache, type AccessTokenRequest } from "./auth-retry";
import {
  CLASSROOM_ACTIONS, type ClassroomAction, type ClassroomActions,
} from "./classroom-actions";
import {
  ClassroomApi, assertClassroomSubmissionReady, validateClassroomCourseWorkId, validateClassroomGrade,
} from "./classroom-api";
import type {
  ClassroomRubric, ClassroomRubricDraft, ClassroomGradingPeriodSettings,
  ClassroomCourse, ClassroomCourseWork, ClassroomCourseWorkDraft, ClassroomRoster,
  ClassroomSubmission, GoogleClassroomCourseSession,
} from "./classroom-types";
import type { GoogleVerifierApi } from "./google-verifier-types";
import CLASSROOM_TYPES_CODE from "./classroom-types.txt";

type Env = Cloudflare.Env;

/** What a Classroom binding names: its owner's account and one course. */
export type GoogleClassroomGatekeeperImplProps = { userObjectId: string; courseId: string };

/** How a session sees and queues the binding's changes. */
export type ClassroomChanges = {
  /** The changes awaiting a decision, oldest first, which reads show as already applied. */
  pending(): readonly JournalEntry<ClassroomAction>[];
  /** Queues a change for approval. */
  submit<K extends keyof ClassroomActions>(kind: K, payload: ClassroomActions[K]): Promise<void>;
};

import { classroomRubricDraft } from "./classroom-plus";

const PENDING_COURSE_WORK_PREFIX = "pending:create:";

/** The gatekeeper for one Google Classroom course. */
@validateRpc()
export class GoogleClassroomGatekeeperImpl
    extends DurableObject<Env, GoogleClassroomGatekeeperImplProps>
    implements Gatekeeper<GoogleClassroomCourseSession> {
  #tokens = new AccessTokenCache(opts => {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return account.getAccessToken(opts);
  });
  #api = new ClassroomApi((opts?: AccessTokenRequest) => this.#tokens.get(opts));
  #journal = new ActionJournal<ClassroomAction>(this.ctx.storage.kv, { namespace: "classroom" });
  #actions = CLASSROOM_ACTIONS.bind(this.#journal, { api: this.#api, courseId: this.ctx.props.courseId });

  async describe(): Promise<ResourceDescription> {
    let course = await this.#api.getCourse(this.ctx.props.courseId);
    let name = course.section ? `${course.name} (${course.section})` : course.name;
    return {
      url: course.alternateLink ?? "https://classroom.google.com/",
      title: `Classroom: ${name}`,
      snippet: `Google Classroom course: ${name}`,
      suggestedBindingName: "GOOGLE_CLASSROOM",
      tsType: "GoogleClassroomCourseSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return CLASSROOM_TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#actions.autoApprovableKinds();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GoogleClassroomCourseSession> {
    let queue = approvalQueue.dup();
    return new GoogleClassroomCourseSessionImpl(this.#api, this.ctx.props.courseId, queue, {
      pending: () => this.#journal.listPending(),
      submit: async (kind, payload) => { await this.#actions.submit(queue, kind, payload); },
    });
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    await this.#actions.apply(actionId);
  }

  async rejectAction(actionId: number): Promise<void> {
    await this.#actions.reject(actionId);
  }

  async revertAction(_actionId: number): Promise<{ message: string }> {
    return {
      message: "Google Classroom changes cannot be reverted automatically. Undo it in Google Classroom.",
    };
  }

  /**
   * Observer tracking — strategy B (ACL check, single unit). A binding reads the roster, and the
   * grades of every student, so an observer must teach the course themselves.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasClassroomTeacherAccess(this.ctx.props.courseId))) {
      throw new Error(
        "This collaborator does not teach the bound Google Classroom course, so they cannot " +
        "observe its roster and grades.");
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}

function pendingCourseWork({ id, action }: JournalEntry<ClassroomAction>): ClassroomCourseWork[] {
  if (action.kind !== "createCourseWork") return [];
  let { title, description, maxPoints, state } = action.payload.draft;
  return [{
    id: `${PENDING_COURSE_WORK_PREFIX}${id}`, title, state: state ?? "DRAFT",
    ...(description === undefined ? {} : { description }),
    ...(maxPoints === undefined ? {} : { maxPoints }),
    pending: true,
  }];
}

/** One course's session, exported for tests. */
@validateRpc()
export class GoogleClassroomCourseSessionImpl extends RpcTarget implements GoogleClassroomCourseSession {
  #api: ClassroomApi;
  #courseId: string;
  #queue: RpcStub<ApprovalQueue>;
  #changes: ClassroomChanges;

  constructor(
    api: ClassroomApi, courseId: string, queue: RpcStub<ApprovalQueue>, changes: ClassroomChanges,
  ) {
    super();
    this.#api = api;
    this.#courseId = courseId;
    this.#queue = queue;
    this.#changes = changes;
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }

  async getGradingPeriodSettings(): Promise<ClassroomGradingPeriodSettings> {
    const settings = await this.#api.getGradingPeriodSettings(this.#courseId);
    await this.#queue.authorizeObservation({ title: "Read Classroom grading periods", description: `Read grading periods of course ${this.#courseId}.` });
    return settings;
  }

  async listRubrics(courseWorkId: string): Promise<ClassroomRubric[]> {
    const rubrics = await this.#api.listRubrics(this.#courseId, courseWorkId);
    await this.#queue.authorizeObservation({ title: "Read Classroom rubrics", description: `Read rubrics of coursework ${courseWorkId} in course ${this.#courseId}.` });
    return rubrics;
  }

  async createRubric(courseWorkId: string, draft: ClassroomRubricDraft): Promise<void> {
    const parsed = classroomRubricDraft(draft);
    await this.#api.getOwnedCourseWork(this.#courseId, courseWorkId);
    await this.#changes.submit("createRubric", { courseWorkId, draft: parsed });
  }

  async getCourse(): Promise<ClassroomCourse> {
    let course = await this.#api.getCourse(this.#courseId);
    await this.#queue.authorizeObservation({
      title: "Read Google Classroom course",
      description: `Read the details of Google Classroom course ${this.#courseId}.`,
    });
    return course;
  }

  async getRoster(): Promise<ClassroomRoster> {
    let roster = await this.#api.getRoster(this.#courseId);
    await this.#queue.authorizeObservation({
      title: "Read Google Classroom roster",
      description:
        `Read the roster of Google Classroom course ${this.#courseId}: ` +
        `${roster.teachers.length} teacher(s) and ${roster.students.length} student(s).`,
    });
    return roster;
  }

  async listCourseWork(): Promise<ClassroomCourseWork[]> {
    let courseWork = [
      ...await this.#api.listOwnedCourseWork(this.#courseId),
      ...this.#changes.pending().flatMap(pendingCourseWork),
    ];
    await this.#queue.authorizeObservation({
      title: "List Google Classroom coursework",
      description:
        `List the ${courseWork.length} coursework item(s) created through this connection in ` +
        `Google Classroom course ${this.#courseId}.`,
    });
    return courseWork;
  }

  async getCourseWork(courseWorkId: string): Promise<ClassroomCourseWork> {
    let courseWork = this.#pendingCourseWork(courseWorkId) ??
      await this.#api.getOwnedCourseWork(this.#courseId, courseWorkId);
    await this.#queue.authorizeObservation({
      title: "Read Google Classroom coursework",
      description: `Read coursework ${courseWorkId} of Google Classroom course ${this.#courseId}.`,
    });
    return courseWork;
  }

  async createCourseWork(draft: ClassroomCourseWorkDraft): Promise<void> {
    if (!draft.title.trim()) throw new Error("Coursework title is required.");
    if (draft.maxPoints !== undefined && !(Number.isSafeInteger(draft.maxPoints) && draft.maxPoints >= 0)) {
      throw new Error("Coursework maxPoints must be a non-negative whole number.");
    }
    await this.#changes.submit("createCourseWork", { draft });
  }

  async listSubmissions(courseWorkId: string, options: { userId?: string } = {})
      : Promise<ClassroomSubmission[]> {
    // Coursework still awaiting approval has no submissions yet.
    let submissions = this.#pendingCourseWork(courseWorkId) ? [] : await this.#ownedSubmissions(
      courseWorkId, options.userId);
    await this.#queue.authorizeObservation({
      title: "List Google Classroom submissions",
      description:
        `List ${submissions.length} student submission(s), with their grades, for coursework ` +
        `${courseWorkId} of Google Classroom course ${this.#courseId}.`,
    });
    return submissions;
  }

  async setGrade(courseWorkId: string, submissionId: string, assignedGrade: number): Promise<void> {
    validateClassroomGrade(assignedGrade);
    if (this.#pendingCourseWork(courseWorkId)) {
      throw new Error("This coursework is not created yet. Once its creation is approved, grade it.");
    }
    let courseWork = await this.#api.getOwnedCourseWork(this.#courseId, courseWorkId);
    let submission = await this.#api.getSubmission(this.#courseId, courseWorkId, submissionId);
    assertClassroomSubmissionReady(submission);
    await this.#changes.submit("setGrade", {
      courseWorkId, courseWorkTitle: courseWork.title, submissionId, userId: submission.userId,
      assignedGrade,
      ...(courseWork.maxPoints === undefined ? {} : { maxPoints: courseWork.maxPoints }),
    });
  }

  /** The coursework a queued creation will make, for an ID of the form `pending:create:{n}`. */
  #pendingCourseWork(courseWorkId: string): ClassroomCourseWork | undefined {
    if (!courseWorkId.startsWith(PENDING_COURSE_WORK_PREFIX)) {
      validateClassroomCourseWorkId(courseWorkId);
      return undefined;
    }
    let found = this.#changes.pending().flatMap(pendingCourseWork).find(({ id }) => id === courseWorkId);
    if (!found) throw new Error(`No coursework creation ${courseWorkId} is awaiting approval.`);
    return found;
  }

  /** The submissions, refused unless this connection created the coursework, with queued grades. */
  async #ownedSubmissions(courseWorkId: string, userId?: string): Promise<ClassroomSubmission[]> {
    await this.#api.getOwnedCourseWork(this.#courseId, courseWorkId);
    let submissions = await this.#api.listSubmissions(this.#courseId, courseWorkId, userId);
    let grades = new Map<string, number>();
    for (let { action } of this.#changes.pending()) {
      if (action.kind === "setGrade" && action.payload.courseWorkId === courseWorkId) {
        grades.set(action.payload.submissionId, action.payload.assignedGrade);
      }
    }
    return submissions.map(submission => {
      let assignedGrade = grades.get(submission.id);
      return assignedGrade === undefined ? submission
        : { ...submission, assignedGrade, state: "RETURNED", pending: true };
    });
  }
}
